'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { WeatherStore } = require('../lib/weather-store');
const { importCapture, inspectCapture } = require('../lib/terminal-capture');
const { interpolateTenMinute } = require('../lib/weather-interpolation');

async function main(manifestFile) {
  if (!manifestFile) throw new Error('Usage: node tools/import-terminal-history.js MANIFEST.json');
  const manifestPath = path.resolve(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const base = path.dirname(manifestPath);
  const store = new WeatherStore(path.resolve(base, manifest.database));
  try {
    if (manifest.verifiedSerial !== store.layout.station.serial) throw new Error('Station serial mismatch');
    const captures = manifest.captures.map(c => ({ ...c, bytes: fs.readFileSync(path.resolve(base, c.path)) }));
    // Resolve every section before the first import; no station connection is used.
    for (const capture of captures) inspectCapture(capture.bytes, store.layout, capture.initialStream);
    const imports = captures.map(c => importCapture(store, c.bytes, {
      name: path.basename(c.path), verifiedSerial: manifest.verifiedSerial, initialStream: c.initialStream
    }));
    store.setQualityPolicy(JSON.parse(fs.readFileSync(path.resolve(base, manifest.policy), 'utf8')));
    const estimates = (manifest.interpolate || []).map(local => interpolateTenMinute(store, local,
      'Owner authorised filling these two ten-minute gaps on 11 October 2026. Midpoint of adjacent vetted measurements; compass bearings follow the shortest arc. Rain, maxima and spread are estimates, not recovered observations.'));
    const report = { completedAt: new Date().toISOString(), imports, estimates, summary: store.summary() };
    if (report.summary.integrity !== 'ok' || report.summary.foreignKeyErrors || report.summary.conflicts) throw new Error('Post-import database verification failed');
    fs.writeFileSync(path.resolve(base, manifest.report), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { store.close(); }
}
if (require.main === module) main(process.argv[2]).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { main };
