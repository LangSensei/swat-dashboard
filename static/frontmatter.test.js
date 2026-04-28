// Edge-case tests for stripFrontmatter.
// Run with: node static/frontmatter.test.js
//
// Uses Node's built-in node:test runner (Node >= 18) so no external deps.

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripFrontmatter } = require('./frontmatter');

test('(a) no frontmatter is returned unchanged', () => {
  const input = '# Title\n\nSome body text.\n';
  assert.equal(stripFrontmatter(input), input);
});

test('(b) leading frontmatter block is stripped', () => {
  const input = '---\ntitle: Hello\nsummary: |\n  multi-line\n---\n# Body\n\nText.\n';
  assert.equal(stripFrontmatter(input), '# Body\n\nText.\n');
});

test('(c) body containing --- horizontal rule is not stripped', () => {
  const input = '# Title\n\nIntro.\n\n---\n\nMore body.\n';
  assert.equal(stripFrontmatter(input), input);
});

test('(d) frontmatter only, no body, returns empty', () => {
  const input = '---\nkey: value\n---\n';
  assert.equal(stripFrontmatter(input), '');
});

test('(d2) frontmatter only with no trailing newline', () => {
  const input = '---\nkey: value\n---';
  assert.equal(stripFrontmatter(input), '');
});

test('(e) unterminated frontmatter returns input unchanged', () => {
  const input = '---\nkey: value\nno closer here\n';
  assert.equal(stripFrontmatter(input), input);
});

test('opening line with trailing spaces is treated as frontmatter', () => {
  const input = '---  \nkey: value\n---\nbody\n';
  assert.equal(stripFrontmatter(input), 'body\n');
});

test('opening line that is not exactly --- is left untouched', () => {
  const input = '----\nnot frontmatter\n----\nbody\n';
  assert.equal(stripFrontmatter(input), input);
});

test('CRLF line endings are handled', () => {
  const input = '---\r\nkey: v\r\n---\r\n# Body\r\n';
  assert.equal(stripFrontmatter(input), '# Body\r\n');
});

test('non-string input is returned unchanged', () => {
  assert.equal(stripFrontmatter(null), null);
  assert.equal(stripFrontmatter(undefined), undefined);
});

test('single line --- with no newline is not treated as frontmatter', () => {
  assert.equal(stripFrontmatter('---'), '---');
});
