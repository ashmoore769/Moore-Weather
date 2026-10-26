'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { bridgeDifference, domain } = require('../public/history-chart');
const { METRICS, HOUR } = require('../lib/water-data');
const { WaterStore } = require('../lib/water-store');
const { WaterReader } = require('../lib/water-history');
const metric = METRICS['condamine-warwick-level'], now = Date.now();

test('bridge difference uses the named Warwick reference, with below, at and above states', () => {
  assert.equal(metric.bridge.name, 'McCahon Bridge'); assert.equal(metric.bridge.level, 7);
  for (const [value, text] of [[5.34, '1.66m (Below Bridge)'], [7, '0.00m (At Bridge)'], [7.21, '0.21m (Above Bridge)']]) {
    const result = bridgeDifference({ value, t: now }, metric.bridge, now);
    assert.equal(result.text, text); assert.equal(result.stale, false);
  }
  assert.equal(METRICS['condamine-level'].bridge, undefined);
  assert.equal(bridgeDifference({ value: 5.34, t: now - 4 * HOUR }, metric.bridge, now).stale, true);
  for (const reading of [null, { value: null, t: now }, { value: NaN, t: now }, { value: 5, t: NaN }, { value: 5, t: now + HOUR }]) {
    assert.equal(bridgeDifference(reading, metric.bridge, now), null);
  }
  assert.equal(bridgeDifference({ value: 5, t: now }, undefined, now), null);
});

test('snapshot exposes independent Scots / Warwick previews and retains bridge lines even without observations', t => {
  const store = new WaterStore(':memory:'); t.after(() => store.close());
  const reader = new WaterReader(store.db), data = reader.snapshot();
  assert.deepEqual(data.series.map(s => s.metric.id), ['leslie-storage', 'condamine-warwick-level', 'condamine-level']);
  const warwick = data.series[1], scots = data.series[2];
  assert.deepEqual(warwick.metric.referenceLines.map(r => r.value), [5, 6, 7]);
  assert.ok(domain(warwick)[1] > 7);
  assert.equal(scots.metric.referenceLines, undefined);
  assert.match(warwick.note, /Collection continues automatically/);
  assert.doesNotMatch(warwick.note, /Historical imports continue/);
});
