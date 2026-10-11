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
  const collector = createHistoryCollector({ enabled: true, persistence: { status: () => ({ ready: true }), recordHistory: () => ({ inserted: 1, linked: 1, warning: null }) },
    runTransaction: async (label, fn) => { calls.push(label); return fn(); }, host: '127.0.0.1', port: 1, logger, now: () => clock,
    read: () => new Promise(resolve => { complete = resolve; }) });
  const first = collector.tick(); await collector.tick(); assert.equal(calls.length, 1); complete('reply'); await first;
  assert.equal(collector.status().feeds.mem3.error, null);
  const second = collector.tick(); assert.equal(calls.length, 2); complete('reply'); await second;
  collector.stop(); await collector.tick(); assert.equal(calls.length, 2);
  const failing = createHistoryCollector({ enabled: true, persistence: { status: () => ({ ready: true }) }, runTransaction: (label, fn) => fn(), host: '', port: 1, logger, now: () => clock, read: async () => { throw new Error('offline'); } });
  await failing.tick(); assert.equal(failing.status().feeds.mem3.error, 'offline');
  await failing.tick(); assert.equal(failing.status().feeds.mem2.error, 'offline');
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
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const options = { host: '127.0.0.1', port: server.address().port, stream: 'mem3', kilobytes: 8, timeoutMs: 1000 };
  assert.match(await readRecent(options), /END OF DATA/); assert.equal(commands[0], 'MEM 3 LAST 8\r\n');
  mode = 'partial'; await assert.rejects(readRecent(options), /completion/);
  mode = 'large'; await assert.rejects(readRecent({ ...options, maxBytes: 100 }), /byte limit/);
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
