// Strip a leading YAML frontmatter block from a markdown string.
//
// Rules:
//   - The file must start with a line that is exactly `---` (optional trailing
//     spaces/tabs allowed) on line 1. Otherwise the input is returned unchanged.
//   - Stripping ends at the next standalone `---` line (also `---` with optional
//     trailing spaces/tabs, terminated by a newline or end-of-file).
//   - If no closing `---` line is found, the input is returned unchanged so we
//     never silently swallow a document that just happens to start with `---`.
//   - Horizontal-rule `---` lines anywhere other than line 1 are never stripped.
//
// Exposed both as a browser global (`window.stripFrontmatter`) and as a
// CommonJS export so the same logic can be unit tested under Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.stripFrontmatter = api.stripFrontmatter;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  function stripFrontmatter(text) {
    if (typeof text !== 'string' || !text.startsWith('---')) {
      return text;
    }
    var nl = text.indexOf('\n');
    if (nl === -1) {
      // Single line that may be just `---` — not a frontmatter block.
      return text;
    }
    var firstLine = text.slice(0, nl).replace(/\r$/, '');
    if (!/^---[ \t]*$/.test(firstLine)) {
      return text;
    }
    var rest = text.slice(nl + 1);
    var closer = /(?:^|\n)---[ \t]*(?:\r?\n|$)/.exec(rest);
    if (!closer) {
      return text;
    }
    return rest.slice(closer.index + closer[0].length);
  }

  return { stripFrontmatter: stripFrontmatter };
}));
