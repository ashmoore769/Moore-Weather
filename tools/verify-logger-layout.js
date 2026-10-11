'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const layout = require('../config/station-layout.json');
const [sensorFile, storageFile, r3File] = process.argv.slice(2);
if (!r3File) throw new Error('Usage: node tools/verify-logger-layout.js listsensor.txt liststorage.txt r3.txt');
const sensors = fs.readFileSync(sensorFile, 'utf8').split(/\r?\n/).filter(l => /^\s*\d+\s/.test(l));
assert.equal(sensors.length, layout.sensors.length);
for (const line of sensors) {
  const m = line.match(/^\s*(\d+)\s+(.+?)\s{2,}[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+(\d+)\s+(.*?)\s{2,}/);
  assert.ok(m, 'Unrecognised sensor line');
  const sensor = layout.sensors.find(s => s.key === m[1]);
  assert.equal(m[2].trim(), sensor.name);
  assert.equal(Number(m[3]), sensor.displayPrecision);
  assert.equal(m[4].trim(), sensor.unit);
}
const storage = fs.readFileSync(storageFile, 'utf8').split(/\r?\n/).filter(l => /^\s*\d+\s/.test(l));
const fields = Object.values(layout.streams).flatMap(s => s.fields).filter(f => f.storageId);
assert.equal(storage.length, fields.length);
for (const line of storage) {
  const t = line.trim().split(/\s+/);
  const f = fields.find(field => field.storageId === Number(t[0]));
  assert.ok(f);
  assert.equal(t[1], f.aggregation);
  const stream = layout.streams['mem' + t[2]];
  assert.ok(stream.fields.some(field => field.storageId === f.storageId));
  assert.deepEqual(t.slice(3).map((v, i) => i === 4 ? v : Number(v)),
    [Number(f.sensorKey), f.precision, f.threshold, f.parameter, f.timeType, f.time1, f.time2, f.flags]);
}
const r3 = fs.readFileSync(r3File, 'utf8').split(/\r?\n/).filter(l => /^\d{4}\//.test(l));
assert.equal(r3.length, 1);
assert.equal(r3[0].split(',').length, layout.streams.r3.fields.length + 2);
console.log(`Verified ${sensors.length} sensor definitions, ${fields.length} storage definitions and ${layout.streams.r3.fields.length} R3 values against the saved schedule.`);
