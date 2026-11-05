'use strict';

// Runs only in the designated main-branch GitHub workflow. This client receives
// encrypted bundles, never the login/cookie secret or a plaintext database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { AUDIENCE } = require('../lib/backup-auth');

const BASE = 'https://moore-weather.onrender.com';
const OUTPUT = path.resolve('recovery-artifact/backup.mwb');
const RECEIPT = path.resolve('recovery-receipt.json');

function normalizeReceipt(receipt) {
  const created = typeof receipt?.createdAt === 'string' ? Date.parse(receipt.createdAt) : NaN;
  const iso = typeof receipt?.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(receipt.createdAt);
  if (typeof receipt?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.sha256.length !== 64 ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0 || receipt.bytes > 6 * 1024 ** 3 ||
      !Number.isFinite(created) || !iso || iso[0] !== receipt.createdAt || typeof receipt.checkpoint !== 'boolean') throw new Error('Backup receipt metadata is invalid');
  return { sha256: receipt.sha256, bytes: receipt.bytes, createdAt: new Date(created).toISOString(), checkpoint: receipt.checkpoint };
}

function normalizeStorageLocation({ artifactId, storageProvider = 'github-actions', releaseId } = {}) {
  const validId = value => typeof value === 'string' && /^[1-9]\d{0,23}$/.exec(value)?.[0] === value;
  if (!validId(artifactId) || !['github-actions', 'github-release'].includes(storageProvider) ||
      (storageProvider === 'github-release' ? !validId(releaseId) : releaseId !== undefined)) {
    throw new Error('Backup storage metadata is invalid');
  }
  return { artifactId, storageProvider, ...(storageProvider === 'github-release' ? { releaseId } : {}) };
}

async function identityToken() {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com')) throw new Error('GitHub workflow identity is unavailable');
  url.searchParams.set('audience', AUDIENCE);
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
    signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error('Could not obtain GitHub workflow identity');
  const token = (await response.json()).value;
  if (typeof token !== 'string' || token.length > 16384) throw new Error('Invalid GitHub workflow identity');
  return token;
}

async function download({ now = Date.now, wait = delay } = {}) {
  const expectedCommit = process.env.GITHUB_SHA;
  if (typeof expectedCommit !== 'string' || expectedCommit.length !== 40 || !/^[a-f0-9]{40}$/.test(expectedCommit)) {
    throw new Error('Backup workflow deployment commit is invalid');
  }
  const deadline = now() + 25 * 60000;
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true, mode: 0o700 });
  let lastError;
  while (now() < deadline) {
    try {
      // A main-branch push can start this workflow before Render finishes
      // deploying it. Do not export or acknowledge against an older server.
      const health = await fetch(BASE + '/healthz', { redirect: 'error', cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(Math.min(10000, deadline - now())) });
      if (!health.ok) {
        await health.body?.cancel();
        throw new Error('Deployment readiness returned HTTP ' + health.status);
      }
      const deployed = await health.json();
      if (deployed?.status !== 'ok' || deployed.commit !== expectedCommit) throw new Error('Waiting for the workflow app version to finish deploying');
      const response = await fetch(BASE + '/internal/backups/export', {
        headers: { Authorization: 'Bearer ' + await identityToken() },
        signal: AbortSignal.timeout(Math.min(20 * 60000, deadline - now())), redirect: 'error'
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Recovery export returned HTTP ' + response.status);
      }
      const expected = response.headers.get('x-backup-sha256');
      if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Recovery export is missing its checksum');
      const checkpoint = response.headers.get('x-backup-checkpoint');
      if (!['true', 'false'].includes(checkpoint)) throw new Error('Recovery export is missing its backup kind');
      let bytes = 0; const digest = crypto.createHash('sha256');
      const inspect = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > 6 * 1024 ** 3) return done(new Error('Recovery export exceeded its size limit'));
        digest.update(chunk); done(null, chunk);
      } });
      await pipeline(response.body, inspect, fs.createWriteStream(OUTPUT + '.partial', { flags: 'w', mode: 0o600 }));
      if (digest.digest('hex') !== expected) throw new Error('Recovery export failed checksum verification');
      const fd = fs.openSync(OUTPUT + '.partial', 'r');
      const magic = Buffer.alloc(4); try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (magic.toString() !== 'MWB1') throw new Error('Recovery export is not an encrypted Moore Weather bundle');
      const receipt = normalizeReceipt({ sha256: expected, bytes, createdAt: response.headers.get('x-backup-created-at'),
        checkpoint: checkpoint === 'true' });
      fs.renameSync(OUTPUT + '.partial', OUTPUT);
      fs.writeFileSync(RECEIPT, JSON.stringify(receipt), { mode: 0o600 });
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'kind=' + (receipt.checkpoint ? 'checkpoint' : 'daily') + '\n');
      console.log('Downloaded verified encrypted recovery bundle (' + bytes + ' bytes).');
      return;
    } catch (error) {
      lastError = error;
      fs.rmSync(OUTPUT + '.partial', { force: true });
      if (now() + 30000 >= deadline) break;
      console.log('Waiting for a verified recovery copy: ' + error.message);
      await wait(30000);
    }
  }
  throw lastError || new Error('Recovery export deadline exceeded');
}

async function acknowledge() {
  const receipt = normalizeReceipt(JSON.parse(fs.readFileSync(RECEIPT, 'utf8')));
  const location = normalizeStorageLocation({ artifactId: process.env.BACKUP_ARTIFACT_ID,
    storageProvider: process.env.BACKUP_STORAGE_PROVIDER, releaseId: process.env.BACKUP_RELEASE_ID });
  const response = await fetch(BASE + '/internal/backups/ack', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: 'Bearer ' + await identityToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256: receipt.sha256, ...location })
  });
  if (!response.ok) throw new Error('Offsite acknowledgment returned HTTP ' + response.status);
  const result = await response.json();
  if (result.accepted !== true) throw new Error('Offsite acknowledgment was not accepted');
  // Old servers can acknowledge legacy Actions artifacts without returning a
  // provider. A release asset requires an explicit matching server receipt.
  if ((result.storageProvider ?? 'github-actions') !== location.storageProvider ||
      (location.storageProvider === 'github-release' && result.releaseId !== location.releaseId)) {
    throw new Error('Offsite acknowledgment storage location did not match');
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'sha256=' + receipt.sha256 + '\nbytes=' + receipt.bytes +
      '\ncreated_at=' + receipt.createdAt + '\nartifact_id=' + location.artifactId +
      '\nstorage_provider=' + location.storageProvider + '\n' + (location.releaseId ? 'release_id=' + location.releaseId + '\n' : ''));
  }
  console.log('Encrypted backup ' + location.artifactId + ' stored offsite (' + location.storageProvider + '). Pre-retention checkpoint ready: ' + result.retentionCheckpointVerified);
}

if (require.main === module) {
  const command = process.argv[2];
  (command === 'download' ? download() : command === 'ack' ? acknowledge() : Promise.reject(new Error('Use download or ack')))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { identityToken, download, acknowledge, normalizeReceipt, normalizeStorageLocation };
