'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAccessRequests, COOLDOWN_MS } = require('../lib/access-requests');
const person = { name: 'Test Visitor', email: 'visitor+weather@example.com', website: '' };

function fixture(t, fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moore-access-'));
  let now = 1000000;
  const env = { RESEND_API_KEY: 'test-key-not-a-secret', ACCESS_REQUEST_FROM: 'Moore Weather <access@example.com>', WEATHER_DB_PATH: path.join(dir, 'weather.sqlite') };
  const services = [], calls = [], logs = [];
  const make = (override = {}) => {
    const service = createAccessRequests({ env: { ...env, ...override }, clock: () => now, logger: { warn: m => logs.push(m) },
      fetchImpl: async (...args) => { calls.push(args); return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ id: 'test-message' }) }; } });
    services.push(service); return service;
  };
  t.after(() => { for (const service of services) service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { make, calls, logs, dir, advance: ms => { now += ms; } };
}

test('global quota is atomic across concurrent visitors and survives reopening the database', async t => {
  const f = fixture(t), first = f.make(), second = f.make();
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? first : second).submit({ ...person, name: 'Visitor ' + i })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 429).length, 59);
  assert.equal(f.calls.length, 1);
  first.close(); second.close();
  const restarted = f.make();
  assert.deepEqual(restarted.status(), { enabled: true, retryAfter: 300 });
  f.advance(COOLDOWN_MS - 1); assert.equal((await restarted.submit(person)).status, 429);
  f.advance(1); assert.equal((await restarted.submit(person)).status, 200);
  assert.equal(f.calls.length, 2);
});

test('mail uses a fixed recipient and a reply-to address, with no passwords or automatic access grant', async t => {
  const f = fixture(t), result = await f.make().submit(person);
  assert.equal(result.status, 200);
  const [url, options] = f.calls[0], body = JSON.parse(options.body);
  assert.equal(url, 'https://api.resend.com/emails');
  assert.deepEqual(body.to, ['ashmoore01@hotmail.com']);
  assert.equal(body.reply_to, person.email);
  assert.equal(body.from, 'Moore Weather <access@example.com>');
  assert.match(body.text, /Access has not been granted automatically/);
  assert.ok(!('html' in body)); assert.ok(options.signal);
  assert.match(options.headers['Idempotency-Key'], /^moore-access-/);
  assert.equal(f.logs.length, 0);
});

test('validation and honeypot reject malformed submissions without sending or consuming the quota', async t => {
  const f = fixture(t), service = f.make();
  for (const input of [null, {}, { ...person, name: '' }, { ...person, name: 'a'.repeat(81) },
    { ...person, email: 'invalid' }, { ...person, email: 'x@example.com\r\nBcc:x@example.com' },
    { ...person, name: 'Bad\nName' }, { ...person, website: 'https://bot.example' }, { ...person, email: ['a@example.com'] }]) {
    assert.equal((await service.submit(input)).status, 400);
  }
  assert.equal(f.calls.length, 0); assert.equal(service.status().retryAfter, 0);
  assert.equal((await service.submit(person)).status, 200);
});

test('failed, timed-out or unconfirmed delivery reserves the quota and never claims success', async t => {
  for (const fetchImpl of [async () => { throw new Error('timeout'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({}) })]) {
    const f = fixture(t, fetchImpl), service = f.make();
    const result = await service.submit(person);
    assert.equal(result.status, 503); assert.equal(result.body.retryAfter, 300); assert.equal(result.body.ok, undefined);
    assert.equal((await service.submit(person)).status, 429); assert.equal(f.calls.length, 1);
    assert.ok(f.logs.every(line => !line.includes(person.email) && !line.includes('test-key')));
  }
});

test('cooldown starts at provider acceptance and unavailable configuration or storage fails closed', async t => {
  let f = fixture(t, async () => { f.advance(9000); return { ok: true, json: async () => ({ id: 'slow' }) }; });
  const service = f.make(); await service.submit(person);
  f.advance(COOLDOWN_MS - 1); assert.equal((await service.submit(person)).status, 429);
  f.advance(1); assert.equal((await service.submit(person)).status, 200);
  for (const env of [{ RESEND_API_KEY: '' }, { ACCESS_REQUEST_FROM: '' }, { ACCESS_REQUESTS_ENABLED: 'false' },
    { ACCESS_REQUEST_DB_PATH: path.join(f.dir, 'nonexistent', 'db.sqlite') }]) {
    const disabled = f.make(env);
    assert.equal(disabled.status().enabled, false);
    assert.equal((await disabled.submit(person)).status, 503);
  }
});

test('public request endpoints reject foreign origins, expose no-store status and return a shared Retry-After', async t => {
  const f = fixture(t), service = f.make(), app = express();
  app.use(express.urlencoded({ extended: false, limit: '2kb' })); service.mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const status = await fetch(base + '/api/access-request');
  assert.equal(status.headers.get('cache-control'), 'no-store'); assert.equal((await status.json()).enabled, true);
  const post = (headers = {}) => fetch(base + '/api/access-request', { method: 'POST', headers, body: new URLSearchParams(person) });
  assert.equal((await post({ Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(f.calls.length, 0);
  const sent = await post({ Origin: base }); assert.equal(sent.status, 200);
  assert.equal(sent.headers.get('set-cookie'), null);
  const blocked = await post({ Origin: base }); assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '300'); assert.equal(f.calls.length, 1);
});
