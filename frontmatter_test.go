package main

import (
	"strings"
	"testing"
)

// Edge cases (a)–(g) from the brief.

func TestSplitFrontmatter_NoFrontmatter(t *testing.T) {
	// (a) No frontmatter at all — body returned untouched, ok=false.
	in := []byte("# Hello\n\nbody text\n")
	yml, body, ok := splitFrontmatter(in)
	if ok {
		t.Fatalf("ok = true, want false")
	}
	if yml != nil {
		t.Errorf("yaml block = %q, want nil", yml)
	}
	if string(body) != string(in) {
		t.Errorf("body = %q, want %q", body, in)
	}
}

func TestSplitFrontmatter_WithFrontmatter(t *testing.T) {
	// (b) Frontmatter present.
	in := []byte("---\nsummary: hi\n---\n# Title\n\nbody\n")
	yml, body, ok := splitFrontmatter(in)
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if string(yml) != "summary: hi\n" {
		t.Errorf("yaml = %q", yml)
	}
	if string(body) != "# Title\n\nbody\n" {
		t.Errorf("body = %q", body)
	}
}

func TestSplitFrontmatter_BodyHasHorizontalRule(t *testing.T) {
	// (c) Body contains `---` as a horizontal rule. The leading-byte check
	// guarantees we never strip when no opening delimiter exists.
	in := []byte("# Title\n\npara 1\n\n---\n\npara 2\n")
	yml, body, ok := splitFrontmatter(in)
	if ok {
		t.Fatalf("ok = true, want false (no leading frontmatter)")
	}
	if yml != nil {
		t.Errorf("yaml = %q, want nil", yml)
	}
	if string(body) != string(in) {
		t.Errorf("body altered; got %q want %q", body, in)
	}
}

func TestSplitFrontmatter_FrontmatterOnlyNoBody(t *testing.T) {
	// (d) Frontmatter only, no body content after closing delimiter.
	in := []byte("---\nsummary: solo\n---\n")
	yml, body, ok := splitFrontmatter(in)
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if string(yml) != "summary: solo\n" {
		t.Errorf("yaml = %q", yml)
	}
	if string(body) != "" {
		t.Errorf("body = %q, want empty", body)
	}
}

func TestSplitFrontmatter_Unterminated(t *testing.T) {
	// (e) Opening `---` never closed — leave content untouched.
	in := []byte("---\nsummary: forever\nbody but no closing\n")
	yml, body, ok := splitFrontmatter(in)
	if ok {
		t.Fatalf("ok = true, want false (unterminated must not be stripped)")
	}
	if yml != nil {
		t.Errorf("yaml = %q, want nil", yml)
	}
	if string(body) != string(in) {
		t.Errorf("body = %q, want untouched %q", body, in)
	}
}

func TestParseFrontmatter_LiteralBlockScalar(t *testing.T) {
	// (f) summary written with `|` literal block scalar — parser must resolve
	// it; the `|` must NOT appear in the result.
	in := []byte("---\nsummary: |\n  line one\n  line two\n---\nbody\n")
	meta, body, ok := parseFrontmatter(in)
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	got := frontmatterString(meta, "summary")
	if strings.Contains(got, "|") {
		t.Errorf("summary leaked block-scalar marker: %q", got)
	}
	if got != "line one\nline two\n" {
		t.Errorf("summary = %q, want %q", got, "line one\nline two\n")
	}
	if body != "body\n" {
		t.Errorf("body = %q", body)
	}
}

func TestParseFrontmatter_FoldedBlockScalar(t *testing.T) {
	// (g) summary written with `>` folded block scalar.
	in := []byte("---\nsummary: >\n  line one\n  line two\n---\nbody\n")
	meta, _, ok := parseFrontmatter(in)
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	got := frontmatterString(meta, "summary")
	if strings.Contains(got, ">") {
		t.Errorf("summary leaked fold marker: %q", got)
	}
	// Folded scalar collapses internal newlines into spaces.
	if got != "line one line two\n" {
		t.Errorf("summary = %q, want %q", got, "line one line two\n")
	}
}

// Additional sanity tests beyond the brief.

func TestSplitFrontmatter_CRLF(t *testing.T) {
	in := []byte("---\r\nsummary: hi\r\n---\r\nbody\r\n")
	yml, body, ok := splitFrontmatter(in)
	if !ok {
		t.Fatalf("ok=false")
	}
	if string(yml) != "summary: hi\r\n" {
		t.Errorf("yaml = %q", yml)
	}
	if string(body) != "body\r\n" {
		t.Errorf("body = %q", body)
	}
}

func TestSplitFrontmatter_NotADelimiterPrefix(t *testing.T) {
	// `---foo` on the first line is not a delimiter.
	in := []byte("---foo\nbody\n")
	_, body, ok := splitFrontmatter(in)
	if ok {
		t.Fatalf("ok=true for non-delimiter prefix")
	}
	if string(body) != string(in) {
		t.Errorf("body altered")
	}
}

func TestParseFrontmatter_EmptyFrontmatter(t *testing.T) {
	in := []byte("---\n---\nbody\n")
	meta, body, ok := parseFrontmatter(in)
	if !ok {
		t.Fatalf("ok=false")
	}
	if meta == nil {
		t.Errorf("meta=nil, want empty map")
	}
	if len(meta) != 0 {
		t.Errorf("meta=%v, want empty", meta)
	}
	if body != "body\n" {
		t.Errorf("body=%q", body)
	}
}

func TestFrontmatterString_NonStringIgnored(t *testing.T) {
	meta := map[string]any{"summary": 42, "brief": "hello"}
	if got := frontmatterString(meta, "summary"); got != "" {
		t.Errorf("non-string returned %q, want empty", got)
	}
	if got := frontmatterString(meta, "brief"); got != "hello" {
		t.Errorf("brief = %q", got)
	}
	if got := frontmatterString(meta, "missing"); got != "" {
		t.Errorf("missing key = %q, want empty", got)
	}
	if got := frontmatterString(nil, "summary"); got != "" {
		t.Errorf("nil meta returned %q", got)
	}
}
