'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WeatherStore } = require('../lib/weather-store');
const { HistoryReader, normalizeRequest } = require('../lib/weather-history');
const { createHistoryApi } = require('../lib/weather-history-api');
const chart = require('../public/history-chart');
const layout = require('../config/station-layout.json');
const end = Date.parse('2026-08-21T00:00:00Z'); // 10:00 AEST

function fixture(t, filename = ':memory:') {
  const store = new WeatherStore(filename);
  store.setQualityPolicy(require('../config/data-quality.json'));
  t.after(() => store.close());
  return store;
}
function insert(store, stream, time, overrides = {}, date = '2026/08/21') {
  const values = layout.streams[stream].fields.map(f => overrides[f.sensorKey + ':' + f.aggregation] ?? overrides[f.sensorKey] ?? (f.sensorKey === '7' ? 1015 : 0));
  store.ingestLive(stream, [date, time, ...values].join(','));
  return store.db.prepare('SELECT id FROM records ORDER BY rowid DESC LIMIT 1').get().id;
}
function series(store, metric, resolution = '10m', hours = 1, finish = end) {
  // Test native quality/gap semantics independently of the API's archive bounds.
  return new HistoryReader(store.db).series([metric], resolution, hours, finish)[0];
}

test('native means, interval rain totals and real gaps are kept distinct', t => {
  const store = fixture(t);
  insert(store, 'mem3', '09:10:00', { '4': 12, '5': .2, '1:AVERAGE': 4, '1:MAXIMUM': 18 });
  insert(store, 'mem3', '09:30:00', { '4': 18, '5': .8 });
  const air = series(store, 'air');
  assert.deepEqual(air.points.map(p => p.value), [12, null, 18, null, null, null]);
  assert.equal(air.missing, 4);
  assert.deepEqual(series(store, 'rain').points.map(p => p.value), [.2, null, .8, null, null, null]);
  assert.equal(series(store, 'wind').points[0].value, 4);
  assert.equal(series(store, 'wind').points[0].max, 18);
});

test('screened outliers stay gaps, solar floors are flagged, raw values and pressure are unchanged', t => {
  const store = fixture(t);
  insert(store, 'mem3', '09:10:00', { '4': -25, '6': -1.2, '7': 1020 });
  insert(store, 'mem3', '09:20:00', { '4': -2, '6': -30, '7': 804.2 });
  assert.deepEqual(series(store, 'air').points.slice(0, 2).map(p => p.value), [null, -2]);
  assert.equal(series(store, 'solar').points[0].value, 0);
  assert.equal(series(store, 'solar').points[0].adjusted, true);
  assert.equal(series(store, 'solar').points[1].value, null);
  assert.deepEqual(series(store, 'pressure').points.slice(0, 2).map(p => p.value), [1020, null]);
  assert.equal(store.db.prepare("SELECT value FROM weather_readings_raw WHERE sensor_key='6' ORDER BY observed_at LIMIT 1").get().value, -1.2);
});

test('daily ranges use the 9 AM boundary, preserve negative evaporation and do not invent unavailable feeds', t => {
  const store = fixture(t);
  insert(store, 'mem1', '09:00:00', { '4:MINIMUM': 8, '4:AVERAGE': 16, '4:MAXIMUM': 26, '33': -.12 });
  const daily = series(store, 'air', 'daily', 24);
  assert.equal(daily.points.length, 1);
  assert.equal(daily.points[0].t, Date.parse('2026-08-20T23:00:00Z'));
  assert.equal(daily.points[0].reportingDate, '2026-08-20');
  assert.deepEqual([daily.points[0].min, daily.points[0].value, daily.points[0].max], [8, 16, 26]);
  assert.equal(series(store, 'evaporation-total', 'daily', 24).latest.value, -.12);
  assert.throws(() => series(store, 'globe'), /not recorded/);
  const catalog = new HistoryReader(store.db).catalog;
  assert.deepEqual(catalog.find(m => m.id === 'globe').resolutions, ['hourly', 'daily']);
  assert.deepEqual(catalog.find(m => m.id === 'evaporation').resolutions, ['hourly']);
});

test('conflicting measurements are withheld; measured data replaces flagged interpolation', t => {
  const store = fixture(t);
  const before = insert(store, 'mem3', '09:10:00', { '4': 10 });
  const after = insert(store, 'mem3', '09:30:00', { '4': 20 });
  const estimated = insert(store, 'mem3', '09:20:00', { '4': 15 });
  store.db.prepare('INSERT INTO record_estimates VALUES(?,?,?,?,?,?)').run(estimated, before, after, 'linear', 'test', new Date().toISOString());
  assert.equal(series(store, 'air').points[1].estimated, true);
  insert(store, 'mem3', '09:20:00', { '4': 16 });
  assert.equal(series(store, 'air').points[1].value, 16);
  assert.equal(series(store, 'air').points[1].estimated, false);
  insert(store, 'mem3', '09:30:00', { '4': 21 });
  assert.equal(series(store, 'air').points[2].value, null);
});

test('request validation bounds work and rejects malformed or ambiguous parameters', () => {
  for (const bad of [{ metric: '__proto__' }, { metric: 'air', resolution: 'constructor' }, { metric: 'air', hours: '169' }, { metric: 'air', hours: '-1' }, { metric: 'air', hours: '1e3' }, { metric: ['air'] }, { metric: 'air', start: 'anything' }, { metric: 'air', end: '2026-02-30T00:00:00.000Z' }, { metric: 'air', end: '2099-01-01T00:00:00.000Z' }]) assert.throws(() => normalizeRequest(bad, false, end), error => error.status === 400);
  assert.throws(() => normalizeRequest({ view: 'other' }, true), /Unknown/);
  assert.equal(normalizeRequest({ metric: 'air', hours: '168' }, false, end).hours, 168);
});

test('rendering breaks at gaps and at north; rain and signed evaporation include zero', () => {
  const points = [350, 355, 2, 10, null, 20].map((value, t) => ({ value, t, min: null, max: null }));
  assert.deepEqual(chart.segments(points, true).map(s => s.map(p => p.value)), [[350, 355], [2, 10], [20]]);
  assert.deepEqual(chart.segments(points).map(s => s.length), [4, 1]);
  for (const value of [-.12, 10]) {
    const domain = chart.domain({ metric: { id: 'evaporation-total', kind: 'bar', precision: 2 }, points: [{ value, min: null, max: null }] });
    assert.ok(domain[0] <= 0 && domain[1] >= 0);
  }
});

test('read-only worker serves the same data while recording continues; disabled history fails cleanly', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'history.sqlite'), store = new WeatherStore(filename);
  insert(store, 'mem3', '09:10:00', { '4': 17 });
  const api = createHistoryApi({ filename, isReady: () => true, logger: { warn() {} } });
  try {
    const request = { metric: 'air', resolution: '10m', hours: 1, end };
    const first = await api.query(request);
    assert.equal(first.series[0].points[0].value, 17);
    insert(store, 'mem3', '09:20:00', { '4': 18 });
    const second = await api.query({ ...request, end: end + 60000 });
    assert.equal(second.series[0].points[1].value, 18);
    const unavailable = createHistoryApi({ filename: '', isReady: () => false, logger: { warn() {} } });
    await assert.rejects(unavailable.query(request), /unavailable/);
  } finally { api.close(); store.close(); await new Promise(resolve => setTimeout(resolve, 100)); }
});

test('Current previews cover twenty-four hours across station metrics while Daily Summary keeps thirty days', t => {
  const store = fixture(t);
  insert(store, 'mem3', '09:10:00', { '4': 12 });
  insert(store, 'mem2', '10:00:00');
  const reader = new HistoryReader(store.db);
  const current = reader.query(normalizeRequest({ view: 'current' }, true, end));
  assert.ok(current.series.length > 10);
  assert.ok(current.series.every(s => s.end - s.start === 24 * 3600000));
  assert.equal(current.series.find(s => s.metric.id === 'air').points.length, 144);
  assert.equal(current.series.find(s => s.metric.id === 'globe').points.length, 24);
  const daily = reader.query(normalizeRequest({ view: 'daily' }, true, end));
  assert.ok(daily.series.every(s => s.end - s.start === 720 * 3600000));
});
