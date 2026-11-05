'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createStationClock, parseStationTime, brisbaneParts, nextClockCheckAt,
  readStationTime, writeStationTime, measuredDrift, clockOffsetBounds, correctionAllowed,
  DRIFT_MS, MAX_CORRECTION_MS, MAX_RTT_MS, IO_TIMEOUT_MS, MAX_REPLY_BYTES, CORRECTION_COOLDOWN_MS
} = require('../lib/station-clock');

// Every transport, timer, time source and queue is injected. These tests never
// import server.js, open a network connection, or contact a physical logger.
const BASE = Date.parse('2026-11-05T02:00:00.000Z'); // Noon in Brisbane.
const flush = () => new Promise(resolve => setImmediate(resolve));
const logger = { info() {}, warn() {}, error() {} };

function fakeClock(start = BASE) {
  let wall = start, elapsed = 0;
  const timers = new Map();
  const setTimer = (fn, delay) => {
    const handle = { unref() {} };
    timers.set(handle, { at: elapsed + delay, fn });
    return handle;
  };
  const clearTimer = handle => timers.delete(handle);
  const move = ms => { wall += ms; elapsed += ms; };
  return {
    now: () => wall, monotonic: () => elapsed, timers, setTimer, clearTimer, move,
    jumpWall(ms) { wall += ms; },
    async advance(ms) {
      const target = elapsed + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        move(next[1].at - elapsed);
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      move(target - elapsed);
      await flush();
    }
  };
}

function socketHarness({ autoConnect = true, writeError = false, connectError = false } = {}) {
  const clock = fakeClock(), sockets = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.writes = []; sockets.push(this); }
    connect(port, host, callback) {
      assert.equal(host, 'offline.invalid'); assert.equal(port, 12345);
      if (connectError) throw new Error('offline connection failure');
      this.connected = callback;
      if (autoConnect) queueMicrotask(callback);
      return this;
    }
    write(value, callback) {
      this.writes.push(value);
      queueMicrotask(() => callback(writeError ? new Error('offline write failure') : null));
      return true;
    }
    receive(value) { this.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value)); }
    destroy() { this.destroyed = true; queueMicrotask(() => this.emit('close')); }
  }
  const options = { host: 'offline.invalid', port: 12345, ...clock, createSocket: () => new Socket() };
  return { clock, sockets, options };
}

function sample(clock, drift = 0, extra = {}) {
  const at = clock.now();
  return { stationAt: at + drift, sentAt: at, receivedAt: at, roundTripMs: 0, ...extra };
}

function delayedSample(clock, { offset = 0, sampledAfter = 0, roundTripMs = 7800 } = {}) {
  const sentAt = clock.now();
  const stationAt = Math.floor((sentAt + sampledAfter + offset) / 1000) * 1000;
  clock.move(roundTripMs);
  return { stationAt, sentAt, receivedAt: clock.now(), roundTripMs };
}

function monitorHarness(t, options = {}) {
  const clock = options.clock || fakeClock();
  const reads = [], writes = [], records = [], verified = [], queueLabels = [], events = [];
  let responses = options.responses || [0];
  const readTime = async transport => {
    assert.equal(transport.host, 'offline.invalid'); assert.equal(transport.port, 12345);
    reads.push(clock.now()); events.push('TIME');
    const response = responses.length > 1 ? responses.shift() : responses[0];
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response() : sample(clock, response);
  };
  const recordCorrection = correction => {
    events.push('record');
    const id = records.length + 1;
    records.push({ ...correction, id });
    return id;
  };
  const verifyCorrection = (id, at) => { events.push('verify'); verified.push({ id, at }); };
  const writeTime = async transport => {
    const command = transport.makeCommand();
    events.push('SETTIME'); writes.push(command);
    return { command, sentAt: clock.now() };
  };
  const runTransaction = async (label, task) => { queueLabels.push(label); return task(); };
  const monitor = createStationClock({ enabled: true, host: 'offline.invalid', port: 12345,
    ...clock, logger, readTime, writeTime, recordCorrection, verifyCorrection, runTransaction,
    ...options, clock: undefined, responses: undefined });
  t.after(() => monitor.stop());
  return { monitor, clock, reads, writes, records, verified, queueLabels, events,
    setResponses(values) { responses = [...values]; } };
}

test('TIME parsing uses Brisbane AEST and requires one complete valid calendar timestamp', () => {
  assert.equal(parseStationTime('TIME\r\n2026/11/05 12:00:00\r\n> '), BASE);
  assert.equal(parseStationTime('> time\r\n> 2028/02/29 00:00:00\r\n\\END OF DATA\r\n'), Date.parse('2028-02-28T14:00:00Z'));
  assert.equal(parseStationTime('2026/01/01 00:00:00'), Date.parse('2025-12-31T14:00:00Z'));
  for (const reply of ['', 'TIME\r\n>', '2026/02/29 12:00:00', '2026/04/31 12:00:00',
    '2026/11/05 24:00:00', '2026/11/05 12:60:00', '2026/11/05 12:00:60',
    '2026/11/05 12:00:', '2026/11/05,12:00:00,1,2,3', 'TIME 2026/11/05 12:00:00',
    '2026/11/05 12:00:00\r\n2026/11/05 12:00:01', '2026/11/05 12:00:00\r\nERROR',
    '2026/11/05 12:00:00\u0000']) assert.throws(() => parseStationTime(reply), /TIME/);
});

test('Brisbane formatting and twice-daily scheduling handle midnight, years and fixed UTC+10', () => {
  assert.deepEqual(brisbaneParts(Date.parse('2026-12-31T14:00:05Z')),
    { date: '2027/01/01', time: '00:00:05', hour: 0, minute: 0, second: 5 });
  for (const month of ['01', '07', '11']) assert.equal(brisbaneParts(Date.parse(`2026-${month}-05T02:00:00Z`)).time, '12:00:00');
  const cases = [
    ['2026-11-04T20:04:59.999Z', '2026-11-04T20:05:00Z'],
    ['2026-11-04T20:05:00Z', '2026-11-05T08:05:00Z'],
    ['2026-11-05T08:05:00Z', '2026-11-05T20:05:00Z'],
    ['2026-12-31T14:00:00Z', '2026-12-31T20:05:00Z'],
    ['2028-02-28T20:05:00Z', '2028-02-29T08:05:00Z']
  ];
  for (const [current, next] of cases) assert.equal(nextClockCheckAt(Date.parse(current)), Date.parse(next));
  for (const value of [NaN, Infinity, undefined]) assert.throws(() => brisbaneParts(value), /clock/);
});

test('drift uses the round-trip midpoint and rejects timing that cannot justify a hardware write', () => {
  assert.equal(measuredDrift({ stationAt: BASE + 11000, sentAt: BASE, receivedAt: BASE + 2000, roundTripMs: 2000 }), 10000);
  assert.equal(measuredDrift({ stationAt: BASE - 9000, sentAt: BASE, receivedAt: BASE + 2000, roundTripMs: 2000 }), -10000);
  const valid = { stationAt: BASE, sentAt: BASE, receivedAt: BASE, roundTripMs: 0 };
  for (const extra of [{ stationAt: NaN }, { sentAt: Infinity }, { roundTripMs: -1 },
    { receivedAt: BASE + MAX_RTT_MS + 1, roundTripMs: MAX_RTT_MS + 1 },
    { receivedAt: BASE - 1 }, { receivedAt: BASE + 1001 }]) {
    assert.throws(() => measuredDrift({ ...valid, ...extra }), /too uncertain/);
  }
});

test('offset bounds account for whole-second timestamps, asymmetric 7.8-second replies and measured clock jitter', () => {
  const cases = [
    { stationAt: BASE, minimumMs: -7800, maximumMs: 1000 },
    { stationAt: BASE + 7000, minimumMs: -800, maximumMs: 8000 }
  ];
  for (const item of cases) {
    const result = clockOffsetBounds({ stationAt: item.stationAt, sentAt: BASE, receivedAt: BASE + 7800, roundTripMs: 7800 });
    assert.equal(result.minimumMs, item.minimumMs); assert.equal(result.maximumMs, item.maximumMs);
    assert.equal(result.estimatedMs, (item.minimumMs + item.maximumMs) / 2);
  }
  const jitter = clockOffsetBounds({ stationAt: BASE, sentAt: BASE, receivedAt: BASE + 7800, roundTripMs: 7700 });
  assert.equal(jitter.minimumMs, -7900); assert.equal(jitter.maximumMs, 1100);
  assert.throws(() => clockOffsetBounds({ stationAt: BASE, sentAt: BASE, receivedAt: BASE + 7800, roundTripMs: 6799 }), /uncertain/);
  assert.throws(() => clockOffsetBounds({ stationAt: BASE, sentAt: BASE, receivedAt: BASE + MAX_RTT_MS + 1,
    roundTripMs: MAX_RTT_MS + 1 }), /uncertain/);
});

test('a healthy clock with 7.8 seconds of request-side or response-side buffering needs no SETTIME', async t => {
  for (const sampledAfter of [0, 7800]) {
    const clock = fakeClock();
    const h = monitorHarness(t, { clock, readTime: async () => delayedSample(clock, { sampledAfter }) });
    const result = await h.monitor.check();
    assert.equal(result.status, 'in-sync');
    assert.equal(result.lastVerifiedAt, new Date(BASE + 7800).toISOString());
    assert.equal(h.writes.length, 0); assert.equal(h.records.length, 0);
  }
});

test('definite 75-second drift through the slow gateway is corrected once and independently verified', async t => {
  for (const initialOffset of [-75000, 75000]) {
    const clock = fakeClock(), commands = [];
    let offset = initialOffset, readCount = 0;
    const h = monitorHarness(t, { clock,
      readTime: async () => { readCount++; return delayedSample(clock, { offset }); },
      async writeTime(options) {
        const command = options.makeCommand(); commands.push(command);
        offset = Math.floor(clock.now() / 1000) * 1000 - clock.now();
        return { command, sentAt: clock.now() };
      }
    });
    const result = await h.monitor.check();
    assert.equal(result.status, 'corrected'); assert.equal(readCount, 2);
    assert.deepEqual(commands, ['SETTIME 12 00 07']);
    assert.equal(h.records.length, 1); assert.equal(h.verified.length, 1);
    assert.equal(h.verified[0].at, new Date(BASE + 15600).toISOString());
  }
});

test('an ambiguous offset interval or unsafe possible five-minute offset cannot authorize correction', async t => {
  for (const offset of [12000, -4000, 300000]) {
    const clock = fakeClock();
    const h = monitorHarness(t, { clock, readTime: async () => delayedSample(clock, { offset }) });
    const result = await h.monitor.check();
    assert.equal(result.status, 'warning'); assert.equal(result.lastVerifiedAt, null);
    assert.equal(h.writes.length, 0); assert.equal(h.records.length, 0);
  }
});

test('post-write verification requires the complete interval within both 10-second boundaries', async t => {
  for (const item of [
    { delay: 1000, stationOffset: 10000, accepted: true },
    { delay: 999, stationOffset: 10000, accepted: false },
    { delay: 1000, stationOffset: -9000, accepted: true },
    { delay: 1001, stationOffset: -9000, accepted: false }
  ]) {
    const clock = fakeClock();
    const h = monitorHarness(t, { clock, responses: [20000, () => {
      clock.move(item.delay);
      return sample(clock, 0, { stationAt: BASE + item.stationOffset });
    }] });
    const result = await h.monitor.check();
    assert.equal(result.status, item.accepted ? 'corrected' : 'warning');
    assert.equal(h.writes.length, 1); assert.equal(h.records.length, 1);
    assert.equal(h.verified.length, item.accepted ? 1 : 0);
    assert.equal(result.lastVerifiedAt !== null, item.accepted);
  }
});

test('correction guards reject date changes, large steps and daily rollover crossings in either direction', () => {
  assert.doesNotThrow(() => correctionAllowed(BASE, BASE + MAX_CORRECTION_MS));
  assert.doesNotThrow(() => correctionAllowed(BASE, BASE - MAX_CORRECTION_MS));
  assert.throws(() => correctionAllowed(BASE, BASE + MAX_CORRECTION_MS + 1), /five minutes/);
  assert.throws(() => correctionAllowed(BASE, BASE - 86400000), /calendar date/);
  for (const local of ['00:01:00', '23:59:00', '08:59:00', '09:01:00']) {
    const at = parseStationTime('2026/11/05 ' + local);
    assert.throws(() => correctionAllowed(at, at + 10000), /boundary/);
  }
  const before = parseStationTime('2026/11/05 08:57:30'), after = parseStationTime('2026/11/05 09:02:30');
  assert.throws(() => correctionAllowed(before, after), /cross.*9 am/);
  assert.throws(() => correctionAllowed(after, before), /cross.*9 am/);
});

test('TIME transport joins fragmented replies, measures actual send/receive time and clears all resources', async () => {
  const h = socketHarness();
  const pending = readStationTime(h.options);
  await flush();
  const socket = h.sockets[0];
  assert.deepEqual(socket.writes, ['TIME\r\n']);
  socket.receive('TIME\r\n2026/11/05 12:00:');
  await h.clock.advance(120);
  socket.receive('00\r\n> ');
  assert.deepEqual(await pending, { stationAt: BASE, sentAt: BASE, receivedAt: BASE + 120, roundTripMs: 120 });
  assert.equal(socket.destroyed, true); assert.equal(h.clock.timers.size, 0);
});

test('TIME transport has a total deadline despite trickle traffic and counts bytes rather than characters', async t => {
  for (const mode of ['deadline', 'bytes', 'truncated']) await t.test(mode, async () => {
    const h = socketHarness();
    const result = readStationTime(h.options).then(value => ({ value }), error => ({ error }));
    await flush(); const socket = h.sockets[0];
    if (mode === 'deadline') {
      for (let step = 0; step < 3; step++) { await h.clock.advance(2000); socket.receive('x'); }
      await h.clock.advance(IO_TIMEOUT_MS - 6000);
    } else if (mode === 'bytes') {
      socket.receive(Buffer.alloc(MAX_REPLY_BYTES, 120));
      assert.equal(socket.destroyed, false);
      socket.receive('é');
    } else { socket.receive('TIME\r\n2026/11/05 12:00:'); socket.emit('close'); }
    assert.match((await result).error.message, mode === 'deadline' ? /timed out/ : mode === 'bytes' ? /size limit/ : /malformed/);
    assert.equal(socket.destroyed, true); assert.equal(h.clock.timers.size, 0);
  });
});

test('socket creation, connect, write and connection failures settle once without leaked timers', async t => {
  for (const mode of ['create', 'connect', 'write', 'error', 'empty-close']) await t.test(mode, async () => {
    const h = socketHarness({ connectError: mode === 'connect', writeError: mode === 'write' });
    const options = { ...h.options, ...(mode === 'create' ? { createSocket() { throw Error('offline constructor failure'); } } : {}) };
    const pending = readStationTime(options).then(value => ({ value }), error => ({ error }));
    await flush();
    if (mode === 'error') h.sockets[0].emit('error', Error('offline peer failure'));
    if (mode === 'empty-close') h.sockets[0].emit('close');
    assert.ok((await pending).error);
    assert.equal(h.clock.timers.size, 0);
    if (h.sockets.length) assert.equal(h.sockets[0].destroyed, true);
  });
});

test('SETTIME is constructed at connection time, accepts only the fixed command shape and rejects explicit errors', async () => {
  const h = socketHarness({ autoConnect: false });
  let constructed = 0;
  const pending = writeStationTime({ ...h.options, makeCommand() {
    constructed++; return 'SETTIME ' + brisbaneParts(h.clock.now()).time.replaceAll(':', ' ');
  } });
  assert.equal(constructed, 0); assert.deepEqual(h.sockets[0].writes, []);
  await h.clock.advance(2500); h.sockets[0].connected(); await flush();
  assert.deepEqual(h.sockets[0].writes, ['SETTIME 12 00 02\r\n']);
  await h.clock.advance(750);
  assert.deepEqual(await pending, { sentAt: BASE + 2500, command: 'SETTIME 12 00 02' });
  assert.equal(constructed, 1); assert.equal(h.clock.timers.size, 0);
  for (const command of ['SETDATE 2026 11 05', 'SETTIME 24 00 00', 'SETTIME 12 60 00', 'SETTIME 12 00 60', 'SETTIME 12 00 00\r\nTIME']) {
    const bad = socketHarness();
    await assert.rejects(writeStationTime({ ...bad.options, makeCommand: () => command }), /command is invalid/);
    assert.deepEqual(bad.sockets[0].writes, []); assert.equal(bad.clock.timers.size, 0);
  }
  const refused = socketHarness();
  const result = writeStationTime({ ...refused.options, makeCommand: () => 'SETTIME 12 00 00' }).catch(error => error);
  await flush(); refused.sockets[0].receive('SETTIME 12 00 00\r\nInvalid command\r\n');
  assert.match((await result).message, /rejected SETTIME/); assert.equal(refused.clock.timers.size, 0);
});

test('clock intervals wholly inside tolerance are read-only; definite positive and negative drift require verified correction', async t => {
  for (const drift of [-DRIFT_MS, 0, DRIFT_MS - 1000]) {
    const h = monitorHarness(t, { responses: [drift] });
    const result = await h.monitor.check();
    assert.equal(result.status, 'in-sync'); assert.equal(result.driftSeconds, (drift + 500) / 1000);
    assert.equal(result.driftMinimumSeconds, drift / 1000);
    assert.equal(result.driftMaximumSeconds, (drift + 1000) / 1000);
    assert.equal(h.writes.length, 0); assert.equal(h.records.length, 0); assert.equal(result.running, false);
  }
  for (const drift of [-DRIFT_MS - 1001, DRIFT_MS + 1, -120000, 120000]) {
    const h = monitorHarness(t, { responses: [drift, 1000] });
    const result = await h.monitor.check();
    assert.equal(result.status, 'corrected'); assert.equal(result.driftSeconds, 1.5);
    assert.deepEqual(h.writes, ['SETTIME 12 00 00']);
    assert.equal(h.records[0].adjustmentMs, -(drift + 500));
    assert.deepEqual(h.verified, [{ id: 1, at: new Date(BASE).toISOString() }]);
    assert.deepEqual(h.events, ['TIME', 'record', 'SETTIME', 'TIME', 'verify']);
    assert.equal(h.queueLabels.length, 1, 'the read, write and verification share one queue transaction');
  }
});

test('uncertain, invalid, large and wrong-date measurements cannot issue a SETTIME command', async t => {
  const cases = [new Error('malformed TIME'), MAX_CORRECTION_MS + 1, -86400000,
    () => ({ stationAt: BASE + 10000, sentAt: BASE, receivedAt: BASE + MAX_RTT_MS + 1, roundTripMs: MAX_RTT_MS + 1 }),
    () => ({ stationAt: BASE + 10000, sentAt: BASE, receivedAt: BASE + 1001, roundTripMs: 0 })];
  for (const response of cases) {
    const h = monitorHarness(t, { responses: [response] });
    const result = await h.monitor.check();
    assert.equal(result.status, 'warning'); assert.equal(result.lastVerifiedAt, null);
    assert.equal(h.writes.length, 0); assert.equal(h.records.length, 0);
  }
});

test('queue waits and connection waits cannot make SETTIME stale; callers share one complete cycle', async t => {
  const clock = fakeClock();
  let releaseQueue, releaseConnection, queuedTask, queueCalls = 0, command;
  const h = monitorHarness(t, { clock, responses: [20000, 0],
    runTransaction(_label, task) {
      queueCalls++; queuedTask = task;
      return new Promise(resolve => { releaseQueue = () => resolve(task()); });
    },
    writeTime(options) { return new Promise(resolve => { releaseConnection = () => {
      command = options.makeCommand(); resolve({ command, sentAt: clock.now() });
    }; }); }
  });
  const pending = h.monitor.check('test');
  for (let i = 0; i < 20; i++) assert.equal(h.monitor.check('duplicate'), pending);
  await flush(); assert.equal(queueCalls, 1); assert.equal(typeof queuedTask, 'function');
  clock.move(45000); releaseQueue(); await flush();
  assert.equal(h.reads[0], BASE + 45000);
  clock.move(2500); releaseConnection();
  const result = await pending;
  assert.equal(command, 'SETTIME 12 00 47');
  assert.equal(h.records[0].at, new Date(BASE + 47500).toISOString());
  assert.equal(h.records[0].adjustmentMs, -20500);
  assert.equal(result.status, 'corrected'); assert.equal(result.running, false);
});

test('startup enqueues the whole clock cycle before an immediate CURRENT request without overlap', async t => {
  const clock = fakeClock(), enqueued = [], events = [];
  let tail = Promise.resolve(), active = 0, readCount = 0, releaseTime;
  const runTransaction = (label, task) => {
    enqueued.push(label);
    const run = tail.then(async () => {
      active++;
      assert.equal(active, 1, 'only one station transaction may be active');
      events.push('start ' + label);
      try { return await task(); }
      finally { events.push('finish ' + label); active--; }
    });
    tail = run.catch(() => {});
    return run;
  };
  const h = monitorHarness(t, { clock, runTransaction,
    readTime() {
      events.push('TIME');
      if (++readCount === 1) return new Promise(resolve => { releaseTime = () => resolve(sample(clock, 20000)); });
      return Promise.resolve(sample(clock));
    },
    async writeTime(options) {
      const command = options.makeCommand();
      events.push('SETTIME');
      return { command, sentAt: clock.now() };
    }
  });
  h.monitor.start();
  const startup = h.monitor.check('join startup');
  const current = runTransaction('CURRENT r3', async () => { events.push('r3'); return 'weather'; });
  assert.deepEqual(enqueued, ['CLOCK startup', 'CURRENT r3'], 'startup must enqueue before yielding a microtask');
  await flush();
  assert.deepEqual(events, ['start CLOCK startup', 'TIME']);
  assert.equal(active, 1);
  releaseTime();
  const [result, weather] = await Promise.all([startup, current]);
  assert.equal(result.status, 'corrected'); assert.equal(weather, 'weather');
  assert.deepEqual(events, ['start CLOCK startup', 'TIME', 'SETTIME', 'TIME', 'finish CLOCK startup',
    'start CURRENT r3', 'r3', 'finish CURRENT r3']);
  assert.equal(active, 0);
});

test('a rejected or synchronously throwing queue does not latch the monitor or prevent a later check', async t => {
  let calls = 0;
  const h = monitorHarness(t, { runTransaction(_label, task) {
    calls++;
    if (calls === 1) throw Error('queue failed synchronously');
    if (calls === 2) return Promise.reject(Error('queue rejected'));
    return task();
  } });
  assert.equal((await h.monitor.check()).status, 'warning');
  assert.equal(h.monitor.status().running, false);
  assert.equal((await h.monitor.check()).status, 'warning');
  assert.equal((await h.monitor.check()).status, 'in-sync');
  assert.equal(calls, 3); assert.equal(h.reads.length, 1);
});

test('journal failure prevents the hardware command, and an uncertain write retains intent for later verification', async t => {
  const blocked = monitorHarness(t, { responses: [20000], recordCorrection() { throw Error('journal unavailable'); } });
  assert.equal((await blocked.monitor.check()).status, 'warning');
  assert.equal(blocked.writes.length, 0); assert.equal(blocked.reads.length, 1);

  const journal = [], verified = [], commands = [];
  const uncertain = monitorHarness(t, { responses: [20000],
    recordCorrection(correction) { journal.push({ ...correction, id: 7 }); return 7; },
    verifyCorrection(id, at) { verified.push({ id, at }); },
    writeTime(options) {
      commands.push(options.makeCommand());
      return Promise.reject(Error('connection lost after write'));
    }
  });
  const failed = await uncertain.monitor.check();
  assert.equal(failed.status, 'warning'); assert.equal(failed.lastCorrectionAt, null);
  assert.equal(journal.length, 1); assert.equal(commands.length, 1); assert.equal(verified.length, 0);
  uncertain.monitor.stop();
  const restarted = monitorHarness(t, { clock: uncertain.clock, responses: [0], pendingCorrections: () => journal,
    verifyCorrection(id, at) { verified.push({ id, at }); } });
  assert.equal((await restarted.monitor.check()).status, 'in-sync');
  assert.deepEqual(verified, [{ id: 7, at: new Date(BASE).toISOString() }]);
  assert.equal(restarted.writes.length, 0, 'recovery verifies the existing intent without repeating SETTIME');
});

test('slow journaling or a backward server-clock step preserves intent but prevents a stale SETTIME target', async t => {
  for (const elapsed of [1001, -1, 1000]) {
    const clock = fakeClock(), journal = [];
    const h = monitorHarness(t, { clock, responses: [20000, -1000], recordCorrection(correction) {
      journal.push({ ...correction, id: 17 });
      if (elapsed < 0) clock.jumpWall(elapsed);
      else clock.move(elapsed);
      return 17;
    } });
    const result = await h.monitor.check();
    assert.equal(journal.length, 1, 'the durable intent survives a failed preparation');
    assert.equal(journal[0].at, new Date(BASE).toISOString());
    if (elapsed === 1000) {
      assert.equal(result.status, 'corrected'); assert.equal(result.driftSeconds, -0.5);
      assert.deepEqual(h.writes, ['SETTIME 12 00 00']);
      assert.deepEqual(h.verified, [{ id: 17, at: new Date(BASE + 1000).toISOString() }]);
    } else {
      assert.equal(result.status, 'warning'); assert.match(result.error, /target became stale/);
      assert.equal(h.writes.length, 0); assert.equal(h.reads.length, 1);
      assert.equal(h.verified.length, 0); assert.equal(result.lastCorrectionAt, null);
    }
  }
});

test('a write alone never proves correction; failed or inaccurate verification stays pending', async t => {
  for (const after of [20000, new Error('verification read failed'),
    () => ({ stationAt: BASE, sentAt: BASE, receivedAt: BASE + MAX_RTT_MS + 1, roundTripMs: MAX_RTT_MS + 1 })]) {
    const h = monitorHarness(t, { responses: [20000, after] });
    const result = await h.monitor.check();
    assert.equal(result.status, 'warning'); assert.equal(result.lastCorrectionAt, null); assert.equal(result.lastVerifiedAt, null);
    assert.equal(h.records.length, 1); assert.equal(h.writes.length, 1); assert.equal(h.verified.length, 0);
  }
});

test('an uncertain correction cannot cause repeated writes during cooldown and later recovers', async t => {
  const h = monitorHarness(t, { responses: [20000, new Error('verification lost')] });
  assert.equal((await h.monitor.check()).status, 'warning'); assert.equal(h.writes.length, 1);
  h.setResponses([20000, 0]);
  h.clock.move(CORRECTION_COOLDOWN_MS - 1);
  assert.match((await h.monitor.check()).error, /cooldown/); assert.equal(h.writes.length, 1);
  h.clock.move(1);
  h.setResponses([20000, 0]);
  assert.equal((await h.monitor.check()).status, 'corrected'); assert.equal(h.writes.length, 2);
});

test('a persisted uncertain write restores cooldown after restart while TIME still reports drift', async t => {
  const clock = fakeClock(), journal = [], commands = [], verified = [];
  const recordCorrection = correction => {
    const id = journal.length + 1;
    journal.push({ ...correction, id });
    return id;
  };
  const original = monitorHarness(t, { clock, responses: [20000], recordCorrection,
    writeTime(options) {
      commands.push(options.makeCommand());
      return Promise.reject(Error('write outcome uncertain'));
    }
  });
  assert.equal((await original.monitor.check()).status, 'warning');
  original.monitor.stop();
  assert.equal(journal.length, 1); assert.equal(commands.length, 1);
  clock.move(5 * 60000);
  const restarted = monitorHarness(t, { clock, responses: [20000], recordCorrection,
    pendingCorrections: () => journal,
    verifyCorrection(id, at) { verified.push({ id, at }); }
  });
  assert.match((await restarted.monitor.check()).error, /cooldown/);
  assert.equal(restarted.writes.length, 0); assert.equal(journal.length, 1); assert.equal(verified.length, 0);
  clock.move(CORRECTION_COOLDOWN_MS - 5 * 60000 - 1);
  assert.match((await restarted.monitor.check()).error, /cooldown/);
  assert.equal(restarted.writes.length, 0);
  clock.move(1);
  restarted.setResponses([20000, 0]);
  assert.equal((await restarted.monitor.check()).status, 'corrected');
  assert.deepEqual(restarted.writes, ['SETTIME 12 15 00']);
  assert.equal(journal.length, 2);
  assert.deepEqual(verified, [{ id: 2, at: new Date(BASE + CORRECTION_COOLDOWN_MS).toISOString() }]);
});

test('startup checks once, schedules in AEST, bounds retries and stop clears its timer', async t => {
  const clock = fakeClock(Date.parse('2026-11-04T20:04:00Z'));
  const h = monitorHarness(t, { clock });
  h.monitor.start(); h.monitor.start(); await flush();
  assert.equal(h.reads.length, 1);
  assert.equal(h.monitor.status().nextCheckAt, '2026-11-04T20:05:00.000Z');
  assert.equal(clock.timers.size, 1);
  await clock.advance(60000);
  assert.equal(h.reads.length, 2);
  assert.equal(h.monitor.status().nextCheckAt, '2026-11-05T08:05:00.000Z');
  h.monitor.stop(); assert.equal(clock.timers.size, 0); assert.equal(h.monitor.status().nextCheckAt, null);
  await clock.advance(86400000); assert.equal(h.reads.length, 2);

  const failing = monitorHarness(t, { responses: [new Error('offline TIME')] });
  failing.monitor.start(); await flush();
  assert.equal(failing.monitor.status().nextCheckAt, new Date(BASE + 300000).toISOString());
  await failing.clock.advance(300000);
  assert.equal(failing.monitor.status().nextCheckAt, new Date(BASE + 600000).toISOString());
  await failing.clock.advance(300000);
  assert.equal(failing.reads.length, 3);
  assert.equal(failing.monitor.status().nextCheckAt, '2026-11-05T08:05:00.000Z');
});

test('disabled and stopped monitors do not touch the queue, and stopping queued or connecting work prevents SETTIME', async t => {
  const disabled = monitorHarness(t, { enabled: false });
  disabled.monitor.start(); assert.equal((await disabled.monitor.check()).status, 'disabled');
  assert.equal(disabled.queueLabels.length, 0); assert.equal(disabled.clock.timers.size, 0);

  let release;
  const queued = monitorHarness(t, { runTransaction(_label, task) { return new Promise(resolve => { release = () => resolve(task()); }); } });
  const pending = queued.monitor.check(); await flush(); queued.monitor.stop(); release(); await pending;
  assert.equal(queued.reads.length, 0); assert.equal(queued.writes.length, 0);
  await queued.monitor.check(); assert.equal(queued.reads.length, 0);

  let connect;
  const connecting = monitorHarness(t, { responses: [20000], writeTime(options) {
    return new Promise((resolve, reject) => { connect = () => {
      try { resolve({ command: options.makeCommand() }); } catch (error) { reject(error); }
    }; });
  } });
  const setting = connecting.monitor.check(); await flush(); connecting.monitor.stop(); connect();
  assert.match((await setting).error, /stopped before correction/);
  assert.equal(connecting.records.length, 0); assert.equal(connecting.writes.length, 0);
});
