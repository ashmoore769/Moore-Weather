'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { createRecoveryBundle, restoreRecoveryBundle, verifyEnvelope } = require('../lib/recovery-backup');
const { createBackupScheduler } = require('../lib/database-backups');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moore-recovery-'));
  const env = { WEATHER_DB_PATH: path.join(directory, 'weather.sqlite'), WEATHER_BACKUP_DIR: path.join(directory, 'backups'),
    MOORE_AUTH_COOKIE_SECRET: 'synthetic-test-recovery-secret-'.repeat(3) };
  const databases = [];
  for (const [index, name] of ['weather.sqlite', 'station-alerts.sqlite', 'access-requests.sqlite'].entries()) {
    const db = new DatabaseSync(path.join(directory, name));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE saved(id INTEGER PRIMARY KEY, value TEXT);');
    db.prepare('INSERT INTO saved VALUES(?,?)').run(index + 1, 'private-' + name);
    databases.push(db);
  }
  t.after(() => { for (const db of databases) db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, env, databases };
}

function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
    const filename = path.join(directory, entry.name);
    return sum + (entry.isDirectory() ? directoryBytes(filename) : fs.statSync(filename).size);
  }, 0);
}

function limitedBackupDisk(t, directory, usableBytes) {
  const reserve = 512 * 1024 * 1024;
  const existing = directoryBytes(directory), capacity = existing + usableBytes + reserve;
  let peak = existing;
  const measure = () => { const bytes = directoryBytes(directory); peak = Math.max(peak, bytes); return bytes; };
  t.mock.method(fs, 'statfsSync', () => ({ bsize: 1, bavail: Math.max(0, capacity - measure()) }));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => { measure(); return rename(...args); });
  return { peak: () => peak - existing, reserve };
}

test('recovery fits one logical snapshot and compressed output without staging a second database copy', async t => {
  const { directory, env, databases } = fixture(t);
  const source = databases[0];
  source.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE payloads(id INTEGER PRIMARY KEY, payload BLOB);');
  source.prepare('INSERT INTO payloads VALUES(1,?)').run(Buffer.alloc(8 * 1024 * 1024, 0x5a));
  const logicalBytes = source.prepare('PRAGMA page_count').get().page_count * source.prepare('PRAGMA page_size').get().page_size;
  const usableBytes = logicalBytes + 1280 * 1024;
  const disk = limitedBackupDisk(t, env.WEATHER_BACKUP_DIR, usableBytes);
  const result = await createRecoveryBundle({ env });
  assert.ok(result.verified);
  assert.ok(disk.peak() <= usableBytes, 'actual staging must leave the 512 MiB reserve available');
  assert.ok(disk.peak() < 2 * logicalBytes, 'do not keep two full database copies during compaction');
  const destination = path.join(directory, 'limited-disk-restore');
  await restoreRecoveryBundle(path.join(env.WEATHER_BACKUP_DIR, result.file), destination, { secret: env.MOORE_AUTH_COOKIE_SECRET });
  const restored = new DatabaseSync(path.join(destination, 'weather.sqlite'), { readOnly: true });
  try { assert.deepEqual(Buffer.from(restored.prepare('SELECT payload FROM payloads').get().payload), Buffer.alloc(8 * 1024 * 1024, 0x5a)); }
  finally { restored.close(); }
});

test('incompressible output cannot consume the disk reserve or replace a completed checkpoint', async t => {
  const { env, databases } = fixture(t);
  const checkpoint = await createRecoveryBundle({ env, checkpoint: true });
  const checkpointBytes = fs.readFileSync(path.join(env.WEATHER_BACKUP_DIR, checkpoint.file));
  fs.writeFileSync(path.join(env.WEATHER_BACKUP_DIR, 'owner-note.txt'), 'keep');
  const source = databases[0], payload = crypto.randomBytes(2 * 1024 * 1024);
  source.exec('CREATE TABLE payloads(id INTEGER PRIMARY KEY, payload BLOB);');
  source.prepare('INSERT INTO payloads VALUES(1,?)').run(payload);
  const logicalBytes = source.prepare('PRAGMA page_count').get().page_count * source.prepare('PRAGMA page_size').get().page_size;
  const usableBytes = logicalBytes + 1088 * 1024;
  const disk = limitedBackupDisk(t, env.WEATHER_BACKUP_DIR, usableBytes);
  await assert.rejects(createRecoveryBundle({ env }), /Recovery compression exceeded its disk budget|Insufficient free disk space for recovery compression/);
  assert.ok(disk.peak() <= usableBytes, 'failed compression must preserve the reserve');
  assert.deepEqual(fs.readdirSync(env.WEATHER_BACKUP_DIR).sort(), [checkpoint.file, 'owner-note.txt'].sort());
  assert.deepEqual(fs.readFileSync(path.join(env.WEATHER_BACKUP_DIR, checkpoint.file)), checkpointBytes);
  assert.deepEqual(Buffer.from(source.prepare('SELECT payload FROM payloads').get().payload), payload);
});

test('a genuine snapshot-space shortage reports numeric requirements and leaves source files unchanged', async t => {
  const { env, databases } = fixture(t);
  const original = fs.readFileSync(env.WEATHER_DB_PATH), wal = fs.readFileSync(env.WEATHER_DB_PATH + '-wal');
  limitedBackupDisk(t, env.WEATHER_BACKUP_DIR, 1024 * 1024);
  await assert.rejects(createRecoveryBundle({ env }), error => {
    assert.match(error.message, /^Insufficient free disk space for recovery snapshot: available \d+ bytes, required \d+ bytes \(including 536870912 bytes reserve\)$/);
    assert.equal(error.message.includes(env.WEATHER_DB_PATH), false);
    assert.equal(error.message.includes(env.MOORE_AUTH_COOKIE_SECRET), false);
    return true;
  });
  assert.deepEqual(fs.readdirSync(env.WEATHER_BACKUP_DIR), []);
  assert.deepEqual(fs.readFileSync(env.WEATHER_DB_PATH), original);
  assert.deepEqual(fs.readFileSync(env.WEATHER_DB_PATH + '-wal'), wal);
  assert.equal(databases[0].prepare('SELECT value FROM saved').get().value, 'private-weather.sqlite');
});

test('a compression preflight failure opens no dangling reader before cleaning scratch', async t => {
  const { env } = fixture(t);
  let snapshotReads = 0;
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (filename, ...args) => {
    if (String(filename).startsWith(env.WEATHER_BACKUP_DIR + path.sep) && path.basename(filename) === 'weather.sqlite') snapshotReads++;
    return createReadStream(filename, ...args);
  });
  t.mock.method(fs, 'statfsSync', () => {
    const scratch = fs.existsSync(env.WEATHER_BACKUP_DIR) && fs.readdirSync(env.WEATHER_BACKUP_DIR).find(name => name.startsWith('.recovery-work-'));
    const ready = scratch && fs.existsSync(path.join(env.WEATHER_BACKUP_DIR, scratch, 'weather.sqlite'));
    // The snapshot and hash succeed, then another disk user consumes the
    // available output budget just before the compression streams are opened.
    return { bsize: 1, bavail: ready ? 513 * 1024 * 1024 - 1 : 4 * 1024 ** 3 };
  });
  await assert.rejects(createRecoveryBundle({ env }), /Insufficient free disk space for recovery compression/);
  assert.equal(snapshotReads, 1, 'only the completed hash read may have opened; compression must not start');
  assert.deepEqual(fs.readdirSync(env.WEATHER_BACKUP_DIR), []);
  await new Promise(resolve => setImmediate(resolve));
});

test('ciphertext space is checked separately after all compressed inputs are ready', async t => {
  const { env } = fixture(t);
  const reserve = 512 * 1024 * 1024;
  t.mock.method(fs, 'statfsSync', () => {
    const scratch = fs.existsSync(env.WEATHER_BACKUP_DIR) && fs.readdirSync(env.WEATHER_BACKUP_DIR).find(name => name.startsWith('.recovery-work-'));
    const files = scratch ? fs.readdirSync(path.join(env.WEATHER_BACKUP_DIR, scratch)) : [];
    const gzipOnly = files.length === 3 && files.every(name => name.endsWith('.sqlite.gz'));
    const compressedBytes = gzipOnly ? directoryBytes(path.join(env.WEATHER_BACKUP_DIR, scratch)) : 0;
    // Simulate other live writes consuming space after snapshot compression.
    // There is room for the compressed inputs, but not the complete envelope.
    return { bsize: 1, bavail: gzipOnly ? reserve + 1024 * 1024 + compressedBytes : 4 * 1024 ** 3 };
  });
  await assert.rejects(createRecoveryBundle({ env }), /Insufficient free disk space for recovery encryption: available \d+ bytes, required \d+ bytes/);
  assert.deepEqual(fs.readdirSync(env.WEATHER_BACKUP_DIR), []);
});

test('recovery compacts only its snapshots and excludes deleted payload while preserving all retained data', async t => {
  const { directory, env, databases } = fixture(t);
  const source = databases[0], retained = new Map();
  source.exec('PRAGMA secure_delete=OFF; CREATE TABLE payloads(id INTEGER PRIMARY KEY, payload BLOB); BEGIN');
  const insert = source.prepare('INSERT INTO payloads VALUES(?,?)');
  for (let id = 1; id <= 1000; id++) {
    const payload = crypto.randomBytes(1024); insert.run(id, payload);
    if (id > 900) retained.set(id, payload);
  }
  source.exec('COMMIT; DELETE FROM payloads WHERE id<=900; PRAGMA wal_checkpoint(TRUNCATE)');
  const original = fs.readFileSync(env.WEATHER_DB_PATH);
  const originalFree = source.prepare('PRAGMA freelist_count').get().freelist_count;
  assert.ok(originalFree > 100);
  const ordinaryGzipBytes = zlib.gzipSync(original, { level: 6 }).length;
  const result = await createRecoveryBundle({ env });
  assert.ok(result.bytes < ordinaryGzipBytes / 3, 'deleted payload must not remain in the encrypted backup');
  const output = path.join(directory, 'compacted-restore');
  await restoreRecoveryBundle(path.join(env.WEATHER_BACKUP_DIR, result.file), output, { secret: env.MOORE_AUTH_COOKIE_SECRET });
  const restored = new DatabaseSync(path.join(output, 'weather.sqlite'), { readOnly: true });
  try {
    const rows = restored.prepare('SELECT id,payload FROM payloads ORDER BY id').all();
    assert.equal(rows.length, retained.size);
    for (const row of rows) assert.deepEqual(Buffer.from(row.payload), retained.get(row.id));
    assert.equal(restored.prepare('SELECT value FROM saved').get().value, 'private-weather.sqlite');
    assert.equal(restored.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  } finally { restored.close(); }
  assert.deepEqual(fs.readFileSync(env.WEATHER_DB_PATH), original, 'the live source file must remain unchanged');
  assert.equal(source.prepare('PRAGMA freelist_count').get().freelist_count, originalFree);
  assert.equal(source.prepare('SELECT count(*) AS n FROM payloads').get().n, retained.size);
});

test('failed compact-snapshot promotion removes owned work files and preserves completed backups and source data', async t => {
  const { env, databases } = fixture(t);
  const checkpoint = await createRecoveryBundle({ env, checkpoint: true });
  const originalCheckpoint = fs.readFileSync(path.join(env.WEATHER_BACKUP_DIR, checkpoint.file));
  fs.writeFileSync(path.join(env.WEATHER_BACKUP_DIR, 'owner-note.txt'), 'keep');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith('.compact')) throw new Error('simulated snapshot promotion failure');
    return rename(from, to);
  });
  await assert.rejects(createRecoveryBundle({ env }), /snapshot promotion failure/);
  assert.deepEqual(fs.readdirSync(env.WEATHER_BACKUP_DIR).sort(), [checkpoint.file, 'owner-note.txt'].sort());
  assert.deepEqual(fs.readFileSync(path.join(env.WEATHER_BACKUP_DIR, checkpoint.file)), originalCheckpoint);
  assert.equal(databases[0].prepare('SELECT value FROM saved').get().value, 'private-weather.sqlite');
});

test('complete encrypted recovery includes committed WAL, alerts and access requests and restores all three', async t => {
  const { directory, env, databases } = fixture(t);
  const originals = new Map();
  for (const name of ['weather.sqlite', 'station-alerts.sqlite', 'access-requests.sqlite']) {
    for (const suffix of ['', '-wal']) {
      const filename = path.join(directory, name + suffix);
      originals.set(filename, fs.readFileSync(filename));
    }
    assert.ok(originals.get(path.join(directory, name + '-wal')).length > 32, 'committed data is still in the WAL');
    assert.equal(originals.get(path.join(directory, name)).includes(Buffer.from('private-' + name)), false,
      'the committed row must not already be present in the physical source file');
  }
  const result = await createRecoveryBundle({ env, checkpoint: true });
  for (const [filename, original] of originals) assert.deepEqual(fs.readFileSync(filename), original, 'backup must not rewrite live database or WAL bytes');
  for (const [index, db] of databases.entries()) assert.equal(db.prepare('SELECT id FROM saved').get().id, index + 1);
  assert.equal(result.verified, true);
  assert.equal(result.databases.length, 3);
  const source = path.join(env.WEATHER_BACKUP_DIR, result.file);
  assert.equal(fs.statSync(source).mode & 0o777, 0o600);
  const bytes = fs.readFileSync(source);
  assert.equal(bytes.subarray(0, 4).toString(), 'MWB1');
  assert.equal(bytes.includes(Buffer.from('private-weather.sqlite')), false);
  assert.equal(bytes.includes(Buffer.from(env.MOORE_AUTH_COOKIE_SECRET)), false);
  await verifyEnvelope(source, env.MOORE_AUTH_COOKIE_SECRET);
  const destination = path.join(directory, 'restored');
  const restored = await restoreRecoveryBundle(source, destination, { secret: env.MOORE_AUTH_COOKIE_SECRET });
  assert.equal(restored.checkpoint, true);
  for (const name of result.databases) {
    const db = new DatabaseSync(path.join(destination, name), { readOnly: true });
    try { assert.equal(db.prepare('SELECT value FROM saved').get().value, 'private-' + name); } finally { db.close(); }
  }
  await assert.rejects(restoreRecoveryBundle(source, destination, { secret: env.MOORE_AUTH_COOKIE_SECRET }), /new output directory/);
  assert.deepEqual(fs.readdirSync(env.WEATHER_BACKUP_DIR), [result.file]);
});

test('wrong key and modified ciphertext fail authentication before any restored directory is published', async t => {
  const { directory, env } = fixture(t);
  const result = await createRecoveryBundle({ env });
  const source = path.join(env.WEATHER_BACKUP_DIR, result.file);
  await assert.rejects(restoreRecoveryBundle(source, path.join(directory, 'wrong-key'), { secret: 'incorrect-test-secret'.repeat(4) }));
  const bytes = fs.readFileSync(source); bytes[bytes.length - 22] ^= 1;
  const altered = path.join(directory, 'altered.mwb'); fs.writeFileSync(altered, bytes);
  await assert.rejects(restoreRecoveryBundle(altered, path.join(directory, 'altered-output'), { secret: env.MOORE_AUTH_COOKIE_SECRET }));
  assert.equal(fs.existsSync(path.join(directory, 'wrong-key')), false);
  assert.equal(fs.existsSync(path.join(directory, 'altered-output')), false);
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.recovery-restore-')), false);
});

test('missing required recovery database fails closed instead of silently producing an incomplete backup', async t => {
  const { directory, env } = fixture(t);
  await assert.rejects(createRecoveryBundle({ env: { ...env, ACCESS_REQUEST_DB_PATH: path.join(directory, 'missing.sqlite') } }), /Required recovery database/);
});

test('retention stays blocked until the complete checkpoint has an offsite acknowledgment and survives restart', async t => {
  const { env } = fixture(t);
  const persistence = { status: () => ({ ready: true }) };
  const logger = { info() {}, warn() {}, error() {} };
  const scheduler = createBackupScheduler(env, persistence, logger);
  t.after(() => scheduler.close());
  const [first, shared] = await Promise.all([scheduler.run(), scheduler.run()]);
  assert.ok(first?.verified);
  assert.equal(first.sha256, shared.sha256);
  assert.equal(scheduler.status().retentionCheckpointVerified, false);
  assert.equal((await scheduler.run()).sha256, first.sha256);
  assert.throws(() => scheduler.acknowledge({ sha256: '0'.repeat(64), artifactId: '1', runId: '123' }), /does not match/);
  scheduler.acknowledge({ sha256: first.sha256, artifactId: '1234', runId: '123' });
  assert.equal(scheduler.status().retentionCheckpointVerified, true);
  const restarted = createBackupScheduler(env, persistence, logger);
  assert.equal(restarted.status().retentionCheckpointVerified, true);
  assert.equal(restarted.status().offsiteArtifactId, '1234');
  assert.equal((await restarted.exportLatest()).sha256, first.sha256);
  fs.unlinkSync(path.join(env.WEATHER_BACKUP_DIR, first.file));
  assert.equal(restarted.status().retentionCheckpointVerified, false);
  restarted.close();
});
