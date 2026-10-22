'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WaterStore } = require('../lib/water-store');
const { WaterCollector, nextHour } = require('../lib/water-collector');
const { WaterReader } = require('../lib/water-history');
const { damDaily, damCurrent, riverTrace, hydstraTime, hydstraStamp, METRICS, DAY, HOUR } = require('../lib/water-data');
const { normalizeRequest } = require('../lib/weather-history');
const { createWaterClient, jsonRequest } = require('../lib/water-client');
const chart = require('../public/history-chart');
const end = Date.parse('2026-10-22T12:00:00Z');
const daily = (date = '1986-01-01', min = 29, max = 30) => ({ station: '422315B', date: date + 'T00:00:00+10:00', minPercentageFull: min, maxPercentageFull: max, averagePercentageFull: 0 });
function trace(points, metric = 'condamine-level') {
  return { error_num: 0, return: { traces: [{ error_num: 0, compressed: '0', site: '422310C', site_details: { timezone: '10.0' },
    varto_details: { variable: metric === 'condamine-level' ? '100.00' : '140.00' }, quality_codes: { 9: 'Historic observed', 130: 'Unvalidated', 255: 'Missing' }, trace: points }] } };
}
function fixture(t) { const store = new WaterStore(':memory:'); t.after(() => store.close()); return store; }

test('water dates preserve Brisbane time before 1970; invalid dates and wrong stations are rejected', () => {
  assert.equal(new Date(hydstraTime('19601001120000')).toISOString(), '1960-10-01T02:00:00.000Z');
  assert.equal(hydstraStamp(hydstraTime('19601001120000')), '19601001120000');
  assert.throws(() => hydstraTime('19600230120000'));
  assert.throws(() => damCurrent({ station: 'other', date: '2026-10-22T00:00:00+10:00' }));
  assert.throws(() => damDaily({ value: [{ ...daily(), date: '1986-01-01' }] }));
  assert.throws(() => riverTrace(trace([]), 'condamine-flow'));
});

test('Sunwater daily min/max never uses its placeholder average or invents historical ML', t => {
  const store = fixture(t), rows = damDaily({ value: [daily()] });
  store.save(rows); store.save(rows);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM water_samples').get().n, 1);
  const result = new WaterReader(store.db).series({ metric: 'leslie-storage', resolution: 'daily', hours: 24, end: rows[0].t });
  assert.deepEqual(result.points.map(p => [p.value, p.min, p.max]), [[30, 29, 30]]);
  assert.equal(result.points[0].t, Date.parse('1986-01-01T14:00:00Z'));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM water_samples WHERE metric='leslie-volume'").get().n, 0);
  const current = damCurrent({ station: '422315B', date: '1986-01-01T10:00:00+10:00', percentageFull: 31, megaLitres: 33000, totalCapacityMegaLitres: 106000 });
  store.save(current);
  assert.equal(new WaterReader(store.db).series({ metric: 'leslie-storage', resolution: 'daily', hours: 24, end: rows[0].t }).latest.value, 30);
  assert.equal(new WaterReader(store.db).snapshot().readings['leslie-volume'].capacity, 106000);
});

test('native river observations, gaps and source revisions survive idempotent imports and rollups', t => {
  const store = fixture(t);
  const readings = [{ t: 19601001121000, v: '-0.05', q: 9 }, { t: 19601001122000, v: '0.3', q: 9 }, { t: 19601001123000, v: '0.2', q: 130 }, { t: 19601001140000, v: '0', q: 255 }];
  const rows = riverTrace(trace(readings), 'condamine-level');
  store.save(rows); store.save(rows);
  const request = { metric: 'condamine-level', resolution: 'hourly', hours: 3, end: hydstraTime('19601001150000') };
  let result = new WaterReader(store.db).series(request);
  assert.deepEqual(result.points.map(p => p.value), [.2, null, null]);
  assert.equal(result.points[0].min, -.05); assert.equal(result.points[0].max, .3);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM water_samples').get().n, 4);
  assert.match(result.points[0].quality, /130/);
  assert.equal(JSON.parse(store.db.prepare('SELECT raw_json FROM water_samples WHERE quality=255').get().raw_json).v, '0');
  store.save(riverTrace(trace([{ t: 19601001123000, v: '0.25', q: 9 }]), 'condamine-level'));
  result = new WaterReader(store.db).series(request);
  assert.equal(result.points[0].value, .25);
  assert.equal(chart.summary(result)[1][0], 'Lowest river level');
});

test('wide water graphs bound point counts while retaining extrema; weather bounds remain intact', t => {
  const store = fixture(t), values = [];
  const first = Date.parse('1986-01-01T00:00:00Z');
  for (let i = 0; i < 2000; i++) values.push(daily(new Date(first + i * DAY).toISOString().slice(0, 10), i === 5 ? 1 : 20, i === 6 ? 95 : 30));
  store.save(damDaily({ value: values }));
  const request = normalizeRequest({ metric: 'leslie-storage', resolution: 'daily', hours: '400000' }, false, end);
  const result = new WaterReader(store.db).series(request);
  assert.ok(result.points.length <= 1500); assert.equal(Math.min(...result.points.filter(p => p.value !== null).map(p => p.min)), 1);
  assert.equal(Math.max(...result.points.filter(p => p.value !== null).map(p => p.max)), 95);
  assert.throws(() => normalizeRequest({ metric: 'air', resolution: 'daily', hours: '400000' }), /large/);
  assert.throws(() => normalizeRequest({ metric: 'leslie-storage', resolution: '10m' }), /Unsupported/);
  const nav = chart.navigationWindow(first, end, ['hourly', 'daily'], end, undefined, METRICS['leslie-storage']);
  assert.ok(nav.start < Date.UTC(1987, 0, 1)); assert.equal(new Date(nav.end).getUTCHours(), 14);
});

test('water page and cursor commit atomically and retry without skipping a failed page', async t => {
  const store = fixture(t);
  for (const job of new WaterCollector(store, {}).jobs()) if (job !== 'leslie-daily') store.setState(job, { complete: true, earliest: end - DAY });
  let calls = 0, fail = false;
  const client = { daily: async (_start, _end, token) => {
    calls++; if (fail) throw new Error('HTTP 503');
    return token ? { value: [], continuationToken: token } : { value: [daily()], continuationToken: 'opaque cursor' };
  } };
  const collector = new WaterCollector(store, client);
  await collector.step(end);
  assert.equal(store.state('leslie-daily').token, 'opaque cursor');
  fail = true; await collector.step(end + 30000);
  assert.equal(store.state('leslie-daily').token, 'opaque cursor');
  assert.match(store.state('leslie-daily').error, /503/);
  fail = false; await new WaterCollector(store, client).step(end + HOUR);
  assert.equal(store.state('leslie-daily').archiveComplete, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM water_samples').get().n, 1);
  assert.equal(calls, 3);
  assert.throws(() => store.save([{ ...damDaily({ value: [daily()] })[0], metric: null }], 'bad', { complete: true }));
  assert.equal(store.state('bad'), null);
});

test('backfill fairly serves both river metrics and resumes cursor after restart', async t => {
  const store = fixture(t), calls = [];
  store.setState('river-extent', { complete: true, earliest: end - 90 * DAY });
  const collector = new WaterCollector(store, { trace: async (metric, start, finish) => { calls.push({ metric, start, finish }); return trace([], metric); } });
  for (const job of collector.jobs()) if (!job.endsWith('-backfill') && job !== 'river-extent') store.setState(job, { complete: true });
  await collector.step(end); await collector.step(end + 30000);
  assert.deepEqual(calls.map(c => c.metric), ['condamine-level', 'condamine-flow']);
  const previous = store.state('condamine-level-backfill').cursor;
  await new WaterCollector(store, collector.client).step(end + 60000);
  assert.equal(calls[2].finish, previous);
  assert.equal(nextHour(Date.parse('2026-10-22T12:15:00Z')), Date.parse('2026-10-22T12:30:00Z'));
});

test('provider errors and oversized responses fail closed; request contracts use ATQ for flow', async () => {
  const requests = [], client = createWaterClient(async (url, options) => { requests.push({ url, options }); return {}; });
  await client.trace('condamine-flow', end - DAY, end); await client.daily(end - DAY, end, 'opaque');
  const query = JSON.parse(decodeURIComponent(requests[0].url.split('?')[1]));
  assert.equal(query.params.datasource, 'ATQ'); assert.equal(query.params.data_type, 'point');
  assert.equal(JSON.parse(requests[1].options.body).continuationToken, 'opaque');
  await assert.rejects(jsonRequest('https://test.invalid', {}, async () => ({ ok: false, status: 429 })), /429/);
  await assert.rejects(jsonRequest('https://test.invalid', {}, async () => ({ ok: true, body: [Buffer.alloc(25 * 1024 * 1024)] })), error => error.code === 'BATCH_SIZE');
});
