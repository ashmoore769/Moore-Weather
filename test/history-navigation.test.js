'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chart = require('../public/history-chart');
const { normalizeRequest } = require('../lib/weather-history');
const HOUR = 3600000;
const now = Date.parse('2026-10-22T00:15:00Z');
const supported = ['10m', 'hourly', 'daily'];
function series(values, metric = { id: 'rain', aggregation: 'TOTAL', kind: 'bar' }) {
  const points = values.map((value, i) => ({ t: now - (values.length - i) * HOUR, value, min: null, max: null, estimated: false }));
  return { metric, points, latest: points.filter(p => p.value !== null).at(-1), missing: values.filter(v => v === null).length, resolution: 'hourly', intervalSeconds: 3600 };
}

test('rainfall sums recorded totals, includes dry readings, and distinguishes gaps from zero', () => {
  assert.equal(chart.summary(series([.2, 0, .6]))[0][1], .8);
  assert.deepEqual(chart.summary(series([0, 0]))[0], ['Total rainfall', 0]);
  assert.deepEqual(chart.summary(series([null, null]))[0], ['Recorded rainfall (incomplete)', null]);
  const partial = series([.2, null, 4]); partial.points[2].estimated = true;
  assert.deepEqual(chart.summary(partial)[0], ['Recorded rainfall (incomplete)', .2]);
  assert.equal(chart.summary(series([1, 2]))[2][0], 'Lowest hourly rainfall');
});
test('temperature and wind labels distinguish recorded extremes from native averages without mixing them', () => {
  const s = series([12, 22], { id: 'air', aggregation: 'AVERAGE' });
  assert.equal(chart.summary(s)[1][0], 'Lowest hourly average');
  s.points[0].min = 8; s.points[0].max = 15; s.points[1].max = 26;
  assert.deepEqual(chart.summary(s)[1].slice(0, 2), ['Lowest temperature', 8]);
  assert.deepEqual(chart.summary(s)[2].slice(0, 2), ['Highest temperature', 26]);
  s.metric.id = 'wind'; s.points[0].min = null;
  assert.equal(chart.summary(s)[1][0], 'Lowest hourly average');
  assert.deepEqual(chart.summary(s)[2], ['Highest wind speed', 26]);
  s.metric = { id: 'direction', kind: 'direction' };
  assert.equal(chart.summary(s)[1][0], 'Available readings');
});
test('temperature dates belong to the winning native statistic, not the lowest or highest average', () => {
  const s = series([10, 20, 30], { id: 'air', aggregation: 'AVERAGE' });
  assert.equal(chart.summary(s)[1][3].t, s.points[0].t);
  assert.equal(chart.summary(s)[2][3].t, s.points[2].t);
  s.points[0].max = 40;
  s.points[1].min = -2;
  s.points[2].min = 1;
  s.points[2].max = 35;
  assert.equal(chart.summary(s)[1][3].t, s.points[1].t);
  assert.equal(chart.summary(s)[2][3].t, s.points[0].t);
});
test('tied temperature extrema use the earliest period, with no date for missing readings', () => {
  const s = series([5, null, 5], { id: 'air', aggregation: 'AVERAGE' });
  const earliest = s.points[0].t;
  s.points.reverse();
  assert.equal(chart.summary(s)[1][3].t, earliest);
  assert.equal(chart.summary(s)[2][3].t, earliest);
  const empty = series([null, null], s.metric);
  assert.equal(chart.summary(empty)[1][3], undefined);
  assert.equal(chart.summary(empty)[2][3], undefined);
});
test('daily temperature dates retain the 9 AM recording boundary, including estimated flags', () => {
  const s = series([12, 22], { id: 'globe', aggregation: 'AVERAGE' });
  s.resolution = 'daily'; s.intervalSeconds = 86400;
  s.points[0].t = Date.parse('2026-10-20T23:00:00Z');
  s.points[1].t = Date.parse('2026-10-21T23:00:00Z');
  s.points[0].estimated = true;
  assert.deepEqual(chart.summary(s)[1][3], { t: s.points[0].t, estimated: true });
  assert.deepEqual(chart.summary(s)[2][3], { t: s.points[1].t, estimated: false });
  for (const id of ['ground', 'dew', 'soil-temp-10', 'soil-temp-40']) {
    s.metric.id = id;
    assert.equal(chart.summary(s)[1][3].t, s.points[0].t);
  }
});
test('temperature extrema dates follow the selected visible window', () => {
  const s = series([1, 2, 3, 40], { id: 'air', aggregation: 'AVERAGE' });
  const visible = chart.visibleSeries(s, s.points[0].t, s.points[2].t);
  assert.equal(chart.summary(visible)[1][3].t, s.points[1].t);
  assert.equal(chart.summary(visible)[2][3].t, s.points[2].t);
});
test('visible totals and fitted trends only use readings in the displayed window', () => {
  const s = series([1, 2, 3, 40]);
  const visible = chart.visibleSeries(s, s.points[0].t, s.points[2].t);
  assert.equal(chart.summary(visible)[0][1], 5);
  assert.equal(visible.latest.value, 3);
  assert.equal(visible.missing, 0);
  assert.deepEqual(chart.fittedTrend(visible), []);
  const incomplete = chart.visibleSeries(s, s.points[0].t - 2 * HOUR, s.points[2].t);
  assert.equal(incomplete.missing, 1);
});
test('zoom selects supported detail, pan preserves resolution and daily totals keep 9 AM boundaries', () => {
  assert.equal(chart.navigationWindow(now - 24 * HOUR, now, supported, now).resolution, '10m');
  assert.equal(chart.navigationWindow(now - 360 * HOUR, now, supported, now).resolution, 'hourly');
  const daily = chart.navigationWindow(now - 2160 * HOUR, now, supported, now);
  assert.equal(daily.resolution, 'daily');
  assert.equal(new Date(daily.end).getUTCHours(), 23);
  assert.equal(daily.hours % 24, 0);
  assert.equal(chart.navigationWindow(now - 720 * HOUR, now, supported, now, 'daily').resolution, 'daily');
  assert.equal(chart.navigationWindow(now - HOUR, now, ['hourly', 'daily'], now).resolution, 'hourly');
  assert.equal(chart.navigationWindow(now - HOUR, now, ['daily'], now).hours, 24);
});
test('navigation never exceeds query bounds, minimum detail or the newest completed reading', () => {
  for (const available of [supported, ['hourly'], ['daily'], ['10m']]) {
    for (const hours of [.0001, 1, 5, 167.9, 168.1, 744, 744.1, 17520, 1e6]) {
      for (const shift of [-1e8, 0, 100]) {
        const end = now + shift * HOUR;
        const view = chart.navigationWindow(end - hours * HOUR, end, available, now);
        assert.ok(view.end <= now);
        assert.equal(view.end - view.start, view.hours * HOUR);
        assert.ok(available.includes(view.resolution));
        assert.doesNotThrow(() => normalizeRequest({ metric: 'rain', resolution: view.resolution, hours: String(view.hours), end: new Date(view.end).toISOString() }, false, now));
      }
    }
  }
});
