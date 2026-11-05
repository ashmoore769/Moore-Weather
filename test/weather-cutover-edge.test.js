'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { WeatherStore, hash, timestamp } = require('../lib/weather-store');
const baseline = require('../config/station-layout.json');
const cutover = require('./fixtures/layout-cutover');
const quality = { ...require('../config/data-quality.json'),
  earliestLocalTimestamp: new Date(Date.parse(cutover.scheduleChangedAt) - 86400000 + 600 * 60000).toISOString().slice(0, 19) };

// Exact committed schema3 from7151c888, before layout cutover metadata/views.
// Keeping the old DDL here makes this a migration test, not a fresh-schema test.
const LEGACY_SCHEMA = String.raw`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, serial TEXT NOT NULL,
  timezone TEXT NOT NULL, utc_offset_minutes INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sensors (
  station_id TEXT NOT NULL REFERENCES stations(id), sensor_key TEXT NOT NULL,
  PRIMARY KEY (station_id, sensor_key)
) STRICT;
CREATE TABLE IF NOT EXISTS layouts (
  id TEXT PRIMARY KEY, station_id TEXT NOT NULL REFERENCES stations(id),
  definition_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY, layout_id TEXT NOT NULL REFERENCES layouts(id),
  stream TEXT NOT NULL, position INTEGER NOT NULL, sensor_key TEXT NOT NULL,
  name TEXT NOT NULL, unit TEXT NOT NULL, aggregation TEXT NOT NULL,
  metadata_json TEXT NOT NULL, UNIQUE(layout_id, stream, position)
) STRICT;
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, format TEXT NOT NULL,
  station_id TEXT NOT NULL REFERENCES stations(id), stream TEXT NOT NULL,
  layout_id TEXT NOT NULL REFERENCES layouts(id), imported_at TEXT NOT NULL,
  original_bytes BLOB NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sources_retention ON sources(station_id, stream, imported_at, id);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, station_id TEXT NOT NULL REFERENCES stations(id),
  stream TEXT NOT NULL, layout_id TEXT NOT NULL REFERENCES layouts(id),
  observed_at TEXT NOT NULL, local_timestamp TEXT NOT NULL,
  interval_start TEXT, reporting_date TEXT, raw_line TEXT NOT NULL,
  diagnostic_message TEXT, received_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS records_time ON records(station_id, stream, observed_at);
CREATE TABLE IF NOT EXISTS observations (
  record_id TEXT NOT NULL REFERENCES records(id), field_id INTEGER NOT NULL REFERENCES fields(id),
  value REAL, raw_value TEXT NOT NULL, quality TEXT NOT NULL CHECK(quality IN ('valid','missing','invalid')),
  PRIMARY KEY(record_id, field_id)
) STRICT;
CREATE INDEX IF NOT EXISTS observations_field ON observations(field_id, record_id);
CREATE TABLE IF NOT EXISTS source_records (
  source_id TEXT NOT NULL REFERENCES sources(id), line_number INTEGER NOT NULL,
  record_id TEXT NOT NULL REFERENCES records(id), PRIMARY KEY(source_id, line_number)
) STRICT;
CREATE INDEX IF NOT EXISTS source_records_record ON source_records(record_id, source_id);
CREATE TABLE IF NOT EXISTS rejected_rows (
  source_id TEXT NOT NULL REFERENCES sources(id), line_number INTEGER NOT NULL,
  raw_line TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(source_id, line_number)
) STRICT;
CREATE TABLE IF NOT EXISTS data_quality_policies (
  station_id TEXT PRIMARY KEY REFERENCES stations(id), earliest_local_timestamp TEXT NOT NULL,
  pressure_min_hpa REAL NOT NULL, pressure_max_hpa REAL NOT NULL,
  note TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sensor_quality_limits (
  station_id TEXT NOT NULL REFERENCES stations(id), sensor_key TEXT NOT NULL,
  minimum REAL NOT NULL, maximum REAL NOT NULL, floor_zero INTEGER NOT NULL CHECK(floor_zero IN (0,1)),
  note TEXT NOT NULL, CHECK(minimum < maximum), PRIMARY KEY(station_id, sensor_key)
) STRICT;
CREATE TABLE IF NOT EXISTS record_estimates (
  record_id TEXT PRIMARY KEY REFERENCES records(id),
  previous_record_id TEXT NOT NULL REFERENCES records(id), next_record_id TEXT NOT NULL REFERENCES records(id),
  method TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS record_estimates_previous ON record_estimates(previous_record_id);
CREATE INDEX IF NOT EXISTS record_estimates_next ON record_estimates(next_record_id);
-- Additive operational metadata deliberately keeps schema version 3. Older
-- application releases can still open the database during a code rollback.
CREATE TABLE IF NOT EXISTS weather_history_gaps (
  station_id TEXT NOT NULL REFERENCES stations(id), stream TEXT NOT NULL CHECK(stream IN ('mem1','mem2','mem3')),
  previous_at TEXT NOT NULL, next_at TEXT NOT NULL, interval_seconds INTEGER NOT NULL,
  missing_intervals INTEGER NOT NULL CHECK(missing_intervals > 0),
  detected_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(previous_at < next_at), PRIMARY KEY(station_id,stream,previous_at,next_at)
) STRICT;
CREATE TABLE IF NOT EXISTS weather_history_audits (
  station_id TEXT NOT NULL REFERENCES stations(id), stream TEXT NOT NULL CHECK(stream IN ('mem1','mem2','mem3')),
  cursor_at TEXT, complete INTEGER NOT NULL CHECK(complete IN (0,1)), updated_at TEXT NOT NULL,
  PRIMARY KEY(station_id,stream)
) STRICT;
CREATE TABLE IF NOT EXISTS weather_quarantine_state (
  station_id TEXT NOT NULL REFERENCES stations(id), stream TEXT NOT NULL,
  future_rows INTEGER NOT NULL, last_received_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
  PRIMARY KEY(station_id,stream)
) STRICT;
CREATE TABLE IF NOT EXISTS weather_maintenance_state (
  station_id TEXT NOT NULL REFERENCES stations(id), task TEXT NOT NULL,
  value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(station_id,task)
) STRICT;
-- Clock intents commit before SETTIME; only a fresh verified readback permits
-- the tightly bounded historical-order exception. Keep this additive for rollback.
CREATE TABLE IF NOT EXISTS weather_clock_corrections (
  id TEXT PRIMARY KEY, station_id TEXT NOT NULL REFERENCES stations(id),
  recorded_at TEXT NOT NULL, station_at TEXT NOT NULL, server_at TEXT NOT NULL,
  adjustment_ms REAL NOT NULL CHECK(adjustment_ms BETWEEN -300000 AND 300000),
  verified_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS weather_clock_pending ON weather_clock_corrections(station_id, recorded_at DESC)
  WHERE verified_at IS NULL;
CREATE INDEX IF NOT EXISTS weather_clock_backward ON weather_clock_corrections(station_id, server_at)
  WHERE verified_at IS NOT NULL AND adjustment_ms < 0;
-- Explicit backward spans account for measured gateway timing uncertainty.
-- A side table preserves older correction rows and avoids altering their schema.
CREATE TABLE IF NOT EXISTS weather_clock_backward_windows (
  correction_id TEXT PRIMARY KEY REFERENCES weather_clock_corrections(id),
  start_at TEXT NOT NULL, end_at TEXT NOT NULL, CHECK(start_at < end_at)
) STRICT;
CREATE VIEW IF NOT EXISTS weather_readings_raw AS
SELECT r.station_id, r.stream, r.observed_at, r.local_timestamp, r.interval_start,
       r.reporting_date, f.sensor_key, f.name, f.unit, f.aggregation,
       o.value, o.raw_value, o.quality, r.id AS record_id, r.layout_id,
       f.id AS field_id, CASE WHEN e.record_id IS NULL THEN 0 ELSE 1 END AS is_estimated,
       e.method AS estimation_method
FROM observations o JOIN records r ON r.id=o.record_id JOIN fields f ON f.id=o.field_id
LEFT JOIN record_estimates e ON e.record_id=r.id;
CREATE VIEW IF NOT EXISTS weather_readings_review AS
SELECT w.*, CASE
  WHEN p.station_id IS NULL THEN NULL
  WHEN w.local_timestamp < p.earliest_local_timestamp THEN 'before-current-format'
  WHEN w.quality != 'valid' THEN 'not-numeric'
  WHEN lim.sensor_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM observations bad JOIN fields bf ON bf.id=bad.field_id
    WHERE bad.record_id=w.record_id AND bf.sensor_key=w.sensor_key
      AND (bad.value < lim.minimum OR bad.value > lim.maximum)
  ) THEN 'outside-sensor-range'
  WHEN w.unit IN ('%', 'VWC %') AND (w.value < 0 OR w.value > 100) THEN 'percentage-out-of-range'
  WHEN w.sensor_key IN ('1','25','26') AND w.unit='km/h' AND w.value < 0 THEN 'negative-wind-speed'
  WHEN w.sensor_key IN ('5','30') AND w.unit='mm' AND w.value < 0 THEN 'negative-rainfall'
  WHEN w.unit='Degs' AND (w.value < 0 OR w.value > 360) THEN 'direction-out-of-range'
  WHEN w.unit IN ('DegC','deg C') AND (w.value < -90 OR w.value > 100) THEN 'temperature-out-of-range'
  WHEN w.sensor_key='7' AND w.unit='hPa' AND EXISTS (
    SELECT 1 FROM observations bad JOIN fields bf ON bf.id=bad.field_id
    WHERE bad.record_id=w.record_id AND bf.sensor_key='7' AND bf.unit='hPa'
      AND (bad.value < p.pressure_min_hpa OR bad.value > p.pressure_max_hpa)
  ) THEN 'pressure-outside-station-range'
  ELSE NULL END AS exclusion_reason
FROM weather_readings_raw w LEFT JOIN data_quality_policies p ON p.station_id=w.station_id
LEFT JOIN sensor_quality_limits lim ON lim.station_id=w.station_id AND lim.sensor_key=w.sensor_key;
CREATE VIEW IF NOT EXISTS weather_readings AS
SELECT w.station_id, w.stream, w.observed_at, w.local_timestamp, w.interval_start,
       w.reporting_date, w.sensor_key, w.name, w.unit, w.aggregation,
       CASE WHEN lim.floor_zero=1 AND w.value<0 THEN 0.0 ELSE w.value END AS value,
       w.raw_value, w.quality, w.record_id, w.layout_id, w.field_id, w.is_estimated, w.estimation_method,
       CASE WHEN lim.floor_zero=1 AND w.value<0 THEN 'solar-zero-floor' ELSE NULL END AS adjustment,
       w.value AS original_value
FROM weather_readings_review w
LEFT JOIN sensor_quality_limits lim ON lim.station_id=w.station_id AND lim.sensor_key=w.sensor_key
WHERE w.exclusion_reason IS NULL AND (w.is_estimated=0 OR NOT EXISTS (
  SELECT 1 FROM records measured WHERE measured.station_id=w.station_id AND measured.stream=w.stream
    AND measured.observed_at=w.observed_at AND NOT EXISTS (
      SELECT 1 FROM record_estimates e WHERE e.record_id=measured.id
    )
));
CREATE VIEW IF NOT EXISTS conflicting_records AS
SELECT station_id, stream, observed_at, COUNT(*) AS variants
FROM records WHERE stream != 'mem0' AND NOT EXISTS (SELECT 1 FROM record_estimates e WHERE e.record_id=records.id)
GROUP BY station_id, stream, observed_at HAVING COUNT(*) > 1;
PRAGMA user_version = 3;
`;

const BASE_ID = hash(JSON.stringify(baseline));
const PARTIAL = Date.parse(cutover.firstNewObservedAt), FIRST = Date.parse(cutover.firstCompleteObservedAt);
const RECEIVED = new Date(FIRST + 600000).toISOString();
const PRECHANGE = new Date(Date.parse(cutover.scheduleChangedAt) - 60000).toISOString();
const OPTIONS = { layoutCutover: cutover };

function legacyFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-cutover-edge-'));
  const filename = path.join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(LEGACY_SCHEMA);
  const station = baseline.station;
  db.prepare('INSERT INTO stations VALUES(?,?,?,?,?)').run(station.id, station.name, station.serial, station.timezone, station.utcOffsetMinutes);
  db.prepare('INSERT INTO layouts VALUES(?,?,?,?)').run(BASE_ID, station.id, JSON.stringify(baseline), PRECHANGE);
  for (const sensor of baseline.sensors) db.prepare('INSERT INTO sensors VALUES(?,?)').run(station.id, sensor.key);
  const insert = db.prepare('INSERT INTO fields(layout_id,stream,position,sensor_key,name,unit,aggregation,metadata_json) VALUES(?,?,?,?,?,?,?,?)');
  for (const [stream, definition] of Object.entries(baseline.streams)) for (const field of definition.fields) {
    insert.run(BASE_ID, stream, field.position, field.sensorKey, field.name, field.unit, field.aggregation, JSON.stringify(field));
  }
  let nextSource = 0, closed = false, opened;
  function add(at, slot77, { receivedAt = RECEIVED, copies = 1 } = {}) {
    const fields = db.prepare("SELECT * FROM fields WHERE layout_id=? AND stream='mem3' ORDER BY position").all(BASE_ID);
    const values = baseline.streams.mem3.fields.map(field => String(field.storageId === 77 ? slot77 : field.sensorKey === '7' ? 1018.2 : 20));
    const local = new Date(at + 600 * 60000).toISOString(), date = local.slice(0, 10).replaceAll('-', '/'), time = local.slice(11, 19);
    const observed = timestamp(date, time, 600);
    const raw = [date, time, ...values].join(',');
    const id = hash(JSON.stringify([station.id, BASE_ID, 'mem3', observed.utc, values]));
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, station.id, 'mem3', BASE_ID, observed.utc,
      observed.local, new Date(Date.parse(observed.utc) - 600000).toISOString(), null, raw, null, receivedAt);
    values.forEach((value, i) => db.prepare('INSERT INTO observations VALUES(?,?,?,?,?)').run(id, fields[i].id, Number(value), value, 'valid'));
    for (let copy = 0; copy < copies; copy++) {
      const name = 'legacy/' + ++nextSource, bytes = Buffer.from(raw + '\r\n'), digest = hash(bytes);
      const source = hash(JSON.stringify([digest, BASE_ID, 'mem3', name]));
      db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)').run(source, digest, name, 'logger', station.id, 'mem3', BASE_ID, receivedAt, bytes);
      db.prepare('INSERT INTO source_records VALUES(?,?,?)').run(source, 1, id);
    }
    return id;
  }
  function close() { if (!closed) { closed = true; db.close(); } }
  t.after(() => { opened?.close(); close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, filename, add, close, adopt: value => { opened = value; } };
}

function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return {
    version: db.prepare('PRAGMA user_version').get().user_version,
    schema: db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
    tables: Object.fromEntries(tables.map(name => [name, db.prepare('SELECT * FROM "' + name + '"').all().map(row =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, ArrayBuffer.isView(value) ? Buffer.from(value).toString('hex') : value]))
    )]))
  };
}

function withStore(t, fixture) {
  fixture.close();
  const store = new WeatherStore(fixture.filename, undefined, OPTIONS);
  fixture.adopt(store);
  store.setQualityPolicy(quality);
  return store;
}

test('schema3 databases with old views acquire the transition exclusion without changing raw evidence', t => {
  const f = legacyFixture(t), id = f.add(PARTIAL, 24.1, { copies: 2 });
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(f.db.prepare("SELECT value FROM weather_readings WHERE record_id=? AND aggregation='S-THETA'").get(id).value, 24.1);
  const before = snapshot(f.db);
  const store = withStore(t, f);
  const raw = store.db.prepare("SELECT value,unit,aggregation FROM weather_readings_raw WHERE record_id=? AND sensor_key='58'").get(id);
  assert.deepEqual({ ...raw }, { value: 24.1, unit: 'DegC', aggregation: 'AVERAGE' });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM weather_readings WHERE record_id=? AND sensor_key='58'").get(id).n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM weather_readings WHERE record_id=?').get(id).n, 22);
  const after = snapshot(store.db);
  assert.deepEqual(after.tables.sources, before.tables.sources);
  assert.deepEqual(after.tables.source_records, before.tables.source_records);
  assert.equal(store.db.prepare('SELECT raw_line FROM records WHERE id=?').get(id).raw_line, before.tables.records[0].raw_line);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('pre-change receipts prevent future-dated legacy wind records from being relabelled as globe', t => {
  const f = legacyFixture(t);
  const future = f.add(FIRST, 67.8, { receivedAt: PRECHANGE, copies: 2 });
  const actual = f.add(FIRST, 26.4);
  const before = snapshot(f.db);
  const store = withStore(t, f);
  assert.equal(store.db.prepare('SELECT layout_id FROM records WHERE id=?').get(future).layout_id, BASE_ID);
  assert.equal(store.db.prepare("SELECT value FROM weather_readings_raw WHERE record_id=? AND aggregation='S-THETA'").get(future).value, 67.8);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM weather_readings_raw WHERE record_id=? AND sensor_key='58'").get(future).n, 0);
  assert.equal(store.db.prepare("SELECT value FROM weather_readings_raw WHERE record_id=? AND sensor_key='58'").get(actual).value, 26.4);
  const after = snapshot(store.db);
  assert.deepEqual(after.tables.sources, before.tables.sources);
  assert.deepEqual(after.tables.source_records, before.tables.source_records);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a failure after partial field repair rolls back records, observations, aliases, metadata and views together', t => {
  const f = legacyFixture(t);
  f.add(PARTIAL, 24.1, { copies: 2 });
  const second = f.add(FIRST, 25.2);
  f.db.exec("CREATE TRIGGER reject_second_remap BEFORE UPDATE OF field_id ON observations WHEN OLD.record_id='" + second +
    "' BEGIN SELECT RAISE(ABORT,'synthetic field remap failure'); END");
  const before = snapshot(f.db);
  f.close();
  assert.throws(() => new WeatherStore(f.filename, undefined, OPTIONS), /synthetic field remap failure/);
  const db = new DatabaseSync(f.filename); f.adopt(db);
  assert.deepEqual(snapshot(db), before, 'A failed constructor must leave the complete old schema and data unchanged');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('inconsistent legacy identities and registered field metadata fail without partial migration', async t => {
  for (const kind of ['record identity', 'field metadata']) await t.test(kind, t => {
    const f = legacyFixture(t), id = f.add(FIRST, 25.2);
    if (kind === 'record identity') {
      const wrong = '0'.repeat(64);
      f.db.exec('BEGIN; PRAGMA defer_foreign_keys=ON;');
      f.db.prepare('UPDATE records SET id=? WHERE id=?').run(wrong, id);
      f.db.prepare('UPDATE observations SET record_id=? WHERE record_id=?').run(wrong, id);
      f.db.prepare('UPDATE source_records SET record_id=? WHERE record_id=?').run(wrong, id);
      f.db.exec('COMMIT');
    } else {
      f.db.prepare("UPDATE fields SET unit='invalid-unit' WHERE layout_id=? AND stream='mem3' AND position=4").run(BASE_ID);
    }
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [], 'Fixture corruption preserves structural foreign keys');
    const before = snapshot(f.db); f.close();
    assert.throws(() => new WeatherStore(f.filename, undefined, OPTIONS), /verified original identity|registered MEM3 fields/);
    const db = new DatabaseSync(f.filename); f.adopt(db);
    assert.deepEqual(snapshot(db), before);
  });
});

test('an inconsistent repair alias is rejected on restart without overwriting its audit evidence', t => {
  const f = legacyFixture(t); f.add(FIRST, 25.2); f.close();
  const migrated = new WeatherStore(f.filename, undefined, OPTIONS);
  let before;
  try {
    assert.equal(migrated.db.prepare('SELECT COUNT(*) AS n FROM weather_layout_repairs').get().n, 1);
    migrated.db.prepare('UPDATE weather_layout_repairs SET canonical_id=?').run('f'.repeat(64));
    before = snapshot(migrated.db);
  } finally { migrated.close(); }
  assert.throws(() => new WeatherStore(f.filename), /repair identity alias does not match/);
  const db = new DatabaseSync(f.filename); f.adopt(db);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('later overlapping sources do not retroactively resolve an originally unverifiable slot meaning', t => {
  const f = legacyFixture(t), id = f.add(FIRST, 25.2);
  const line = f.db.prepare('SELECT raw_line FROM records WHERE id=?').get(id).raw_line;
  f.db.prepare('DELETE FROM source_records WHERE record_id=?').run(id);
  let store = withStore(t, f);
  assert.equal(store.db.prepare('SELECT layout_id FROM records WHERE id=?').get(id).layout_id, BASE_ID);
  const initial = store.db.prepare('SELECT reason FROM weather_layout_field_exclusions WHERE record_id=?').get(id);
  assert.equal(initial.reason, 'layout-transition-unverified-provenance');
  for (const name of ['later/first', 'later/second']) {
    const result = store.importBuffer(Buffer.from(line + '\r\n'), {
      name, stream: 'mem3', format: 'logger', receivedAt: RECEIVED, verifiedSerial: baseline.station.serial
    });
    assert.equal(result.inserted, 0); assert.equal(result.linked, 1);
    if (name === 'later/first') {
      store.close(); f.adopt(null);
      store = new WeatherStore(f.filename); f.adopt(store);
    }
  }
  assert.equal(store.db.prepare('SELECT layout_id FROM records WHERE id=?').get(id).layout_id, BASE_ID);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM source_records WHERE record_id=?').get(id).n, 2);
  assert.equal(store.db.prepare('SELECT reason FROM weather_layout_field_exclusions WHERE record_id=?').get(id).reason, initial.reason);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

