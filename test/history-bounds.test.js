'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WeatherStore } = require('../lib/weather-store');
const { HistoryReader } = require('../lib/weather-history');
const chart = require('../public/history-chart');
const layout = require('../config/station-layout.json');
const HOUR = 3600000, DAY = 24 * HOUR;
const now = Date.parse('2026-10-22T00:15:00Z');

function insert(store, date, time, values = {}) {
  const row = layout.streams.mem3.fields.map(f => values[f.sensorKey] ?? (f.sensorKey === '7' ? 1015 : 0));
  store.ingestLive('mem3', [date, time, ...row].join(','));
}

test('each weather measurement starts at its first usable record; missing recent periods stay visible', t => {
  const store = new WeatherStore(':memory:'); t.after(() => store.close());
  store.setQualityPolicy(require('../config/data-quality.json'));
  insert(store, '2026/08/21', '09:10:00', { '4': -25, '5': .2 });
  insert(store, '2026/08/21', '09:20:00', { '4': 12, '5': .3 });
  const reader = new HistoryReader(store.db), catalog = reader.availableCatalog(now);
  const air = catalog.find(m => m.id === 'air'), rain = catalog.find(m => m.id === 'rain');
  assert.equal(air.coverage['10m'].first - rain.coverage['10m'].first, 600000);
  const end = Date.parse('2026-08-21T00:00:00Z');
  const s = reader.query({ metric: 'air', resolution: '10m', hours: 1, end }).series[0];
  assert.equal(s.start, air.coverage['10m'].start);
  assert.equal(s.points[0].value, 12);
  assert.ok(s.points.at(-1).t >= end && s.points.at(-1).value === null);
  const bounded = reader.query({ metric: 'rain', resolution: '10m', hours: 168, end: Date.parse('1876-01-01') }).series[0];
  assert.equal(bounded.start, rain.coverage['10m'].start);
  assert.equal(chart.summary(bounded)[0][1], .5); // Includes the first rainfall period.
});

test('coverage refreshes as backfill extends the database and ignores conflicted leading records', t => {
  const store = new WeatherStore(':memory:'); t.after(() => store.close());
  insert(store, '2026/08/21', '09:20:00', { '4': 12 });
  const reader = new HistoryReader(store.db), edge = () => reader.availableCatalog(now).find(m => m.id === 'air').coverage['10m'];
  const original = edge().first;
  insert(store, '2026/08/21', '09:10:00', { '4': 10 });
  assert.equal(edge().first, original - 600000);
  insert(store, '2026/08/21', '09:10:00', { '4': 11 });
  assert.equal(edge().first, original);
  insert(store, '2026/08/21', '09:30:00', { '4': 14 });
  assert.equal(edge().last, original + 600000);
});

test('pan, zoom and all-history stay within the database start at every native resolution', () => {
  const last = Date.parse('2026-10-21T23:00:00Z');
  const metric = { coverage: {
    '10m': { start: last - 3 * DAY, first: last - 3 * DAY + 600000, last },
    hourly: { start: last - 30 * DAY, first: last - 30 * DAY + HOUR, last },
    daily: { start: last - 700 * DAY, first: last - 699 * DAY, last }
  } };
  for (const resolution of Object.keys(metric.coverage)) {
    const coverage = metric.coverage[resolution];
    for (const shift of [-1e7, -5000, -10, 0, 100]) {
      for (const hours of [.01, 24, 720, 20000, 1e7]) {
        const end = now + shift * HOUR;
        const view = chart.navigationWindow(end - hours * HOUR, end, [resolution], now, resolution, metric);
        assert.ok(view.start >= coverage.start);
        assert.ok(view.end <= now);
        assert.ok(view.end > view.start);
      }
    }
    const all = chart.navigationWindow(coverage.start, coverage.last, [resolution], now, resolution, metric);
    assert.equal(all.start, coverage.start);
    assert.equal(all.end, coverage.last);
  }
});

test('zooming an old daily archive does not jump into a recent hourly archive', () => {
  const end = Date.parse('1987-06-01T14:00:00Z');
  const metric = { water: true, dailyOffset: 14 * HOUR, maxHours: 150 * 366 * 24, coverage: {
    hourly: { first: now - DAY, start: now - DAY - HOUR, last: now - HOUR },
    daily: { first: Date.parse('1986-01-01T14:00:00Z'), start: Date.parse('1985-12-31T14:00:00Z'), last: now - DAY }
  } };
  const view = chart.navigationWindow(end - 24 * HOUR, end, ['hourly', 'daily'], now, undefined, metric);
  assert.equal(view.resolution, 'daily'); assert.equal(view.end, end);
});

test('empty and newly created archives produce finite bounded windows', () => {
  for (const coverage of [null, { start: now - 900000, first: now - 300000, last: now - 300000 }]) {
    const view = chart.navigationWindow(now - 500 * DAY, now, ['10m'], now, '10m', { coverage: { '10m': coverage } });
    assert.ok(Number.isFinite(view.hours) && view.hours > 0);
    if (coverage) assert.ok(view.start >= coverage.start);
    assert.ok(view.end <= now);
  }
});

test('all history includes exactly the available native periods even for fractional-hour archives', () => {
  const last = Date.parse('2026-10-22T00:10:00Z');
  for (const periods of [1, 5, 7, 25]) {
    const coverage = { start: last - periods * 600000, first: last - (periods - 1) * 600000, last };
    const metric = { coverage: { '10m': coverage } };
    const client = chart.navigationWindow(coverage.start, last, ['10m'], now, '10m', metric);
    const server = chart.navigationWindow(last - Math.ceil(client.hours) * HOUR, last, ['10m'], now, '10m', metric);
    assert.equal(client.start, coverage.start); assert.equal(client.end, last);
    assert.equal(server.start, coverage.start); assert.equal(server.end, last);
  }
});
