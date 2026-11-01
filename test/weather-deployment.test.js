'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { createPersistence } = require('../lib/weather-persistence');
const { readRecent, createHistoryCollector } = require('../lib/weather-history-collector');
const { createBackup } = require('../tools/backup-weather-database');
const layout = require('../config/station-layout.json');
const logger = { info() {}, error() {} };
const row = time => ['2026/10/11', time, ...layout.streams.mem3.fields.map(f => f.sensorKey === '7' ? '1020' : '0')].join(',');
const reply = lines => `MEM 3 LAST 8\r\n${lines.join('\r\n')}\r\n\\END OF DATA\r\n> `;
function directory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'weather-deployment-')); }

test('bounded collector validates completion, preserves overlapping history and exposes lost overlap', t => {
  const dir = directory(), db = path.join(dir, 'weather.sqlite');
  const p = createPersistence({ WEATHER_DB_PATH: db }, logger); t.after(() => { p.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(p.recordHistory('mem3', reply([row('10:00:00'), row('10:10:00')])).inserted, 2);
  assert.equal(p.recordHistory('mem3', reply([row('10:00:00'), row('10:10:00')])).inserted, 0);
  const next = p.recordHistory('mem3', reply([row('10:10:00'), row('10:20:00')]));
  assert.equal(next.inserted, 1); assert.equal(next.warning, null);
  assert.match(p.recordHistory('mem3', reply([row('12:00:00')])).warning, /No overlap/);
  assert.throws(() => p.recordHistory('mem3', row('12:10:00')), /incomplete/);
  assert.throws(() => p.recordHistory('mem3', reply([row('12:10:00'), '2026/10/11,12:20:00,1'])), /field count/);
  const read = new DatabaseSync(db, { readOnly: true });
  assert.equal(read.prepare('SELECT COUNT(*) AS n FROM records').get().n, 4); read.close();
});

test('collector staggers requests, avoids concurrent ticks and backs off after errors', async () => {
  const calls = []; let clock = 1000; let complete;
  const collector = createHistoryCollector({ enabled: true, persistence: { status: () => ({ ready: true }), recordHistory: () => ({ inserted: 1, linked: 1, received: 1, replyBytes: 100, firstObservedAt: new Date(clock).toISOString(), lastObservedAt: new Date(clock).toISOString(), storedThrough: new Date(clock).toISOString(), warning: null }) },
    runTransaction: async (label, fn) => { calls.push(label); return fn(); }, host: '127.0.0.1', port: 1, logger, now: () => clock,
    read: () => new Promise(resolve => { complete = resolve; }) });
  const first = collector.tick(); await collector.tick(); assert.equal(calls.length, 1); complete('reply'); await first;
  assert.equal(collector.status().feeds.mem3.error, null);
  const second = collector.tick(); assert.equal(calls.length, 2); complete('reply'); await second;
  collector.stop(); await collector.tick(); assert.equal(calls.length, 2);
  const failing = createHistoryCollector({ enabled: true, persistence: { status: () => ({ ready: true }) }, runTransaction: (label, fn) => fn(), host: '', port: 1, logger, now: () => clock, read: async () => { throw new Error('offline'); } });
  await failing.tick(); assert.equal(failing.status().feeds.mem3.error, 'offline');
  await failing.tick(); assert.equal(failing.status().feeds.mem2.error, 'offline');
  await failing.tick(); await failing.tick();
  let attempts = 0;
  const retries = createHistoryCollector({ enabled: true, persistence: { status: () => ({ ready: true }) }, runTransaction: (label, fn) => fn(), host: '', port: 1, logger, now: () => clock, read: async () => { attempts++; throw new Error('damaged reply'); } });
  for (let i = 0; i < 4; i++) await retries.tick();
  await retries.tick(); assert.equal(attempts, 4);
  clock += 299999; await retries.tick(); assert.equal(attempts, 4);
  clock++; await retries.tick(); await retries.tick(); assert.equal(attempts, 6);
});

test('socket transfer sends a kilobyte-bounded command and rejects partial or oversized replies', async t => {
  let mode = 'ok'; const commands = [];
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', command => {
      commands.push(command.toString());
      if (mode === 'ok') { socket.write(reply([row('10:00:00')]).slice(0, 40)); socket.end(reply([row('10:00:00')]).slice(40)); }
      if (mode === 'partial') socket.end(row('10:00:00'));
      if (mode === 'large') socket.end('x'.repeat(1000));
      if (mode === 'timeout') socket.write('partial');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const options = { host: '127.0.0.1', port: server.address().port, stream: 'mem3', kilobytes: 8, timeoutMs: 1000 };
  assert.match(await readRecent(options), /END OF DATA/); assert.equal(commands[0], 'MEM 3 LAST 8\r\n');
  mode = 'partial'; await assert.rejects(readRecent(options), /completion; \d+ bytes received/);
  mode = 'large'; await assert.rejects(readRecent({ ...options, maxBytes: 100 }), /byte limit/);
  mode = 'timeout'; await assert.rejects(readRecent({ ...options, timeoutMs: 250 }), /time limit; 7 bytes received/);
  assert.throws(() => readRecent({ ...options, kilobytes: 999 }), /Invalid bounded/);
});

test('compressed native backup restores a complete database and skips an unnecessary repeat', async t => {
  const dir = directory(), filename = path.join(dir, 'weather.sqlite'), backups = path.join(dir, 'backups');
  const p = createPersistence({ WEATHER_DB_PATH: filename }, logger); t.after(() => { p.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  p.recordHistory('mem3', reply([row('10:00:00')]));
  const result = await createBackup(filename, backups); assert.equal(result.created, true);
  const restored = path.join(dir, 'restored.sqlite');
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(path.join(backups, result.file))));
  const check = new DatabaseSync(restored, { readOnly: true });
  assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 23); check.close();
  assert.equal((await createBackup(filename, backups)).created, false);
});

test('repeated history reports actual returned rows and empty regular replies preserve saved records', t => {
  const dir = directory(), db = path.join(dir, 'weather.sqlite');
  const p = createPersistence({ WEATHER_DB_PATH: db }, logger);
  t.after(() => { p.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const batch = reply([row('10:00:00'), row('10:10:00')]);
  p.recordHistory('mem3', batch);
  const repeated = p.recordHistory('mem3', batch);
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.inserted, 0);
  assert.equal(repeated.linked, 0);
  assert.equal(repeated.received, 2);
  assert.equal(repeated.replyBytes, Buffer.byteLength(batch));
  assert.equal(repeated.firstObservedAt, '2026-10-11T00:00:00.000Z');
  assert.equal(repeated.lastObservedAt, '2026-10-11T00:10:00.000Z');
  assert.equal(repeated.storedThrough, repeated.lastObservedAt);
  const lastWrite = p.status().lastWrite;
  for (const stream of ['mem1', 'mem2', 'mem3']) {
    const empty = 'MEM ' + stream.slice(3) + ' LAST 8\r\n\\END OF DATA\r\n> ';
    assert.throws(() => p.recordHistory(stream, empty), /Empty mem[123] history response/);
  }
  assert.equal(p.status().lastWrite, lastWrite);
  const emptyEvents = p.recordHistory('mem4', 'MEM 4 LAST 8\r\n\\END OF DATA\r\n> ');
  assert.equal(emptyEvents.received, 0);
  assert.equal(emptyEvents.lastObservedAt, null);
  const read = new DatabaseSync(db, { readOnly: true });
  assert.equal(read.prepare("SELECT COUNT(*) AS n FROM records WHERE stream='mem3'").get().n, 2);
  read.close();
});

test('history continues through the month boundary without replacing earlier records', t => {
  const dir = directory(), db = path.join(dir, 'weather.sqlite');
  const p = createPersistence({ WEATHER_DB_PATH: db }, logger);
  t.after(() => { p.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = row('23:50:00').replace('2026/10/11', '2026/10/31');
  const after = row('00:00:00').replace('2026/10/11', '2026/11/01');
  p.recordHistory('mem3', reply([before]));
  const next = p.recordHistory('mem3', reply([before, after]));
  assert.equal(next.inserted, 1);
  assert.equal(next.received, 2);
  assert.equal(next.warning, null);
  assert.equal(next.lastObservedAt, '2026-10-31T14:00:00.000Z');
  assert.equal(next.storedThrough, next.lastObservedAt);
});

test('collector distinguishes stale source observations from successful transfers and clears on recovery', async t => {
  const dir = directory(), db = path.join(dir, 'weather.sqlite');
  const p = createPersistence({ WEATHER_DB_PATH: db }, logger);
  t.after(() => { p.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const logs = [];
  let batch = reply([row('10:00:00'), row('10:10:00')]);
  let clock = Date.parse('2026-10-11T02:00:00Z');
  p.recordHistory('mem3', batch);
  const collector = createHistoryCollector({
    enabled: true, persistence: p, runTransaction: (label, fn) => fn(), host: '', port: 1,
    logger: { info: message => logs.push(message), error: message => logs.push(message) },
    now: () => clock, read: async () => batch
  });
  await collector.tick();
  let state = collector.status().feeds.mem3;
  assert.equal(state.error, null);
  assert.equal(state.received, 2);
  assert.equal(state.lastObservedAt, '2026-10-11T00:10:00.000Z');
  assert.equal(state.lastSuccess, '2026-10-11T02:00:00.000Z');
  assert.match(state.warning, /Logger history is stale/);
  assert.match(logs[0], /0 new records, 2 received.*identical batch/);
  clock += 10 * 60000;
  batch = reply([row('10:10:00'), row('12:10:00')]);
  await collector.tick();
  state = collector.status().feeds.mem3;
  assert.equal(state.warning, null);
  assert.equal(state.received, 2);
  assert.equal(state.lastObservedAt, '2026-10-11T02:10:00.000Z');
  assert.equal(state.storedThrough, state.lastObservedAt);
});
