'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { observationTime } = require('../lib/station-alerts');
const { createPersistence } = require('../lib/weather-persistence');
const layout = require('../config/station-layout.json');

// Execute only the actual polling/queue functions, with no server startup,
// schedulers, network modules or physical station connection. The fake socket
// models activity resetting the idle timer so a trickle exercises the separate
// whole-transaction deadline.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const queueStart = source.indexOf('let stationTransactionTail = Promise.resolve();');
const queueEnd = source.indexOf('const historyCollector =', queueStart);
const pollStart = source.indexOf('const STATION_SOCKET_DEADLINE_MS =');
const pollEnd = source.indexOf('/* =========================================================\n   DAILY SUMMARY - SAFE REFRESH INTERLOCK', pollStart);
assert.ok(queueStart >= 0 && queueEnd > queueStart && pollStart >= 0 && pollEnd > pollStart);
const clockStart = Date.parse('2026-11-05T02:00:00.000Z');
const quiet = { info() {}, warn() {}, error() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));
function row(stream, date = '2026/11/05', time = stream === 'r3' ? '12:00:00' : '09:00:00', fieldCount) {
  const values = layout.streams[stream].fields.map(f => f.sensorKey === '7' ? '1018.2' : '0');
  return [date, time, ...values].slice(0, fieldCount).join(',');
}
function harness(t, { realPersistence = false, connectError = false } = {}) {
  let clock = clockStart;
  const timers = new Map();
  const sockets = [], records = [];
  const later = (fn, delay = 0) => {
    const handle = { unref() {} };
    timers.set(handle, { at: clock + delay, fn });
    return handle;
  };
  const clear = handle => timers.delete(handle);
  async function advance(ms) {
    const target = clock + ms;
    while (true) {
      const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    clock = target;
    await flush();
  }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.writes = [];
      this.idleMs = 0;
      this.idleTimer = null;
      sockets.push(this);
    }
    armIdle() {
      clear(this.idleTimer);
      if (this.idleMs && !this.destroyed) this.idleTimer = later(() => this.emit('timeout'), this.idleMs);
    }
    setTimeout(ms) { this.idleMs = ms; this.armIdle(); return this; }
    connect(port, host, callback) {
      assert.equal(host, '127.0.0.1');
      assert.equal(port, 12345);
      if (connectError) throw new Error('offline test connect failure');
      this.armIdle();
      queueMicrotask(callback);
      return this;
    }
    write(value) { this.writes.push(value); this.armIdle(); return true; }
    receive(value) {
      assert.equal(this.destroyed, false, 'do not send data to a finished socket');
      this.armIdle();
      this.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
    remoteClose() { clear(this.idleTimer); this.emit('close'); }
    fail() { this.emit('error', new Error('offline test socket failure')); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      clear(this.idleTimer);
      queueMicrotask(() => this.emit('close'));
    }
  }
  const database = realPersistence ? createPersistence({ WEATHER_DB_PATH: ':memory:' }, quiet, { now: () => clock }) : null;
  if (database) t.after(() => database.close());
  let api;
  const persistence = { record(stream, raw) {
    records.push({ stream, raw, before: api.snapshot() });
    return database?.record(stream, raw);
  } };
  api = vm.runInNewContext(`
    let cachedWeatherData = initialWeather, cachedDailyData = initialDaily;
    let lastPollTime = null, lastDailyPollTime = null, dailyStationRequestInFlight = null;
    ${source.slice(queueStart, queueEnd)}
    ${source.slice(pollStart, pollEnd)}
    ({ runCurrentWeatherAttempt, updateWeatherData, fetchDailyDataOnce, runStationTransaction,
      snapshot: () => ({ weather: cachedWeatherData, daily: cachedDailyData,
        lastPollTime, lastDailyPollTime, active: stationTransactionActive,
        currentInFlight: Boolean(currentWeatherRequestInFlight), dailyInFlight: Boolean(dailyStationRequestInFlight) }) });
  `, { net: { Socket }, Buffer, Date: ClockDate, setTimeout: later, clearTimeout: clear,
    WEATHER_STATION_HOST: '127.0.0.1', WEATHER_STATION_PORT: 12345,
    persistence, observationTime, logger: quiet,
    initialWeather: row('r3', '2026/11/05', '11:59:00'), initialDaily: row('mem1', '2026/11/04'),
    dailyCacheStatus: () => ({ displayedDate: '2026-11-04', expectedDate: '2026-11-04', current: true }) });
  return { api, sockets, records, database, timers, advance, now: () => clock };
}
async function begin(h, kind) {
  const promise = kind === 'current' ? h.api.runCurrentWeatherAttempt() : h.api.fetchDailyDataOnce();
  await flush();
  return { promise, socket: h.sockets.at(-1) };
}
function valid(kind) { return row(kind === 'current' ? 'r3' : 'mem1'); }
function response(kind, csv, end = true) { return (kind === 'current' ? 'r3\r\n' : 'MEM 1 LAST\r\n') + csv + (end ? '\r\n\\END' : ''); }

test('current and daily trickle replies hit the 15-second whole-transaction deadline and release every timer', async t => {
  for (const kind of ['current', 'daily']) await t.test(kind, async t => {
    const h = harness(t), before = h.api.snapshot();
    const { promise, socket } = await begin(h, kind);
    let settled = false;
    promise.then(() => { settled = true; });
    assert.deepEqual(socket.writes, [kind === 'current' ? 'r3\r\n' : 'MEM 1 LAST\r\n']);
    for (let i = 0; i < 3; i++) {
      await h.advance(4000);
      socket.receive('x');
      assert.equal(settled, false, 'activity keeps the 5-second idle timer alive');
    }
    await h.advance(2999);
    assert.equal(settled, false);
    await h.advance(1);
    assert.equal(await promise, kind === 'current' ? false : '');
    assert.equal(h.now() - clockStart, 15000);
    assert.equal(socket.destroyed, true);
    assert.equal(h.timers.size, 0, 'deadline and inactivity timer are both cleared');
    assert.equal(h.api.snapshot().weather, before.weather);
    assert.equal(h.api.snapshot().daily, before.daily);
  });
});

test('current and daily enforce a cumulative 16 KB byte cap and recover on the next request', async t => {
  for (const kind of ['current', 'daily']) await t.test(kind, async t => {
    const h = harness(t), before = h.api.snapshot();
    const first = await begin(h, kind);
    first.socket.receive(Buffer.alloc(16 * 1024, 120));
    assert.equal(first.socket.destroyed, false, 'exactly 16 KB is allowed');
    first.socket.receive('é'); // Two UTF-8 bytes, not a character-count limit.
    assert.equal(await first.promise, kind === 'current' ? false : '');
    assert.equal(first.socket.destroyed, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.api.snapshot().weather, before.weather);
    assert.equal(h.api.snapshot().daily, before.daily);
    const second = await begin(h, kind);
    second.socket.receive(response(kind, valid(kind)));
    assert.equal(await second.promise, kind === 'current' ? true : valid(kind));
    assert.equal(h.api.snapshot()[kind === 'current' ? 'weather' : 'daily'], valid(kind));
    assert.equal(h.timers.size, 0);
  });
});

test('the existing 31-field current compatibility and normal 32-field current/43-field daily replies still succeed', async t => {
  const h = harness(t);
  for (const size of [31, 32]) {
    const call = await begin(h, 'current');
    const csv = row('r3', '2026/11/05', '12:00:00', size);
    call.socket.receive(response('current', csv));
    assert.equal(await call.promise, true);
    assert.equal(h.api.snapshot().weather, csv);
  }
  const daily = await begin(h, 'daily');
  daily.socket.receive(response('daily', valid('daily')));
  assert.equal(await daily.promise, valid('daily'));
  assert.equal(h.records.filter(r => r.stream === 'r3').length, 2);
  assert.equal(h.records.filter(r => r.stream === 'mem1').length, 1);
  assert.equal(h.timers.size, 0);
});

test('valid replies without END are accepted consistently on close, error or idle timeout, with no live timers', async t => {
  for (const kind of ['current', 'daily']) for (const ending of ['close', 'error', 'timeout']) await t.test(`${kind} ${ending}`, async t => {
    const h = harness(t);
    const call = await begin(h, kind);
    call.socket.receive(response(kind, valid(kind), false));
    if (ending === 'close') call.socket.remoteClose();
    else if (ending === 'error') call.socket.fail();
    else await h.advance(5000);
    assert.equal(await call.promise, kind === 'current' ? true : valid(kind));
    assert.equal(h.timers.size, 0);
    assert.equal(h.records.length, 1);
    assert.equal(call.socket.destroyed, true);
  });
});

test('future and invalid timestamps preserve raw evidence before rejecting both cache paths, including daily close fallback', async t => {
  for (const kind of ['current', 'daily']) await t.test(kind, async t => {
    const h = harness(t, { realPersistence: true });
    const before = h.api.snapshot();
    const stream = kind === 'current' ? 'r3' : 'mem1';
    for (const [date, ending] of [['2030/01/01', 'END'], ['2030/01/02', 'close'], ['2026/02/30', 'timeout']]) {
      const call = await begin(h, kind);
      const csv = row(stream, date);
      call.socket.receive(response(kind, csv, ending === 'END'));
      if (ending === 'close') call.socket.remoteClose();
      if (ending === 'timeout') await h.advance(5000);
      assert.equal(await call.promise, kind === 'current' ? false : '');
      assert.equal(h.api.snapshot().weather, before.weather);
      assert.equal(h.api.snapshot().daily, before.daily);
      assert.equal(h.api.snapshot().lastPollTime, null);
      assert.equal(h.api.snapshot().lastDailyPollTime, null);
      const recorded = h.records.at(-1);
      assert.equal(recorded.raw, csv);
      assert.equal(recorded.before.weather, before.weather, 'persistence precedes cache acceptance');
      assert.equal(recorded.before.daily, before.daily);
      assert.equal(h.timers.size, 0);
    }
    assert.equal(h.database.status().quarantine.futureRows, 2);
    assert.equal(h.database.latest(stream), null);
    const recovered = await begin(h, kind);
    recovered.socket.receive(response(kind, valid(kind)));
    assert.equal(await recovered.promise, kind === 'current' ? true : valid(kind));
    assert.equal(h.database.status().error, null);
    assert.equal(h.database.latest(stream).raw_line, valid(kind));
  });
});

test('daily cache also rejects a non-09:00 timestamp that the verified MEM1 format cannot accept', async t => {
  const h = harness(t, { realPersistence: true }), before = h.api.snapshot().daily;
  const call = await begin(h, 'daily');
  call.socket.receive(response('daily', row('mem1', '2026/11/05', '08:59:00'), false));
  call.socket.remoteClose();
  assert.equal(await call.promise, '');
  assert.equal(h.api.snapshot().daily, before);
  assert.equal(h.records.length, 1);
  assert.equal(h.database.latest('mem1'), null);
  assert.equal(h.timers.size, 0);
});

test('minute polls share one queued chain through queue waits and retry delays, then allow a fresh poll', async t => {
  const h = harness(t);
  let release;
  const blocker = h.api.runStationTransaction('test queue blocker', () => new Promise(resolve => { release = resolve; }));
  await flush();
  const first = h.api.updateWeatherData();
  for (let i = 0; i < 100; i++) assert.equal(h.api.updateWeatherData(), first);
  await h.advance(120000);
  assert.equal(h.sockets.length, 0, 'only one current chain is queued behind another transaction');
  release(); await blocker; await flush();
  assert.equal(h.sockets.length, 1);
  h.sockets[0].fail(); await flush();
  for (let i = 0; i < 100; i++) assert.equal(h.api.updateWeatherData(), first);
  await h.advance(999); assert.equal(h.sockets.length, 1);
  await h.advance(1); assert.equal(h.sockets.length, 2);
  h.sockets[1].receive(response('current', valid('current')));
  assert.equal(await first, true);
  assert.equal(h.api.snapshot().currentInFlight, false);
  const next = h.api.updateWeatherData();
  assert.notEqual(next, first);
  await flush(); assert.equal(h.sockets.length, 3);
  h.sockets[2].receive(response('current', valid('current')));
  assert.equal(await next, true);
  assert.equal(h.timers.size, 0);
});

test('daily callers share the same queued promise, and synchronous connection failures clear timers and in-flight state', async t => {
  const h = harness(t);
  const first = h.api.fetchDailyDataOnce();
  for (let i = 0; i < 20; i++) assert.equal(h.api.fetchDailyDataOnce(), first);
  await flush();
  assert.equal(h.sockets.length, 1);
  h.sockets[0].receive(response('daily', valid('daily')));
  assert.equal(await first, valid('daily'));
  assert.equal(h.api.snapshot().dailyInFlight, false);
  for (const kind of ['current', 'daily']) {
    const failed = harness(t, { connectError: true });
    const call = await begin(failed, kind);
    assert.equal(await call.promise, kind === 'current' ? false : '');
    assert.equal(failed.timers.size, 0);
    assert.equal(call.socket.destroyed, true);
    assert.equal(failed.api.snapshot().dailyInFlight, false);
  }
});
