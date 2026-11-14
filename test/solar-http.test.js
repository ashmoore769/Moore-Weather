'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { configuration, createSolarService, mountSolarIngest, mountSolarRead } = require('../lib/solar-service');

const TOKEN = 'offline-solar-machine-token-with-at-least-32-characters';
const NOW = Date.parse('2026-11-14T02:00:00.000Z');
const reading = (overrides = {}) => ({ observedAt: '2026-11-14T01:59:00.000Z', collectedAt: '2026-11-14T01:59:01.000Z',
  pvPowerW: 1000, inverterPowerW: 950, gridPowerW: null, loadPowerW: null, batteryPowerW: null,
  batterySocPercent: null, totalAcEnergyWh: null, meterLocation: null, mode: 'produce-only', ...overrides });
const payload = samples => JSON.stringify({ version: 1, samples: samples || [reading()] });

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'weather.sqlite');
  const database = new DatabaseSync(filename); database.close();
  const env = { WEATHER_DB_PATH: filename, SOLAR_INGEST_TOKEN: TOKEN, ...options.env };
  const service = createSolarService({ env, isReady: options.isReady || (() => true), now: () => NOW,
    logger: { warn() {} }, ...(options.openStore ? { openStore: options.openStore } : {}) });
  t.after(() => service.close());
  const app = express();
  mountSolarIngest(app, { env, getService: () => service, now: () => NOW,
    ...(options.maxRequestsPerMinute ? { maxRequestsPerMinute: options.maxRequestsPerMinute } : {}) });
  app.use((req, res, next) => req.get('cookie') === 'test-login=yes' ? next() : res.status(401).end());
  mountSolarRead(app, { getService: () => service });
  const base = await serve(t, app);
  const post = (body = payload(), headers = {}) => fetch(base + '/internal/solar/ingest', { method: 'POST',
    body, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...headers } });
  const get = (query = '') => fetch(base + '/api/solar' + query, { headers: { Cookie: 'test-login=yes' } });
  return { base, post, get, service };
}

test('solar is optional and fails closed without both a valid independent token and durable database configuration', async t => {
  assert.equal(configuration({ WEATHER_DB_PATH: '/tmp/example', SOLAR_INGEST_TOKEN: 'short' }).enabled, false);
  assert.equal(configuration({ SOLAR_INGEST_TOKEN: TOKEN }).enabled, false);
  for (const env of [{ SOLAR_INGEST_TOKEN: '' }, { SOLAR_INGEST_TOKEN: 'short' }, { WEATHER_DB_PATH: '' }]) {
    const f = await fixture(t, { env });
    const response = await f.post('{bad json');
    assert.equal(response.status, 404, 'disabled endpoint must not parse a body or create storage');
    const view = await (await f.get()).json();
    assert.equal(view.enabled, false);
    assert.equal(view.status, 'disabled');
    assert.equal(view.current, null);
  }
});

test('machine authorization precedes JSON parsing, rejects browser origins and cannot be replaced by a cookie', async t => {
  const f = await fixture(t);
  for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer wrong' },
    { Authorization: '', Cookie: 'test-login=yes' }, { Origin: 'https://moore-weather.onrender.com' },
    { Origin: '' }]) assert.equal((await f.post('{invalid json', headers)).status, 403);
  assert.equal((await f.post('{invalid json')).status, 400);
  assert.equal((await f.post(payload(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('x'.repeat(129 * 1024))).status, 413);
  assert.equal((await f.post(payload(), { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal(f.service.snapshot().current, null);
});

test('committed batches acknowledge exact accepted and duplicate counts while old replay cannot replace live data', async t => {
  const f = await fixture(t);
  const accepted = await f.post();
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { accepted: 1, duplicates: 0 });
  const duplicate = await f.post();
  assert.deepEqual(await duplicate.json(), { accepted: 0, duplicates: 1 });
  const previous = reading({ observedAt: '2026-11-14T01:58:00.000Z', collectedAt: '2026-11-14T01:58:01.000Z', pvPowerW: 500 });
  assert.deepEqual(await (await f.post(payload([previous, reading()]))).json(), { accepted: 1, duplicates: 1 });
  assert.equal((await fetch(f.base + '/api/solar')).status, 401);
  const response = await f.get();
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  const snapshot = await response.json();
  assert.equal(snapshot.status, 'fresh');
  assert.equal(snapshot.current.pvPowerW, 1000);
  assert.equal(snapshot.current.gridPowerW, null);
  assert.equal(snapshot.today.energyAcWh, null);
  assert.equal(snapshot.history, null);
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
  assert.equal((await f.get('?history=today')).status, 200);
  assert.equal((await f.get('?history=all')).status, 400);
  assert.equal((await f.get('?source=another-home')).status, 400);
});

test('invalid batches write no partial sample and unavailable storage never returns a success acknowledgement', async t => {
  const f = await fixture(t);
  const invalid = reading({ observedAt: '2026-11-14T01:58:00.000Z', pvPowerW: '100' });
  assert.equal((await f.post(payload([reading(), invalid]))).status, 400);
  assert.equal(f.service.snapshot().current, null);
  const unavailable = await fixture(t, { isReady: () => false });
  assert.equal((await unavailable.post()).status, 503);
  assert.equal((await unavailable.get()).status, 503);
  const diskFailure = await fixture(t, { openStore: () => ({ save() { throw new Error('private disk detail'); },
    latest() { return null; }, close() {}, snapshot() { throw new Error('private disk detail'); } }) });
  const failed = await diskFailure.post();
  assert.equal(failed.status, 503);
  const failureBody = await failed.text();
  assert.doesNotMatch(failureBody, /private disk detail|accepted/);
});

test('authenticated uploads are rate limited with a retry hint', async t => {
  const f = await fixture(t, { maxRequestsPerMinute: 2 });
  assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 200);
  const limited = await f.post();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('daily storage capacity returns a retryable failure while reads and duplicate acknowledgements remain available', async t => {
  const { SolarStore } = require('../lib/solar-store');
  const f = await fixture(t, { openStore: filename => new SolarStore(filename, { dailySampleLimit: 1 }) });
  assert.equal((await f.post()).status, 200);
  const other = reading({ observedAt: '2026-11-14T01:58:00.000Z', collectedAt: '2026-11-14T01:58:01.000Z' });
  const over = await f.post(payload([other]));
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('retry-after'), '3600');
  assert.doesNotMatch(await over.text(), /accepted/);
  assert.deepEqual(await (await f.post()).json(), { accepted: 0, duplicates: 1 });
  assert.equal((await f.get()).status, 200);
  assert.equal(f.service.status().ready, true);
});

test('actual server routing keeps solar data and assets private while the machine route accepts only its own credential', async t => {
  const root = path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = source.indexOf('const app = express();'), stop = source.indexOf('let cachedWeatherData = null;');
  const password = 'offline-test-password', salt = crypto.randomBytes(16);
  const hash = 'scrypt$' + salt.toString('base64url') + '$' + crypto.scryptSync(password, salt, 32).toString('base64url');
  let writes = 0;
  const solarService = { ingest(samples) { writes++; return { accepted: samples.length, duplicates: 0 }; },
    snapshot() { return { enabled: true, status: 'fresh', current: { pvPowerW: 1234 } }; } };
  const app = vm.runInNewContext(source.slice(start, stop) + '\napp;', {
    require: createRequire(path.join(root, 'server.js')), express, cors: require('cors'), path, crypto, Buffer,
    __dirname: root, process: { env: { MOORE_AUTH_PASSWORD_HASH: hash,
      MOORE_AUTH_COOKIE_SECRET: 'offline-cookie-secret-longer-than-32-characters', NODE_ENV: 'production',
      WEATHER_DB_PATH: '/test/nonexistent-but-never-opened', SOLAR_INGEST_TOKEN: TOKEN } },
    logger: { warn() {}, info() {} }, solarService,
    systemHealth: { snapshot: () => ({ status: 'ok', checks: { private: 'not-public' } }) }
  });
  mountSolarRead(app, { getService: () => solarService });
  const base = await serve(t, app);
  for (const url of ['/api/solar', '/solar.js', '/solar.css']) {
    assert.equal((await fetch(base + url, { redirect: 'manual' })).status, 401, url);
  }
  const health = await (await fetch(base + '/health/monitor')).json();
  assert.deepEqual(health, { status: 'ok' });
  const login = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/solar', { headers: { Cookie: cookie } })).status, 200);
  const upload = await fetch(base + '/internal/solar/ingest', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: payload([reading({ observedAt: new Date().toISOString(), collectedAt: new Date().toISOString() })]) });
  assert.equal(upload.status, 200);
  assert.equal(writes, 1);
  const cookieUpload = await fetch(base + '/internal/solar/ingest', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: payload() });
  assert.equal(cookieUpload.status, 403);
  assert.equal(writes, 1);
});
