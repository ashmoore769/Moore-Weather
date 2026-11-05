'use strict';

// Portable, authenticated recovery bundles. Only encrypted bytes leave the
// server. Each SQLite file is copied using SQLite's online backup API, not a
// filesystem copy of a database with an active WAL.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync, backup } = require('node:sqlite');

const MAGIC = Buffer.from('MWB1');
const DOMAIN = 'Moore Weather recovery backup v1';
const DATABASE_NAMES = new Set(['weather.sqlite', 'station-alerts.sqlite', 'access-requests.sqlite']);
const MAX_HEADER = 16384;
const MAX_MANIFEST = 65536;
const MIN_FREE_BYTES = 128 * 1024 * 1024;

// Only worker-owned scratch directories are eligible for crash cleanup. A
// running PID, unrelated directory, symlink or completed bundle is untouched.
function cleanupRecoveryWork(directory, { pid = null, ownerExiting = false } = {}) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const match = /^\.recovery-work-([1-9]\d{0,9})-[A-Za-z0-9]{6}$/.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const owner = Number(match[1]);
    if (pid !== null && owner !== pid) continue;
    if (!(ownerExiting && owner === process.pid && pid === process.pid)) {
      try { process.kill(owner, 0); continue; }
      catch (error) { if (error.code !== 'ESRCH') continue; }
    }
    fs.rmSync(path.join(directory, entry.name), { recursive: true, force: true });
  }
}

function encryptionSecret(env = process.env) {
  const secret = env.WEATHER_BACKUP_ENCRYPTION_KEY || env.MOORE_AUTH_COOKIE_SECRET || '';
  if (Buffer.byteLength(secret) < 32) throw new Error('Recovery backup encryption requires a secret of at least 32 bytes');
  return secret;
}

function keyId(secret) {
  return crypto.createHash('sha256').update(DOMAIN).update(secret).digest('hex').slice(0, 16);
}

function deriveKey(secret, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, DOMAIN, 32));
}

async function hashFile(filename) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

function verifyDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 10000 });
  try {
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok') ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Recovery database failed integrity verification');
  } finally { db.close(); }
}

function compactSnapshot(filename) {
  const compacted = filename + '.compact';
  const disk = fs.statfsSync(path.dirname(filename));
  // The original snapshot and its compact replacement coexist. VACUUM INTO
  // avoids the extra overwrite journal required by an in-place VACUUM.
  if (disk.bavail * disk.bsize < fs.statSync(filename).size + MIN_FREE_BYTES) {
    throw new Error('Insufficient free disk space to compact a recovery snapshot');
  }
  const snapshot = new DatabaseSync(filename, { readOnly: true, timeout: 10000 });
  try {
    snapshot.exec('PRAGMA synchronous=FULL;');
    snapshot.prepare('VACUUM INTO ?').run(compacted);
  } finally { snapshot.close(); }
  fs.chmodSync(compacted, 0o600);
  verifyDatabase(compacted);
  // Replace only the worker's temporary snapshot, after validation succeeds.
  // The live database and completed immutable checkpoint are never opened here.
  fs.renameSync(compacted, filename);
}

function readExactly(fd, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, bytes, offset, length - offset, position + offset);
    if (!count) throw new Error('Truncated recovery bundle');
    offset += count;
  }
  return bytes;
}

function readEnvelope(filename, secret) {
  const fd = fs.openSync(filename, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = readExactly(fd, 8, 0);
    const length = start.readUInt32BE(4);
    if (!start.subarray(0, 4).equals(MAGIC) || length < 2 || length > MAX_HEADER || size < 8 + length + 16) {
      throw new Error('Invalid recovery bundle header');
    }
    const headerBytes = readExactly(fd, length, 8);
    const header = JSON.parse(headerBytes.toString('utf8'));
    if (header.version !== 1 || header.cipher !== 'aes-256-gcm' || header.keyId !== keyId(secret) ||
        !/^[a-f0-9]{32}$/.test(header.salt) || !/^[a-f0-9]{24}$/.test(header.iv)) {
      throw new Error('Recovery key or bundle version does not match');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, Buffer.from(header.salt, 'hex')), Buffer.from(header.iv, 'hex'));
    decipher.setAAD(Buffer.concat([start, headerBytes]));
    decipher.setAuthTag(readExactly(fd, 16, size - 16));
    return { header, decipher, start: 8 + length, end: size - 17 };
  } finally { fs.closeSync(fd); }
}

async function verifyEnvelope(filename, secret) {
  const envelope = readEnvelope(filename, secret);
  await pipeline(fs.createReadStream(filename, { start: envelope.start, end: envelope.end }), envelope.decipher,
    new Writable({ write(_chunk, _encoding, done) { done(); } }));
  return envelope.header;
}

function databaseSources(env) {
  const weather = path.resolve(env.WEATHER_DB_PATH);
  const directory = path.dirname(weather);
  const candidates = [
    { name: 'weather.sqlite', source: weather, required: true },
    { name: 'station-alerts.sqlite', source: path.join(directory, 'station-alerts.sqlite'), required: env.WEATHER_ALERTS_ENABLED !== 'false' },
    { name: 'access-requests.sqlite', source: path.resolve(env.ACCESS_REQUEST_DB_PATH || path.join(directory, 'access-requests.sqlite')), required: env.ACCESS_REQUESTS_ENABLED !== 'false' }
  ];
  return candidates.filter(entry => {
    if (fs.existsSync(entry.source)) return true;
    if (entry.required) throw new Error('Required recovery database is unavailable: ' + entry.name);
    return false;
  });
}

async function createRecoveryBundle({ env = process.env, checkpoint = false, now = new Date() } = {}) {
  if (!env.WEATHER_DB_PATH || !env.WEATHER_BACKUP_DIR) throw new Error('Recovery backup paths are not configured');
  const secret = encryptionSecret(env);
  const sources = databaseSources(env);
  const directory = path.resolve(env.WEATHER_BACKUP_DIR);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  cleanupRecoveryWork(directory);
  const disk = fs.statfsSync(directory);
  const totalBytes = sources.reduce((sum, entry) => sum + fs.statSync(entry.source).size +
    (fs.existsSync(entry.source + '-wal') ? fs.statSync(entry.source + '-wal').size : 0), 0);
  if (disk.bavail * disk.bsize < 2 * totalBytes + MIN_FREE_BYTES) throw new Error('Insufficient free disk space for a verified recovery backup');
  const stamp = now.toISOString().replaceAll(':', '').replace(/\.\d{3}/, '');
  const filename = `recovery-${checkpoint ? 'checkpoint-' : ''}${stamp}-${crypto.randomBytes(4).toString('hex')}.mwb`;
  const destination = path.join(directory, filename);
  const temporary = fs.mkdtempSync(path.join(directory, '.recovery-work-' + process.pid + '-'));
  // Ciphertext-in-progress belongs to the same PID-scoped directory as its
  // database snapshots, so SIGKILL leftovers can be removed without guessing.
  const partial = path.join(temporary, filename + '.partial');
  const createdAt = now.toISOString();
  try {
    const entries = [];
    for (const entry of sources) {
      const snapshot = path.join(temporary, entry.name);
      const source = new DatabaseSync(entry.source, { readOnly: true, timeout: 10000 });
      try { await backup(source, snapshot); } finally { source.close(); }
      fs.chmodSync(snapshot, 0o600);
      compactSnapshot(snapshot);
      const bytes = fs.statSync(snapshot).size;
      const sha256 = await hashFile(snapshot);
      const compressed = snapshot + '.gz';
      await pipeline(fs.createReadStream(snapshot), zlib.createGzip({ level: 6 }), fs.createWriteStream(compressed, { flags: 'wx', mode: 0o600 }));
      entries.push({ name: entry.name, bytes, sha256, compressedBytes: fs.statSync(compressed).size, compressedSha256: await hashFile(compressed) });
      fs.unlinkSync(snapshot);
    }
    const manifest = Buffer.from(JSON.stringify({ version: 1, createdAt, checkpoint, databases: entries }));
    const manifestLength = Buffer.alloc(4); manifestLength.writeUInt32BE(manifest.length);
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const header = { version: 1, cipher: 'aes-256-gcm', createdAt, keyId: keyId(secret), salt: salt.toString('hex'), iv: iv.toString('hex') };
    const encoded = Buffer.from(JSON.stringify(header));
    const prefix = Buffer.alloc(8); MAGIC.copy(prefix); prefix.writeUInt32BE(encoded.length, 4);
    const aad = Buffer.concat([prefix, encoded]);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
    cipher.setAAD(aad);
    async function* payload() {
      yield manifestLength; yield manifest;
      for (const entry of entries) yield* fs.createReadStream(path.join(temporary, entry.name + '.gz'));
    }
    fs.writeFileSync(partial, aad, { flag: 'wx', mode: 0o600 });
    await pipeline(Readable.from(payload()), cipher, fs.createWriteStream(partial, { flags: 'a', mode: 0o600 }));
    fs.appendFileSync(partial, cipher.getAuthTag());
    await verifyEnvelope(partial, secret);
    const sha256 = await hashFile(partial);
    // Flush the complete verified ciphertext before making it visible.
    const fd = fs.openSync(partial, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(partial, destination);
    return { verified: true, checkpoint, file: filename, createdAt, sha256, bytes: fs.statSync(destination).size,
      keyId: header.keyId, databases: entries.map(entry => entry.name) };
  } finally {
    fs.rmSync(partial, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function restoreRecoveryBundle(filename, outputDirectory, { secret = encryptionSecret() } = {}) {
  const destination = path.resolve(outputDirectory);
  if (fs.existsSync(destination)) throw new Error('Restore requires a new output directory; existing data is never overwritten');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.recovery-restore-'));
  const packed = path.join(temporary, 'verified.payload');
  const extracted = path.join(temporary, 'databases');
  try {
    const envelope = readEnvelope(filename, secret);
    // Authenticate the ENTIRE bundle before interpreting or publishing plaintext.
    await pipeline(fs.createReadStream(filename, { start: envelope.start, end: envelope.end }), envelope.decipher,
      fs.createWriteStream(packed, { flags: 'wx', mode: 0o600 }));
    const fd = fs.openSync(packed, 'r');
    let manifest, offset;
    try {
      const length = readExactly(fd, 4, 0).readUInt32BE();
      if (length < 2 || length > MAX_MANIFEST) throw new Error('Invalid recovery manifest length');
      manifest = JSON.parse(readExactly(fd, length, 4).toString('utf8'));
      offset = 4 + length;
    } finally { fs.closeSync(fd); }
    if (manifest.version !== 1 || !Array.isArray(manifest.databases) || manifest.databases.length < 1 || manifest.databases.length > 3) {
      throw new Error('Invalid recovery manifest');
    }
    fs.mkdirSync(extracted, { mode: 0o700 });
    const seen = new Set();
    for (const entry of manifest.databases) {
      if (!DATABASE_NAMES.has(entry.name) || seen.has(entry.name) || !Number.isSafeInteger(entry.compressedBytes) || entry.compressedBytes < 1 ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{64}$/.test(entry.compressedSha256)) {
        throw new Error('Invalid recovery database entry');
      }
      seen.add(entry.name);
      const compressedHash = crypto.createHash('sha256');
      const compressed = fs.createReadStream(packed, { start: offset, end: offset + entry.compressedBytes - 1 });
      compressed.on('data', chunk => compressedHash.update(chunk));
      const target = path.join(extracted, entry.name);
      await pipeline(compressed, zlib.createGunzip(), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      if (compressedHash.digest('hex') !== entry.compressedSha256 || fs.statSync(target).size !== entry.bytes || await hashFile(target) !== entry.sha256) {
        throw new Error('Recovery database checksum mismatch');
      }
      verifyDatabase(target);
      offset += entry.compressedBytes;
    }
    if (!seen.has('weather.sqlite') || offset !== fs.statSync(packed).size) throw new Error('Incomplete recovery bundle');
    fs.renameSync(extracted, destination);
    return { verified: true, createdAt: manifest.createdAt, checkpoint: manifest.checkpoint, databases: [...seen], directory: destination };
  } finally { await fsp.rm(temporary, { recursive: true, force: true }); }
}

module.exports = { cleanupRecoveryWork, createRecoveryBundle, restoreRecoveryBundle, verifyEnvelope, verifyDatabase, hashFile, encryptionSecret, databaseSources, keyId };
