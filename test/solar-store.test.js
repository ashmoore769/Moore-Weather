'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SolarStore, SOURCE, MAX_DAILY_SAMPLES } = require('../lib/solar-store');
const { validateBatch, DAY, MINUTE, localDay } = require('../lib/solar-data');
const { createRecoveryBundle, restoreRecoveryBundle } = require('../lib/recovery-backup');

const NOW = Date.parse('2026-11-14T02:00:00.000Z');
function sample(at = NOW - MINUTE, overrides = {}) {
  const iso = new Date(at).toISOString();
  return { observedAt: iso, collectedAt: iso, pvPowerW: 1000, inverterPowerW: 950, gridPowerW: null,
    loadPowerW: null, batteryPowerW: null, batterySocPercent: null, totalAcEnergyWh: 100000,
    meterLocation: null, mode: 'produce-only', ...overrides };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'weather.sqlite');
  const original = new DatabaseSync(filename);
  original.exec("PRAGMA user_version=3; CREATE TABLE weather_original(value TEXT); INSERT INTO weather_original VALUES('preserved');");
  original.close();
  const store = new SolarStore(filename);
  t.after(() => { try { store.close(); } catch {} });
  return { directory, filename, store };
}

test('solar ingestion is durable and idempotent; out-of-order or duplicate observations cannot replace current', t => {
  const { store, filename } = fixture(t);
  const newest = sample(), oldest = sample(NOW - 2 * MINUTE);
  assert.deepEqual(store.save([newest, oldest], NOW), { accepted: 2, duplicates: 0 });
  assert.deepEqual(store.save([newest, { ...newest, pvPowerW: 999999 }], NOW + MINUTE), { accepted: 0, duplicates: 2 });
  assert.equal(store.latest().pvPowerW, newest.pvPowerW);
  assert.equal(store.latest().observedAt, newest.observedAt);
  assert.equal(store.latest().receivedAt, new Date(NOW).toISOString());
  store.close();
  const reopened = new SolarStore(filename);
  try {
    assert.equal(reopened.latest().observedAt, newest.observedAt);
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(reopened.db.prepare('SELECT value FROM weather_original').get().value, 'preserved');
  } finally { reopened.close(); }
});

test('solar storage cannot silently create a replacement for a missing weather database', t => {
  const { directory } = fixture(t);
  const missing = path.join(directory, 'missing.sqlite');
  assert.throws(() => new SolarStore(missing));
  assert.equal(fs.existsSync(missing), false);
});

test('a failed sample transaction acknowledges nothing and rolls back earlier rows in that batch', t => {
  const { store } = fixture(t);
  store.db.exec(`CREATE TRIGGER reject_solar BEFORE INSERT ON solar_samples
    WHEN NEW.pvPowerW=999 BEGIN SELECT RAISE(ABORT,'test storage failure'); END;`);
  assert.throws(() => store.save([sample(), sample(NOW, { pvPowerW: 999 })], NOW), /test storage failure/);
  assert.equal(store.latest(), null);
});

test('ninety-day solar retention is bounded and cannot touch weather data or another source', t => {
  const { store } = fixture(t);
  // Populate through the storage layer to simulate already-retained history;
  // the HTTP validator deliberately accepts only fourteen days of replay.
  store.save([sample(NOW - 91 * DAY), sample(NOW - 89 * DAY)], NOW - 89 * DAY);
  store.db.prepare(`INSERT INTO solar_samples SELECT 'other-source',observed_at,collected_at,received_at,
    pvPowerW,inverterPowerW,gridPowerW,loadPowerW,batteryPowerW,batterySocPercent,totalAcEnergyWh,meterLocation,mode
    FROM solar_samples WHERE source_id=? LIMIT 1`).run(SOURCE);
  store.save([sample()], NOW);
  const own = store.db.prepare('SELECT observed_at FROM solar_samples WHERE source_id=? ORDER BY observed_at').all(SOURCE);
  assert.deepEqual(own.map(row => row.observed_at), [NOW - 89 * DAY, NOW - MINUTE]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM solar_samples WHERE source_id=?').get('other-source').n, 1);
  assert.equal(store.db.prepare('SELECT value FROM weather_original').get().value, 'preserved');
});

test('atomic daily growth limit admits duplicates and other days without letting a bad producer exhaust storage', t => {
  const { store } = fixture(t), { start } = localDay(NOW);
  const rows = Array.from({ length: MAX_DAILY_SAMPLES }, (_, index) => sample(start + index));
  assert.deepEqual(store.save(rows, NOW), { accepted: MAX_DAILY_SAMPLES, duplicates: 0 });
  assert.deepEqual(store.save([rows[0], rows[0]], NOW), { accepted: 0, duplicates: 2 });
  const previousDay = sample(start - MINUTE), excessive = sample(start + MAX_DAILY_SAMPLES);
  assert.throws(() => store.save([previousDay, excessive], NOW), error => error.code === 'SOLAR_DAILY_LIMIT');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM solar_samples').get().count, MAX_DAILY_SAMPLES,
    'over-limit batch must not partially insert another day');
  assert.deepEqual(store.save([previousDay], NOW), { accepted: 1, duplicates: 0 });
  assert.equal(store.snapshot(NOW).current.observedAt, rows.at(-1).observedAt, 'daily reads remain available at capacity');
});

test('solar freshness uses the displayed observation and optional history preserves null gaps and DC/AC meaning', t => {
  const { store } = fixture(t), { start } = localDay(NOW);
  assert.equal(store.snapshot(NOW).status, 'waiting');
  const samples = [sample(start + MINUTE, { pvPowerW: 0, inverterPowerW: null }),
    sample(start + 2 * MINUTE, { pvPowerW: 1000, inverterPowerW: 900 }), sample()];
  store.save(validateBatch({ version: 1, samples }, NOW), NOW);
  assert.equal(store.snapshot(NOW).status, 'fresh');
  assert.equal(store.snapshot(NOW + 5 * MINUTE).status, 'stale');
  assert.equal(store.snapshot(NOW).history, null);
  const points = store.snapshot(NOW, { history: true }).history.points;
  assert.ok(points.length <= 288);
  assert.deepEqual(points[0], { observedAt: new Date(start).toISOString(), pvPowerW: 500, inverterPowerW: 900,
    loadPowerW: null, gridPowerW: null, gridImportPowerW: null, gridExportPowerW: null, solarToHomeW: null, samples: 2,
    firstObservedAt: new Date(start + MINUTE).toISOString(), lastObservedAt: new Date(start + 2 * MINUTE).toISOString(),
    breakBefore: false, hasGap: true });
  assert.equal(points[1].pvPowerW, null);
  assert.equal(points[1].inverterPowerW, null);
  assert.equal(points[1].samples, 0);
  store.save([sample(NOW + MINUTE)], NOW);
  assert.equal(store.snapshot(NOW).status, 'stale', 'accepted clock skew must not appear live');
});

test('the unchanged encrypted recovery format restores solar tables, committed WAL, and existing weather rows', async t => {
  const { directory, filename, store } = fixture(t);
  store.db.exec('PRAGMA wal_autocheckpoint=0;');
  const reading = sample();
  store.save([sample(NOW - 2 * MINUTE), reading], NOW);
  assert.ok(JSON.parse(store.db.prepare('SELECT summary_json FROM solar_daily WHERE source_id=?').get(SOURCE).summary_json).generatedAcWh > 0);
  const env = { WEATHER_DB_PATH: filename, WEATHER_BACKUP_DIR: path.join(directory, 'backups'),
    WEATHER_ALERTS_ENABLED: 'false', ACCESS_REQUESTS_ENABLED: 'false',
    WEATHER_BACKUP_ENCRYPTION_KEY: 'offline-solar-test-recovery-secret-with-32-characters' };
  const result = await createRecoveryBundle({ env });
  const destination = path.join(directory, 'restored');
  await restoreRecoveryBundle(path.join(env.WEATHER_BACKUP_DIR, result.file), destination,
    { secret: env.WEATHER_BACKUP_ENCRYPTION_KEY });
  const restored = new SolarStore(path.join(destination, 'weather.sqlite'));
  try {
    assert.equal(restored.latest().observedAt, reading.observedAt);
    assert.equal(restored.latest().pvPowerW, reading.pvPowerW);
    assert.deepEqual(restored.db.prepare('SELECT * FROM solar_daily ORDER BY local_date').all(),
      store.db.prepare('SELECT * FROM solar_daily ORDER BY local_date').all(), 'daily archives are part of the same encrypted recovery database');
    assert.equal(restored.db.prepare('SELECT value FROM weather_original').get().value, 'preserved');
    assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version, 3);
  } finally { restored.close(); }
});

test('daily archives recompute late midnight data idempotently and lightweight polls omit history', t => {
  const { store } = fixture(t), { start } = localDay(NOW);
  const flow = (at, gridPowerW) => sample(at, { inverterPowerW: 2000, loadPowerW: 1000, gridPowerW,
    meterLocation: 'grid', mode: 'meter' });
  const readDay = date => JSON.parse(store.db.prepare('SELECT summary_json FROM solar_daily WHERE source_id=? AND local_date=?').get(SOURCE, date).summary_json);
  const previous = flow(start - MINUTE, 1000), next = flow(start + MINUTE, -1000);
  store.save([next, previous], NOW);
  assert.ok(Math.abs(readDay(localDay(start - DAY).date).gridImportWh - 25 / 3) < 1e-8);
  assert.ok(Math.abs(readDay(localDay(start).date).gridExportWh - 25 / 3) < 1e-8);
  const midnight = flow(start, 1000);
  store.save([midnight], NOW);
  const previousArchive = readDay(localDay(start - DAY).date), currentArchive = readDay(localDay(start).date);
  assert.ok(Math.abs(previousArchive.gridImportWh - 50 / 3) < 1e-8);
  assert.ok(Math.abs(currentArchive.gridImportWh - 25 / 6) < 1e-8);
  assert.ok(Math.abs(currentArchive.gridExportWh - 25 / 6) < 1e-8);
  store.save([{ ...midnight, gridPowerW: 9000 }], NOW);
  assert.deepEqual(readDay(localDay(start).date), currentArchive, 'a replay cannot rewrite an accepted interval');
  assert.equal(store.snapshot(NOW).energy.days, null);
  assert.equal(store.snapshot(NOW).history, null);
  const detailed = store.snapshot(NOW, { history: true });
  assert.equal(detailed.energy.days.length, 30);
  assert.deepEqual(detailed.energy.days.at(-1), detailed.energy.today);
  assert.equal(detailed.energy.days[0].netCost, null, 'unrecorded days must not look like zero-cost days');
  assert.equal(detailed.rates.importPerKwh, 0.288948);
});

test('migration backfills existing raw history once and preserves a complete archive after partial raw pruning', t => {
  const { store, filename } = fixture(t), oldStart = localDay(NOW - 90 * DAY).start;
  const flow = at => sample(at, { gridPowerW: 1000, loadPowerW: 2000, inverterPowerW: 1000 });
  store.save([flow(oldStart + 60 * MINUTE), flow(oldStart + 61 * MINUTE),
    flow(oldStart + 13 * 60 * MINUTE), flow(oldStart + 13 * 60 * MINUTE + MINUTE)], oldStart + 14 * 60 * MINUTE);
  // Simulate upgrading a database created by the previous application version.
  store.db.exec('DROP TABLE solar_daily;');
  store.close();
  const migrated = new SolarStore(filename);
  let archive;
  try {
    archive = migrated.db.prepare('SELECT summary_json FROM solar_daily WHERE source_id=? AND local_date=?').get(SOURCE, localDay(oldStart).date).summary_json;
    assert.ok(Math.abs(JSON.parse(archive).gridImportWh - 100 / 3) < 1e-8, 'migration aggregates both retained intervals');
    migrated.save([sample()], NOW);
    assert.equal(migrated.db.prepare('SELECT COUNT(*) AS n FROM solar_samples WHERE source_id=? AND observed_at>=? AND observed_at<?').get(SOURCE, oldStart, oldStart + DAY).n, 2,
      'pruning removed the morning half of the old raw day');
  } finally { migrated.close(); }
  const reopened = new SolarStore(filename);
  try {
    assert.equal(reopened.db.prepare('SELECT summary_json FROM solar_daily WHERE source_id=? AND local_date=?').get(SOURCE, localDay(oldStart).date).summary_json,
      archive, 'a reopen must not overwrite the archive with the smaller retained raw subset');
    reopened.save([sample(NOW + DAY - MINUTE)], NOW + DAY);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM solar_samples WHERE source_id=? AND observed_at>=? AND observed_at<?').get(SOURCE, oldStart, oldStart + DAY).n, 0);
    assert.equal(reopened.db.prepare('SELECT summary_json FROM solar_daily WHERE source_id=? AND local_date=?').get(SOURCE, localDay(oldStart).date).summary_json,
      archive, 'daily energy and prices survive expiry of every raw sample');
  } finally { reopened.close(); }
});

test('archive write failures roll back the same batch and cannot acknowledge unstored daily history', t => {
  const { store } = fixture(t);
  store.db.exec(`CREATE TRIGGER reject_daily BEFORE INSERT ON solar_daily BEGIN SELECT RAISE(ABORT,'archive write failure'); END;`);
  assert.throws(() => store.save([sample()], NOW), /archive write failure/);
  assert.equal(store.latest(), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM solar_daily').get().n, 0);
});

test('graph bins keep purchase/export directions separate and expose gaps between nonempty neighbors', t => {
  const { store } = fixture(t), { start } = localDay(NOW);
  const flow = (at, gridPowerW, extra = {}) => sample(at, { gridPowerW, loadPowerW: 1000, inverterPowerW: 1000, ...extra });
  store.save([flow(start + MINUTE, 1000), flow(start + 9 * MINUTE, -1000),
    flow(start + 10 * MINUTE, 1000), flow(start + 11 * MINUTE, -1000),
    flow(start + 12 * MINUTE, null)], NOW);
  const points = store.snapshot(NOW, { history: true }).history.points;
  assert.equal(points[1].breakBefore, true, 'an eight-minute gap is visible even with adjacent nonempty chart bins');
  assert.equal(points[2].gridPowerW, 0);
  assert.equal(points[2].gridImportPowerW, 500); assert.equal(points[2].gridExportPowerW, 500);
  assert.equal(points[2].hasGap, true, 'a missing meter measurement must break a line too');
});

test('snapshot cache is invalidated on committed uploads and does not share mutable results', t => {
  const { store } = fixture(t);
  store.save([sample(NOW - MINUTE)], NOW);
  const first = store.snapshot(NOW, { history: true });
  first.current.pvPowerW = 123456;
  first.energy.days.length = 0;
  const second = store.snapshot(NOW + 1000, { history: true });
  assert.equal(second.current.pvPowerW, 1000); assert.equal(second.energy.days.length, 30);
  store.save([sample(NOW, { pvPowerW: 2000 })], NOW + 1000);
  assert.equal(store.snapshot(NOW + 1000, { history: true }).current.pvPowerW, 2000);
});
