'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const chart = require('../public/history-chart');
const metric = { id: 'rain', kind: 'bar', aggregation: 'TOTAL', precision: 1, unit: 'mm' };
function series(values) {
  const points = values.map((value, i) => ({ t: Date.parse('2026-10-25T00:00:00Z') + (i + 1) * 600000, value, min: null, max: null }));
  return { metric, resolution: '10m', intervalSeconds: 600, points, latest: points.at(-1), missing: values.filter(v => v === null).length };
}
test('rainfall inches use 25.4mm per inch and never turn a missing value into zero', () => {
  assert.equal(chart.rainfallInches(25.4), '(1.00 in)');
  assert.equal(chart.rainfallInches(225), '(8.86 in)');
  assert.equal(chart.rainfallInches(0), '(0.00 in)');
  for (const value of [null, undefined, NaN, Infinity, -1, '25.4']) assert.equal(chart.rainfallInches(value), '');
});
test('highest rainfall carries the native period end, with earliest tied occurrence and no estimated peaks', () => {
  const s = series([.2, 4, 1, 4, 10]); s.points[4].estimated = true;
  const highest = () => chart.summary(s).at(-1);
  assert.equal(highest()[0], 'Highest 10-minute rainfall');
  assert.equal(highest()[1], 4); assert.equal(highest()[3].t, s.points[1].t);
  const t = s.points[1].t; s.points.reverse(); assert.equal(highest()[3].t, t);
  const allMissing = chart.summary(series([null, null])).at(-1);
  assert.equal(allMissing[1], null); assert.equal(allMissing[3], undefined);
  assert.equal(chart.summary(series([0, 0])).at(-1)[3].t, series([0]).points[0].t);
});
test('rainfall peak date follows the visible range and native resolution', () => {
  const s = series([8, 2, 4]), narrowed = chart.visibleSeries(s, s.points[0].t, s.points[2].t);
  assert.equal(chart.summary(narrowed).at(-1)[3].t, s.points[2].t);
  s.resolution = 'hourly'; assert.equal(chart.summary(s).at(-1)[0], 'Highest hourly rainfall');
  assert.equal(chart.summary(s).at(-1)[3].t, s.points[0].t);
});
test('bridge warning starts at one metre and progresses from amber to red without changing clearance', () => {
  for (const n of [1.01, 2, NaN, null]) assert.equal(chart.bridgeWarning(n), null);
  assert.deepEqual(chart.bridgeWarning(1), { hue: 42, tint: 12 });
  assert.deepEqual(chart.bridgeWarning(.5), { hue: 21, tint: 18 });
  assert.deepEqual(chart.bridgeWarning(0), { hue: 0, tint: 24 });
  assert.deepEqual(chart.bridgeWarning(-.2), { hue: 0, tint: 24 });
});
