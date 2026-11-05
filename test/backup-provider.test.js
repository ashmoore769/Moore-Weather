'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createBackupScheduler, CHECKPOINT_OFFSITE_MAX_AGE } = require('../lib/database-backups');
const { mountBackupRoutes } = require('../lib/backup-auth');
const logger = { info() {}, warn() {}, error() {} };

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moore-provider-'));
  const env = { WEATHER_DB_PATH: path.join(directory, 'weather.sqlite'), WEATHER_BACKUP_DIR: path.join(directory, 'backups'),
    WEATHER_ALERTS_ENABLED: 'false', ACCESS_REQUESTS_ENABLED: 'false', MOORE_AUTH_COOKIE_SECRET: 'synthetic-provider-secret-'.repeat(3) };
  const database = new DatabaseSync(env.WEATHER_DB_PATH);
  database.exec('CREATE TABLE saved(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO saved VALUES(1,\'preserved\');');
  database.close();
  let timestamp = Date.now();
  const options = { now: () => timestamp }, persistence = { status: () => ({ ready: true }) };
  const scheduler = createBackupScheduler(env, persistence, logger, options);
  const checkpoint = await scheduler.run();
  assert.ok(checkpoint?.verified);
  t.after(() => { scheduler.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { env, scheduler, checkpoint, advance: ms => timestamp += ms,
    restart: () => createBackupScheduler(env, persistence, logger, options) };
}

test('legacy Actions acknowledgements and existing marker files remain valid after provider migration', async t => {
  const f = await fixture(t);
  const result = f.scheduler.acknowledge({ sha256: f.checkpoint.sha256, artifactId: '100', runId: '200' });
  assert.equal(result.storageProvider, 'github-actions'); assert.equal(result.releaseId, null);
  const stateFile = path.join(f.env.WEATHER_BACKUP_DIR, 'recovery-state.json');
  const old = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete old.offsiteStorageProvider; delete old.offsiteReleaseId;
  for (const entry of [old.checkpoint, old.latest]) { delete entry.storageProvider; delete entry.releaseId; }
  fs.writeFileSync(stateFile, JSON.stringify(old));
  const restarted = f.restart(); t.after(() => restarted.close());
  assert.equal(restarted.status().retentionCheckpointVerified, true);
  assert.equal(restarted.status().offsiteStorageProvider, 'github-actions');
  const exported = await restarted.exportLatest();
  assert.equal(exported.sha256, f.checkpoint.sha256);
  assert.equal(exported.storageProvider, 'github-actions'); assert.equal(exported.releaseId, null);
});

test('release migration persists the new external identity and reverifies the same immutable checkpoint', async t => {
  const f = await fixture(t);
  f.scheduler.acknowledge({ sha256: f.checkpoint.sha256, artifactId: '100', runId: '200' });
  const filename = path.join(f.env.WEATHER_BACKUP_DIR, f.checkpoint.file);
  const original = fs.readFileSync(filename);
  const result = f.scheduler.acknowledge({ sha256: f.checkpoint.sha256, artifactId: '300', runId: '201',
    storageProvider: 'github-release', releaseId: '400' });
  assert.equal(result.storageProvider, 'github-release'); assert.equal(result.releaseId, '400');
  const restarted = f.restart(); t.after(() => restarted.close());
  assert.equal(restarted.status().retentionCheckpointVerified, true);
  assert.equal(restarted.status().offsiteStorageProvider, 'github-release');
  assert.equal(restarted.status().offsiteReleaseId, '400');
  let exported = await restarted.exportLatest();
  assert.equal(exported.artifactId, '300'); assert.equal(exported.storageProvider, 'github-release');
  assert.equal(exported.releaseId, '400'); assert.equal(exported.sha256, f.checkpoint.sha256);
  f.advance(CHECKPOINT_OFFSITE_MAX_AGE);
  assert.equal(restarted.status().retentionCheckpointVerified, false);
  exported = await restarted.exportLatest();
  assert.equal(exported.sha256, f.checkpoint.sha256);
  restarted.acknowledge({ sha256: exported.sha256, artifactId: '300', runId: '202', storageProvider: 'github-release', releaseId: '400' });
  assert.equal(restarted.status().retentionCheckpointVerified, true);
  assert.deepEqual(fs.readFileSync(filename), original);
});

test('unknown providers and missing, non-positive or injected release identities cannot change durable backup state', async t => {
  const f = await fixture(t);
  const original = fs.readFileSync(path.join(f.env.WEATHER_BACKUP_DIR, 'recovery-state.json'));
  for (const extra of [{ storageProvider: 'other' }, { storageProvider: null }, { storageProvider: 'github-release' },
    ...[null, 0, -1, '0', '01', '1\n', '1/2', 'bad', 1.5, 1e20].map(releaseId => ({ storageProvider: 'github-release', releaseId })),
    { storageProvider: 'github-actions', releaseId: '400' }]) {
    assert.throws(() => f.scheduler.acknowledge({ sha256: f.checkpoint.sha256, artifactId: '300', runId: '200', ...extra }), /storage provider/);
    assert.equal(f.scheduler.status().retentionCheckpointVerified, false);
    assert.deepEqual(fs.readFileSync(path.join(f.env.WEATHER_BACKUP_DIR, 'recovery-state.json')), original);
  }
});

test('authenticated acknowledgement passes provider metadata and uses the signed run identity, then exports that metadata', async t => {
  const f = await fixture(t), app = require('express')();
  mountBackupRoutes(app, { getScheduler: () => f.scheduler, logger, verifier: async token => {
    if (token !== 'synthetic.fixture.token') throw new Error('not authorized');
    return { run_id: '200' };
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer synthetic.fixture.token', 'Content-Type': 'application/json' };
  const payload = { sha256: f.checkpoint.sha256, artifactId: '300', storageProvider: 'github-release', releaseId: '400', runId: 'untrusted' };
  const denied = await fetch(base + '/internal/backups/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(denied.status, 403);
  const response = await fetch(base + '/internal/backups/ack', { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const acknowledged = await response.json();
  assert.equal(acknowledged.storageProvider, 'github-release'); assert.equal(acknowledged.releaseId, '400');
  assert.equal(f.scheduler.status().checkpoint.runId, '200');
  const exported = await fetch(base + '/internal/backups/export', { headers });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('x-backup-storage-provider'), 'github-release');
  assert.equal(exported.headers.get('x-backup-release-id'), '400');
  assert.equal((await exported.arrayBuffer()).byteLength, f.checkpoint.bytes);
});
