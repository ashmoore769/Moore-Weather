'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WeatherStore } = require('../lib/weather-store');
const { HistoryReader } = require('../lib/weather-history');
const baseline = require('../config/station-layout.json');
const policy = require('../config/data-quality.json');
const cutover = require('./fixtures/layout-cutover');
const HOUR = 3600000;
// All changeover times and observations in this regression are fictional.
const TRANSITION = Date.parse(cutover.firstNewObservedAt), FIRST = Date.parse(cutover.firstCompleteObservedAt);
const OLD = TRANSITION - 600000, NEXT = FIRST + 600000;
const NOW = NEXT + 600000;

function fixture(t) {
  t.mock.method(Date, 'now', () => NOW);
  const store = new WeatherStore(':memory:', baseline, { layoutCutover:cutover });
  store.setQualityPolicy({ ...policy, earliestLocalTimestamp:'2025-04-01T00:00:00' });
  t.after(() => store.close());
  return store;
}
function insert(store, stream, at, overrides = {}) {
  // Slot77 keeps its position on the wire. Its meaning is selected by timestamp
  // inside WeatherStore, so the same helper also creates the historical rows.
  const local = new Date(at + 10 * HOUR).toISOString();
  const values = baseline.streams[stream].fields.map(field =>
    stream === 'mem3' && field.storageId === 77 ? overrides.slot77 ?? 20 :
      overrides[field.sensorKey] ?? (field.sensorKey === '7' ? 1015 : 20));
  const result = store.ingestLive(stream,
    [local.slice(0, 10).replaceAll('-', '/'), local.slice(11, 19), ...values].join(','), new Date(NOW).toISOString());
  assert.equal(result.rejected, 0);
  return result;
}
function seedOlderGlobe(store) {
  const hourly = Math.floor(OLD / HOUR) * HOUR;
  const daily = Math.floor((OLD - 23 * HOUR) / (24 * HOUR)) * 24 * HOUR + 23 * HOUR;
  insert(store, 'mem2', hourly, { '58':27.4 });
  insert(store, 'mem1', daily, { '58':22.8 });
}
function globePreview(reader) {
  return reader.query({ trends:true, daily:false, end:NOW }).series.find(series => series.metric.id === 'globe');
}
function globeCoverage(reader) {
  return reader.availableCatalog(NOW).find(metric => metric.id === 'globe').coverage['10m'];
}

test('old slot77 wind and the first partial globe interval never advertise ten-minute temperature coverage', t => {
  const store = fixture(t);
  seedOlderGlobe(store);
  insert(store, 'mem3', OLD, { slot77:21.6, '4':19.2 });
  insert(store, 'mem3', TRANSITION, { slot77:24.1, '4':19.8 });
  const reader = new HistoryReader(store.db);
  assert.equal(globeCoverage(reader), null);
  const preview = globePreview(reader);
  assert.equal(preview.resolution, 'hourly');
  assert.equal(preview.latest.value, 27.4);
  assert.ok(reader.series(['globe'], '10m', 1, TRANSITION)[0].points.every(point => point.value === null));
  assert.equal(reader.series(['air'], '10m', 1, TRANSITION)[0].latest.value, 19.8, 'the other transition-period sensors remain available');

  const historical = store.db.prepare("SELECT sensor_key,aggregation,unit,value FROM weather_readings_raw WHERE stream='mem3' AND observed_at=? AND aggregation='S-THETA'").get(new Date(OLD).toISOString());
  assert.deepEqual({ ...historical }, { sensor_key:'2', aggregation:'S-THETA', unit:'Degs', value:21.6 });
  const partial = store.db.prepare("SELECT value,exclusion_reason FROM weather_readings_review WHERE stream='mem3' AND observed_at=? AND sensor_key='58'").get(new Date(TRANSITION).toISOString());
  assert.equal(partial.value, 24.1, 'the partial native value is retained for review');
  assert.notEqual(partial.exclusion_reason, null);
});

test('the first complete native globe row switches Current to ten-minute history without changing older hourly or daily data', t => {
  const store = fixture(t);
  seedOlderGlobe(store);
  insert(store, 'mem3', OLD, { slot77:21.6 });
  insert(store, 'mem3', TRANSITION, { slot77:24.1 });
  const reader = new HistoryReader(store.db);
  assert.equal(globePreview(reader).resolution, 'hourly');

  insert(store, 'mem3', FIRST, { slot77:24.7 });
  insert(store, 'mem3', NEXT, { slot77:25.1 });
  assert.deepEqual(globeCoverage(reader), { first:FIRST, last:NEXT, start:TRANSITION });
  const preview = globePreview(reader);
  assert.equal(preview.resolution, '10m');
  assert.deepEqual(preview.points.filter(point => point.value !== null).map(point => [point.t, point.value]), [[FIRST,24.7],[NEXT,25.1]]);
  assert.equal(preview.start, NOW - 24 * HOUR);
  assert.ok(preview.points.filter(point => point.t < FIRST).every(point => point.value === null));
  assert.deepEqual(preview.metric.resolutions, ['10m','hourly','daily']);

  const olderHourly = reader.query({ metric:'globe', resolution:'hourly', hours:24, end:OLD }).series[0];
  assert.equal(olderHourly.latest.value, 27.4);
  const daily = reader.query({ trends:true, daily:true, end:NOW }).series.find(series => series.metric.id === 'globe');
  assert.equal(daily.resolution, 'daily');
  assert.equal(daily.latest.value, 22.8);
  const beforeAvailable = reader.query({ metric:'globe', resolution:'10m', hours:24, end:OLD }).series[0];
  assert.ok(beforeAvailable.start >= TRANSITION, 'the API bounds exploration to the native globe archive');
  assert.ok(beforeAvailable.points.every(point => point.t >= FIRST));
});

test('invalid and conflicting ten-minute globe rows keep the hourly fallback until a usable native row arrives', async t => {
  for (const kind of ['non-numeric', 'screened-outlier', 'conflicting']) {
    await t.test(kind, t => {
      const store = fixture(t);
      seedOlderGlobe(store);
      insert(store, 'mem3', TRANSITION, { slot77:24.1 });
      if (kind === 'non-numeric') insert(store, 'mem3', FIRST, { slot77:'NaN' });
      if (kind === 'screened-outlier') insert(store, 'mem3', FIRST, { slot77:-100 });
      if (kind === 'conflicting') {
        insert(store, 'mem3', FIRST, { slot77:25.1 });
        insert(store, 'mem3', FIRST, { slot77:26.2 });
      }
      const reader = new HistoryReader(store.db);
      assert.equal(globeCoverage(reader), null);
      assert.equal(globePreview(reader).resolution, 'hourly');
      assert.equal(globePreview(reader).latest.value, 27.4);

      insert(store, 'mem3', NEXT, { slot77:26.8 });
      assert.deepEqual(globeCoverage(reader), { first:NEXT, last:NEXT, start:FIRST });
      const preview = globePreview(reader);
      assert.equal(preview.resolution, '10m');
      assert.equal(preview.points.find(point => point.t === FIRST).value, null);
      assert.equal(preview.latest.value, 26.8);
    });
  }
});

test('an empty newly declared ten-minute feed does not fabricate samples or displace existing daily metadata', t => {
  const store = fixture(t), reader = new HistoryReader(store.db);
  const preview = globePreview(reader);
  assert.equal(preview.resolution, '10m');
  assert.equal(preview.latest, null);
  assert.ok(preview.points.every(point => point.value === null));
  assert.deepEqual(preview.metric.coverage, { '10m':null, hourly:null, daily:null });
});
