'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { WeatherStore } = require('../lib/weather-store');
const { HistoryReader, normalizeRequest, METRICS } = require('../lib/weather-history');
const chart = require('../public/history-chart');
const layout = require('../config/station-layout.json');
const HOUR = 3600000, end = Date.parse('2026-09-30T00:00:00Z'), start = end - 720 * HOUR;

test('30 days of native rain are queryable at ten-minute detail without raising other metric limits', () => {
  assert.equal(normalizeRequest({ metric: 'rain', resolution: '10m', hours: '720' }, false, end).hours, 720);
  for (const query of [{ metric: 'rain', hours: '721' }, { metric: 'air', hours: '169' }, { metric: 'soil-temp-10', hours: '720' }]) {
    assert.throws(() => normalizeRequest(query, false, end), /too large/);
  }
  const view = chart.navigationWindow(start, end, ['10m', 'hourly'], end, '10m', METRICS.rain);
  assert.equal(view.resolution, '10m'); assert.equal(view.hours, 720);
});

test('30-day rain comparison retains exact bounds and totals across all 4320 native readings', t => {
  const store = new WeatherStore(':memory:'); t.after(() => store.close());
  for (const [stream, step, value] of [['mem3', HOUR / 6, .2], ['mem2', HOUR, 1.2]]) {
    const lines = [];
    for (let time = start + step; time <= end; time += step) {
      const wall = new Date(time + 10 * HOUR).toISOString();
      lines.push([wall.slice(0, 10).replaceAll('-', '/'), wall.slice(11, 19),
        ...layout.streams[stream].fields.map(f => f.sensorKey === '5' ? value : f.sensorKey === '7' ? 1020 : 0)].join(','));
    }
    const imported = store.importBuffer(Buffer.from(lines.join('\n')), { stream, name: 'rain-month-' + stream,
      format: 'logger', verifiedSerial: layout.station.serial });
    assert.equal(imported.rejected, 0); assert.equal(imported.inserted, 720 * HOUR / step);
  }
  const reader = new HistoryReader(store.db);
  const query = resolution => reader.query(normalizeRequest({ metric: 'rain', resolution, hours: '720', end: new Date(end).toISOString() }, false, end)).series[0];
  const fine = query('10m'), hourly = query('hourly');
  assert.equal(fine.start, start); assert.equal(fine.end, end);
  assert.equal(hourly.start, start); assert.equal(hourly.end, end);
  assert.equal(fine.points.length, 4320); assert.equal(hourly.points.length, 720);
  assert.equal(fine.missing, 0); assert.equal(hourly.missing, 0);
  assert.ok(Math.abs(chart.summary(fine)[0][1] - 864) < 1e-8);
  assert.ok(Math.abs(chart.summary(hourly)[0][1] - chart.summary(fine)[0][1]) < 1e-8);
  for (const resolution of ['hourly', '10m']) {
    const view = chart.rainfallComparisonWindow(start, end, resolution, fine.metric, end + 35 * 60000);
    assert.equal(view.start, start); assert.equal(view.end, end); assert.equal(view.hours, 720);
  }
  // A missing native reading must remain a gap and make the sum incomplete.
  const id = store.db.prepare("SELECT id FROM records WHERE stream='mem3' AND observed_at=?").get(new Date(start + HOUR).toISOString()).id;
  store.db.prepare('DELETE FROM observations WHERE record_id=?').run(id);
  const incomplete = query('10m');
  assert.equal(incomplete.missing, 1);
  assert.equal(chart.summary(incomplete)[0][0], 'Recorded rainfall (incomplete)');
  assert.ok(Math.abs(chart.summary(incomplete)[0][1] - 863.8) < 1e-8);
});

test('comparison aligns partial hours and respects the earliest available native period', () => {
  const view = chart.rainfallComparisonWindow(start + 20 * 60000, end + 20 * 60000, 'hourly', METRICS.rain, end + HOUR);
  assert.equal(view.start, start); assert.equal(view.end, end);
  const metric = { ...METRICS.rain, coverage: { '10m': { start: end - 2 * HOUR, first: end - 2 * HOUR + HOUR / 6, last: end } } };
  const bounded = chart.rainfallComparisonWindow(start, end, '10m', metric, end);
  assert.equal(bounded.start, metric.coverage['10m'].start);
  assert.equal(bounded.end, end); assert.equal(bounded.hours, 2);
});
