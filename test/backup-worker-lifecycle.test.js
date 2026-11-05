'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { cleanupRecoveryWork } = require('../lib/recovery-backup');
const { createBackupScheduler, CHECKPOINT_OFFSITE_MAX_AGE } = require('../lib/database-backups');
const logger = { info() {}, error() {} };
const persistence = { status: () => ({ ready: true }) };
const DEAD_PID = 2147483647;

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-lifecycle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, env: { WEATHER_DB_PATH: path.join(directory, 'unused.sqlite'), WEATHER_BACKUP_DIR: directory } };
}
function child() {
  const worker = new EventEmitter();
  worker.stdout = new PassThrough(); worker.stderr = new PassThrough(); worker.signals = [];
  worker.kill = signal => { worker.signals.push(signal); return true; };
  return worker;
}
function completedWorker(directory, now) {
  const worker = child();
  const file = 'recovery-checkpoint-' + new Date(now).toISOString().replaceAll(':', '').replace(/\.\d{3}/, '') + '-1234abcd.mwb';
  const ciphertext = Buffer.from('a fixture for scheduler lifecycle, cryptography is tested separately');
  fs.writeFileSync(path.join(directory, file), ciphertext);
  queueMicrotask(() => {
    worker.stdout.write(JSON.stringify({ verified: true, checkpoint: true, file, createdAt: new Date(now).toISOString(),
      sha256: crypto.createHash('sha256').update(ciphertext).digest('hex'), bytes: ciphertext.length, databases: ['weather.sqlite'] }));
    worker.emit('close', 0);
  });
  return worker;
}

test('a synchronous spawn failure releases the promise latch and permits a healthy retry', async t => {
  const { directory, env } = setup(t);
  let calls = 0;
  const now = Date.now();
  const scheduler = createBackupScheduler(env, persistence, logger, { now: () => now, spawnWorker() {
    if (++calls === 1) throw Error('worker could not start');
    return completedWorker(directory, now);
  } });
  t.after(() => scheduler.close());
  assert.equal(await scheduler.run(), null);
  assert.equal(scheduler.status().running, false);
  assert.match(scheduler.status().error, /could not start/);
  assert.equal((await scheduler.run()).verified, true);
  assert.equal(calls, 2);
  assert.equal(scheduler.status().error, null);
});

test('worker timeout keeps single-flight ownership until close and cleans only that dead worker', async t => {
  const { directory, env } = setup(t);
  const worker = child(); worker.pid = DEAD_PID;
  let calls = 0;
  const scheduler = createBackupScheduler(env, persistence, logger, {
    workerTimeoutMs: 10, terminateGraceMs: 1000, spawnWorker() { calls++; return worker; }
  });
  t.after(() => scheduler.close());
  const pending = scheduler.run();
  const scratch = path.join(directory, '.recovery-work-' + DEAD_PID + '-Ab12xy');
  fs.mkdirSync(scratch); fs.writeFileSync(path.join(scratch, 'recovery-test.mwb.partial'), 'incomplete');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(worker.signals, ['SIGTERM']);
  assert.equal(scheduler.status().running, true);
  assert.strictEqual(scheduler.run(), pending);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(scratch), true);
  worker.emit('close', null);
  assert.equal(await pending, null);
  assert.equal(scheduler.status().running, false);
  assert.match(scheduler.status().error, /deadline/);
  assert.equal(fs.existsSync(scratch), false);
});

test('crash cleanup preserves active workers, completed bundles, unrelated paths and symlinks', t => {
  const { directory } = setup(t);
  const dead = '.recovery-work-' + DEAD_PID + '-Ab12xy';
  const live = '.recovery-work-' + process.pid + '-Ab12xy';
  const unrelated = '.recovery-work-owner-files';
  for (const name of [dead, live, unrelated]) {
    fs.mkdirSync(path.join(directory, name));
    fs.writeFileSync(path.join(directory, name, 'keep-or-remove.mwb.partial'), 'data');
  }
  const completed = path.join(directory, 'recovery-checkpoint-2026-11-05T000000Z-1234abcd.mwb');
  fs.writeFileSync(completed, 'verified');
  const link = path.join(directory, '.recovery-work-' + DEAD_PID + '-Cd34xy');
  fs.symlinkSync(path.join(directory, unrelated), link);
  cleanupRecoveryWork(directory);
  assert.equal(fs.existsSync(path.join(directory, dead)), false);
  for (const name of [live, unrelated]) assert.equal(fs.existsSync(path.join(directory, name, 'keep-or-remove.mwb.partial')), true);
  assert.equal(fs.readFileSync(completed, 'utf8'), 'verified');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('checkpoint receipt expires before artifact deletion and export renews the same immutable copy', async t => {
  const { directory, env } = setup(t);
  let clock = Date.now(), calls = 0;
  const scheduler = createBackupScheduler(env, persistence, logger, { now: () => clock, spawnWorker() {
    calls++; return completedWorker(directory, clock);
  } });
  t.after(() => scheduler.close());
  const first = await scheduler.run();
  scheduler.acknowledge({ sha256: first.sha256, artifactId: '100', runId: '200' });
  assert.equal(scheduler.status().retentionCheckpointVerified, true);
  clock += CHECKPOINT_OFFSITE_MAX_AGE;
  assert.equal(scheduler.status().retentionCheckpointVerified, false);
  assert.equal((await scheduler.exportLatest()).sha256, first.sha256);
  assert.equal(calls, 1);
  scheduler.acknowledge({ sha256: first.sha256, artifactId: '101', runId: '201' });
  assert.equal(scheduler.status().retentionCheckpointVerified, true);
  const restarted = createBackupScheduler(env, persistence, logger, { now: () => clock });
  assert.equal(restarted.status().retentionCheckpointVerified, true);
  assert.equal(restarted.status().checkpoint.artifactId, '101');
  restarted.close();
});

test('failed durable acknowledgement cannot authorize retention from memory', async t => {
  const { directory, env } = setup(t);
  const now = Date.now();
  const scheduler = createBackupScheduler(env, persistence, logger, { now: () => now,
    spawnWorker: () => completedWorker(directory, now) });
  t.after(() => scheduler.close());
  const first = await scheduler.run();
  const obstruction = path.join(directory, 'recovery-state.json.partial');
  fs.mkdirSync(obstruction);
  assert.throws(() => scheduler.acknowledge({ sha256: first.sha256, artifactId: '100', runId: '200' }));
  assert.equal(scheduler.status().retentionCheckpointVerified, false);
  assert.equal(scheduler.status().offsiteLastSuccess, null);
  fs.rmdirSync(obstruction);
  scheduler.acknowledge({ sha256: first.sha256, artifactId: '100', runId: '200' });
  assert.equal(scheduler.status().retentionCheckpointVerified, true);
});
