'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { connollyReport, CONNOLLY_URL } = require('../lib/water-connolly');
const { createWaterClient } = require('../lib/water-client');
const { WaterStore } = require('../lib/water-store');
const { WaterReader } = require('../lib/water-history');
const { WaterCollector } = require('../lib/water-collector');
const { normalizeRequest } = require('../lib/weather-history');
const { DAY, HOUR } = require('../lib/water-data');
const html = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/connolly-report.html'), 'utf8');
const now = Date.parse('2026-10-26T12:00:00Z'), published = Date.parse('2026-10-26T00:00:00+10:00');
function setup(t) { const s = new WaterStore(':memory:'); t.after(() => s.close()); return s; }
test('Connolly parser selects its own column across merged headings and retains report date and provenance', () => {
  const parsed = connollyReport(html, now);
  assert.equal(parsed.reportDate, '2026-10-26');
  assert.deepEqual(parsed.rows.map(r => [r.metric, r.t, r.value]), [['connolly-storage', published, 100], ['connolly-volume', published, 2166]]);
  const raw = JSON.parse(parsed.rows[0].raw);
  assert.equal(raw.source, CONNOLLY_URL); assert.equal(raw.totalCapacityMegaLitres, 2166);
  assert.ok(raw.table.includes('Connolly Dam')); assert.match(parsed.rows[0].qualityText, /date only/);
  const reordered = html.replaceAll('<th>Leslie Dam</th><th><strong>Connolly Dam</strong></th>', '<th><strong>Connolly Dam</strong></th><th>Leslie Dam</th>')
    .replace('<td>65.2%</td><td>100.0%</td>', '<td>100.0%</td><td>65.2%</td>')
    .replace('<td>69,233</td><td>2,166</td>', '<td>2,166</td><td>69,233</td>')
    .replace('<td>106,250</td><td>2,166&nbsp;</td>', '<td>2,166&nbsp;</td><td>106,250</td>');
  assert.deepEqual(connollyReport(reordered, now).rows.map(r => r.value), [100, 2166]);
});
test('missing dates, placeholders, malformed layouts and inconsistent storage fail closed', () => {
  for (const broken of [
    html.replace('Last Updated:', 'Last checked:'),
    html.replace('26/10/2026', '31/02/2026'),
    html.replace('26/10/2026', '27/10/2026'),
    html.replace('100.0%', '-'),
    html.replace('100.0%', '20%'),
    html.replace('2,166</td>', '2,16</td>'),
    html.replaceAll('Connolly Dam', 'Other Dam'),
    html + html,
    '<html>Maintenance</html>'
  ]) assert.throws(() => connollyReport(broken, now));
  const empty = html.replace('100.0%', '0.0%').replace('2,166</td>', '0</td>');
  assert.equal(connollyReport(empty, now).rows[0].value, 0);
});
test('repeated reports do not manufacture samples; corrections and later reports persist independently', t => {
  const store = setup(t), parsed = connollyReport(html, now);
  store.save(parsed.rows); store.save(connollyReport(html, now + 6 * HOUR).rows);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM water_samples').get().n, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM water_buckets WHERE resolution='hourly'").get().n, 0);
  const corrected = html.replace('100.0%', '99.5%').replace('2,166</td>', '2,155</td>');
  store.save(connollyReport(corrected, now).rows);
  const old = html.replace('26/10/2026', '19/10/2026').replace('100.0%', '71.9%').replace('2,166</td>', '1,558</td>');
  store.save(connollyReport(old, now).rows);
  const reader = new WaterReader(store.db);
  const series = reader.series({ metric: 'connolly-storage', resolution: 'daily', hours: 720, end: now });
  assert.deepEqual(series.points.map(p => p.value), [71.9, 99.5]);
  assert.equal(series.missing, 0); assert.equal(series.points.length, 2);
  assert.equal(series.extrema.max.dateOnly, true); assert.equal(series.extrema.max.t, published);
  assert.equal(series.latest.observedAt, published);
  assert.equal(series.metric.reporting, 'published'); assert.match(series.note, /no measurements are inferred/);
  const snapshot = reader.snapshot();
  assert.equal(snapshot.readings['connolly-volume'].capacity, 2166);
  assert.equal(snapshot.readings['connolly-volume'].value, 2155);
  assert.deepEqual(reader.catalog(now).find(m => m.id === 'connolly-storage').resolutions, ['daily']);
  assert.throws(() => normalizeRequest({ metric: 'connolly-storage', resolution: 'hourly' }, false, now), /Unsupported/);
});
test('Connolly collector survives restart, retries without losing data and rejects older cached reports', async t => {
  const store = setup(t); let fail = false, body = html, calls = 0;
  const client = { connolly: async () => { calls++; if (fail) throw new Error('HTTP 503'); return body; } };
  const collector = new WaterCollector(store, client);
  for (const job of collector.jobs()) if (job !== 'connolly-current') store.setState(job, { complete: true });
  assert.equal((await collector.step(now)).rows, 2);
  assert.equal(store.state('connolly-current').due, now + 6 * HOUR);
  assert.equal(await collector.step(now + HOUR), null);
  fail = true; await new WaterCollector(store, client).step(now + 6 * HOUR);
  assert.match(store.state('connolly-current').error, /503/);
  assert.equal(new WaterReader(store.db).snapshot().readings['connolly-storage'].value, 100);
  fail = false; await collector.step(now + 7 * HOUR);
  assert.equal(store.state('connolly-current').error, null);
  body = html.replace('26/10/2026', '19/10/2026');
  assert.match((await collector.step(now + 13 * HOUR)).error, /older report/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM water_samples').get().n, 2);
  assert.equal(calls, 4);
});
test('Connolly client uses the fixed official council page', async () => {
  const urls = [], client = createWaterClient(undefined, async url => { urls.push(url); return html; });
  assert.equal(await client.connolly(), html);
  assert.deepEqual(urls, [CONNOLLY_URL]);
});
