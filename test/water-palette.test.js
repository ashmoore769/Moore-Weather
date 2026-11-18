'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path');
const css = readFileSync(join(__dirname, '../public/water.css'), 'utf8');
function siteAccent(site, dark) {
  const prefix = (dark ? 'html[data-theme="dark"] ' : '') + '.water-panel.' + site + ' { --water-site-accent:';
  const start = css.indexOf(prefix);
  assert.ok(start >= 0, 'missing ' + prefix);
  return css.slice(start + prefix.length, start + prefix.length + 7);
}
function luminance(hex) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a, b) {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}
test('four water sites have distinct, readable hues in both themes', () => {
  for (const dark of [false, true]) {
    const hues = ['water-dam', 'water-connolly', 'water-scots', 'water-warwick']
      .map(site => siteAccent(site, dark));
    assert.equal(new Set(hues).size, 4);
    for (const hue of hues) {
      assert.match(hue, /^#[0-9a-f]{6}$/);
      assert.ok(contrast(hue, dark ? '#203548' : '#ffffff') >= 4.5,
        'insufficient contrast for ' + hue);
    }
  }
});
test('secondary water values are differentiated without overriding flood warnings', () => {
  assert.ok(css.includes('color:color-mix(in srgb,var(--water-secondary-accent) 46%,var(--text))'));
  assert.ok(css.includes('--water-reading-accent:var(--water-secondary-accent)'));
  assert.ok(css.indexOf('Curated, site-specific water accents') < css.indexOf('Warning colours use current'));
  assert.ok(css.includes('.water-panel .water-bridge[data-warning="true"] :is(strong,.water-label,.water-history-cue)'));
});
