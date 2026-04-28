package main

import (
	"bytes"

	"gopkg.in/yaml.v3"
)

// splitFrontmatter separates a leading YAML frontmatter block from the body.
//
// A frontmatter block must:
//   - Start at the very first byte of the document with `---` followed by an
//     end-of-line (LF or CRLF). Any leading whitespace, BOM, or non-`---` byte
//     means there is no frontmatter.
//   - Be terminated by a line containing exactly `---` (optionally with
//     trailing CR) before EOF.
//
// On success it returns (yamlBlock, body, true). yamlBlock excludes the
// surrounding `---` delimiters; body is everything after the closing delimiter
// (including its trailing newline if any).
//
// On any of the following it returns (nil, content, false) so callers can
// safely fall back to treating the whole document as body:
//   - The document does not start with a `---` line.
//   - The opening `---` line is never closed by another standalone `---`.
//   - A `---` later in the body must NOT be treated as a closing delimiter
//     when there was no opening delimiter (the leading-byte check guarantees
//     this).
func splitFrontmatter(content []byte) (yamlBlock, body []byte, ok bool) {
	const delim = "---"

	// Must start with `---` followed by LF or CRLF (or be exactly `---`+EOF).
	if !bytes.HasPrefix(content, []byte(delim)) {
		return nil, content, false
	}
	rest := content[len(delim):]
	// The character immediately after `---` must be \n or \r (CRLF). If the
	// document is just `---` with no terminator, that is also not a valid
	// (closed) frontmatter block.
	if len(rest) == 0 {
		return nil, content, false
	}
	switch rest[0] {
	case '\n':
		rest = rest[1:]
	case '\r':
		if len(rest) > 1 && rest[1] == '\n' {
			rest = rest[2:]
		} else {
			rest = rest[1:]
		}
	default:
		// e.g. "---foo" — not a frontmatter delimiter.
		return nil, content, false
	}

	// Walk line-by-line looking for a standalone `---` line.
	cursor := 0
	for cursor < len(rest) {
		// Find end of current line.
		nl := bytes.IndexByte(rest[cursor:], '\n')
		var line []byte
		var lineEnd int // index in rest just past the line terminator
		if nl < 0 {
			line = rest[cursor:]
			lineEnd = len(rest)
		} else {
			line = rest[cursor : cursor+nl]
			lineEnd = cursor + nl + 1
		}
		// Strip a single trailing CR for CRLF files.
		trimmed := line
		if n := len(trimmed); n > 0 && trimmed[n-1] == '\r' {
			trimmed = trimmed[:n-1]
		}
		if bytes.Equal(trimmed, []byte(delim)) {
			yamlBlock = rest[:cursor]
			body = rest[lineEnd:]
			return yamlBlock, body, true
		}
		cursor = lineEnd
	}

	// Unterminated frontmatter — treat whole file as body, untouched.
	return nil, content, false
}

// parseFrontmatter splits the document and unmarshals the YAML block.
//
// If there is no valid frontmatter, it returns (nil, original-content, false).
// If the YAML fails to parse, it returns (nil, body, true) — callers still
// see the body without the raw YAML, and can fall back for missing fields.
func parseFrontmatter(content []byte) (meta map[string]any, body string, ok bool) {
	yamlBlock, bodyBytes, hasFM := splitFrontmatter(content)
	if !hasFM {
		return nil, string(content), false
	}
	if len(bytes.TrimSpace(yamlBlock)) == 0 {
		return map[string]any{}, string(bodyBytes), true
	}
	var m map[string]any
	if err := yaml.Unmarshal(yamlBlock, &m); err != nil {
		return nil, string(bodyBytes), true
	}
	return m, string(bodyBytes), true
}

// frontmatterString returns meta[key] as a string if present and string-typed,
// else "". This deliberately ignores non-string values (numbers, maps, etc.)
// so block-scalar markers (`|`, `>`) cannot leak: a real YAML parser already
// resolved them into a plain Go string.
func frontmatterString(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	v, ok := meta[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// needsFrontmatterReparse reports whether a string field looks like it still
// carries a raw YAML block-scalar indicator (`|` or `>`, optionally followed
// by chomping/indent indicators). When the upstream operation package returns
// such a value verbatim, callers must re-parse OPERATION.md with a real YAML
// parser; otherwise the leading marker would leak into the UI.
//
// Returns false for plain strings (the common case) so callers can skip the
// expensive file-read + YAML parse on every list call.
func needsFrontmatterReparse(s string) bool {
	// Strip leading horizontal whitespace; a YAML scalar may be written as
	// `summary:   |` and the upstream package may or may not trim that.
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	if i >= len(s) {
		return false
	}
	return s[i] == '|' || s[i] == '>'
}
