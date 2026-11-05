'use strict';

// This job records public, non-sensitive evidence of a completed offsite copy.
// It never downloads a bundle, changes main, or passes credentials to git.
const REPOSITORY = 'ashmoore769/Moore-Weather';
const BRANCH = 'recovery-receipts';
const REF = 'refs/heads/' + BRANCH;
const API = 'https://api.github.com/repos/' + REPOSITORY + '/git';
const WORKFLOW = REPOSITORY + '/.github/workflows/backups.yml@refs/heads/main';
const validId = value => typeof value === 'string' && /^[1-9]\d{0,23}$/.test(value);
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function receiptFromEnvironment(env, timestamp) {
  if (env.BACKUP_JOB_RESULT !== 'success') throw new Error('A successful backup job is required before recording a receipt');
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY ||
      env.GITHUB_REPOSITORY_ID !== '945419169' || env.GITHUB_REPOSITORY_OWNER_ID !== '202510356' ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_WORKFLOW_REF !== WORKFLOW ||
      !['push', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('Backup receipt workflow context is not authorized');
  }
  if (!validId(env.GITHUB_RUN_ID) || !/^[1-9]\d{0,7}$/.test(env.GITHUB_RUN_ATTEMPT || '') || !validId(env.BACKUP_ARTIFACT_ID)) {
    throw new Error('Backup receipt run or artifact identity is invalid');
  }
  const bytes = Number(env.BACKUP_BYTES), created = Date.parse(env.BACKUP_CREATED_AT);
  if (!/^[a-f0-9]{64}$/.test(env.BACKUP_SHA256 || '') || !/^[1-9]\d{0,12}$/.test(env.BACKUP_BYTES || '') ||
      !Number.isSafeInteger(bytes) || bytes > 6 * 1024 ** 3 || !Number.isFinite(created) ||
      new Date(created).toISOString() !== env.BACKUP_CREATED_AT || !Number.isFinite(timestamp)) {
    throw new Error('Backup receipt metadata is invalid');
  }
  // Explicitly select fields: no environment dump, token, ciphertext or key can
  // be included in the receipt by an extra workflow output.
  return {
    schema: 1,
    repository: REPOSITORY,
    artifactId: env.BACKUP_ARTIFACT_ID,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    runUrl: 'https://github.com/' + REPOSITORY + '/actions/runs/' + env.GITHUB_RUN_ID + '/attempts/' + env.GITHUB_RUN_ATTEMPT,
    sha256: env.BACKUP_SHA256,
    bytes,
    createdAt: env.BACKUP_CREATED_AT,
    recordedAt: new Date(timestamp).toISOString()
  };
}

async function recordBackupReceipt({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, log = console.log } = {}) {
  const receipt = receiptFromEnvironment(env, now());
  if (typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN || /\s/.test(env.GITHUB_TOKEN)) {
    throw new Error('GitHub receipt credentials are unavailable');
  }
  async function request(method, endpoint, body, allowMissing = false) {
    let response;
    try {
      response = await fetchImpl(API + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_TOKEN,
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch { throw new Error('GitHub receipt request failed'); }
    if (allowMissing && response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Do not print the response body or an underlying request exception: they
      // could contain reflected credentials or other unexpected private data.
      throw new Error('GitHub receipt request returned HTTP ' + response.status);
    }
    try { return await response.json(); }
    catch { throw new Error('GitHub receipt response was invalid'); }
  }
  const existing = await request('GET', '/ref/heads/' + BRANCH, undefined, true);
  if (existing && (existing.ref !== REF || existing.object?.type !== 'commit' || !validSha(existing.object.sha))) {
    throw new Error('GitHub returned an unexpected receipt reference');
  }
  let baseTree;
  if (existing) {
    const parent = await request('GET', '/commits/' + existing.object.sha);
    if (parent?.sha !== existing.object.sha || !validSha(parent.tree?.sha)) {
      throw new Error('GitHub returned an invalid receipt parent tree');
    }
    baseTree = parent.tree.sha;
  }
  // The first tree contains only latest.json, independently of application
  // files. Later updates preserve any other files added to this branch.
  const tree = await request('POST', '/trees', {
    ...(baseTree ? {base_tree:baseTree} : {}),
    tree: [{ path: 'latest.json', mode: '100644', type: 'blob', content: JSON.stringify(receipt, null, 2) + '\n' }]
  });
  if (!validSha(tree?.sha)) throw new Error('GitHub returned an invalid receipt tree');
  const commit = await request('POST', '/commits', {
    message: 'Record encrypted recovery backup ' + receipt.artifactId,
    tree: tree.sha, parents: existing ? [existing.object.sha] : []
  });
  if (!validSha(commit?.sha)) throw new Error('GitHub returned an invalid receipt commit');
  const result = existing
    ? await request('PATCH', '/refs/heads/' + BRANCH, { sha: commit.sha, force: false })
    : await request('POST', '/refs', { ref: REF, sha: commit.sha });
  if (result?.ref !== REF || result.object?.sha !== commit.sha) throw new Error('GitHub did not confirm the receipt reference');
  log('Recorded encrypted backup artifact ' + receipt.artifactId + ' on ' + BRANCH + '.');
  return { branch: BRANCH, commit: commit.sha, receipt };
}

if (require.main === module) {
  recordBackupReceipt().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { recordBackupReceipt, receiptFromEnvironment };
