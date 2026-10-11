'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { WeatherStore, timestamp } = require('../lib/weather-store');
const { createPersistence } = require('../lib/weather-persistence');
const layout = require('../config/station-layout.json');
const row = (stream, date = '2026/08/21', time = '09:00:00', values) =>
  [date, time, ...(values || layout.streams[stream].fields.map(() => '0'))].join(',');
const source = (data, stream = 'mem4') => Buffer.from(`;Serial Number:5555-1234\n;> mem ${stream.slice(3)} searchb 2026 08 18 14 31\n${data}\n\\END OF DATA\n`);
const quietLogger = { error() {} };
function memoryStore(t) { const store = new WeatherStore(':memory:'); t.after(() => store.close()); return store; }
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moore-weather-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('paired CSV and Environdata preserve both sources but deduplicate records; reruns are idempotent', t => {
  const store = memoryStore(t);
  const data = '2026/08/21,07:06:00,0.2';
  const dm = source(data);
  store.importBuffer(dm, { name: 'rain.dm4', stream: 'mem4' });
  store.importBuffer(Buffer.from(`"sep=,"\n;Serial Number:5555-1234\nDate,Time,,,,\n${data}\n`), { name: 'rain.csv', stream: 'mem4' });
  assert.equal(store.importBuffer(dm, { name: 'rain.dm4', stream: 'mem4' }).unchanged, true);
  assert.equal(store.summary().sources, 2);
  assert.equal(store.summary().observations, 1);
  assert.equal(store.summary().streams[0].records, 1);
  assert.deepEqual(Buffer.from(store.db.prepare("SELECT original_bytes FROM sources WHERE name='rain.dm4'").get().original_bytes), dm);
  const reading = store.db.prepare('SELECT * FROM weather_readings').get();
  assert.equal(reading.value, 0.2);
  assert.equal(reading.unit, 'mm');
  assert.equal(reading.aggregation, 'TOTGR');
  assert.equal(reading.interval_start, '2026-08-20T21:05:00.000Z');
});

test('Brisbane timestamps and daily reporting boundaries are retained', t => {
  const store = memoryStore(t);
  store.importBuffer(source(row('mem1'), 'mem1'), { name: 'daily.dm1', stream: 'mem1' });
  const record = store.latest('mem1');
  assert.equal(record.observed_at, '2026-08-20T23:00:00.000Z');
  assert.equal(record.interval_start, '2026-08-19T23:00:00.000Z');
  assert.equal(record.reporting_date, '2026-08-20');
  assert.equal(record.local_timestamp, '2026-08-21T09:00:00');
  assert.throws(() => timestamp('2026/02/30', '09:00:00', 600), /calendar/);
  assert.throws(() => timestamp('2026/08/21', '24:00:00', 600), /calendar/);
  assert.equal(timestamp('2024/02/29', '00:00:00', 600).utc, '2024-02-28T14:00:00.000Z');
  const bad = store.importBuffer(source(row('mem1', '2026/08/22', '00:00:00'), 'mem1'), { name: 'bad.dm1', stream: 'mem1' });
  assert.equal(bad.rejected, 1);
});

test('zero, negative, missing and invalid values stay distinguishable; precision is preserved', t => {
  const store = memoryStore(t);
  const values = layout.streams.r3.fields.map(() => '0');
  values[3] = '-2.50'; // Air temperature, not the adjacent humidity channel.
  values[4] = '';
  values[5] = 'N/A';
  store.ingestLive('r3', row('r3', '2026/08/21', '07:06:00', values));
  const readings = store.db.prepare('SELECT * FROM weather_readings').all();
  assert.equal(readings.find(r => r.sensor_key === '4').value, -2.5);
  assert.equal(readings.find(r => r.sensor_key === '4').raw_value, '-2.50');
  assert.equal(readings.find(r => r.sensor_key === '3').value, 0);
  assert.equal(readings.find(r => r.sensor_key === '5').quality, 'missing');
  assert.equal(readings.find(r => r.sensor_key === '5').value, null);
  assert.equal(readings.find(r => r.sensor_key === '6').quality, 'invalid');
  assert.equal(store.latest('r3'), undefined);
});

test('repeated diagnostic messages survive while an identical paired batch is deduplicated', t => {
  const store = memoryStore(t);
  const data = Array(3).fill('2026/08/19,20:08:14 CFGFILE : Invalid File Format (SPCR START)').join('\n');
  store.importBuffer(source(data, 'mem0'), { name: 'a.dm0', stream: 'mem0' });
  store.importBuffer(source(data, 'mem0'), { name: 'a.csv', stream: 'mem0' });
  assert.equal(store.summary().streams[0].records, 3);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM source_records').get().n, 6);
});

test('conflicting values are retained and surfaced; restart does not choose a winner', t => {
  const store = memoryStore(t);
  for (const value of ['0.2', '0.4']) store.importBuffer(source('2026/08/21,07:06:00,' + value), { name: value, stream: 'mem4' });
  assert.equal(store.summary().conflicts, 1);
  assert.equal(store.summary().observations, 2);
  assert.equal(store.latest('mem4'), undefined);
});

test('wrong station and memory are rejected; unknown row shapes and bad dates are quarantined', t => {
  const store = memoryStore(t);
  assert.throws(() => store.importBuffer(Buffer.from(';Serial Number:other\n2026/08/21,07:06:00,0.2'), { name: 'wrong', stream: 'mem4' }), /serial/);
  assert.throws(() => store.importBuffer(source('2026/08/21,07:06:00,0.2'), { name: 'wrong', stream: 'mem3' }), /memory/);
  const bytes = source('2026/08/21,07:06:00,0.2,99\n2026/02/30,07:06:00,0.2\n2026/08/22,07:06:00,0.4');
  const options = { name: 'mixed', stream: 'mem4' };
  const result = store.importBuffer(bytes, options);
  assert.equal(result.rejected, 2);
  assert.equal(result.inserted, 1);
  assert.equal(store.importBuffer(bytes, options).rejected, 2);
  assert.equal(store.summary().foreignKeyErrors, 0);
});

test('unexpected database failure rolls back the entire source import', t => {
  const store = memoryStore(t);
  store.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON observations WHEN NEW.raw_value='0.4' BEGIN SELECT RAISE(ABORT, 'test disk failure'); END;");
  assert.throws(() => store.importBuffer(source('2026/08/21,07:06:00,0.2\n2026/08/21,07:07:00,0.4'), { name: 'rollback', stream: 'mem4' }), /test disk failure/);
  assert.equal(store.summary().sources, 0);
  assert.equal(store.summary().observations, 0);
  assert.equal(store.summary().streams.length, 0);
});

test('adding a sensor creates a new layout without changing earlier names, units or data', t => {
  const filename = path.join(tempDir(t), 'future.sqlite');
  let store = new WeatherStore(filename);
  store.ingestLive('r3', row('r3'));
  const oldLayout = store.layoutId;
  store.close();
  const next = structuredClone(layout);
  next.sensors.push({ key: 'new-test-channel', name: 'Additional sensor', unit: 'DegC', displayPrecision: 1 });
  next.streams.r3.fields.push({ position: 30, sensorKey: 'new-test-channel', name: 'Additional sensor', unit: 'DegC', aggregation: 'CURRENT' });
  next.streams.r3.fields[3].name = 'Renamed air sensor';
  store = new WeatherStore(filename, next);
  store.ingestLive('r3', row('r3', '2026/08/21', '09:01:00') + ',21.3');
  assert.notEqual(store.layoutId, oldLayout);
  assert.equal(store.summary().observations, 61);
  assert.equal(store.db.prepare('SELECT name FROM fields WHERE layout_id=? AND stream=? AND sensor_key=?').get(oldLayout, 'r3', '4').name, 'Air Temp');
  assert.equal(store.db.prepare("SELECT value FROM weather_readings WHERE sensor_key='new-test-channel'").get().value, 21.3);
  assert.equal(store.summary().integrity, 'ok');
  store.close();
});

test('consistent backups reopen with all data and sources intact', async t => {
  const directory = tempDir(t);
  const store = new WeatherStore(path.join(directory, 'original.sqlite'));
  store.importBuffer(source('2026/08/21,07:06:00,0.2'), { name: 'rain', stream: 'mem4' });
  await store.backup(path.join(directory, 'backup.sqlite'));
  const copy = new WeatherStore(path.join(directory, 'backup.sqlite'));
  assert.deepEqual(copy.summary(), store.summary());
  copy.close();
  store.close();
});

test('optional app persistence survives restart, stays disabled by default and isolates failures', t => {
  const filename = path.join(tempDir(t), 'live.sqlite');
  const disabled = createPersistence({}, quietLogger);
  assert.equal(disabled.status().enabled, false);
  disabled.record('r3', 'ignored');
  let persistence = createPersistence({ WEATHER_DB_PATH: filename }, quietLogger);
  assert.equal(persistence.status().ready, true);
  persistence.record('r3', row('r3', '2026/08/21', '09:00:00', layout.streams.r3.fields.map(f => f.sensorKey === '7' ? '1020' : '0')) + '\r\n> ');
  assert.equal(persistence.status().error, null);
  persistence.record('r3', '2026/08/21,09:01:00,1');
  assert.match(persistence.status().error, /Unmapped/);
  persistence.record('r3', '2026/08/21,09:01:00,1');
  assert.match(persistence.status().error, /Unmapped/);
  persistence.close();
  persistence = createPersistence({ WEATHER_DB_PATH: filename }, quietLogger);
  assert.equal(persistence.latest('r3').local_timestamp, '2026-08-21T09:00:00');
  persistence.close();
  const broken = createPersistence({ WEATHER_DB_PATH: path.join(filename, 'impossible.sqlite') }, quietLogger);
  assert.equal(broken.status().ready, false);
  assert.ok(broken.status().error);
  assert.doesNotThrow(() => broken.record('r3', row('r3')));
});

test('unknown future database versions are refused without rewriting them', t => {
  const filename = path.join(tempDir(t), 'future.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA user_version=99');
  db.close();
  assert.throws(() => new WeatherStore(filename), /newer/);
  const read = new DatabaseSync(filename);
  assert.equal(read.prepare('PRAGMA user_version').get().user_version, 99);
  read.close();
});

test('quality screening omits old history and bad sensors while retaining originals and valid negatives', t => {
  const store = memoryStore(t);
  store.importBuffer(source('2012/06/20,02:10:00,0.2\n2025/06/11,23:59:00,0.2\n2025/06/12,00:00:00,0.0'), { name: 'rain', stream: 'mem4' });
  const values = layout.streams.r3.fields.map(() => '0');
  function set(key, value) { values[layout.streams.r3.fields.findIndex(f => f.sensorKey === key)] = value; }
  set('3', '101');
  set('4', '-4.2');
  set('6', '-1.8');
  set('7', '809.2');
  set('31', '-0.013');
  set('33', '-0.109');
  set('62', '-546');
  store.ingestLive('r3', row('r3', '2025/08/01', '10:00:00', values));
  const before = store.summary().observations;
  store.setQualityPolicy(require('../config/data-quality.json'));
  const after = store.summary();
  assert.equal(after.observations, before);
  assert.equal(after.usableObservations, before - 4);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM weather_readings_raw').get().n, before);
  assert.deepEqual(store.db.prepare("SELECT value FROM weather_readings WHERE stream='mem4'").all().map(r => r.value), [0]);
  for (const [sensor, value] of [['4',-4.2],['6',0],['31',-0.013],['33',-0.109],['62',-546]]) {
    assert.equal(store.db.prepare("SELECT value FROM weather_readings WHERE stream='r3' AND sensor_key=?").get(sensor).value, value);
  }
  assert.equal(store.latest('r3'), undefined);
  store.ingestLive('mem4', '2012/06/21,02:10:00,0.2');
  assert.equal(store.summary().usableObservations, before - 4);
});

test('one failed daily pressure statistic excludes pressure aggregates, preserving other daily sensors', t => {
  const store = memoryStore(t);
  const values = layout.streams.mem1.fields.map(() => '0');
  for (const f of layout.streams.mem1.fields.filter(f => f.sensorKey === '7')) values[f.position] = f.aggregation === 'MINIMUM' ? '804.2' : '1010';
  store.importBuffer(source(row('mem1', '2025/10/07', '09:00:00', values), 'mem1'), { name: 'daily', stream: 'mem1' });
  store.setQualityPolicy(require('../config/data-quality.json'));
  assert.equal(store.summary().observations, 41);
  assert.equal(store.summary().usableObservations, 38);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM weather_readings WHERE sensor_key='7'").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM weather_readings WHERE sensor_key='4'").get().n, 3);
});

test('schema upgrade replaces the unfiltered view without removing existing data', t => {
  const filename = path.join(tempDir(t), 'upgrade.sqlite');
  let store = new WeatherStore(filename);
  store.ingestLive('mem4', '2012/06/20,02:10:00,0.2');
  store.db.exec(`DROP VIEW weather_readings; DROP VIEW weather_readings_review;
    DROP TABLE data_quality_policies; CREATE VIEW weather_readings AS SELECT * FROM weather_readings_raw;
    PRAGMA user_version=1;`);
  store.close();
  store = new WeatherStore(filename);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(store.summary().observations, 1);
  store.setQualityPolicy(require('../config/data-quality.json'));
  assert.equal(store.summary().usableObservations, 0);
  store.close();
});
