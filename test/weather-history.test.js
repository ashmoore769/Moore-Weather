'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WeatherStore } = require('../lib/weather-store');
const { importCapture } = require('../lib/terminal-capture');
const { midpoint, interpolateTenMinute } = require('../lib/weather-interpolation');
const layout = require('../config/station-layout.json');
const policy = require('../config/data-quality.json');
function storeFor(t) { const s = new WeatherStore(':memory:'); t.after(() => s.close()); return s; }
function line(stream, time, changes = {}) {
  return ['2026/08/23', time, ...layout.streams[stream].fields.map(f => changes[f.sensorKey] ?? (f.sensorKey === '7' ? '1020' : '0'))].join(',');
}

test('terminal commands select sections, prompt-prefixed rows survive, originals and rejected fragments remain', t => {
  const s = storeFor(t);
  const bytes = Buffer.from(`mem 4 searchb 2026 08 21\r\n2026/08/23,09:00:00,0.2\r\n\\END OF DATA\r\n> mem 3 searchb 2026 08 21\r\n> DEBUG : INACTIVITY Modem Power Off Reset.\r\n> ${line('mem3','11:20:00')}\r\n2026/08/23,11:30:00,1,`);
  const options = { name: 'capture.bin', verifiedSerial: '5555-1234' };
  const result = importCapture(s, bytes, options);
  assert.equal(result.imports.reduce((n, r) => n+r.inserted, 0), 2);
  assert.equal(result.imports.reduce((n, r) => n+r.rejected, 0), 1);
  assert.equal(result.unfinishedStream, 'mem3');
  assert.equal(result.notes.filter(n => n.kind === 'diagnostic').length, 1);
  for (const source of s.db.prepare('SELECT original_bytes FROM sources').all()) assert.deepEqual(Buffer.from(source.original_bytes), bytes);
  assert.equal(s.db.prepare('SELECT line_number FROM rejected_rows').get().line_number, 7);
  assert.ok(importCapture(s, bytes, options).imports.every(r => r.unchanged));
  const continuation = Buffer.from(`4,5,6\n${line('mem3','11:40:00')}\n\\END OF DATA`);
  assert.throws(() => importCapture(s, continuation, { name: 'tail', verifiedSerial: '5555-1234' }), /verified stream/);
  const tail = importCapture(s, continuation, { name: 'tail', verifiedSerial: '5555-1234', initialStream: 'mem3' });
  assert.equal(tail.imports[0].inserted, 1);
  assert.equal(tail.imports[0].rejected, 1);
});

test('solar floors are explicit, raw negatives survive and suspect sensor aggregates are excluded', t => {
  const s = storeFor(t);
  s.setQualityPolicy(policy);
  s.ingestLive('r3', line('r3','11:00:00', {'4':'-20','6':'-1.7','58':'56.8','34':'-25'}));
  const solar = s.db.prepare("SELECT * FROM weather_readings WHERE sensor_key='6'").get();
  assert.equal(solar.value, 0);
  assert.equal(solar.original_value, -1.7);
  assert.equal(solar.raw_value, '-1.7');
  assert.equal(solar.adjustment, 'solar-zero-floor');
  assert.equal(s.db.prepare("SELECT value FROM weather_readings_raw WHERE sensor_key='4'").get().value, -20);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM weather_readings WHERE sensor_key='4'").get().n, 0);
  assert.equal(s.db.prepare("SELECT value FROM weather_readings WHERE sensor_key='58'").get().value, 56.8);
  assert.equal(s.db.prepare("SELECT value FROM weather_readings WHERE sensor_key='34'").get().value, -25);
  s.ingestLive('r3', line('r3','11:01:00', {'6':'-999'}));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM weather_readings WHERE sensor_key='6'").get().n, 1);
  const bad = structuredClone(policy); bad.sensorLimits[0].minimum = 100;
  assert.throws(() => s.setQualityPolicy(bad), /Invalid sensor/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sensor_quality_limits').get().n, policy.sensorLimits.length);
});

test('single-gap interpolation has lineage, handles north and yields to later measured data', t => {
  const s = storeFor(t); s.setQualityPolicy(policy);
  s.ingestLive('mem3', line('mem3','11:20:00', {'2':'359','27':'359','4':'10','6':'-1.7'}));
  s.ingestLive('mem3', line('mem3','11:40:00', {'2':'1','27':'1','4':'12','6':'-1.7'}));
  const filled = interpolateTenMinute(s, '2026-08-23T11:30:00', 'Owner-requested estimate');
  const rows = s.db.prepare('SELECT * FROM weather_readings WHERE record_id=?').all(filled.recordId);
  assert.equal(rows.length, 23);
  assert.ok(rows.every(r => r.is_estimated === 1));
  assert.equal(rows.find(r => r.sensor_key === '4').value, 11);
  assert.equal(rows.find(r => r.aggregation === 'AVGDIR').value, 0);
  assert.equal(rows.find(r => r.aggregation === 'S-THETA').value, 180); // spread is not a compass bearing
  assert.equal(rows.find(r => r.sensor_key === '6').value, 0);
  assert.equal(interpolateTenMinute(s, '2026-08-23T11:30:00', 'repeat').unchanged, true);
  assert.throws(() => interpolateTenMinute(s, '2026-08-23T12:30:00', 'outside'), /neighbour/);
  s.ingestLive('mem3', line('mem3','11:30:00', {'4':'11.5'}));
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM weather_readings WHERE record_id=?').get(filled.recordId).n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM conflicting_records').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM record_estimates').get().n, 1);
  assert.equal(s.summary().foreignKeyErrors, 0);
  assert.equal(midpoint(350, 10, true), 0);
  assert.throws(() => midpoint(90, 270, true), /ambiguous/);
});

test('interpolation refuses suspect neighbours rather than manufacturing plausible values', t => {
  const s = storeFor(t); s.setQualityPolicy(policy);
  s.ingestLive('mem3', line('mem3','11:20:00', {'4':'-20'}));
  s.ingestLive('mem3', line('mem3','11:40:00', {'4':'12'}));
  assert.throws(() => interpolateTenMinute(s, '2026-08-23T11:30:00', 'test'), /excluded/);
  assert.equal(s.summary().estimatedRecords, 0);
});
