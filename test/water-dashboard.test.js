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
  assert.deepEqual(data.series.map(s => s.metric.id), ['leslie-storage', 'condamine-warwick-level', 'condamine-level', 'connolly-storage']);
  const warwick = data.series[1], scots = data.series[2];
  assert.deepEqual(warwick.metric.referenceLines.map(r => r.value), [5, 6, 7]);
  assert.ok(domain(warwick)[1] > 7);
  assert.equal(scots.metric.referenceLines, undefined);
  assert.match(warwick.note, /Collection continues automatically/);
  assert.doesNotMatch(warwick.note, /Historical imports continue/);
});

test('an unusable newest water observation marks the fallback as last available until fresh valid data returns', t => {
  const store = new WaterStore(':memory:'); t.after(() => store.close());
  const reader = new WaterReader(store.db), id = 'condamine-warwick-level';
  const sample = (value, time) => ({ metric: id, value, t: time, min: value, max: value,
    stream: 'point', quality: null, qualityText: 'Unverified', priority: 1, raw: '{}' });
  assert.equal(reader.snapshot().readings[id], null);
  store.save([sample(6.8, now - 10 * 60000), sample(null, now - 5 * 60000)],
    'condamine-warwick-live', { lastSuccess: new Date(now).toISOString(), error: null });
  const fallback = reader.snapshot().readings[id];
  assert.equal(fallback.value, 6.8);
  assert.equal(fallback.t, now - 10 * 60000);
  assert.equal(fallback.latestObservedAt, now - 5 * 60000);
  assert.equal(fallback.latestValueAvailable, false);
  assert.equal(fallback.lastAvailable, true);
  assert.equal(reader.bridgeObservation().value, null);
  store.save([sample(0, now)]);
  const current = reader.snapshot().readings[id];
  assert.equal(current.value, 0);
  assert.equal(current.latestObservedAt, now);
  assert.equal(current.latestValueAvailable, true);
  assert.equal(current.lastAvailable, false);
});

test('all-null water data remains unavailable without inventing a number', t => {
  const store = new WaterStore(':memory:'); t.after(() => store.close());
  store.save([{ metric: 'condamine-warwick-level', value: null, t: now, min: null, max: null,
    stream: 'point', quality: null, qualityText: 'Missing', priority: 1, raw: '{}' }]);
  const reading = new WaterReader(store.db).snapshot().readings['condamine-warwick-level'];
  assert.equal(reading, null);
});
