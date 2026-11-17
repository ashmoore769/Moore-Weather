'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { configuration, validateBatch, createYardPowerService,
  mountYardPowerIngest, mountYardPowerRead } = require('../lib/yard-power');
const { readingPresentation } = require('../public/yard-power');

const TOKEN = 'yard-power-collector-is-independent-of-fronius-123456';
const NOW = Date.parse('2026-11-17T06:00:00.000Z');
const SAMPLE = {
  observedAt: '2026-11-17T05:59:00.000Z',
  collectedAt: '2026-11-17T05:59:01.000Z',
  batteryVoltageV: 13.83,
  pvVoltageV: 19.90,
  pvPowerW: 3.04,
  chargeCurrentA: .22,
  controllerLoadPowerW: 1.38,
  controllerTempC: 37.52,
  pvCurrentA: .15,
  controllerLoadCurrentA: .10,
  chargingPowerW: 3.04
};

async function fixture(t, envOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yard-power-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'weather.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES (\'safe\')');
  db.close();
  const env = { WEATHER_DB_PATH: filename, YARD_POWER_INGEST_TOKEN: TOKEN, ...envOverrides };
  const service = createYardPowerService({ env, now: () => NOW, isReady: () => true, logger: { warn() {} } });
  t.after(() => service.close());
  const app = express();
  mountYardPowerIngest(app, { env, getService: () => service, now: () => NOW });
  app.use((_req, res, next) => next());
  mountYardPowerRead(app, { getService: () => service });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (samples = [SAMPLE], headers = {}) => fetch(origin + '/internal/yard-power/ingest', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ version: 1, samples })
  });
  const get = (query = '') => fetch(origin + '/api/yard-power' + query);
  return { post, get, service, filename };
}

test('feature remains disabled until a dedicated token and database are configured', async t => {
  assert.equal(configuration({ WEATHER_DB_PATH: '/tmp/a', YARD_POWER_INGEST_TOKEN: 'short' }).enabled, false);
  assert.equal(configuration({ YARD_POWER_INGEST_TOKEN: TOKEN }).enabled, false);
  const f = await fixture(t, { YARD_POWER_INGEST_TOKEN: '' });
  assert.equal((await f.post()).status, 404);
  const body = await (await f.get()).json();
  assert.equal(body.enabled, false);
  assert.equal(body.current, null);
});

test('rejects wrong token and browser-based ingestion before accepting a body', async t => {
  const f = await fixture(t);
  assert.equal((await f.post([SAMPLE], { Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await f.post([SAMPLE], { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.post()).status, 200);
  assert.deepEqual(await (await f.post()).json(), { accepted: 0, duplicates: 1 });
});

test('strict measurement schema rejects missing, extra, invalid and out-of-range fields', () => {
  assert.equal(validateBatch({ version: 1, samples: [SAMPLE] }, NOW).length, 1);
  for (const invalid of [
    { ...SAMPLE, batteryVoltageV: -1 },
    { ...SAMPLE, pvVoltageV: Infinity },
    { ...SAMPLE, controllerTempC: 130 },
    { ...SAMPLE, extra: 1 },
    { ...SAMPLE, batteryVoltageV: '13.8' },
    { ...SAMPLE, observedAt: '2020-01-01T00:00:00.000Z' },
    { ...SAMPLE, observedAt: '2026-11-17T05:59:00+00:00' }
  ]) assert.throws(() => validateBatch({ version: 1, samples: [invalid] }, NOW));
});

test('data persists separately, preserves existing table, and remains stale without a fresh sample', async t => {
  const f = await fixture(t);
  assert.equal((await f.post()).status, 200);
  const view = await (await f.get('?range=24h')).json();
  assert.equal(view.enabled, true);
  assert.equal(view.status, 'fresh');
  assert.equal(view.current.batteryVoltageV, 13.83);
  assert.equal(view.current.controllerLoadPowerW, 1.38);
  assert.equal(view.history.length, 1);
  assert.equal((await f.get('?range=invalid')).status, 400);
  const db = new DatabaseSync(f.filename);
  assert.equal(db.prepare('SELECT value FROM sentinel').get().value, 'safe');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM yard_power_samples').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='solar_samples'").get().count, 0);
  db.close();
  const later = createYardPowerService({ env: { WEATHER_DB_PATH: f.filename, YARD_POWER_INGEST_TOKEN: TOKEN },
    isReady: () => true, now: () => NOW + 7 * 60000, logger: { warn() {} } });
  assert.equal(later.snapshot().status, 'stale');
  assert.equal(later.snapshot().current.batteryVoltageV, 13.83);
  later.close();
});

test('dashboard markup includes six metrics below station power and loaded assets', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const station = html.indexOf('id="stationPower"');
  const yard = html.indexOf('id="yardPower"');
  assert.ok(station !== -1 && yard > station, 'yard card must follow station power');
  assert.equal((html.match(/class="yard-power-metric"/g) || []).length, 6);
  assert.match(html, /yard-power\.css/);
  assert.match(html, /yard-power\.js/);
});

test('Yard battery emphasis uses the raw 12.9V boundary and keeps invalid values neutral', () => {
  for (const [voltage, text, color] of [
    [12.899, '12.90', 'var(--amber)'],
    [12.9, '12.90', 'var(--battery-good)'],
    [13.1, '13.10', 'var(--battery-good)'],
    [0, '0.00', 'var(--amber)']
  ]) {
    const reading = readingPresentation({ ...SAMPLE, batteryVoltageV: voltage }).yardBatteryV;
    assert.deepEqual([reading.text, reading.color], [text, color], 'voltage ' + voltage);
  }
  for (const voltage of [null, undefined, NaN, Infinity, -1, 101, '12.9']) {
    const reading = readingPresentation({ ...SAMPLE, batteryVoltageV: voltage }).yardBatteryV;
    assert.deepEqual([reading.text, reading.color], ['–', ''], 'missing/invalid voltage is not a zero or a warning reading');
  }
});

test('Yard charge emphasis compares actual amps only below 13.8V and never substitutes load watts', () => {
  const sample = { ...SAMPLE, batteryVoltageV: 13, chargeCurrentA: .2 };
  const ahead = readingPresentation({ ...sample, controllerLoadCurrentA: .1, controllerLoadPowerW: 999 });
  assert.equal(ahead.yardChargeA.color, 'var(--battery-good)', '0.2A exceeds 0.1A regardless of displayed load watts');
  assert.match(ahead.yardChargeA.title, /controller load 0\.10 A only/);
  assert.match(ahead.yardChargeA.title, /inverter loads are excluded/);
  const behind = readingPresentation({ ...sample, controllerLoadCurrentA: .3, controllerLoadPowerW: .01 });
  assert.equal(behind.yardChargeA.color, 'var(--battery-bad)', '0.2A is below 0.3A regardless of displayed load watts');
  assert.equal(readingPresentation({ ...sample, controllerLoadCurrentA: .2 }).yardChargeA.color, 'var(--battery-bad)', 'equality retains the Station comparison');
  assert.equal(readingPresentation({ ...sample, batteryVoltageV: 13.7999 }).yardChargeA.color, 'var(--battery-good)', 'the 13.8V comparison also precedes display rounding');
  assert.equal(readingPresentation({ ...sample, batteryVoltageV: 13.8 }).yardChargeA.color, '', 'comparison is neutral at the established voltage limit');
  for (const field of ['batteryVoltageV', 'chargeCurrentA', 'controllerLoadCurrentA']) {
    for (const value of [null, undefined, NaN, Infinity, -1, '0.1']) {
      const reading = readingPresentation({ ...sample, [field]: value }).yardChargeA;
      assert.equal(reading.color, '', field + ' must be a valid raw measurement');
      assert.equal(reading.title, '', 'an unavailable comparison clears the prior explanation');
    }
  }
  assert.equal(readingPresentation({ ...sample, controllerLoadCurrentA: 201 }).yardChargeA.color, '');
  assert.equal(readingPresentation({ ...sample, pvVoltageV: 1.24 }).yardPvV.text, '1.24', 'low PV voltage remains the real reading');
});
