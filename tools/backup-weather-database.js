'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync, backup } = require('node:sqlite');

async function createBackup(source, directory, now = new Date()) {
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: true });
  const pattern = /^weather-auto-\d{4}-\d{2}-\d{2}T\d{6}Z\.sqlite\.gz$/;
  const existing = fs.readdirSync(directory).filter(n => pattern.test(n)).sort();
  const newest = existing.at(-1);
  if (newest && now.getTime() - fs.statSync(path.join(directory, newest)).mtimeMs < 23 * 3600000) {
    return { created: false, file: newest };
  }
  const filename = 'weather-auto-' + now.toISOString().slice(0, 19).replaceAll(':', '') + 'Z.sqlite';
  const temp = path.join(directory, filename + '.partial');
  const compressed = path.join(directory, filename + '.gz.partial');
  const destination = path.join(directory, filename + '.gz');
  if (fs.existsSync(destination) || fs.existsSync(temp) || fs.existsSync(compressed)) throw new Error('Backup destination already exists');
  const db = new DatabaseSync(source, { readOnly: true, timeout: 10000 });
  try {
    await backup(db, temp);
  } finally { db.close(); }
  const check = new DatabaseSync(temp, { readOnly: true });
  try {
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
      || check.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup failed integrity verification');
  } finally { check.close(); }
  await pipeline(fs.createReadStream(temp), zlib.createGzip({ level: 6 }), fs.createWriteStream(compressed, { flags: 'wx' }));
  fs.renameSync(compressed, destination);
  fs.unlinkSync(temp);
  // Retain three verified compressed backups. Never remove other user files.
  for (const old of [...existing, path.basename(destination)].sort().slice(0, -3)) fs.unlinkSync(path.join(directory, old));
  return { created: true, file: path.basename(destination), bytes: fs.statSync(destination).size };
}
if (require.main === module) {
  const [source, directory] = process.argv.slice(2);
  if (!source || !directory) throw new Error('Usage: node tools/backup-weather-database.js DATABASE DIRECTORY');
  createBackup(source, directory).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { createBackup };
