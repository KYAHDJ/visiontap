const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, installPageHider } = require('../local-hide-test');

test('local hide launcher accepts a domain or a complete URL', () => {
  assert.equal(normalizeUrl('example.com').href, 'https://example.com/');
  assert.equal(normalizeUrl('http://example.com/page').href, 'http://example.com/page');
  assert.throws(() => normalizeUrl(''), /required/);
});

test('local hide launcher targets paragraphs and footers without removing them', () => {
  const source = installPageHider.toString();
  assert.match(source, /p, footer/);
  assert.match(source, /display: none !important/);
  assert.doesNotMatch(source, /\.remove\(/);
});
