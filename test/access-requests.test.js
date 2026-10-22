'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { createAccessRequests, RequestQueue, RETRY_BASE_MS, LEASE_MS, DEDUP_MS, MAX_PENDING, RETENTION_MS } = require('../lib/access-requests');
const person = { name: 'Test Visitor', email: 'visitor+weather@example.com', website: '' };
const accepted = () => ({ ok: true, status: 200, json: async () => ({ success: 'true' }) });

function fixture(t, fetchImpl = async () => accepted()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moore-access-'));
  const filename = path.join(dir, 'access-requests.sqlite');
  let now = 1000000;
  const services = [], calls = [], logs = [];
  const make = (override = {}) => {
    const service = createAccessRequests({ env: { WEATHER_DB_PATH: path.join(dir, 'weather.sqlite'), ...override }, clock: () => now,
      logger: { warn: m => logs.push(m), info: m => logs.push(m) },
      fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); } });
    services.push(service); return service;
  };
  const rows = () => {
    const db = new DatabaseSync(filename, { readOnly: true });
    try { return db.prepare('SELECT * FROM access_request_queue ORDER BY created_at,rowid').all(); } finally { db.close(); }
  };
  t.after(async () => { for (const service of services) await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { make, calls, logs, dir, filename, rows, now: () => now, advance: ms => { now += ms; } };
}

test('request is persisted before acknowledgement, independently of provider failure or background retry', async t => {
  const f = fixture(t, async () => { throw Error('network error'); }), service = f.make();
  assert.deepEqual(service.status(), { enabled: true, retryAfter: 0 });
  const first = await service.submit(person, 'first-client');
  assert.equal(first.status, 202); assert.equal(first.body.ok, true);
  assert.match(first.body.message, /details have been saved/);
  assert.doesNotMatch(first.body.message, /email sent|delivered|password sent/i);
  assert.equal(f.calls.length, 0); assert.equal(f.rows()[0].email, person.email);
  await service.runDue();
  assert.equal(f.rows()[0].state, 'queued');
  assert.equal((await service.submit({ ...person, email: 'second@example.com' }, 'second-client')).status, 202);
  assert.deepEqual(service.status(), { enabled: true, retryAfter: 0 });
  assert.equal(f.rows().length, 2);
});

test('duplicate requests across processes and lost responses produce one stored request and notification', async t => {
  const f = fixture(t), a = f.make(), b = f.make();
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).submit(person, 'client-' + i)));
  assert.ok(results.every(r => r.status === 202)); assert.equal(f.rows().length, 1);
  await Promise.all([a.runDue(), b.runDue(), a.runDue()]);
  assert.equal(f.calls.length, 1);
  assert.equal((await b.submit({ ...person, email: person.email.toUpperCase() }, 'another')).status, 202);
  f.advance(DEDUP_MS - 1); await b.runDue(); assert.equal(f.calls.length, 1);
  assert.equal(f.rows()[0].name, null); assert.equal(f.rows()[0].email, null);
  f.advance(1); await b.submit(person); await b.runDue(); assert.equal(f.calls.length, 2);
});

test('queued requests survive restart; upgrading ignores the old five-minute lockout entirely', async t => {
  const f = fixture(t);
  const old = new DatabaseSync(f.filename);
  old.exec('CREATE TABLE access_request_gate (id INTEGER PRIMARY KEY, next_allowed_at INTEGER NOT NULL)');
  old.prepare('INSERT INTO access_request_gate VALUES(1,?)').run(f.now() + 300000); old.close();
  const first = f.make();
  await first.submit(person, 'one'); await first.submit({ ...person, email: 'other@example.com' }, 'two');
  assert.equal(f.calls.length, 0);
  await first.close();
  const restarted = f.make();
  await restarted.runDue(); assert.equal(f.calls.length, 2);
  assert.ok(f.rows().every(r => r.state === 'sent'));
});

test('provider receives fixed whitelisted fields and actual form origin; visitor cannot change destination', async t => {
  const f = fixture(t), service = f.make();
  await service.submit({ ...person, _cc: 'attacker@example.com', _url: 'https://foreign.example',
    _replyto: 'attacker@example.com', _autoresponse: 'password', _webhook: 'https://foreign.example', _subject: 'Override' });
  await service.runDue();
  const [url, options] = f.calls[0], body = JSON.parse(options.body);
  assert.equal(url, 'https://formsubmit.co/ajax/ashmoore01@hotmail.com');
  assert.equal(body.name, person.name); assert.equal(body.email, person.email); assert.equal(body._replyto, person.email);
  assert.equal(body._subject, 'Moore Weather access request'); assert.equal(body._url, 'https://moore-weather.onrender.com/login');
  assert.equal(options.headers.Referer, body._url); assert.equal(options.headers.Origin, 'https://moore-weather.onrender.com');
  assert.match(body.request_reference, /^[0-9a-f-]{36}$/);
  assert.match(body.message, /Access has not been granted automatically/);
  for (const field of ['html', '_cc', '_autoresponse', '_webhook', 'website']) assert.ok(!(field in body));
  assert.ok(options.signal); assert.equal(options.redirect, 'error');
  assert.ok(!('Authorization' in options.headers));
});

test('validation, honeypot and storage failures never acknowledge an unsaved request', async t => {
  const f = fixture(t), service = f.make();
  for (const input of [null, {}, { ...person, name: '' }, { ...person, name: 'a'.repeat(81) },
    { ...person, email: 'invalid' }, { ...person, email: 'x@example.com\r\nBcc:x@example.com' },
    { ...person, name: 'Bad\nName' }, { ...person, website: 'https://bot.example' }, { ...person, email: ['a@example.com'] }]) {
    assert.equal((await service.submit(input)).status, 400);
  }
  assert.equal(f.calls.length, 0);
  for (const env of [{ WEATHER_DB_PATH: '' }, { ACCESS_REQUESTS_ENABLED: 'false' },
    { ACCESS_REQUEST_DB_PATH: path.join(f.dir, 'nonexistent', 'db.sqlite') }]) {
    const disabled = f.make(env);
    assert.equal(disabled.status().enabled, false);
    const result = await disabled.submit(person); assert.equal(result.status, 503); assert.equal(result.body.ok, undefined);
  }
});

test('failed or ambiguous provider replies retain the request and redact provider details from diagnostics', async t => {
  const cases = [
    [async () => { throw new DOMException('visitor@example.com secret', 'TimeoutError'); }, 'provider_timeout'],
    [async () => ({ ok: false, status: 403 }), 'provider_http_403'],
    [async () => ({ ok: true, json: async () => { throw SyntaxError('secret'); } }), 'provider_invalid_json'],
    ...[{}, null, { success: false }, { success: 'false' }, { success: 1 }, { success: 'yes' }].map(result =>
      [async () => ({ ok: true, json: async () => result }), 'provider_unconfirmed']),
    [async () => ({ ok: true, json: async () => ({ success: 'false', message: 'Please activate form for visitor@example.com TOKEN_SECRET' }) }), 'activation_required']
  ];
  for (const [provider, category] of cases) {
    const f = fixture(t, provider), service = f.make();
    await service.submit(person); await service.runDue();
    const row = f.rows()[0]; assert.equal(row.state, 'queued'); assert.equal(row.email, person.email);
    assert.equal(row.last_failure, category); assert.equal(row.attempts, 1);
    f.advance(RETRY_BASE_MS - 1); await service.runDue(); assert.equal(f.calls.length, 1);
    assert.ok(f.logs.some(line => line.includes(category)));
    assert.ok(f.logs.every(line => !line.includes(person.email) && !line.includes(person.name) && !line.includes('TOKEN_SECRET') && !line.includes('visitor@example.com')));
  }
});

test('retry eventually sends once, clears personal details and respects Retry-After globally', async t => {
  let count = 0;
  const f = fixture(t, async () => ++count === 1 ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '7200' }) } : accepted());
  const a = f.make();
  await a.submit(person, 'one'); await a.runDue();
  await a.submit({ ...person, email: 'second@example.com' }, 'two');
  await a.close(); const b = f.make();
  f.advance(7200000 - 1); await b.runDue(); assert.equal(f.calls.length, 1);
  f.advance(1); await b.runDue(); assert.equal(f.calls.length, 3);
  assert.ok(f.rows().every(r => r.state === 'sent' && r.name === null && r.email === null));
  f.advance(DEDUP_MS); await b.runDue(); assert.equal(f.calls.length, 3);
});

test('crash recovery reclaims an expired lease and rejects stale worker completion', async t => {
  const f = fixture(t), service = f.make(); await service.submit(person);
  const queue = new RequestQueue(f.filename);
  const first = queue.take(f.now()); assert.ok(first); assert.equal(queue.take(f.now()), null);
  f.advance(LEASE_MS); const recovered = queue.take(f.now()); assert.equal(recovered.attempts, 2);
  assert.equal(queue.finish(first, f.now()), false);
  assert.equal(f.rows()[0].state, 'sending');
  assert.equal(queue.finish(recovered, f.now()), true);
  queue.close(); assert.equal(f.rows()[0].state, 'sent');
});

test('new visitors can submit and receive notifications back-to-back with no global, hourly or per-IP cooldown', async t => {
  const f = fixture(t), a = f.make(), b = f.make();
  for (let i = 0; i < 50; i++) assert.equal((await a.submit({ ...person, email: `user${i}@example.com` })).status, 202);
  await Promise.all([a.runDue(), b.runDue()]);
  assert.equal(f.calls.length, 50);
  assert.equal(new Set(f.calls.map(call => JSON.parse(call[1].body).request_reference)).size, 50);
  assert.ok(f.rows().every(row => row.state === 'sent'));
});

test('pending storage is bounded and old records expire', async t => {
  const f = fixture(t), service = f.make();
  for (let i = 0; i < MAX_PENDING; i++) {
    assert.equal((await service.submit({ ...person, email: `bounded${i}@example.com` }, `client${i}`)).status, 202);
  }
  assert.equal((await service.submit(person)).status, 503);
  f.advance(RETENTION_MS);
  assert.equal((await service.submit(person)).status, 202); assert.equal(f.rows().length, 1);
});

test('HTTP acknowledgement returns while provider is still pending; origins, duplicate retry and password boundary remain separate', async t => {
  let release;
  let sends = 0;
  const f = fixture(t, () => ++sends === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(accepted()));
  const service = f.make(), app = express();
  app.use(express.urlencoded({ extended: false, limit: '2kb' })); service.mount(app); service.start();
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { release?.(accepted()); await service.close(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body = person, headers = {}) => fetch(base + '/api/access-request', { method: 'POST', headers, body: new URLSearchParams(body), signal: AbortSignal.timeout(2000) });
  assert.equal((await post(person, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post(person, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(f.calls.length, 0);
  const saved = await post(person, { Origin: base }); assert.equal(saved.status, 202);
  assert.equal((await saved.json()).ok, true); assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.equal(saved.headers.get('set-cookie'), null); assert.equal(f.calls.length, 1);
  assert.equal(f.rows()[0].state, 'sending');
  assert.equal((await post()).status, 202); assert.equal(f.calls.length, 1);
  const status = await fetch(base + '/api/access-request');
  assert.deepEqual(await status.json(), { enabled: true, retryAfter: 0 });
  const second = await post({ ...person, email: 'second@example.com' });
  assert.equal(second.status, 202); assert.equal(second.headers.get('retry-after'), null);
  release(accepted()); await service.runDue();
  assert.equal(f.calls.length, 2);
});
