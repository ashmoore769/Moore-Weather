'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WeatherStore, hash, timestamp } = require('../lib/weather-store');
const { interpolateTenMinute } = require('../lib/weather-interpolation');
const { baselineId } = require('../lib/weather-layout-cutover');
const cutover = require('./fixtures/layout-cutover');
const baseline = require('../config/station-layout.json');
const quality = require('../config/data-quality.json');
const RECEIVED = '2025-04-02T00:40:00.000Z';
const NOW = Date.parse(RECEIVED);

function fixture(t, legacy = false, layout = baseline) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-layout-cutover-'));
  const filename = path.join(directory, 'weather.sqlite');
  const useCutover = layout === baseline;
  let configured = useCutover && !legacy;
  let store = new WeatherStore(filename, layout, configured ? { layoutCutover: cutover } : {});
  store.setQualityPolicy({ ...quality, earliestLocalTimestamp: '2025-04-01T00:00:00' });
  // Simulate the previous importer's interpretation using its exact baseline
  // layout and native identity algorithm. The separate edge suite exercises
  // the actual previous schema and view upgrade from committed DDL.
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { filename, get store() { return store; }, restart() {
    store.close();
    store = new WeatherStore(filename, layout, useCutover && !configured ? { layoutCutover: cutover } : {});
    configured = useCutover;
    return store;
  } };
}

function row(time, globe = '24.10', stream = 'mem3', date = '2025/04/02') {
  const values = baseline.streams[stream].fields.map(field => String(field.storageId === 77 ? globe :
    field.sensorKey === '7' ? '1018.2' : field.unit === '%' ? '50' : '20'));
  return [date, time, ...values].join(',');
}

function ingest(store, text, name, stream = 'mem3', receivedAt = RECEIVED) {
  return store.importBuffer(Buffer.from(text), { name, stream, receivedAt, format: 'logger', verifiedSerial: baseline.station.serial });
}

function sourceSnapshot(db) {
  return {
    sources: db.prepare('SELECT * FROM sources ORDER BY id').all().map(source =>
      ({ ...source, original_bytes: Buffer.from(source.original_bytes).toString('hex') })),
    links: db.prepare('SELECT * FROM source_records ORDER BY source_id,line_number').all().map(value => ({ ...value }))
  };
}

function measuredSnapshot(db) {
  return db.prepare(`SELECT r.id,r.raw_line,r.received_at,f.position,o.value,o.raw_value,o.quality
    FROM records r JOIN observations o ON o.record_id=r.id JOIN fields f ON f.id=o.field_id
    ORDER BY r.id,f.position`).all().map(value => ({ ...value }));
}

test('a mixed MEM3 tail routes each interval while preserving original bytes and the transitional globe value', t => {
  const f = fixture(t), store = f.store;
  const bytes = [row('10:00:00', '17.25'), row('10:10:00', '24.10'), row('10:20:00', '25.20')].join('\r\n') + '\r\n';
  assert.equal(store.layoutId, cutover.baselineLayoutSha256);
  assert.equal(hash(JSON.stringify(baseline)), baselineId);
  assert.equal(ingest(store, bytes, 'mixed').inserted, 3);
  const records = store.db.prepare('SELECT * FROM records ORDER BY observed_at').all();
  assert.deepEqual(records.map(record => record.layout_id), [baselineId, store.layoutCutover.layoutId, store.layoutCutover.layoutId]);
  const field = id => store.db.prepare(`SELECT f.sensor_key,f.aggregation,f.unit,o.raw_value,o.value
    FROM observations o JOIN fields f ON f.id=o.field_id WHERE o.record_id=? AND f.position=4`).get(id);
  assert.deepEqual({ ...field(records[0].id) }, { sensor_key: '2', aggregation: 'S-THETA', unit: 'Degs', raw_value: '17.25', value: 17.25 });
  assert.deepEqual({ ...field(records[1].id) }, { sensor_key: '58', aggregation: 'AVERAGE', unit: 'DegC', raw_value: '24.10', value: 24.1 });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM weather_readings WHERE record_id=? AND sensor_key='58'").get(records[1].id).n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM weather_readings WHERE record_id=?').get(records[1].id).n, 22);
  const source = store.db.prepare('SELECT * FROM sources').get();
  assert.equal(source.layout_id, baselineId, 'Source identity stays stable even when individual rows use different layouts');
  assert.deepEqual(Buffer.from(source.original_bytes), Buffer.from(bytes));
  assert.deepEqual(store.db.prepare('SELECT line_number FROM source_records ORDER BY line_number').all().map(value => value.line_number), [1, 2, 3]);
  const status = store.layoutTransitionStatus(NOW);
  assert.equal(status.transitionExcludedRows, 1);
  assert.equal(status.firstUsableGlobe.observedAt, '2025-04-02T00:20:00.000Z');
  assert.equal(status.firstUsableGlobe.rawValue, '25.20');
  assert.equal(store.latest('mem3', NOW).id, records[2].id);
});

test('legacy repairs keep record IDs, values and every raw source link; aliases deduplicate overlapping tails after restart', t => {
  const f = fixture(t, true);
  const bytes = [row('10:00:00', '17.25'), row('10:10:00'), row('10:20:00', '25.20')].join('\r\n') + '\r\n';
  for (const name of ['original/a', 'original/b']) ingest(f.store, bytes, name);
  const beforeSources = sourceSnapshot(f.store.db), beforeValues = measuredSnapshot(f.store.db);
  const ids = f.store.db.prepare('SELECT id FROM records ORDER BY observed_at').all().map(value => value.id);
  let store = f.restart();
  assert.equal(store.layoutTransitionStatus(NOW).repairedRecords, 2);
  assert.deepEqual(sourceSnapshot(store.db), beforeSources);
  assert.deepEqual(measuredSnapshot(store.db), beforeValues);
  assert.equal(ingest(store, bytes, 'original/a').unchanged, true, 'Constructor repairs run even when the original source short-circuits reimport');
  const overlapping = row('10:10:00') + '\n' + row('10:20:00', '25.20') + '\n';
  assert.equal(ingest(store, overlapping, 'overlap/one').inserted, 0);
  store = f.restart();
  assert.equal(ingest(store, overlapping, 'overlap/two').inserted, 0);
  assert.deepEqual(store.db.prepare('SELECT id FROM records ORDER BY observed_at').all().map(value => value.id), ids);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM source_records').get().n, 10);
  const aliases = store.db.prepare('SELECT record_id,canonical_id FROM weather_layout_repairs').all();
  assert.equal(aliases.length, 2);
  for (const alias of aliases) {
    assert.ok(ids.includes(alias.record_id));
    assert.equal(store.db.prepare('SELECT 1 FROM records WHERE id=?').get(alias.canonical_id), undefined);
  }
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a genuinely changed value remains a distinct conflict instead of being folded into the repaired alias', t => {
  const f = fixture(t, true);
  ingest(f.store, row('10:20:00', '25.20') + '\n', 'original');
  const store = f.restart();
  assert.equal(ingest(store, row('10:20:00', '25.30') + '\n', 'variant').inserted, 1);
  assert.equal(ingest(store, row('10:20:00', '25.20') + '\n', 'same-original').inserted, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 2);
  assert.equal(store.db.prepare('SELECT variants FROM conflicting_records').get().variants, 2);
  assert.equal(store.layoutTransitionStatus(NOW).firstUsableGlobe, null);
  assert.equal(store.latest('mem3', NOW), undefined);
});

test('legacy interpolation IDs and endpoint lineage survive repair without being interpreted as measured globe', t => {
  const f = fixture(t, true);
  ingest(f.store, row('10:00:00', '10') + '\n' + row('10:20:00', '30') + '\n', 'old-neighbours');
  const estimate = interpolateTenMinute(f.store, '2025-04-02T10:10:00', 'Owner-requested historical gap estimate');
  const lineage = { ...f.store.db.prepare('SELECT * FROM record_estimates WHERE record_id=?').get(estimate.recordId) };
  const beforeValues = measuredSnapshot(f.store.db), sources = sourceSnapshot(f.store.db);
  const store = f.restart();
  assert.deepEqual({ ...store.db.prepare('SELECT * FROM record_estimates WHERE record_id=?').get(estimate.recordId) }, lineage);
  assert.deepEqual(measuredSnapshot(store.db), beforeValues);
  assert.deepEqual(sourceSnapshot(store.db), sources);
  assert.equal(store.db.prepare('SELECT layout_id FROM records WHERE id=?').get(estimate.recordId).layout_id, baselineId);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM weather_readings_raw WHERE record_id=? AND sensor_key='58'").get(estimate.recordId).n, 0);
  assert.equal(store.db.prepare("SELECT value FROM weather_readings_raw WHERE record_id=? AND aggregation='S-THETA'").get(estimate.recordId).value, 20);
  assert.equal(store.db.prepare('SELECT reason FROM weather_layout_field_exclusions WHERE record_id=?').get(estimate.recordId).reason,
    'layout-transition-unverified-provenance');
  assert.equal(store.layoutTransitionStatus(NOW).firstUsableGlobe.value, 30);
  assert.equal(store.layoutTransitionStatus(NOW).repairedRecords, 1);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  f.restart();
});

test('interpolation refuses neighbours from incompatible layouts across the transition', t => {
  const f = fixture(t);
  ingest(f.store, row('10:00:00', '10') + '\n' + row('10:20:00', '30') + '\n', 'mixed-neighbours');
  assert.throws(() => interpolateTenMinute(f.store, '2025-04-02T10:10:00', 'Never combine wind and globe'), /Missing or ambiguous measured neighbour/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 2);
});

test('R3, diagnostics and unchanged native banks retain their original record and source identities', t => {
  const f = fixture(t), store = f.store;
  for (const stream of ['r3', 'mem0', 'mem1', 'mem2', 'mem4']) {
    const daily = stream === 'mem1', time = daily ? '09:00:00' : '10:20:00', date = daily ? '2025/04/03' : '2025/04/02';
    const line = stream === 'mem0' ? `${date},${time} CONFIG : owner saved schedule` : row(time, '24.1', stream, date);
    const bytes = Buffer.from(line + '\r\n'), name = 'unchanged/' + stream;
    assert.equal(ingest(store, bytes, name, stream).inserted, 1);
    const values = stream === 'mem0' ? [hash(line), 0] : line.split(',').slice(2);
    const expectedId = hash(JSON.stringify([baseline.station.id, baselineId, stream, timestamp(date, time, 600).utc, values]));
    const sourceId = hash(JSON.stringify([hash(bytes), baselineId, stream, name]));
    assert.equal(store.db.prepare('SELECT layout_id FROM records WHERE id=?').get(expectedId).layout_id, baselineId);
    assert.equal(store.db.prepare('SELECT record_id FROM source_records WHERE source_id=?').get(sourceId).record_id, expectedId);
    assert.deepEqual(Buffer.from(store.db.prepare('SELECT original_bytes FROM sources WHERE id=?').get(sourceId).original_bytes), bytes);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM weather_layout_repairs').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM weather_layout_field_exclusions').get().n, 0);
});

test('repeated future-dated old wind in new downloads keeps its original identity and exclusion', t => {
  const f = fixture(t, true), line = row('10:20:00', '67.8') + '\n';
  ingest(f.store, line, 'pre-change-clock-error', 'mem3', '2025-04-02T00:02:00.000Z');
  const original = f.store.db.prepare('SELECT id FROM records').get().id;
  let store = f.restart();
  for (const name of ['new-tail/one', 'new-tail/two']) {
    assert.equal(ingest(store, line, name).inserted, 0);
    store = f.restart();
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 1);
  assert.equal(store.db.prepare('SELECT layout_id FROM records WHERE id=?').get(original).layout_id, baselineId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM source_records WHERE record_id=?').get(original).n, 3);
  assert.equal(store.db.prepare('SELECT reason FROM weather_layout_field_exclusions WHERE record_id=?').get(original).reason,
    'layout-transition-prechange-evidence');
  assert.equal(store.layoutTransitionStatus(NOW).mappedGlobeRecords, 0);
});

test('matching column counts in a different explicit layout do not activate this station-specific cutover', t => {
  const custom = structuredClone(baseline);
  custom.evidence.note += ' Separately supplied layout for a controlled test.';
  const f = fixture(t, false, custom), store = f.store;
  ingest(store, row('10:20:00', '67.8') + '\n', 'custom-layout');
  assert.equal(store.layoutTransitionStatus(NOW).enabled, false);
  assert.equal(store.db.prepare('SELECT layout_id FROM records').get().layout_id, store.layoutId);
  assert.equal(store.db.prepare("SELECT value FROM weather_readings_raw WHERE aggregation='S-THETA'").get().value, 67.8);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM weather_layout_cutovers').get().n, 0);
});

test('an unconfigured database has no implicit production transition', t => {
  const store = new WeatherStore(':memory:');
  t.after(() => store.close());
  ingest(store, row('10:20:00', '67.8') + '\n', 'baseline-only');
  assert.equal(store.layoutTransitionStatus(NOW).enabled, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM layouts').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM weather_layout_cutovers').get().n, 0);
  assert.equal(store.db.prepare("SELECT value FROM weather_readings_raw WHERE aggregation='S-THETA'").get().value, 67.8);
});

test('private configurations are isolated per store and copied before the caller can mutate them', t => {
  const first = structuredClone(cutover), second = structuredClone(cutover);
  second.id = 'fixture-next-day';
  for (const key of ['scheduleChangedAt', 'confirmedStationAt', 'firstNewObservedAt', 'firstCompleteObservedAt']) {
    second[key] = new Date(Date.parse(second[key]) + 86400000).toISOString();
  }
  const a = new WeatherStore(':memory:', baseline, { layoutCutover: first });
  const b = new WeatherStore(':memory:', baseline, { layoutCutover: second });
  t.after(() => { a.close(); b.close(); });
  first.firstNewObservedAt = second.firstNewObservedAt;
  first.after.sensorKey = '2';
  const line = row('10:20:00', '24.1') + '\n';
  ingest(a, line, 'store-a');
  ingest(b, line, 'store-b');
  assert.equal(a.layoutTransitionStatus(NOW).firstNewObservedAt, cutover.firstNewObservedAt);
  assert.equal(b.layoutTransitionStatus(NOW).firstNewObservedAt, second.firstNewObservedAt);
  assert.equal(a.db.prepare("SELECT value FROM weather_readings_raw WHERE sensor_key='58'").get().value, 24.1);
  assert.equal(b.db.prepare("SELECT value FROM weather_readings_raw WHERE aggregation='S-THETA'").get().value, 24.1);
  assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM weather_readings_raw WHERE sensor_key='58'").get().n, 0);
});

test('saved private configuration recovers on restart and rejects a conflicting replacement atomically', t => {
  const f = fixture(t);
  ingest(f.store, row('10:20:00', '25.2') + '\n', 'private-config-source');
  const beforeSources = sourceSnapshot(f.store.db), beforeValues = measuredSnapshot(f.store.db);
  const beforeConfig = { ...f.store.db.prepare('SELECT * FROM weather_layout_cutovers').get() };
  const changed = structuredClone(cutover);
  changed.evidence.note = 'Different synthetic evidence cannot replace the saved interpretation.';
  assert.throws(() => new WeatherStore(f.filename, baseline, { layoutCutover: changed }), /metadata differs/);
  assert.deepEqual(sourceSnapshot(f.store.db), beforeSources);
  assert.deepEqual(measuredSnapshot(f.store.db), beforeValues);
  assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM weather_layout_cutovers').get() }, beforeConfig);
  const restarted = f.restart();
  assert.equal(restarted.layoutTransitionStatus(NOW).id, cutover.id);
  assert.equal(restarted.layoutTransitionStatus(NOW).firstUsableGlobe.value, 25.2);
  const repeated = new WeatherStore(f.filename, baseline, { layoutCutover: structuredClone(cutover) });
  repeated.close();
});

test('configuration rejects unverifiable fields, timing, identity and evidence before importing records', async t => {
  const cases = [
    ['null', () => null],
    ['different station', value => ({ ...value, stationSerial: 'other' })],
    ['different baseline', value => ({ ...value, baselineLayoutSha256: '0'.repeat(64) })],
    ['noncanonical timestamp', value => ({ ...value, scheduleChangedAt: '2025-04-02T00:04:00Z' })],
    ['confirmation after first interval', value => ({ ...value, confirmedStationAt: value.firstCompleteObservedAt })],
    ['nonadjacent complete interval', value => ({ ...value, firstCompleteObservedAt: '2025-04-02T00:30:00.000Z' })],
    ['wrong original mapping', value => ({ ...value, before: { ...value.before, aggregation: 'MAXIMUM' } })],
    ['unknown replacement sensor', value => ({ ...value, after: { ...value.after, sensorKey: 'unknown-sensor' } })],
    ['unapproved evidence', value => ({ ...value, evidence: { ...value.evidence, savedByOwner: false } })],
    ['oversized evidence', value => ({ ...value, evidence: { ...value.evidence, note: 'x'.repeat(17000) } })]
  ];
  for (const [name, change] of cases) await t.test(name, () => {
    assert.throws(() => new WeatherStore(':memory:', baseline, { layoutCutover: change(structuredClone(cutover)) }),
      /Weather layout cutover:|Invalid field definition/);
  });
});

test('ambiguous saved configurations are refused instead of silently selecting one', t => {
  const f = fixture(t), db = f.store.db;
  const extra = structuredClone(cutover);
  extra.id = 'fixture-second-conflicting-config';
  const saved = db.prepare('SELECT * FROM weather_layout_cutovers').get();
  db.prepare(`INSERT INTO weather_layout_cutovers VALUES(?,?,?,?,?,?,?,?,?,?)`).run(extra.id, saved.station_id,
    saved.stream, saved.old_layout_id, saved.new_layout_id, saved.schedule_changed_at, saved.first_new_at,
    saved.first_complete_at, JSON.stringify(extra), saved.created_at);
  const before = db.prepare('SELECT * FROM weather_layout_cutovers ORDER BY id').all().map(value => ({ ...value }));
  assert.throws(() => new WeatherStore(f.filename), /multiple saved cutovers/);
  assert.deepEqual(db.prepare('SELECT * FROM weather_layout_cutovers ORDER BY id').all().map(value => ({ ...value })), before);
});
