'use strict';

// Encrypted bundles only. This tool never publishes, updates or deletes a
// release, and never follows a URL supplied by an API response.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { finished } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { normalizeReceipt } = require('./offsite-backup-client');

const REPOSITORY = 'ashmoore769/Moore-Weather';
const REPOSITORY_ID = 945419169, OWNER_ID = 202510356;
const WORKFLOW = '.github/workflows/backups.yml';
const API = 'https://api.github.com/repos/' + REPOSITORY;
const UPLOADS = 'https://uploads.github.com/repos/' + REPOSITORY;
const TAG = 'moore-weather-recovery';
const RELEASE_NAME = 'Moore Weather encrypted recovery';
const MARKER = 'Managed encrypted recovery storage: ' + REPOSITORY + '/' + WORKFLOW + '@refs/heads/main';
const RELEASE_BODY = MARKER + '\nKeep this release unpublished. Assets contain encrypted recovery bundles only.';
const NAME = /^encrypted-recovery-(checkpoint|daily)-([a-f0-9]{64})\.mwb$/;
const LABEL = /^moore-weather-recovery\/v1;run=([1-9]\d{0,15});attempt=([1-9]\d{0,7});bytes=([1-9]\d{0,9});created=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z);commit=([a-f0-9]{40})$/;
const MAX_BYTES = 2 * 1024 ** 3 - 1;
const PAGE_SIZE = 100, MAX_PAGES = 10, MAX_CANDIDATES = 100, MAX_JSON_BYTES = 8 * 1024 * 1024;
const UPLOAD_DEADLINE_MS = 10 * 60000, ROTATE_DEADLINE_MS = 3 * 60000;
const VISIBILITY_ATTEMPTS = 6, VISIBILITY_RETRY_MS = 2000;
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && positive(Number(value)) && String(Number(value)) === value;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value.length === 40;
const exact = (expression, value) => typeof value === 'string' && expression.exec(value)?.[0] === value;
const bot = actor => actor?.id === 41898282 && actor.login === 'github-actions[bot]' && actor.type === 'Bot';
const releaseAuthor = actor => bot(actor) || (actor?.id === OWNER_ID && actor.login === 'ashmoore769' && actor.type === 'User');

function workflowContext(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY ||
      env.GITHUB_REPOSITORY_ID !== String(REPOSITORY_ID) || env.GITHUB_REPOSITORY_OWNER_ID !== String(OWNER_ID) ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_WORKFLOW_REF !== REPOSITORY + '/' + WORKFLOW + '@refs/heads/main' ||
      !['push', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      !id(env.GITHUB_RUN_ID) || !exact(/^[1-9]\d{0,7}$/, env.GITHUB_RUN_ATTEMPT) || !sha(env.GITHUB_SHA)) {
    throw new Error('Recovery storage workflow context is not authorized');
  }
  if (typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN || /\s/.test(env.GITHUB_TOKEN)) {
    throw new Error('GitHub recovery storage credentials are unavailable');
  }
  return { runId: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT), headSha: env.GITHUB_SHA };
}

function validRun(run, provenance) {
  return String(run?.id) === provenance.runId && run.run_attempt === provenance.attempt &&
    [WORKFLOW, WORKFLOW + '@main'].includes(run.path) && run.head_branch === 'main' && run.head_sha === provenance.headSha &&
    run.repository?.id === REPOSITORY_ID && run.head_repository?.id === REPOSITORY_ID &&
    ['push', 'schedule', 'workflow_dispatch'].includes(run.event);
}

function validateRelease(release, expectedId) {
  if (!positive(release?.id) || (expectedId !== undefined && release.id !== expectedId) ||
      release.tag_name !== TAG || release.name !== RELEASE_NAME || release.body !== RELEASE_BODY ||
      release.target_commitish !== 'main' || release.draft !== true || release.prerelease !== true ||
      release.published_at !== null || release.immutable === true || !releaseAuthor(release.author)) {
    throw new Error('Recovery release identity or unpublished state is invalid');
  }
  return release;
}

function assetName(receipt) { return 'encrypted-recovery-' + (receipt.checkpoint ? 'checkpoint' : 'daily') + '-' + receipt.sha256 + '.mwb'; }
function assetLabel(receipt, context) {
  return 'moore-weather-recovery/v1;run=' + context.runId + ';attempt=' + context.attempt + ';bytes=' + receipt.bytes +
    ';created=' + receipt.createdAt + ';commit=' + context.headSha;
}

// A label is ownership metadata, not a cryptographic attestation. Only exact
// names, GitHub's raw-content digest/size, the trusted Actions bot and the
// designated main-branch workflow are eligible for reuse or rotation.
function candidate(asset) {
  const name = typeof asset?.name === 'string' && NAME.exec(asset.name);
  const label = typeof asset?.label === 'string' && LABEL.exec(asset.label);
  if (!name || name[0] !== asset.name || !label || label[0] !== asset.label || !positive(asset.id) ||
      asset.state !== 'uploaded' || asset.content_type !== 'application/octet-stream' || !bot(asset.uploader) ||
      !positive(asset.size) || asset.size > MAX_BYTES || Number(label[3]) !== asset.size ||
      asset.digest !== 'sha256:' + name[2] || !id(label[1])) return null;
  const created = Date.parse(label[4]), uploaded = Date.parse(asset.created_at);
  if (!Number.isFinite(created) || new Date(created).toISOString() !== label[4] || !Number.isFinite(uploaded)) return null;
  return { id: asset.id, name: asset.name, label: asset.label, kind: name[1], sha256: name[2], bytes: asset.size,
    createdAt: label[4], created, uploaded, runId: label[1], attempt: Number(label[2]), headSha: label[5] };
}

function sameAsset(first, second) { return first && second && JSON.stringify(first) === JSON.stringify(second); }
function matchesReceipt(asset, receipt) {
  return asset && asset.name === assetName(receipt) && asset.sha256 === receipt.sha256 && asset.bytes === receipt.bytes && asset.createdAt === receipt.createdAt;
}

function client({ env, fetchImpl, now, duration, wait = delay }) {
  const deadline = now() + duration;
  async function request(method, endpoint, { body, stream, bytes, allowConflict = false } = {}) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Recovery storage exceeded its time limit');
    // All endpoint components are fixed literals or previously validated IDs.
    const url = (stream ? UPLOADS : API) + endpoint;
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: 'error', ...(method === 'GET' ? { cache: 'no-store' } : {}),
        signal: AbortSignal.timeout(Math.min(stream ? 8 * 60000 : 30000, remaining)),
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_TOKEN,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Moore-Weather-recovery',
          ...(method === 'GET' ? { 'Cache-Control': 'no-cache' } : {}),
          ...(stream ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) } :
            body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(stream ? { body: stream, duplex: 'half' } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('GitHub recovery storage request failed'); }
    if (method === 'DELETE' && [204, 404].includes(response.status)) {
      await response.body?.cancel().catch(() => {}); return null;
    }
    if (allowConflict && response.status === 422) {
      await response.body?.cancel().catch(() => {}); return { conflict: true };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('GitHub recovery storage request returned HTTP ' + response.status);
    }
    try {
      let size = 0; const chunks = [];
      if (!response.body) throw new Error('Missing JSON body');
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_JSON_BYTES) throw new Error('Oversized JSON body');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('GitHub recovery storage response was invalid'); }
  }
  async function inventory(endpoint, kind) {
    const entries = [], ids = new Set();
    // Require an empty terminal page rather than relying on a possibly partial
    // first page or following arbitrary Link URLs. The inventory is bounded.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await request('GET', endpoint + '?per_page=' + PAGE_SIZE + '&page=' + page);
      if (!Array.isArray(result) || result.length > PAGE_SIZE) throw new Error('Recovery ' + kind + ' inventory has an unexpected shape');
      if (!result.length) return entries;
      for (const entry of result) {
        if (!positive(entry?.id) || ids.has(entry.id) ||
            (kind === 'release' ? typeof entry.tag_name !== 'string' || typeof entry.draft !== 'boolean' ||
              (entry.body !== undefined && entry.body !== null && typeof entry.body !== 'string') : typeof entry.name !== 'string')) {
          throw new Error('Recovery ' + kind + ' inventory is inconsistent; nothing was deleted');
        }
        ids.add(entry.id); entries.push(entry);
      }
    }
    throw new Error('Recovery ' + kind + ' inventory exceeds its bounded limit; nothing was deleted');
  }
  async function retryMissing(read) {
    // A successful GitHub mutation can precede its visibility in a list.
    // Retry absence only; identity, ambiguity and HTTP failures still stop.
    for (let attempt = 0; attempt < VISIBILITY_ATTEMPTS; attempt++) {
      const found = await read();
      if (found !== null || attempt === VISIBILITY_ATTEMPTS - 1) return found;
      if (deadline - now() <= VISIBILITY_RETRY_MS) throw new Error('Recovery storage exceeded its time limit');
      await wait(VISIBILITY_RETRY_MS);
    }
  }
  async function listedRelease() {
    const releases = await inventory('/releases', 'release');
    const matching = releases.filter(item => item.tag_name === TAG || item.name === RELEASE_NAME || item.body?.includes(MARKER));
    if (matching.length > 1) throw new Error('Recovery release discovery is ambiguous');
    return matching.length ? validateRelease(matching[0]) : null;
  }
  async function discover(create = false) {
    const existing = await listedRelease();
    if (existing) return existing;
    if (!create) throw new Error('Unpublished recovery release is unavailable');
    const made = await request('POST', '/releases', { body: { tag_name: TAG, target_commitish: 'main', name: RELEASE_NAME,
      body: RELEASE_BODY, draft: true, prerelease: true, make_latest: 'false', generate_release_notes: false }, allowConflict: true });
    if (!made?.conflict) validateRelease(made);
    // Re-read after creation/conflict; never continue if another matching draft
    // appeared concurrently. Existing releases are never patched or removed.
    const discovered = await retryMissing(listedRelease);
    if (!discovered) throw new Error('Unpublished recovery release is unavailable');
    if (!made?.conflict && discovered.id !== made.id) throw new Error('Recovery release changed during creation');
    return discovered;
  }
  const runs = new Map();
  async function provenance(item) {
    const key = item.runId + '/' + item.attempt;
    if (!runs.has(key)) runs.set(key, await request('GET', '/actions/runs/' + item.runId + '/attempts/' + item.attempt));
    return validRun(runs.get(key), item);
  }
  async function authorize(context) {
    if (!(await provenance(context)) || runs.get(context.runId + '/' + context.attempt).status !== 'in_progress') {
      throw new Error('Current main-branch recovery workflow identity is invalid');
    }
  }
  const freshRelease = async releaseId => validateRelease(await request('GET', '/releases/' + releaseId), releaseId);
  return { request, inventory, discover, provenance, authorize, freshRelease, retryMissing };
}

function readReceipt(directory) {
  const filename = path.join(directory, 'recovery-receipt.json');
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.size > 4096) throw new Error('Recovery receipt file is invalid');
  return normalizeReceipt(JSON.parse(fs.readFileSync(filename, 'utf8')));
}

async function verifiedFile(directory, receipt, now, deadline) {
  if (receipt.bytes > MAX_BYTES) throw new Error('Encrypted recovery bundle must be smaller than 2 GiB for release storage');
  const filename = path.join(directory, 'recovery-artifact', 'backup.mwb');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size !== receipt.bytes || info.size < 4) throw new Error('Encrypted recovery file size does not match its receipt');
    const magic = Buffer.alloc(4); fs.readSync(fd, magic, 0, 4, 0);
    if (magic.toString() !== 'MWB1') throw new Error('Recovery file is not an encrypted Moore Weather bundle');
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    // Keep explicit ownership of this descriptor while hashing. A cancelled
    // ReadStream iterator can close an fd even with autoClose disabled.
    for (;;) {
      if (now() >= deadline) throw new Error('Recovery storage exceeded its time limit');
      const count = await new Promise((resolve, reject) => fs.read(fd, buffer, 0, buffer.length, position,
        (error, bytesRead) => error ? reject(error) : resolve(bytesRead)));
      if (!count) break;
      position += count;
      if (position > receipt.bytes) throw new Error('Encrypted recovery file size changed during verification');
      digest.update(buffer.subarray(0, count));
    }
    if (digest.digest('hex') !== receipt.sha256) throw new Error('Encrypted recovery file checksum does not match its receipt');
    return { fd, filename };
  } catch (error) { fs.closeSync(fd); throw error; }
}

async function confirmAsset(api, release, asset, receipt) {
  const listed = await api.retryMissing(async () => {
    await api.freshRelease(release.id);
    const member = (await api.inventory('/releases/' + release.id + '/assets', 'asset')).find(item => item.id === asset.id);
    if (!member) return null;
    const value = candidate(member);
    if (!sameAsset(asset, value)) throw new Error('Current recovery asset membership, checksum or workflow identity is invalid');
    return value;
  });
  if (!listed) throw new Error('Current recovery asset membership, checksum or workflow identity is invalid');
  const detailed = candidate(await api.request('GET', '/releases/assets/' + asset.id));
  if (!sameAsset(asset, detailed) || !matchesReceipt(asset, receipt) || !(await api.provenance(asset))) {
    throw new Error('Current recovery asset membership, checksum or workflow identity is invalid');
  }
  return detailed;
}

async function uploadReleaseBackup({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
  directory = process.cwd(), log = console.log, wait = delay } = {}) {
  const context = workflowContext(env), receipt = readReceipt(directory), deadline = now() + UPLOAD_DEADLINE_MS;
  const file = await verifiedFile(directory, receipt, now, deadline);
  let stream;
  try {
    const api = client({ env, fetchImpl, now, duration: Math.max(0, deadline - now()), wait });
    await api.authorize(context);
    const release = await api.discover(true);
    const inventory = await api.inventory('/releases/' + release.id + '/assets', 'asset');
    const matches = inventory.filter(item => item.name === assetName(receipt));
    if (matches.length > 1) throw new Error('Matching recovery asset is ambiguous');
    let stored, reused = false;
    if (matches.length) {
      stored = candidate(matches[0]);
      if (!matchesReceipt(stored, receipt) || !(await api.provenance(stored))) throw new Error('Existing recovery asset does not match the verified bundle');
      reused = true;
    } else {
      await api.freshRelease(release.id);
      const query = new URLSearchParams({ name: assetName(receipt), label: assetLabel(receipt, context) });
      // Transfer descriptor ownership to the upload stream. Its close must be
      // awaited even after an early HTTP error; never close the same fd twice.
      stream = fs.createReadStream(file.filename, { fd: file.fd, autoClose: true, start: 0, end: receipt.bytes - 1 });
      const uploaded = await api.request('POST', '/releases/' + release.id + '/assets?' + query, { stream, bytes: receipt.bytes });
      stored = candidate(uploaded);
      if (!matchesReceipt(stored, receipt) || stored.label !== assetLabel(receipt, context)) {
        throw new Error('Uploaded recovery asset checksum or size does not match the verified bundle');
      }
    }
    await confirmAsset(api, release, stored, receipt);
    const result = { assetId: String(stored.id), releaseId: String(release.id), kind: stored.kind,
      sha256: stored.sha256, bytes: stored.bytes, createdAt: stored.createdAt, reused };
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, 'asset_id=' + result.assetId + '\nrelease_id=' + result.releaseId + '\nkind=' + result.kind + '\n');
    log('Encrypted recovery asset ' + result.assetId + (reused ? ' reused' : ' uploaded') + ' in unpublished release ' + result.releaseId + '; ' + result.bytes + ' verified bytes.');
    return result;
  } finally {
    if (stream) { stream.destroy(); await finished(stream, { cleanup: true }).catch(() => {}); }
    else fs.closeSync(file.fd);
  }
}

function rotationReceipt(env) {
  if (env.BACKUP_JOB_RESULT !== 'success' || env.BACKUP_RECEIPT_RESULT !== 'success' || env.BACKUP_STORAGE_PROVIDER !== 'github-release' ||
      !['checkpoint', 'daily'].includes(env.BACKUP_KIND) || !id(env.BACKUP_ASSET_ID) || !id(env.BACKUP_RELEASE_ID) ||
      !exact(/^[1-9]\d{0,9}$/, env.BACKUP_BYTES)) throw new Error('Acknowledged backup and completed receipt are required before release rotation');
  const receipt = normalizeReceipt({ sha256: env.BACKUP_SHA256, bytes: Number(env.BACKUP_BYTES), createdAt: env.BACKUP_CREATED_AT,
    checkpoint: env.BACKUP_KIND === 'checkpoint' });
  if (receipt.bytes > MAX_BYTES || receipt.createdAt !== env.BACKUP_CREATED_AT) throw new Error('Release rotation receipt metadata is invalid');
  return receipt;
}

function releaseRetentionPlan(assets) {
  const checkpoints = assets.filter(item => item.kind === 'checkpoint');
  if (!checkpoints.length) throw new Error('A valid owned checkpoint is required before deleting daily backups');
  const daily = assets.filter(item => item.kind === 'daily').sort((a, b) => b.created - a.created || b.uploaded - a.uploaded || b.id - a.id);
  return { retained: [...checkpoints, ...daily.slice(0, 3)], remove: daily.slice(3) };
}

function fingerprint(items) {
  return JSON.stringify(items.map(item => [item.id, item.name, item.label, item.state, item.size, item.digest, item.created_at,
    item.uploader?.id, item.uploader?.login, item.uploader?.type]).sort((a, b) => a[0] - b[0]));
}

async function rotateReleaseBackups({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, log = console.log, wait = delay } = {}) {
  const context = workflowContext(env), receipt = rotationReceipt(env);
  const api = client({ env, fetchImpl, now, duration: ROTATE_DEADLINE_MS, wait });
  await api.authorize(context);
  const release = await api.discover(false);
  if (String(release.id) !== env.BACKUP_RELEASE_ID) throw new Error('Receipt names a different recovery release');
  const inventory = await api.inventory('/releases/' + release.id + '/assets', 'asset');
  const current = candidate(inventory.find(item => String(item.id) === env.BACKUP_ASSET_ID));
  if (!matchesReceipt(current, receipt)) throw new Error('Acknowledged recovery asset is absent or does not match its receipt');
  await confirmAsset(api, release, current, receipt);
  const candidates = inventory.map(candidate).filter(Boolean);
  if (candidates.length > MAX_CANDIDATES) throw new Error('Too many recovery assets for bounded rotation; nothing was deleted');
  const owned = [];
  for (const item of candidates) if (await api.provenance(item)) owned.push(item);
  const plan = releaseRetentionPlan(owned);
  if (!plan.retained.some(item => item.id === current.id)) throw new Error('Current recovery asset would not be retained; nothing was deleted');
  const stable = await api.inventory('/releases/' + release.id + '/assets', 'asset');
  if (fingerprint(inventory) !== fingerprint(stable)) throw new Error('Recovery asset inventory changed; nothing was deleted');
  const checkpoint = plan.retained.find(item => item.kind === 'checkpoint');
  for (const item of plan.remove) {
    // Recheck mutable metadata immediately before deleting a specific old daily
    // asset. A matching name alone never authorizes deletion.
    await api.freshRelease(release.id);
    const anchor = candidate(await api.request('GET', '/releases/assets/' + current.id));
    const protectedCopy = candidate(await api.request('GET', '/releases/assets/' + checkpoint.id));
    const fresh = candidate(await api.request('GET', '/releases/assets/' + item.id));
    if (!sameAsset(anchor, current) || !sameAsset(protectedCopy, checkpoint) || !sameAsset(fresh, item) || item.kind !== 'daily') {
      throw new Error('Recovery asset identity changed before deletion');
    }
    await api.request('DELETE', '/releases/assets/' + item.id);
  }
  const result = { releaseId: String(release.id), retained: plan.retained.map(item => item.id), deleted: plan.remove.map(item => item.id),
    bytes: plan.retained.reduce((total, item) => total + item.bytes, 0) };
  log('Unpublished recovery assets retained: ' + result.retained.length + '; older daily copies removed: ' + result.deleted.length + '. Every checkpoint was preserved.');
  return result;
}

if (require.main === module) {
  const command = process.argv[2];
  (command === 'upload' ? uploadReleaseBackup() : command === 'rotate' ? rotateReleaseBackups() : Promise.reject(new Error('Use upload or rotate')))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { uploadReleaseBackup, rotateReleaseBackups, releaseRetentionPlan, candidate, workflowContext,
  assetName, assetLabel, validateRelease, TAG, RELEASE_NAME, RELEASE_BODY, MAX_BYTES, UPLOAD_DEADLINE_MS, ROTATE_DEADLINE_MS };
