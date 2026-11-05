'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { WeatherStore } = require('../lib/weather-store');
const { createPersistence } = require('../lib/weather-persistence');
const { createWeatherRetention, pruneR3Batch } = require('../lib/weather-retention');
const { auditHistoryGaps, historyCompleteness } = require('../lib/weather-history-gaps');
const { interpolateTenMinute } = require('../lib/weather-interpolation');
const layout = require('../config/station-layout.json');
const stationId = layout.station.id;
const quiet = { error() {}, info() {} };
const clock = Date.parse('2026-11-05T02:00:00.000Z');
const cutoff = new Date(clock - 15 * 86400000).toISOString();
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-maintenance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'weather.sqlite');
}
function row(stream, utc, offset = 0) {
  const local = new Date(Date.parse(utc) + 600 * 60000).toISOString();
  return [local.slice(0, 10).replaceAll('-', '/'), local.slice(11, 19), ...layout.streams[stream].fields.map(f =>
    f.sensorKey === '7' ? '1018.2' : String(offset))].join(',');
}
function ingest(store, stream, at, options = {}) {
  return store.importBuffer(row(stream, at) + '\n', { name: options.name || 'test/' + stream + '/' + at,
    stream, verifiedSerial: layout.station.serial, receivedAt: options.receivedAt || at, ...options });
}
function archiveReply(stream, times) { return `MEM ${stream.slice(3)} LAST 8\r\n${times.map(at => row(stream, at)).join('\r\n')}\r\n\\END OF DATA\r\n> `; }
function completeAudit(store) {
  let result;
  do { result = auditHistoryGaps(store.db, stationId, { now: clock, limit: 750 }); } while (!result.checked);
  return result;
}

test('real SQLite retention gates deletion, keeps exact 15-day boundary, and preserves all archives and water', t => {
  const store = new WeatherStore(fixture(t));
  t.after(() => store.close());
  const old = new Date(Date.parse(cutoff) - 1000).toISOString();
  ingest(store, 'r3', old, { receivedAt: new Date(clock).toISOString() });
  ingest(store, 'r3', cutoff);
  ingest(store, 'r3', new Date(Date.parse(cutoff) + 1000).toISOString());
  for (const stream of ['mem2', 'mem3', 'mem4']) ingest(store, stream, old);
  ingest(store, 'mem1', '2026-10-01T23:00:00.000Z');
  store.db.exec("CREATE TABLE water_test(id INTEGER PRIMARY KEY, raw TEXT) STRICT; INSERT INTO water_test VALUES(1,'preserve me');");
  const before = store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE stream='r3'").get().n;
  assert.equal(pruneR3Batch(store.db, { stationId, cutoff }).blocked, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE stream='r3'").get().n, before);
  const result = pruneR3Batch(store.db, { stationId, cutoff, authorized: true, now: clock });
  assert.equal(result.deletedRecords, 1);
  assert.equal(result.deletedObservations, layout.streams.r3.fields.length);
  assert.equal(result.deletedSources, 1);
  assert.deepEqual(store.db.prepare("SELECT observed_at FROM records WHERE stream='r3' ORDER BY observed_at").all().map(r => r.observed_at),
    [cutoff, new Date(Date.parse(cutoff) + 1000).toISOString()]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE stream IN ('mem1','mem2','mem3','mem4')").get().n, 4);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE stream IN ('mem1','mem2','mem3','mem4')").get().n, 4);
  assert.equal(store.db.prepare('SELECT raw FROM water_test').get().raw, 'preserve me');
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('retention preserves shared source bytes and estimate parents; old rejected R3 evidence expires safely', t => {
  const store = new WeatherStore(fixture(t));
  t.after(() => store.close());
  const old = '2026-10-01T00:00:00.000Z';
  const recent = '2026-11-05T00:00:00.000Z';
  const original = row('r3', old) + '\n' + row('r3', recent) + '\n';
  store.importBuffer(original, { name: 'mixed-r3', stream: 'r3', receivedAt: old, verifiedSerial: layout.station.serial });
  ingest(store, 'r3', '2026-10-02T00:00:00.000Z');
  const parent = store.db.prepare("SELECT id FROM records WHERE stream='r3' AND observed_at='2026-10-02T00:00:00.000Z'").get().id;
  const child = store.db.prepare("SELECT id FROM records WHERE stream='r3' AND observed_at=?").get(recent).id;
  store.db.prepare('INSERT INTO record_estimates VALUES(?,?,?,?,?,?)').run(child, parent, parent, 'test', 'dependency', recent);
  store.importBuffer('invalid old row\n', { name: 'old-rejected-r3', stream: 'r3', receivedAt: old, verifiedSerial: layout.station.serial });
  store.importBuffer('invalid mem row\n', { name: 'old-rejected-mem3', stream: 'mem3', receivedAt: old, verifiedSerial: layout.station.serial });
  const result = pruneR3Batch(store.db, { stationId, cutoff, authorized: true, now: clock });
  assert.equal(result.deletedRecords, 1);
  assert.equal(result.deletedRejected, 1);
  assert.deepEqual(Buffer.from(store.db.prepare("SELECT original_bytes FROM sources WHERE name='mixed-r3'").get().original_bytes), Buffer.from(original));
  assert.ok(store.db.prepare('SELECT 1 FROM records WHERE id=?').get(parent));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM rejected_rows r JOIN sources s ON s.id=r.source_id WHERE s.stream='mem3'").get().n, 1);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('pruning is bounded and freed SQLite pages are reused by subsequent inserts', t => {
  const store = new WeatherStore(fixture(t));
  t.after(() => store.close());
  const oldStart = Date.parse('2026-10-01T00:00:00Z');
  for (let i = 0; i < 300; i++) ingest(store, 'r3', new Date(oldStart + i * 60000).toISOString());
  const initialPages = store.db.prepare('PRAGMA page_count').get().page_count;
  const first = pruneR3Batch(store.db, { stationId, cutoff, authorized: true, now: clock });
  assert.equal(first.deletedRecords, 100);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE stream='r3'").get().n, 200);
  for (let i = 0; i < 3; i++) pruneR3Batch(store.db, { stationId, cutoff, authorized: true, now: clock });
  const freed = store.db.prepare('PRAGMA freelist_count').get().freelist_count;
  assert.ok(freed > 100, 'deletion releases reusable database pages');
  for (let i = 0; i < 100; i++) ingest(store, 'r3', new Date(clock - i * 60000).toISOString());
  assert.ok(store.db.prepare('PRAGMA freelist_count').get().freelist_count < freed, 'new readings consume the freed pages');
  assert.ok(store.db.prepare('PRAGMA page_count').get().page_count <= initialPages + 10, 'database does not need a full vacuum to reuse space');
});

test('unresolved history gaps persist across imports and restart and resolve only after measured backfill', t => {
  const filename = fixture(t);
  let p = createPersistence({ WEATHER_DB_PATH: filename }, quiet, { now: () => clock });
  const early = '2026-11-01T00:00:00.000Z';
  const last = '2026-11-05T01:40:00.000Z';
  p.recordHistory('mem3', archiveReply('mem3', [early]));
  assert.match(p.recordHistory('mem3', archiveReply('mem3', [last])).warning, /unresolved history gap/);
  const newer = '2026-11-05T01:50:00.000Z';
  assert.match(p.recordHistory('mem3', archiveReply('mem3', [last, newer])).warning, /unresolved history gap/);
  const before = p.historyStatus().completeness.streams.mem3;
  assert.ok(before.missingIntervals > 500);
  p.close();
  p = createPersistence({ WEATHER_DB_PATH: filename }, quiet, { now: () => clock });
  assert.equal(p.historyStatus().completeness.streams.mem3.missingIntervals, before.missingIntervals);
  p.close();
  const store = new WeatherStore(filename);
  t.after(() => store.close());
  const backfill = [];
  for (let at = Date.parse(early) + 600000; at < Date.parse(last); at += 600000) backfill.push(row('mem3', new Date(at).toISOString()));
  store.importBuffer(backfill.join('\n'), { name: 'manual-backfill', stream: 'mem3', verifiedSerial: layout.station.serial, receivedAt: new Date(clock).toISOString() });
  assert.equal(completeAudit(store).streams.mem3.unresolvedGaps, 0);
});

test('existing archives are audited in bounded pages, and estimates do not count as recovered measurements', t => {
  const store = new WeatherStore(fixture(t));
  t.after(() => store.close());
  ingest(store, 'mem3', '2026-11-05T00:00:00.000Z');
  ingest(store, 'mem3', '2026-11-05T00:20:00.000Z');
  // Simulate an archive created before gap tracking was introduced.
  store.db.exec('DELETE FROM weather_history_gaps');
  assert.equal(auditHistoryGaps(store.db, stationId, { now: clock, limit: 1 }).checked, false);
  assert.equal(completeAudit(store).streams.mem3.missingIntervals, 1);
  interpolateTenMinute(store, '2026-11-05T10:10:00', 'explicit test estimate');
  assert.equal(historyCompleteness(store.db, stationId).streams.mem3.missingIntervals, 1);
  ingest(store, 'mem3', '2026-11-05T00:10:00.000Z');
  assert.equal(historyCompleteness(store.db, stationId).streams.mem3.unresolvedGaps, 0);
});

test('future live and memory rows are quarantined and valid data recovers from older future maxima', t => {
  const filename = fixture(t);
  const legacy = new WeatherStore(filename);
  for (const stream of ['r3', 'mem3', 'mem2']) ingest(legacy, stream, '2030-01-01T00:00:00.000Z', { receivedAt: new Date(clock).toISOString() });
  legacy.close();
  const p = createPersistence({ WEATHER_DB_PATH: filename }, quiet, { now: () => clock });
  t.after(() => p.close());
  assert.equal(p.latest('r3'), null);
  assert.equal(p.historyStatus().streams.mem3, null);
  assert.equal(p.record('r3', row('r3', '2030-01-02T00:00:00.000Z')), null);
  assert.match(p.status().error, /Future/);
  assert.equal(p.record('r3', row('r3', new Date(clock).toISOString())).inserted, 1);
  assert.equal(p.status().error, null);
  assert.equal(p.latest('r3').observed_at, new Date(clock).toISOString());
  const batch = p.recordHistory('mem3', archiveReply('mem3', ['2026-11-05T01:50:00.000Z', '2030-01-02T00:00:00.000Z']));
  assert.equal(batch.quarantined, 1);
  assert.equal(batch.storedThrough, '2026-11-05T01:50:00.000Z');
  assert.equal(p.historyStatus().streams.mem3, '2026-11-05T01:50:00.000Z');
  assert.equal(p.status().quarantine.futureRows, 2);
  const check = new DatabaseSync(filename, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM rejected_rows WHERE reason LIKE 'Future logger timestamp:%'").get().n, 2);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM records WHERE observed_at='2030-01-02T00:00:00.000Z'").get().n, 0);
  assert.ok(check.prepare("SELECT length(original_bytes) AS n FROM sources WHERE name='live/r3' ORDER BY imported_at LIMIT 1").get().n > 0);
  check.close();
});

test('worker performs coverage checks while backup-gated, coalesces requests, and stops pruning when gate closes', async t => {
  const filename = fixture(t);
  const store = new WeatherStore(filename);
  t.after(() => store.close());
  for (let i = 0; i < 220; i++) ingest(store, 'r3', new Date(Date.parse('2026-10-01T00:00:00Z') + i * 60000).toISOString());
  let gateCalls = 0;
  let allow = false;
  const maintenance = createWeatherRetention({ WEATHER_DB_PATH: filename }, { isReady: () => true,
    canPrune: () => { gateCalls++; return allow && gateCalls < 3; }, logger: quiet, now: () => clock });
  t.after(() => maintenance.close());
  const first = maintenance.run();
  assert.equal(maintenance.run(), first, 'coalesce overlapping maintenance requests');
  assert.equal((await first).blocked, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE stream='r3'").get().n, 220);
  assert.equal(maintenance.status().completeness[stationId].checked, true);
  allow = true;
  const second = await maintenance.run();
  assert.equal(second.deletedRecords, 100);
  assert.equal(second.blocked, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE stream='r3'").get().n, 120);
  assert.equal(maintenance.status().running, false);
  assert.equal(maintenance.status().totals.deletedRecords, 100);
  assert.equal(maintenance.status().totals.cutoff, cutoff);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('coverage checks ignore deliberately excluded pre-format history and recheck offline backfills after restart', t => {
  const filename = fixture(t);
  let store = new WeatherStore(filename);
  ingest(store, 'mem3', '2020-01-01T00:00:00.000Z');
  ingest(store, 'mem3', '2026-11-05T00:00:00.000Z');
  ingest(store, 'mem3', '2026-11-05T00:20:00.000Z');
  store.setQualityPolicy(require('../config/data-quality.json'));
  assert.equal(completeAudit(store).streams.mem3.missingIntervals, 1);
  // An older application would insert the record without a ledger update.
  ingest(store, 'mem3', '2026-11-05T00:10:00.000Z');
  store.db.prepare('INSERT INTO weather_history_gaps VALUES(?,?,?,?,?,?,?,?)').run(stationId, 'mem3',
    '2026-11-05T00:00:00.000Z', '2026-11-05T00:20:00.000Z', 600, 1, new Date(clock).toISOString(), new Date(clock).toISOString());
  store.close();
  store = new WeatherStore(filename);
  t.after(() => store.close());
  assert.equal(historyCompleteness(store.db, stationId).checked, false);
  assert.equal(completeAudit(store).streams.mem3.unresolvedGaps, 0);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
});

test('a clock corrected backwards recovers valid memory rows even while future rows remain in the logger tail', t => {
  const filename = fixture(t);
  const p = createPersistence({ WEATHER_DB_PATH: filename }, quiet, { now: () => clock });
  t.after(() => p.close());
  const bad = '2030-01-01T00:00:00.000Z';
  const fresh = '2026-11-05T01:50:00.000Z';
  const result = p.recordHistory('mem3', archiveReply('mem3', [bad, fresh]));
  assert.equal(result.quarantined, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.storedThrough, fresh);
  assert.equal(p.historyStatus().streams.mem3, fresh);
  assert.equal(p.historyStatus().completeness.streams.mem3.unresolvedGaps, 0);
  assert.match(p.recordHistory('mem3', archiveReply('mem3', [bad, fresh])).warning, /future logger/);
  assert.equal(p.recordHistory('mem3', archiveReply('mem3', [fresh, new Date(clock).toISOString()])).warning, null);
  assert.equal(p.status().error, null);
});

test('future timestamp boundary is exact and old identical live sources cannot bypass the clock guard', t => {
  const filename = fixture(t);
  const store = new WeatherStore(filename);
  const future = '2030-01-01T00:00:00.000Z';
  ingest(store, 'r3', future, { name: 'live/r3', receivedAt: new Date(clock).toISOString() });
  const tolerated = store.ingestLive('r3', row('r3', new Date(clock + 90_000).toISOString()), new Date(clock).toISOString());
  const rejected = store.ingestLive('r3', row('r3', new Date(clock + 91_000).toISOString()), new Date(clock).toISOString());
  assert.equal(tolerated.inserted, 1);
  assert.equal(rejected.quarantined, 1);
  store.close();
  const p = createPersistence({ WEATHER_DB_PATH: filename }, quiet, { now: () => clock });
  t.after(() => p.close());
  assert.equal(p.record('r3', row('r3', future)), null);
  assert.match(p.status().error, /Future/);
  assert.equal(p.latest('r3').observed_at, new Date(clock + 90_000).toISOString());
});
