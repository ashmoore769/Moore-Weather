'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { WeatherStore, datedLines, hash } = require('../lib/weather-store');

async function main(args) {
  function option(name, fallback) {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value for ' + name);
    return args.splice(i, 2)[1];
  }
  const dbPath = option('--db', path.resolve(__dirname, '../data/weather.sqlite'));
  const layoutPath = option('--layout', path.resolve(__dirname, '../config/station-layout.json'));
  const explicitStream = option('--stream', null);
  const [command, input, captureStream, serial] = args;
  if (!['import', 'capture', 'summary', 'backup', 'vet'].includes(command)) throw new Error('Usage: node tools/weather-db.js import FOLDER | capture FILE STREAM VERIFIED_SERIAL | summary | backup DESTINATION | vet POLICY.json [--db PATH] [--layout PATH] [--stream memN]');
  const store = new WeatherStore(dbPath, JSON.parse(fs.readFileSync(layoutPath, 'utf8')));
  try {
    if (command === 'import') {
      if (!input) throw new Error('Import folder/file required');
      const files = fs.statSync(input).isDirectory()
        ? fs.readdirSync(input).filter(f => /\.(csv|dm\d+)$/i.test(f)).map(f => path.join(input, f)) : [input];
      if (!files.length) throw new Error('No CSV or Environdata exports found');
      const memoryByData = new Map();
      const exports = files.map(filename => ({ filename, bytes: fs.readFileSync(filename) }));
      for (const entry of exports) {
        entry.fingerprint = hash(datedLines(entry.bytes.toString('utf8')).join('\n'));
        const memory = entry.filename.match(/\.dm(\d+)$/i)?.[1];
        if (memory !== undefined) {
          entry.stream = 'mem' + memory;
          if (!memoryByData.has(entry.fingerprint)) memoryByData.set(entry.fingerprint, new Set());
          memoryByData.get(entry.fingerprint).add(entry.stream);
        }
      }
      // Plan every file before writing. Generic CSV headers do not identify its
      // columns. Require an exact Environdata data match or an explicit stream.
      for (const entry of exports) {
        if (explicitStream && entry.stream && explicitStream !== entry.stream) throw new Error('Explicit stream conflicts with Environdata filename');
        const candidates = memoryByData.get(entry.fingerprint);
        entry.stream ||= explicitStream || (candidates?.size === 1 ? [...candidates][0] : null);
        if (!entry.stream) throw new Error(`Cannot identify CSV memory: ${entry.filename}. Supply its verified --stream.`);
      }
      const imports = exports.sort((a, b) => a.filename.localeCompare(b.filename)).map(entry =>
        store.importBuffer(entry.bytes, { name: path.basename(entry.filename), stream: entry.stream,
          format: /\.csv$/i.test(entry.filename) ? 'csv' : 'environdata' }));
      console.log(JSON.stringify({ imports, summary: store.summary() }, null, 2));
      if (imports.some(i => i.rejected)) process.exitCode = 2;
    } else if (command === 'capture') {
      if (!input || !captureStream || !serial) throw new Error('Capture requires file, stream and independently verified logger serial');
      const result = store.importBuffer(fs.readFileSync(input), { name: 'inspection/' + path.basename(path.dirname(input)) + '/' + path.basename(input),
        stream: captureStream, format: 'logger', verifiedSerial: serial });
      console.log(JSON.stringify(result));
      if (result.rejected) process.exitCode = 2;
    } else if (command === 'vet') {
      if (!input) throw new Error('A reviewed quality policy file is required');
      store.setQualityPolicy(JSON.parse(fs.readFileSync(input, 'utf8')));
      console.log(JSON.stringify(store.summary(), null, 2));
    } else if (command === 'summary') console.log(JSON.stringify(store.summary(), null, 2));
    else {
      if (!input) throw new Error('Backup path required');
      await store.backup(input);
      console.log('Created consistent database backup: ' + input);
    }
  } finally { store.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
