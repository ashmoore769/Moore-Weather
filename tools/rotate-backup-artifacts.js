'use strict';

// Called only after upload, server acknowledgement and the receipt commit.
// This never enumerates/deletes repository files or unrelated CI artifacts.
const { receiptFromEnvironment } = require('./record-backup-receipt');
const REPOSITORY = 'ashmoore769/Moore-Weather';
const REPOSITORY_ID = 945419169;
const API = 'https://api.github.com/repos/' + REPOSITORY + '/actions';
const WORKFLOW = '.github/workflows/backups.yml';
const NAME = /^encrypted-recovery-(checkpoint|daily)-([1-9]\d{0,23})-([1-9]\d{0,7})$/;
const BUDGET = 350 * 1024 * 1024;
const PAGE_SIZE = 100, MAX_PAGES = 10, MAX_CANDIDATES = 100;
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value.length === 40;

function candidate(artifact, timestamp) {
  const match = typeof artifact?.name === 'string' && NAME.exec(artifact.name);
  if (!match || match[0] !== artifact.name || artifact.expired !== false) return null;
  const run = artifact.workflow_run, created = Date.parse(artifact.created_at), expires = Date.parse(artifact.expires_at);
  if (!positive(artifact.id) || !positive(artifact.size_in_bytes) || !Number.isFinite(created) || !Number.isFinite(expires) ||
      expires <= timestamp || !positive(run?.id) || String(run.id) !== match[2] || run.head_branch !== 'main' ||
      run.repository_id !== REPOSITORY_ID || run.head_repository_id !== REPOSITORY_ID || !sha(run.head_sha)) return null;
  return { id: artifact.id, name: artifact.name, kind: match[1], runId: match[2], attempt: Number(match[3]),
    bytes: artifact.size_in_bytes, created, headSha: run.head_sha };
}

function validRun(run, artifact) {
  // GitHub's run response may qualify the workflow path with @main.
  return String(run?.id) === artifact.runId && run.run_attempt === artifact.attempt && [WORKFLOW, WORKFLOW + '@main'].includes(run.path) &&
    run.head_branch === 'main' && run.head_sha === artifact.headSha && run.repository?.id === REPOSITORY_ID &&
    run.head_repository?.id === REPOSITORY_ID && ['push', 'schedule', 'workflow_dispatch'].includes(run.event);
}

function retentionPlan(artifacts) {
  const newest = (a, b) => b.created - a.created || b.id - a.id;
  const checkpoints = artifacts.filter(item => item.kind === 'checkpoint').sort(newest);
  const daily = artifacts.filter(item => item.kind === 'daily').sort(newest);
  const retained = [checkpoints[0], daily[0]].filter(Boolean);
  let bytes = retained.reduce((total, item) => total + item.bytes, 0);
  const mandatoryBytes = bytes;
  // Keep the newest contiguous daily recovery points that fit, up to three.
  for (const item of daily.slice(1, 3)) {
    if (bytes + item.bytes > BUDGET) break;
    retained.push(item); bytes += item.bytes;
  }
  const keep = new Set(retained.map(item => item.id));
  return { retained, bytes, mandatoryBytes, overBudget: mandatoryBytes > BUDGET,
    remove: artifacts.filter(item => !keep.has(item.id)).sort((a, b) => a.created - b.created || a.id - b.id) };
}

async function rotateBackupArtifacts({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, log = console.log } = {}) {
  const timestamp = now(), receipt = receiptFromEnvironment(env, timestamp);
  if (env.BACKUP_RECEIPT_RESULT !== 'success' || !['checkpoint', 'daily'].includes(env.BACKUP_KIND) || !sha(env.GITHUB_SHA)) {
    throw new Error('A completed backup receipt and valid backup kind/commit are required before rotation');
  }
  if (typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN || /\s/.test(env.GITHUB_TOKEN)) throw new Error('GitHub rotation credentials are unavailable');
  const deadline = timestamp + 150000;
  async function request(method, endpoint) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Backup artifact rotation exceeded its time limit');
    let response;
    try {
      response = await fetchImpl(API + endpoint, { method, redirect: 'error', signal: AbortSignal.timeout(Math.min(15000, remaining)),
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_TOKEN,
          'X-GitHub-Api-Version': '2022-11-28' } });
    } catch { throw new Error('GitHub artifact request failed'); }
    if (method === 'DELETE' && [204, 404].includes(response.status)) {
      await response.body?.cancel().catch(() => {}); return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('GitHub artifact request returned HTTP ' + response.status);
    }
    try { return await response.json(); }
    catch { throw new Error('GitHub artifact response was invalid'); }
  }

  const uploaded = candidate(await request('GET', '/artifacts/' + receipt.artifactId), timestamp);
  const expectedName = 'encrypted-recovery-' + env.BACKUP_KIND + '-' + receipt.runId + '-' + receipt.runAttempt;
  if (!uploaded || String(uploaded.id) !== receipt.artifactId || uploaded.name !== expectedName || uploaded.headSha !== env.GITHUB_SHA) {
    throw new Error('Current backup artifact does not match this main-branch workflow run');
  }
  const currentRun = await request('GET', '/runs/' + uploaded.runId + '/attempts/' + uploaded.attempt);
  if (!validRun(currentRun, uploaded) || currentRun.status !== 'in_progress') throw new Error('Current backup workflow identity is invalid');

  const inventory = [], ids = new Set();
  let total;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await request('GET', '/artifacts?per_page=' + PAGE_SIZE + '&page=' + page);
    if (!Number.isSafeInteger(result?.total_count) || result.total_count < 1 || result.total_count > PAGE_SIZE * MAX_PAGES ||
        !Array.isArray(result.artifacts) || result.artifacts.length > PAGE_SIZE || (total !== undefined && total !== result.total_count)) {
      throw new Error('Backup artifact inventory is incomplete or changed; nothing was deleted');
    }
    total = result.total_count;
    for (const item of result.artifacts) {
      if (!positive(item?.id) || ids.has(item.id)) throw new Error('Backup artifact inventory is inconsistent; nothing was deleted');
      ids.add(item.id); inventory.push(item);
    }
    if (inventory.length === total) break;
    if (inventory.length > total || result.artifacts.length < PAGE_SIZE || page === MAX_PAGES) {
      throw new Error('Backup artifact inventory is incomplete; nothing was deleted');
    }
  }
  const listed = inventory.find(item => String(item.id) === receipt.artifactId);
  if (!listed || JSON.stringify(candidate(listed, timestamp)) !== JSON.stringify(uploaded)) {
    throw new Error('Current backup artifact is absent from the complete inventory; nothing was deleted');
  }
  const candidates = inventory.map(item => candidate(item, timestamp)).filter(Boolean);
  if (candidates.length > MAX_CANDIDATES) throw new Error('Too many backup artifacts for bounded rotation; nothing was deleted');
  const runs = new Map([[uploaded.runId + '/' + uploaded.attempt, currentRun]]), owned = [];
  // Resolve workflow provenance before planning any deletion. A matching name
  // from another workflow or branch is not enough to establish ownership.
  for (const item of candidates) {
    const key = item.runId + '/' + item.attempt;
    if (!runs.has(key)) runs.set(key, await request('GET', '/runs/' + item.runId + '/attempts/' + item.attempt));
    if (validRun(runs.get(key), item)) owned.push(item);
  }
  if (!owned.some(item => item.kind === 'checkpoint')) throw new Error('No valid offsite checkpoint is available; nothing was deleted');
  const plan = retentionPlan(owned);
  if (plan.retained.find(item => item.kind === uploaded.kind)?.id !== uploaded.id) throw new Error('Current backup is not the newest of its kind; nothing was deleted');
  for (const item of plan.remove) await request('DELETE', '/artifacts/' + item.id);
  log('Backup artifacts retained: ' + plan.retained.length + ', ' + plan.bytes + ' bytes; older backups removed: ' + plan.remove.length + '.');
  if (plan.overBudget) throw new Error('Newest checkpoint and daily backup require ' + plan.mandatoryBytes + ' bytes, exceeding the 350 MiB retained-backup budget; both were preserved');
  return { retained: plan.retained.map(item => item.id), deleted: plan.remove.map(item => item.id), bytes: plan.bytes };
}

if (require.main === module) rotateBackupArtifacts().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { rotateBackupArtifacts, retentionPlan, candidate, BUDGET };
