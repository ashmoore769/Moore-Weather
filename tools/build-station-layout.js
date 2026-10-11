'use strict';
// Extract metadata only. This program never connects to or configures a logger.
const fs = require('node:fs');
const crypto = require('node:crypto');
function buildLayout(schedule) {
  const sensors = [];
  const streams = { mem0: { name: 'Diagnostics', intervalSeconds: null, fields: [] },
    r3: { name: 'Current readings', intervalSeconds: null, fields: [] } };
  for (const line of schedule.split(/\r?\n/)) {
    const t = line.match(/"[^"]*"|\S+/g) || [];
    if (t[0] === 'SENSOR') {
      sensors.push({ key: t[1], name: JSON.parse(t[6]), unit: JSON.parse(t[7]),
        model: JSON.parse(t[8]), displayPrecision: Number(t[5]) });
    }
    if (t[0] === 'STORAGE') {
      const key = 'mem' + t[3];
      const intervalSeconds = t[8] === 'HOUR' && t[9] === '9' ? 86400
        : t[8] === 'EHOUR' ? Number(t[9]) * 3600 : t[8] === 'EMIN' ? Number(t[9]) * 60 : null;
      if (!intervalSeconds) throw new Error('Unsupported storage cadence: ' + line);
      if (!streams[key]) streams[key] = { name: key, intervalSeconds, fields: [] };
      if (streams[key].intervalSeconds !== intervalSeconds) throw new Error('Mixed cadence in ' + key);
      streams[key].fields.push({ storageId: Number(t[1]), sensorKey: t[4], aggregation: t[2],
        precision: Number(t[5]), threshold: Number(t[6]), parameter: Number(t[7]),
        timeType: t[8], time1: Number(t[9]), time2: Number(t[10]), flags: Number(t[11]) });
    }
    if (t[0] === 'SETMEMNAME' && streams['mem' + t[1]]) streams['mem' + t[1]].name = JSON.parse(t[2]);
  }
  // Precision 10/11 marks hidden intermediate channels in this verified schedule.
  streams.r3.fields = sensors.filter(s => s.displayPrecision < 10)
    .sort((a, b) => Number(a.key) - Number(b.key))
    .map(s => ({ sensorKey: s.key, aggregation: 'CURRENT', precision: s.displayPrecision }));
  for (const stream of Object.values(streams)) {
    stream.fields.sort((a, b) => (a.storageId || 0) - (b.storageId || 0));
    stream.fields = stream.fields.map((field, i) => {
      const sensor = sensors.find(s => s.key === field.sensorKey);
      if (!sensor) throw new Error('Unknown sensor ' + field.sensorKey);
      return { position: i, ...field, name: sensor.name, unit: sensor.unit };
    });
  }
  const serial = schedule.match(/^SETSERIAL\s+(\S+)/m)?.[1];
  if (!serial || !sensors.length || !streams.mem1) throw new Error('Incomplete schedule');
  return { version: 1, station: { id: 'moore-weather', name: 'Moore Weather', serial,
    timezone: 'Australia/Brisbane', utcOffsetMinutes: 600 },
    evidence: { scheduleSha256: crypto.createHash('sha256').update(schedule).digest('hex'),
      note: 'Historical layout; verify LISTSENSOR, LISTSTORAGE and R3 before using a changed schedule.' },
    sensors, streams };
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node tools/build-station-layout.js schedule.dl3 new-layout.json');
  fs.writeFileSync(output, JSON.stringify(buildLayout(fs.readFileSync(input, 'utf8')), null, 2) + '\n', { flag: 'wx' });
  console.log('Created layout metadata; inspect it before importing any data.');
}
module.exports = { buildLayout };
