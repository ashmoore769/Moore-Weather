"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPersistence } = require('../lib/weather-persistence');
const { HistoryReader } = require('../lib/weather-history');
const layout = require('../config/station-layout.json');
const fixture = require('./fixtures/layout-cutover');
const first = Date.parse(fixture.firstCompleteObservedAt);
const transition = Date.parse(fixture.firstNewObservedAt);
const old = transition - 600000;
const iso = at => new Date(at).toISOString();

function row(at, value) {
  const local = iso(at + layout.station.utcOffsetMinutes * 60000);
  return [local.slice(0, 10).replaceAll('-', '/'), local.slice(11, 19), ...layout.streams.mem3.fields.map(field =>
    field.storageId === fixture.storageId ? String(value) : field.sensorKey === '7' ? '1018.2' : '15')].join(',');
}

test('private configuration and normal history ingestion preserve mixed captures across a configuration-free restart', t => {
  const now = first + 1200000;
  t.mock.method(Date, 'now', () => now);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-globe-persistence-'));
  const filename = path.join(directory, 'weather.sqlite');
  const logs = [], errors = [];
  const logger = { info: message => logs.push(message), error: message => errors.push(message) };
  function open(configured) {
    const env = { WEATHER_DB_PATH: filename };
    if (configured) env.WEATHER_LAYOUT_CUTOVER_JSON = JSON.stringify(fixture);
    const persistence = createPersistence(env, logger, { now: () => now });
    assert.equal(persistence.status().ready, true);
    // The test's fictional dates predate the installation's real quality window.
    const policyDb = new DatabaseSync(filename);
    policyDb.prepare('UPDATE data_quality_policies SET earliest_local_timestamp=? WHERE station_id=?')
      .run(iso(old - 86400000).slice(0, 19), layout.station.id);
    policyDb.close();
    return persistence;
  }
  let persistence = open(true), readerDb;
  t.after(() => { readerDb?.close(); persistence.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const capture = `MEM 3 LAST 8\r\n${row(old, 46.7)}\r\n${row(transition, 17.1)}\r\n${row(first, 18.2)}\r\n\\END OF DATA\r\n> `;
  const imported = persistence.recordHistory('mem3', capture);
  assert.equal(imported.received, 3);
  assert.equal(imported.inserted, 3);
  assert.equal(imported.rejected, 0);
  assert.equal(imported.storedThrough, iso(first));
  const repeat = persistence.recordHistory('mem3', capture);
  assert.equal(repeat.unchanged, true);
  assert.equal(repeat.inserted, 0);
  assert.equal(repeat.received, 3);
  assert.equal(persistence.status().layoutTransition.firstUsableGlobe.observedAt, iso(first));
  assert.ok(logs.some(message => message.startsWith('[LAYOUT] ') && message.includes('native-memory')));
  assert.deepEqual(errors, []);

  persistence.close();
  persistence = open(false);
  assert.equal(persistence.recordHistory('mem3', capture).inserted, 0);
  assert.equal(persistence.status().layoutTransition.firstUsableGlobe.observedAt, iso(first));
  readerDb = new DatabaseSync(filename, { readOnly: true });
  const source = readerDb.prepare("SELECT original_bytes FROM sources WHERE stream='mem3'").get();
  assert.deepEqual(Buffer.from(source.original_bytes), Buffer.from(capture));
  assert.equal(readerDb.prepare('SELECT COUNT(*) AS n FROM source_records').get().n, 3);
  assert.equal(readerDb.prepare('SELECT COUNT(*) AS n FROM conflicting_records').get().n, 0);
  const oldReading = readerDb.prepare("SELECT sensor_key, aggregation, value FROM weather_readings WHERE stream='mem3' AND observed_at=? AND aggregation='S-THETA'").get(iso(old));
  assert.equal(oldReading.sensor_key, '2');
  assert.equal(oldReading.value, 46.7);
  const partial = readerDb.prepare("SELECT value FROM weather_readings_raw WHERE stream='mem3' AND observed_at=? AND sensor_key='58'").get(iso(transition));
  assert.equal(partial.value, 17.1);
  assert.equal(readerDb.prepare("SELECT COUNT(*) AS n FROM weather_readings WHERE stream='mem3' AND observed_at=? AND sensor_key='58'").get(iso(transition)).n, 0);
  assert.equal(readerDb.prepare("SELECT COUNT(*) AS n FROM weather_readings WHERE stream='mem3' AND observed_at=?").get(iso(transition)).n, 22);
  const history = new HistoryReader(readerDb);
  const result = history.query({ metric: 'globe', resolution: '10m', hours: 1, end: first + 600000 });
  assert.deepEqual(result.series[0].points.filter(point => point.value !== null).map(point => [point.t, point.value]), [[first, 18.2]]);
  assert.equal(result.catalog.find(metric => metric.id === 'globe').coverage['10m'].first, first);
  assert.equal(readerDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(readerDb.prepare('PRAGMA foreign_key_check').all(), []);
});

test('invalid private configuration fails safely without echoing its contents', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-globe-config-'));
  const errors = [];
  const persistence = createPersistence({ WEATHER_DB_PATH: path.join(directory, 'weather.sqlite'),
    WEATHER_LAYOUT_CUTOVER_JSON: '{"private-note":"do-not-log-this"' }, { info() {}, error: message => errors.push(message) });
  t.after(() => { persistence.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(persistence.status().ready, false);
  assert.match(persistence.status().error, /Invalid private station layout cutover configuration/);
  assert.ok(errors.every(message => !message.includes('do-not-log-this')));
});
