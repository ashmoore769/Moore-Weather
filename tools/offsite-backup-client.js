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

async function download() {
  const deadline = Date.now() + 20 * 60000;
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true, mode: 0o700 });
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE + '/internal/backups/export', {
        headers: { Authorization: 'Bearer ' + await identityToken() },
        signal: AbortSignal.timeout(Math.min(10 * 60000, deadline - Date.now())), redirect: 'error'
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Recovery export returned HTTP ' + response.status);
      }
      const expected = response.headers.get('x-backup-sha256');
      if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Recovery export is missing its checksum');
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
      fs.renameSync(OUTPUT + '.partial', OUTPUT);
      fs.writeFileSync(RECEIPT, JSON.stringify({ sha256: expected, bytes, createdAt: response.headers.get('x-backup-created-at'),
        checkpoint: response.headers.get('x-backup-checkpoint') === 'true' }), { mode: 0o600 });
      console.log('Downloaded verified encrypted recovery bundle (' + bytes + ' bytes).');
      return;
    } catch (error) {
      lastError = error;
      fs.rmSync(OUTPUT + '.partial', { force: true });
      if (Date.now() + 30000 >= deadline) break;
      console.log('Waiting for a verified recovery copy: ' + error.message);
      await delay(30000);
    }
  }
  throw lastError || new Error('Recovery export deadline exceeded');
}

async function acknowledge() {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const artifactId = process.env.BACKUP_ARTIFACT_ID;
  if (!/^\d{1,24}$/.test(artifactId || '')) throw new Error('Artifact upload must succeed before acknowledgment');
  const response = await fetch(BASE + '/internal/backups/ack', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: 'Bearer ' + await identityToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256: receipt.sha256, artifactId })
  });
  if (!response.ok) throw new Error('Offsite acknowledgment returned HTTP ' + response.status);
  const result = await response.json();
  if (!result.accepted) throw new Error('Offsite acknowledgment was not accepted');
  if (process.env.GITHUB_OUTPUT) {
    const created = Date.parse(receipt.createdAt);
    if (!/^[a-f0-9]{64}$/.test(receipt.sha256 || '') || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0 ||
        receipt.bytes > 6 * 1024 ** 3 || !Number.isFinite(created)) throw new Error('Backup receipt metadata is invalid');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'sha256=' + receipt.sha256 + '\nbytes=' + receipt.bytes +
      '\ncreated_at=' + new Date(created).toISOString() + '\nartifact_id=' + artifactId + '\n');
  }
  console.log('Encrypted artifact ' + artifactId + ' stored offsite. Pre-retention checkpoint ready: ' + result.retentionCheckpointVerified);
}

if (require.main === module) {
  const command = process.argv[2];
  (command === 'download' ? download() : command === 'ack' ? acknowledge() : Promise.reject(new Error('Use download or ack')))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { identityToken, download, acknowledge };
