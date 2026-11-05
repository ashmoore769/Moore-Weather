'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cleanupRecoveryWork } = require('./recovery-backup');

const REGULAR_FILE = /^recovery-\d{4}-\d{2}-\d{2}T\d{6}Z-[a-f0-9]{8}\.mwb$/;
const ANY_FILE = /^recovery-(?:checkpoint-)?\d{4}-\d{2}-\d{2}T\d{6}Z-[a-f0-9]{8}\.mwb$/;
const DAY = 86400000;
// Reverify the immutable offsite checkpoint periodically. This also renews any
// legacy 30-day Actions copy before expiry during migration to release storage.
const CHECKPOINT_OFFSITE_MAX_AGE = 28 * DAY;

function createBackupScheduler(env, persistence, logger = console,
  { now = Date.now, spawnWorker = spawn, workerTimeoutMs = 20 * 60000, terminateGraceMs = 5000 } = {}) {
  const directory = env.WEATHER_BACKUP_DIR ? path.resolve(env.WEATHER_BACKUP_DIR) : null;
  const stateFile = directory ? path.join(directory, 'recovery-state.json') : null;
  const state = { enabled: Boolean(env.WEATHER_DB_PATH && directory), running: false, lastSuccess: null, file: null,
    error: null, checkpoint: null, latest: null, offsiteLastSuccess: null, offsiteArtifactId: null,
    offsiteStorageProvider: null, offsiteReleaseId: null,
    offsiteConfigured: true, retentionCheckpointVerified: false };
  let pending = null;
  let stopActiveWorker = null;
  let closed = false;
  function available(entry) {
    if (!entry?.verified || !ANY_FILE.test(entry.file || '') || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) return false;
    try {
      const file = fs.lstatSync(path.join(directory, entry.file));
      return file.isFile() && file.size === entry.bytes;
    } catch { return false; }
  }
  function checkpointReady() {
    const offsiteAt = Date.parse(state.checkpoint?.offsiteAt);
    const age = now() - offsiteAt;
    return Boolean(available(state.checkpoint) && Number.isFinite(offsiteAt) && age >= -30000 && age < CHECKPOINT_OFFSITE_MAX_AGE);
  }
  function savedEntry(entry) {
    return { ...entry, storageProvider: entry.storageProvider || (entry.offsiteAt ? 'github-actions' : null),
      releaseId: entry.releaseId || null };
  }
  if (state.enabled) {
    try {
      if (env.RENDER === 'true' && !directory.startsWith('/var/data/')) throw new Error('Backup directory must be on the persistent disk');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      cleanupRecoveryWork(directory);
      if (fs.existsSync(stateFile)) {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (available(saved.checkpoint)) state.checkpoint = savedEntry(saved.checkpoint);
        if (available(saved.latest)) state.latest = savedEntry(saved.latest);
        state.offsiteLastSuccess = saved.offsiteLastSuccess || null;
        state.offsiteArtifactId = saved.offsiteArtifactId || null;
        state.offsiteStorageProvider = saved.offsiteStorageProvider || (state.offsiteArtifactId ? 'github-actions' : null);
        state.offsiteReleaseId = saved.offsiteReleaseId || null;
      }
      state.lastSuccess = state.latest?.createdAt || state.checkpoint?.createdAt || null;
      state.file = state.latest?.file || state.checkpoint?.file || null;
      state.retentionCheckpointVerified = checkpointReady();
    } catch (error) { state.error = error.message; }
  }
  function save(next) {
    const temporary = stateFile + '.partial';
    fs.writeFileSync(temporary, JSON.stringify({ checkpoint: next.checkpoint, latest: next.latest,
      offsiteLastSuccess: next.offsiteLastSuccess, offsiteArtifactId: next.offsiteArtifactId,
      offsiteStorageProvider: next.offsiteStorageProvider, offsiteReleaseId: next.offsiteReleaseId }) + '\n', { mode: 0o600 });
    const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, stateFile);
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
  function rotate() {
    // Keep the immutable pre-retention checkpoint and three recent full copies.
    // Legacy weather-only backups and any owner-managed files are untouched.
    const names = fs.readdirSync(directory).filter(name => REGULAR_FILE.test(name)).sort();
    for (const filename of names.slice(0, -3)) {
      if (filename !== state.latest?.file) fs.unlinkSync(path.join(directory, filename));
    }
  }
  function runWorker(checkpoint) {
    return new Promise((resolve, reject) => {
      let finished = false, timer, killTimer, child, stopReason = null, output = '', errors = '';
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearTimeout(killTimer); stopActiveWorker = null;
        try { if (child?.pid) cleanupRecoveryWork(directory, { pid: child.pid }); }
        catch (failure) { error ||= failure; }
        if (error) reject(error); else resolve(result);
      };
      const stop = error => {
        if (finished || stopReason) return;
        stopReason = error;
        child.kill('SIGTERM');
        // Keep the single-flight lock until close: a SIGTERM request does not
        // prove the worker stopped writing. Escalate only this owned child.
        killTimer = setTimeout(() => child.kill('SIGKILL'), terminateGraceMs);
        killTimer.unref();
      };
      try {
        child = spawnWorker(process.execPath, [path.join(__dirname, '../tools/backup-recovery.js'), ...(checkpoint ? ['--checkpoint'] : [])],
          { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        stopActiveWorker = stop;
        child.stdout.on('data', chunk => { output = (output + chunk).slice(-16384); });
        child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096); });
        child.on('error', error => { if (child.pid) stop(error); else finish(error); });
        child.on('close', code => {
          try {
            if (stopReason) throw stopReason;
            if (code !== 0) throw new Error(errors || 'Recovery worker failed');
            finish(null, JSON.parse(output));
          } catch (error) { finish(error); }
        });
        timer = setTimeout(() => stop(new Error('Recovery worker exceeded its twenty-minute deadline')), workerTimeoutMs);
        timer.unref();
      } catch (error) { finish(error); }
    });
  }
  const api = {
    status() { return { ...structuredClone(state), retentionCheckpointVerified: checkpointReady() }; },
    run({ checkpoint = false } = {}) {
      if (closed || !state.enabled || !persistence.status().ready) return Promise.resolve(null);
      if (pending) return pending;
      if (env.RENDER === 'true' && !directory.startsWith('/var/data/')) return Promise.resolve(null);
      // Never replace the first complete checkpoint. Obtain or renew its
      // offsite receipt before authorizing retention and normal rotation.
      if (!available(state.checkpoint)) checkpoint = true;
      else if (checkpoint || !checkpointReady()) return Promise.resolve(state.checkpoint);
      const recent = state.latest || state.checkpoint;
      if (!checkpoint && available(recent) && now() - Date.parse(recent.createdAt) < 23 * 3600000) return Promise.resolve(recent);
      state.running = true;
      pending = (async () => {
        try {
          cleanupRecoveryWork(directory);
          const result = await runWorker(checkpoint);
          if (!available(result)) throw new Error('Recovery worker returned an unverified bundle');
          const next = { ...state, checkpoint: checkpoint ? result : state.checkpoint,
            latest: result, lastSuccess: result.createdAt, file: result.file, error: null };
          save(next);
          Object.assign(state, next);
          rotate();
          logger.info('[DATABASE] Complete encrypted recovery backup verified; ' + result.databases.length + ' databases, ' + result.bytes + ' bytes' + (checkpoint ? '; pre-retention checkpoint' : ''));
          return result;
        } catch (failure) {
          state.error = failure.message;
          logger.error('[DATABASE] Recovery backup: ' + failure.message);
          return null;
        }
      })().finally(() => { state.running = false; pending = null; });
      return pending;
    },
    async exportLatest() {
      const result = await api.run();
      if (!available(result)) throw new Error('Verified recovery copy is not available yet');
      return { ...result, absolutePath: path.join(directory, result.file) };
    },
    async exportCheckpoint() {
      if (!available(state.checkpoint)) await api.run({ checkpoint: true });
      if (!available(state.checkpoint)) throw new Error('Verified recovery checkpoint is not available yet');
      return { ...state.checkpoint, absolutePath: path.join(directory, state.checkpoint.file) };
    },
    acknowledge({ sha256, artifactId, runId, storageProvider = 'github-actions', releaseId }) {
      if (!/^[a-f0-9]{64}$/.test(sha256 || '') || !/^\d{1,24}$/.test(String(artifactId)) || !/^\d{1,24}$/.test(String(runId))) {
        throw new Error('Invalid backup acknowledgment');
      }
      const release = releaseId === undefined ? null : String(releaseId);
      if (!['github-actions', 'github-release'].includes(storageProvider) ||
          (storageProvider === 'github-release' && (!/^[1-9]\d{0,23}$/.test(release || '') || /\D/.test(release))) ||
          (typeof releaseId === 'number' && !Number.isSafeInteger(releaseId)) ||
          (storageProvider === 'github-actions' && releaseId !== undefined)) {
        throw new Error('Invalid backup storage provider or release identity');
      }
      const entry = [state.checkpoint, state.latest].find(item => item?.sha256 === sha256 && available(item));
      if (!entry) throw new Error('Backup acknowledgment does not match an available verified copy');
      const timestamp = new Date(now()).toISOString();
      const next = structuredClone(state);
      for (const item of [next.checkpoint, next.latest]) {
        if (item?.sha256 === sha256) Object.assign(item, { offsiteAt: timestamp, artifactId: String(artifactId), runId: String(runId),
          storageProvider, releaseId: release });
      }
      next.offsiteLastSuccess = timestamp; next.offsiteArtifactId = String(artifactId);
      next.offsiteStorageProvider = storageProvider; next.offsiteReleaseId = release;
      // Do not authorize destructive maintenance from an acknowledgment that
      // exists only in memory after a failed disk write.
      save(next);
      Object.assign(state, next);
      state.retentionCheckpointVerified = checkpointReady();
      logger.info('[DATABASE] Encrypted offsite recovery copy acknowledged; ' + storageProvider + ' copy ' + artifactId + '; retention checkpoint ' + (checkpointReady() ? 'ready' : 'pending'));
      return { accepted: true, offsiteAt: timestamp, storageProvider, releaseId: release, retentionCheckpointVerified: checkpointReady() };
    },
    close() { closed = true; stopActiveWorker?.(new Error('Recovery worker stopped during shutdown')); }
  };
  return api;
}

module.exports = { createBackupScheduler, DAY, CHECKPOINT_OFFSITE_MAX_AGE };
