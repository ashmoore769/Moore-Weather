'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const express = require('express');
const { createStationTerminal, SESSION_MS, IDLE_MS, MAX_SESSION_MS, MAX_OUTPUT_BYTES,
  DRAIN_MS, INTERRUPT_COUNT, INTERRUPT_GAP_MS } = require('../lib/station-terminal');

// These are synthetic test credentials. No production environment or station is used.
const PASSWORD = 'offline-terminal-test-password';
const SALT = Buffer.alloc(24, 19);
const HASH = crypto.scryptSync(PASSWORD, SALT, 64);
const PASSWORD_HASH = 'scrypt$' + SALT.toString('base64url') + '$' + HASH.toString('base64url');
const settle = async () => { await nextTurn(); await nextTurn(); };

class Clock {
  time = Date.UTC(2026, 10, 5, 12); next = 0; timers = new Map();
  now = () => this.time;
  set = (fn, ms) => { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id; };
  clear = id => this.timers.delete(id);
  async advance(ms) {
    const target = this.time + ms;
    for (let count = 0; ; count++) {
      assert.ok(count < 10000, 'Timers must remain bounded');
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await settle();
    }
    this.time = target; await settle();
  }
}

class FakeSocket extends EventEmitter {
  constructor(clock, options = {}) {
    super(); this.clock = clock; this.options = options; this.writes = [];
    this.destroyed = false; this.closed = false; this.paused = false;
  }
  connect(port, host, callback) {
    this.address = { port, host }; this.connectCallback = callback;
    if (this.options.autoConnect !== false) queueMicrotask(() => this.completeConnect());
    return this;
  }
  completeConnect() { if (!this.destroyed) this.connectCallback?.(); }
  write(value, callback) {
    const data = Buffer.from(value); this.writes.push({ data, at: this.clock.now() });
    if (this.options.write) return this.options.write(data, callback, this);
    queueMicrotask(() => callback?.()); return true;
  }
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; return this; }
  receive(value) { this.emit('data', Buffer.from(value)); }
  destroy() {
    this.destroyed = true;
    if (!this.options.holdClose) queueMicrotask(() => this.finishClose());
    return this;
  }
  finishClose() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}

function stationQueue() {
  let tail = Promise.resolve(), active = 0;
  const starts = [], ends = [];
  const run = (label, task) => {
    const next = tail.then(async () => {
      starts.push(label); assert.equal(++active, 1, 'Station socket owners must never overlap');
      try { return await task(); } finally { active--; ends.push(label); }
    });
    tail = next.catch(() => {}); return next;
  };
  return { run, starts, ends, idle: () => tail };
}

async function until(predicate, message = 'Condition did not become true') {
  for (let count = 0; count < 200; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

async function fixture(t, options = {}) {
  const clock = new Clock(), queue = stationQueue(), sockets = [], logs = [];
  let streamResponse;
  const app = express();
  app.use((req, res, next) => {
    if (req.path === '/api/terminal/connect') {
      streamResponse = res;
      if (options.streamHook) options.streamHook(res);
    }
    next();
  });
  const terminal = createStationTerminal({
    env: { NODE_ENV: 'test', MOORE_TERMINAL_PASSWORD_HASH: PASSWORD_HASH, ...options.env },
    host: 'station.invalid', port: 2424, runTransaction: options.runTransaction || queue.run,
    logger: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) },
    now: clock.now, setTimer: clock.set, clearTimer: clock.clear,
    ...(options.realScrypt ? {} : { deriveKey: async password => Buffer.from(password === PASSWORD ? HASH : Buffer.alloc(64)) }),
    ...options.injections,
    createSocket: () => {
      if (options.createSocket) return options.createSocket();
      const socket = new FakeSocket(clock, options.socket); sockets.push(socket); return socket;
    }
  });
  // Mirrors the portal's hook without importing startup or making network station calls.
  app.post('/logout-hook', (req, res) => { terminal.revoke(req, res); res.status(204).end(); });
  terminal.mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const readers = [];
  t.after(async () => {
    const stopped = terminal.stop(); await clock.advance(DRAIN_MS + 1100); await stopped;
    for (const reader of readers) { try { await reader.cancel(); } catch {} }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(clock.timers.size, 0, 'Shutdown clears every owned timer');
  });
  const request = (path, { method = 'POST', body = {}, session, headers = {}, raw, ...rest } = {}) => fetch(base + path, {
    method, ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body) }),
    headers: { Origin: base, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      ...(session ? { Cookie: session.cookie, 'X-Terminal-CSRF': session.csrfToken } : {}), ...headers }, ...rest
  });
  const post = (path, body, session, extras = {}) => request('/api/terminal/' + path, { body, session, ...extras });
  const get = async session => (await request('/api/terminal/status', { method: 'GET', session })).json();
  const unlock = async () => {
    const response = await post('unlock', { password: PASSWORD }); assert.equal(response.status, 200);
    const data = await response.json(); return { ...data, cookie: response.headers.get('set-cookie').split(';')[0], setCookie: response.headers.get('set-cookie') };
  };
  const connect = async session => {
    const response = await post('connect', {}, session); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const reader = response.body.getReader(); readers.push(reader);
    const decoder = new TextDecoder(); let buffered = '';
    const next = async () => {
      while (!buffered.includes('\n')) {
        const chunk = await reader.read(); if (chunk.done) return null;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const index = buffered.indexOf('\n'), value = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(value);
    };
    const first = await next(); assert.equal(first.state, 'queued'); assert.match(first.connectionId, /^[A-Za-z0-9_-]{43}$/);
    return { reader, next, connectionId: first.connectionId, async connected() {
      let event; while ((event = await next()) && event.state !== 'connected') assert.notEqual(event.state, 'closed');
      assert.ok(event); return this;
    } };
  };
  return { clock, queue, sockets, logs, terminal, request, post, get, unlock, connect,
    response: () => streamResponse, base };
}

test('terminal is disabled for missing or malformed configuration and never opens a socket', async t => {
  for (const value of ['', 'plain-password', 'scrypt$invalid$invalid']) await t.test(value ? 'malformed' : 'missing', async t => {
    const f = await fixture(t, { env: { MOORE_TERMINAL_PASSWORD_HASH: value } });
    assert.equal((await f.get()).enabled, false);
    assert.equal((await f.post('unlock', { password: PASSWORD })).status, 503);
    assert.equal(f.sockets.length, 0); assert.deepEqual(f.queue.starts, []);
  });
});

test('real asynchronous scrypt unlock adds a separate expiring HttpOnly Strict root cookie', async t => {
  const f = await fixture(t, { realScrypt: true, env: { NODE_ENV: 'production' } });
  assert.equal((await f.post('unlock', { password: 'incorrect' })).status, 403);
  const session = await f.unlock();
  assert.match(session.setCookie, /HttpOnly/); assert.match(session.setCookie, /Secure/);
  assert.match(session.setCookie, /SameSite=Strict/); assert.match(session.setCookie, /Path=\//);
  assert.equal(Date.parse(session.expiresAt), f.clock.now() + SESSION_MS);
  const status = await f.get(session);
  assert.equal(status.unlocked, true); assert.equal(status.csrfToken, session.csrfToken);
  assert.equal(status.connectionId, undefined); assert.equal(status.cookie, undefined);
  assert.deepEqual(status.limits, { idleSeconds: 60, maxSeconds: 300 });
  assert.equal(JSON.stringify(f.terminal.status()).includes(session.csrfToken), false);
  assert.equal(f.sockets.length, 0); assert.equal(f.logs.join('').includes(PASSWORD), false);
});

test('origin, JSON, body-size and CSRF checks reject requests before station access', async t => {
  const f = await fixture(t), session = await f.unlock();
  for (const origin of ['', 'null', f.base + '.attacker.test', 'https://attacker.test']) {
    assert.equal((await f.post('unlock', { password: PASSWORD }, undefined, { headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await f.post('unlock', { password: PASSWORD }, undefined, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.post('unlock', {}, undefined, { raw: '{' })).status, 400);
  assert.equal((await f.post('unlock', {}, undefined, { raw: '[]' })).status, 400);
  assert.equal((await f.post('unlock', { password: 'x'.repeat(3000) })).status, 413);
  assert.equal((await f.post('unlock', { password: PASSWORD }, undefined, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await f.post('connect', {})).status, 401);
  for (const token of ['', 'wrong', 'é'.repeat(43)]) assert.equal((await f.post('connect', {}, session, { headers: { 'X-Terminal-CSRF': token } })).status, 403);
  assert.equal(f.sockets.length, 0); assert.deepEqual(f.queue.starts, []);
});

test('unlock rate limit recovers after its window and permits only one concurrent hash', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await f.post('unlock', { password: 'wrong' })).status, 403);
  assert.equal((await f.post('unlock', { password: PASSWORD })).status, 429);
  await f.clock.advance(SESSION_MS);
  assert.equal((await f.post('unlock', { password: PASSWORD })).status, 200);
  let release, hashing = false;
  const blocked = await fixture(t, { injections: { deriveKey: () => { hashing = true; return new Promise(resolve => { release = resolve; }); } } });
  const first = blocked.post('unlock', { password: PASSWORD }); await until(() => hashing);
  assert.equal((await blocked.post('unlock', { password: PASSWORD })).status, 429);
  release(HASH); assert.equal((await first).status, 200);
});

test('one queued reservation excludes every other tab and cancellation never contacts the station', async t => {
  let release;
  const f = await fixture(t), session = await f.unlock(), other = await f.unlock();
  const current = f.queue.run('CURRENT', () => new Promise(resolve => { release = resolve; })); await settle();
  const stream = await f.connect(session);
  assert.equal(f.terminal.status().state, 'queued'); assert.equal((await f.get(other)).busy, true);
  assert.equal((await f.post('connect', {}, session)).status, 409);
  assert.equal((await f.post('connect', {}, other)).status, 409);
  assert.equal((await f.post('disconnect', { connectionId: stream.connectionId }, other)).status, 403);
  assert.equal((await f.post('disconnect', { connectionId: 'é'.repeat(43) }, session)).status, 403);
  assert.equal((await f.post('disconnect', { connectionId: stream.connectionId }, session)).status, 200);
  release(); await current; await f.queue.idle();
  assert.equal(f.sockets.length, 0); assert.equal(f.terminal.status().busy, false);
  assert.deepEqual(f.queue.starts, ['CURRENT', 'TERMINAL']);
});

test('arbitrary printable commands send exactly once with CRLF and require this stream capability', async t => {
  const f = await fixture(t), session = await f.unlock(), other = await f.unlock();
  const stream = await (await f.connect(session)).connected(), socket = f.sockets[0];
  assert.deepEqual(socket.address, { host: 'station.invalid', port: 2424 }); assert.equal(socket.writes.length, 0);
  const command = 'STORAGE 77 58 AVERAGE "quoted" ; literal-$text', commandId = crypto.randomUUID();
  const body = { connectionId: stream.connectionId, command, commandId };
  assert.equal((await f.post('input', body, other)).status, 403);
  assert.equal((await f.post('input', { ...body, connectionId: '' }, session)).status, 403);
  assert.deepEqual(await (await f.post('input', body, session)).json(), { ok: true });
  assert.deepEqual(await (await f.post('input', body, session)).json(), { ok: true, duplicate: true });
  assert.equal((await f.post('input', { ...body, command: 'DIFFERENT' }, session)).status, 409);
  assert.equal(socket.writes.length, 1); assert.equal(socket.writes[0].data.toString(), command + '\r\n');
  for (const invalid of ['', ' ', 'TIME\nVER', 'TIME\rVER', '\x03', 'é', 'A'.repeat(513)]) {
    assert.equal((await f.post('input', { ...body, command: invalid, commandId: crypto.randomUUID() }, session)).status, 400);
  }
  assert.equal((await f.post('input', { ...body, command: 'A'.repeat(512), commandId: crypto.randomUUID() }, session)).status, 200);
  assert.equal(f.logs.join('').includes(command), false);
});

test('interrupt sends five spaced Ctrl+C bytes directly while the queue remains exclusively held', async t => {
  const f = await fixture(t), session = await f.unlock(), stream = await (await f.connect(session)).connected(), socket = f.sockets[0];
  let polled = false; const poll = f.queue.run('CURRENT', () => { polled = true; });
  const body = { connectionId: stream.connectionId };
  const first = f.post('interrupt', body, session); await until(() => socket.writes.length === 1);
  const second = f.post('interrupt', body, session); await settle();
  await f.clock.advance(INTERRUPT_GAP_MS * (INTERRUPT_COUNT - 1));
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(socket.writes.length, 5);
  assert.ok(socket.writes.every(write => write.data.equals(Buffer.from([3]))));
  assert.deepEqual(socket.writes.map(write => write.at - socket.writes[0].at), [0, 100, 200, 300, 400]);
  assert.equal(polled, false); assert.equal(f.terminal.status().connected, true);
  assert.equal((await f.post('interrupt', body, session)).status, 429);
  const disconnect = f.post('disconnect', body, session); await until(() => f.terminal.status().state === 'closing');
  await f.clock.advance(DRAIN_MS - 1); assert.equal(polled, false); assert.equal(socket.destroyed, false);
  await f.clock.advance(1); await poll; assert.equal((await disconnect).status, 200);
  assert.equal(socket.destroyed, true); assert.equal(polled, true); assert.equal(f.terminal.status().busy, false);
});

test('stream output resets idle, while heartbeats and status do not', async t => {
  const f = await fixture(t), session = await f.unlock(), stream = await (await f.connect(session)).connected(), socket = f.sockets[0];
  await f.clock.advance(IDLE_MS - 1); assert.equal(f.terminal.status().connected, true);
  socket.receive('long response is still arriving\r\n');
  await f.clock.advance(IDLE_MS - 1); assert.equal(f.terminal.status().connected, true);
  assert.equal((await f.get(session)).connected, true);
  await f.clock.advance(1); assert.equal(f.terminal.status().state, 'closing');
  assert.equal(socket.writes[0].data[0], 3);
  let event, text = '';
  while ((event = await stream.next()) && event.state !== 'closing') if (event.type === 'data') text += event.text;
  assert.equal(text, 'long response is still arriving\r\n');
  await f.clock.advance(DRAIN_MS); assert.equal(f.terminal.status().busy, false);
});

test('five-minute hard limit holds despite continuous output, then drains before queue release', async t => {
  const f = await fixture(t), session = await f.unlock(); await (await f.connect(session)).connected();
  for (let i = 0; i < 5; i++) { await f.clock.advance(50000); f.sockets[0].receive('still running\n'); }
  await f.clock.advance(MAX_SESSION_MS - 250000);
  assert.equal(f.terminal.status().state, 'closing'); assert.equal(f.sockets[0].destroyed, false);
  await f.clock.advance(DRAIN_MS); assert.equal(f.terminal.status().busy, false);
});

test('2 MiB output budget closes a chatty station without retaining its transcript or extending cleanup', async t => {
  const f = await fixture(t), session = await f.unlock(); await (await f.connect(session)).connected();
  const socket = f.sockets[0]; socket.receive(Buffer.alloc(MAX_OUTPUT_BYTES + 1, 65));
  assert.equal(f.terminal.status().state, 'closing');
  socket.receive(Buffer.alloc(MAX_OUTPUT_BYTES, 66));
  await f.clock.advance(DRAIN_MS); assert.equal(f.terminal.status().busy, false);
  assert.ok(f.logs.every(value => value.length < 200));
});

test('HTTP backpressure pauses and resumes the socket, and a stalled browser has bounded cleanup', async t => {
  let stall = false;
  const f = await fixture(t, { streamHook(res) {
    const write = res.write.bind(res); res.write = value => { const accepted = write(value); return stall ? false : accepted; };
  } });
  const session = await f.unlock(); await (await f.connect(session)).connected();
  const socket = f.sockets[0]; stall = true; socket.receive('first'); assert.equal(socket.paused, true);
  stall = false; f.response().emit('drain'); assert.equal(socket.paused, false);
  await f.clock.advance(5000); assert.equal(f.terminal.status().connected, true);
  stall = true; socket.receive('second'); await f.clock.advance(5000);
  assert.equal(f.terminal.status().state, 'closing'); assert.equal(socket.paused, false, 'Cleanup drains even if HTTP is blocked');
  await f.clock.advance(DRAIN_MS); assert.equal(f.terminal.status().busy, false);
});

test('browser loss aborts and drains without waiting for a new queue transaction', async t => {
  const f = await fixture(t), session = await f.unlock(), stream = await (await f.connect(session)).connected();
  let next = false; const queued = f.queue.run('HISTORY', () => { next = true; });
  await stream.reader.cancel(); await until(() => f.terminal.status().state === 'closing');
  assert.equal(f.sockets[0].writes[0].data[0], 3); assert.equal(next, false);
  await f.clock.advance(DRAIN_MS); await queued; assert.equal(next, true);
});

test('backpressure on the final state destroys the response and cannot recreate a lease timer', async t => {
  const f = await fixture(t, { streamHook(res) {
    const write = res.write.bind(res);
    res.write = value => { const accepted = write(value); return value.includes('"state":"closed"') ? false : accepted; };
  } });
  const session = await f.unlock(); await (await f.connect(session)).connected();
  const stopped = f.terminal.stop(); await f.clock.advance(DRAIN_MS); await stopped;
  assert.equal(f.response().destroyed, true); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.terminal.status().busy, false);
});

test('logout clears the root cookie immediately, revokes replay and drains its owned lease', async t => {
  const f = await fixture(t), session = await f.unlock(); await (await f.connect(session)).connected();
  const logout = await f.request('/logout-hook', { session }); assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /moore_terminal=;/); assert.match(logout.headers.get('set-cookie'), /Path=\//);
  assert.equal((await f.get(session)).unlocked, false); assert.equal(f.terminal.status().state, 'closing');
  assert.equal((await f.post('connect', {}, session)).status, 401);
  await f.clock.advance(DRAIN_MS); assert.equal(f.terminal.status().busy, false);
});

test('session expiry closes a newly connected lease and stale cookies cannot reopen it', async t => {
  const f = await fixture(t), session = await f.unlock(); await f.clock.advance(SESSION_MS - 10000);
  await (await f.connect(session)).connected(); await f.clock.advance(10000);
  assert.equal(f.terminal.status().state, 'closing'); assert.equal((await f.get(session)).unlocked, false);
  await f.clock.advance(DRAIN_MS); assert.equal((await f.post('connect', {}, session)).status, 401);
});

test('stop is idempotent, disables new access, and resolves only after socket cleanup', async t => {
  const f = await fixture(t, { socket: { holdClose: true } }), session = await f.unlock(); await (await f.connect(session)).connected();
  let done = false; const stopped = f.terminal.stop(); stopped.then(() => { done = true; });
  assert.equal(f.terminal.stop(), stopped); assert.equal(f.terminal.status().enabled, false);
  assert.equal((await f.get(session)).unlocked, false);
  await f.clock.advance(DRAIN_MS); assert.equal(done, false); assert.equal(f.sockets[0].destroyed, true);
  f.sockets[0].finishClose(); await stopped; assert.equal(done, true);
  assert.equal(f.terminal.status().busy, false); assert.equal(f.clock.timers.size, 0);
});

test('connect timeout and queue failure release reservations so later attempts can recover', async t => {
  const f = await fixture(t, { socket: { autoConnect: false } }), session = await f.unlock(); await f.connect(session);
  await until(() => f.sockets.length === 1); await f.clock.advance(15000);
  assert.equal(f.terminal.status().busy, false); assert.equal(f.sockets[0].destroyed, true);
  const retry = await f.connect(session); await until(() => f.sockets.length === 2);
  f.sockets[1].completeConnect(); await retry.connected(); assert.equal(f.terminal.status().connected, true);
  let count = 0;
  const failed = await fixture(t, { runTransaction: (_label, task) => { if (++count === 1) throw new Error('closed queue'); return task(); } });
  const secondSession = await failed.unlock(); await failed.connect(secondSession); await settle();
  assert.equal(failed.terminal.status().busy, false);
  await (await failed.connect(secondSession)).connected(); assert.equal(failed.sockets.length, 1);
});

test('a command write timeout is uncertain and is never retried or followed by queued work before cleanup', async t => {
  const f = await fixture(t, { socket: { write(data, callback) { if (data[0] === 3) queueMicrotask(() => callback()); return true; } } });
  const session = await f.unlock(), stream = await (await f.connect(session)).connected();
  const body = { connectionId: stream.connectionId, command: 'MEM3', commandId: crypto.randomUUID() };
  const write = f.post('input', body, session); await until(() => f.sockets[0].writes.length === 1);
  assert.equal((await f.post('input', { ...body, commandId: crypto.randomUUID() }, session)).status, 409);
  await f.clock.advance(5000); const result = await write; assert.equal(result.status, 504); assert.match((await result.json()).error, /uncertain/);
  assert.equal(f.terminal.status().state, 'closing'); await f.clock.advance(DRAIN_MS);
  assert.equal(f.sockets[0].writes.filter(write => write.data.toString() === 'MEM3\r\n').length, 1);
});

test('synchronous interrupt write errors stop the burst and clean the lease without stray timers', async t => {
  const f = await fixture(t, { socket: { write(_data, callback) { callback(new Error('synthetic failure')); return false; } } });
  const session = await f.unlock(), stream = await (await f.connect(session)).connected();
  const result = await f.post('interrupt', { connectionId: stream.connectionId }, session);
  assert.equal(result.status, 502); await settle();
  assert.equal(f.sockets[0].writes.length, 1); assert.equal(f.terminal.status().busy, false);
  await f.clock.advance(1000); assert.equal(f.sockets[0].writes.length, 1);
});
