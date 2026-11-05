'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  return { directory, env };
}

test('complete encrypted recovery includes committed WAL, alerts and access requests and restores all three', async t => {
  const { directory, env } = fixture(t);
  const result = await createRecoveryBundle({ env, checkpoint: true });
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
