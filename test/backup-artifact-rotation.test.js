'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { rotateBackupArtifacts, retentionPlan, BUDGET } = require('../tools/rotate-backup-artifacts');
const { normalizeReceipt, normalizeStorageLocation } = require('../tools/offsite-backup-client');
const repository = 'ashmoore769/Moore-Weather', repositoryId = 945419169;
const base = 'https://api.github.com/repos/' + repository + '/actions';
const timestamp = Date.parse('2026-11-05T12:00:00Z'), DAY = 86400000, MiB = 1024 * 1024;
const headSha = 'a'.repeat(40), token = 'ghs_fixture_token_not_for_logs';

function artifact(id, kind, age = 0, bytes = 40 * MiB, extra = {}) {
  return { id, name: 'encrypted-recovery-' + kind + '-' + (1000 + id) + '-1', size_in_bytes: bytes, expired: false,
    created_at: new Date(timestamp - age).toISOString(), expires_at: new Date(timestamp + 30 * DAY).toISOString(),
    workflow_run: { id: 1000 + id, repository_id: repositoryId, head_repository_id: repositoryId, head_branch: 'main', head_sha: headSha }, ...extra };
}
function env(current, extra = {}) {
  return { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: String(repositoryId),
    GITHUB_REPOSITORY_OWNER_ID: '202510356', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: headSha,
    GITHUB_WORKFLOW_REF: repository + '/.github/workflows/backups.yml@refs/heads/main', GITHUB_EVENT_NAME: 'schedule',
    GITHUB_RUN_ID: String(current.workflow_run.id), GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: token,
    GITHUB_API_URL: 'https://untrusted.example', BACKUP_JOB_RESULT: 'success', BACKUP_RECEIPT_RESULT: 'success',
    BACKUP_SHA256: 'b'.repeat(64), BACKUP_BYTES: '100', BACKUP_CREATED_AT: new Date(timestamp - DAY).toISOString(),
    BACKUP_ARTIFACT_ID: String(current.id), BACKUP_KIND: current.name.split('-')[2], ...extra };
}
function fixture(artifacts, { current = artifacts[0], pages, runChanges = {}, detail = current } = {}) {
  const calls = [], deleted = [], logs = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(url.startsWith(base + '/')); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    const route = url.slice(base.length);
    if (options.method === 'DELETE') { deleted.push(Number(route.split('/').at(-1))); return new Response(null, { status: 204 }); }
    if (route === '/artifacts/' + current.id) return Response.json(detail);
    if (route.startsWith('/artifacts?')) {
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json(pages ? pages[page - 1] : { total_count: artifacts.length, artifacts: artifacts.slice((page - 1) * 100, page * 100) });
    }
    const match = /^\/runs\/(\d+)\/attempts\/(\d+)$/.exec(route);
    if (match) {
      const found = artifacts.find(item => String(item.workflow_run?.id) === match[1]) || current;
      return Response.json({ id: Number(match[1]), run_attempt: Number(match[2]), path: '.github/workflows/backups.yml',
        head_branch: 'main', head_sha: found.workflow_run.head_sha, repository: { id: repositoryId },
        head_repository: { id: repositoryId }, event: 'schedule', status: 'in_progress', ...(runChanges[match[1]] || {}) });
    }
    throw Error('Unexpected offline request');
  };
  return { current, calls, deleted, logs, fetchImpl, log: message => logs.push(message), now: () => timestamp };
}
function run(f, extra = {}) { return rotateBackupArtifacts({ ...f, env: env(f.current, extra) }); }

test('rotation preserves newest checkpoint and three daily copies and ignores other artifact owners', async () => {
  const current = artifact(100, 'daily');
  const otherWorkflow = artifact(70, 'daily', 10 * DAY);
  const branch = artifact(71, 'daily', 10 * DAY); branch.workflow_run.head_branch = 'feature';
  const foreign = artifact(72, 'daily', 10 * DAY); foreign.workflow_run.head_repository_id = 999;
  const artifacts = [current, artifact(90, 'checkpoint', 5 * DAY), artifact(99, 'daily', DAY), artifact(98, 'daily', 2 * DAY),
    artifact(97, 'daily', 3 * DAY), artifact(40, 'checkpoint', 15 * DAY), otherWorkflow, branch, foreign,
    artifact(200, 'daily', DAY, 10, { name: 'dashboard-screenshots' }),
    artifact(201, 'daily', DAY, 10, { name: 'manual-export' }),
    artifact(202, 'daily', DAY, 10, { name: 'encrypted-recovery-1202-1' })];
  const f = fixture(artifacts, { runChanges: { 1070: { path: '.github/workflows/checks.yml' } } });
  const result = await run(f);
  assert.deepEqual(new Set(result.retained), new Set([100, 90, 99, 98]));
  assert.deepEqual(f.deleted, [40, 97]);
  const firstDelete = f.calls.findIndex(call => call.method === 'DELETE');
  assert.ok(f.calls.slice(firstDelete).every(call => call.method === 'DELETE'));
  assert.doesNotMatch(JSON.stringify(f.logs), /ghs_fixture/);
});

test('retained size budget trims optional daily copies without sacrificing either required copy', async () => {
  const f = fixture([artifact(100, 'daily', 0, 100 * MiB), artifact(90, 'checkpoint', DAY, 150 * MiB),
    artifact(99, 'daily', DAY, 100 * MiB), artifact(98, 'daily', 2 * DAY, 100 * MiB)]);
  const result = await run(f);
  assert.equal(result.bytes, BUDGET);
  assert.deepEqual(new Set(result.retained), new Set([100, 90, 99]));
  assert.deepEqual(f.deleted, [98]);
});

test('oversized mandatory backups are preserved and the job reports the budget problem', async () => {
  const f = fixture([artifact(100, 'daily', 0, 200 * MiB), artifact(90, 'checkpoint', DAY, 200 * MiB), artifact(80, 'daily', 3 * DAY)]);
  await assert.rejects(run(f), /exceeding the 350 MiB.*both were preserved/);
  assert.deepEqual(f.deleted, [80]);
});

test('checkpoint renewal keeps the newly uploaded original checkpoint and all newest permitted daily copies', async () => {
  const f = fixture([artifact(100, 'checkpoint'), artifact(40, 'checkpoint', 28 * DAY),
    artifact(99, 'daily', DAY), artifact(98, 'daily', 2 * DAY)]);
  const result = await run(f, { BACKUP_CREATED_AT: new Date(timestamp - 28 * DAY).toISOString() });
  assert.deepEqual(new Set(result.retained), new Set([100, 99, 98]));
  assert.deepEqual(f.deleted, [40]);
});

test('first checkpoint needs no daily copy, but an absent checkpoint cannot authorize deleting daily history', async () => {
  const first = fixture([artifact(100, 'checkpoint')]);
  assert.deepEqual((await run(first)).retained, [100]);
  const missing = fixture([artifact(100, 'daily'), artifact(99, 'daily', DAY)]);
  await assert.rejects(run(missing), /No valid offsite checkpoint/);
  assert.deepEqual(missing.deleted, []);
});

test('failed prior steps, changed current artifact or wrong workflow identity never permit deletion', async () => {
  for (const extra of [{ BACKUP_JOB_RESULT: 'failure' }, { BACKUP_RECEIPT_RESULT: 'failure' },
    { BACKUP_RECEIPT_RESULT: 'skipped' }, { BACKUP_KIND: 'daily\nTOKEN=secret' }, { GITHUB_SHA: 'wrong' }, { GITHUB_REPOSITORY_ID: '1' }]) {
    const f = fixture([artifact(100, 'checkpoint')]);
    await assert.rejects(run(f, extra)); assert.equal(f.calls.length, 0);
  }
  for (const detail of [artifact(100, 'daily'), artifact(101, 'checkpoint'),
    artifact(100, 'checkpoint', 0, 10, { expired: true })]) {
    const f = fixture([artifact(100, 'checkpoint')], { detail });
    await assert.rejects(run(f), /does not match/); assert.deepEqual(f.deleted, []);
  }
  for (const changes of [{ path: '.github/workflows/checks.yml' }, { run_attempt: 2 },
    { head_branch: 'feature' }, { head_sha: 'c'.repeat(40) }, { repository: { id: 1 } }, { status: 'completed' }]) {
    const f = fixture([artifact(100, 'checkpoint')], { runChanges: { 1100: changes } });
    await assert.rejects(run(f), /workflow identity/); assert.deepEqual(f.deleted, []);
  }
});

test('documented main-qualified workflow paths are accepted without admitting another ref', async () => {
  for (const workflowPath of ['.github/workflows/backups.yml', '.github/workflows/backups.yml@main']) {
    const f = fixture([artifact(100, 'checkpoint')], { runChanges: { 1100: { path: workflowPath } } });
    assert.deepEqual((await run(f)).retained, [100]);
  }
  for (const workflowPath of ['.github/workflows/backups.yml@feature', '.github/workflows/backups.yml@refs/heads/main',
    '.github/workflows/backups.yml@main/extra']) {
    const f = fixture([artifact(100, 'checkpoint')], { runChanges: { 1100: { path: workflowPath } } });
    await assert.rejects(run(f), /workflow identity/); assert.deepEqual(f.deleted, []);
  }
});

test('incomplete, changing, duplicate, excessive or stale inventories abort before any deletion', async () => {
  const current = artifact(100, 'checkpoint');
  const page = [current, ...Array.from({ length: 99 }, (_, i) => artifact(200 + i, 'daily', DAY, 1, { name: 'ci-' + i }))];
  for (const pages of [
    [{ total_count: 1001, artifacts: [] }], [{ total_count: 2, artifacts: [current] }],
    [{ total_count: 2, artifacts: [current, current] }], [{ total_count: 1, artifacts: [artifact(99, 'checkpoint')] }],
    [{ total_count: 101, artifacts: page }, { total_count: 102, artifacts: [artifact(400, 'daily')] }],
    [{ total_count: 101, artifacts: page }, { total_count: 101, artifacts: [] }]
  ]) {
    const f = fixture([current], { pages });
    await assert.rejects(run(f), /inventory/); assert.deepEqual(f.deleted, []);
  }
});

test('complete pagination handles unrelated CI artifacts without deleting them', async () => {
  const f = fixture([artifact(100, 'daily'), artifact(90, 'checkpoint', DAY), artifact(99, 'daily', DAY),
    ...Array.from({ length: 101 }, (_, i) => artifact(200 + i, 'daily', DAY, 1, { name: 'ci-' + i }))]);
  const result = await run(f);
  assert.equal(f.calls.filter(call => call.url.includes('?per_page=100')).length, 2);
  assert.deepEqual(result.deleted, []); assert.equal(result.retained.length, 3);
});

test('run attempts are checked individually and a newer unexpected backup blocks stale-run rotation', async () => {
  const old = artifact(80, 'daily', 2 * DAY);
  old.name = 'encrypted-recovery-daily-1100-2'; old.workflow_run.id = 1100;
  const f = fixture([artifact(100, 'daily'), artifact(90, 'checkpoint', DAY), old]);
  await run(f);
  assert.ok(f.calls.some(call => call.url.endsWith('/runs/1100/attempts/2')));
  const newer = fixture([artifact(100, 'daily', DAY), artifact(90, 'checkpoint', DAY), artifact(101, 'daily')]);
  await assert.rejects(run(newer), /not the newest/); assert.deepEqual(newer.deleted, []);
});

test('request failures do not expose credential-bearing response or exception text', async () => {
  const current = artifact(100, 'checkpoint');
  for (const fetchImpl of [async () => { throw Error(token); }, async () => new Response(token, { status: 403 }),
    async () => new Response(token)]) {
    await assert.rejects(rotateBackupArtifacts({ env: env(current), now: () => timestamp, fetchImpl }), error => {
      assert.doesNotMatch(error.message, /ghs_fixture/); return true;
    });
  }
});

test('receipt normalization rejects ambiguous checkpoint flags and output injection', () => {
  const receipt = { sha256: 'a'.repeat(64), bytes: 100, createdAt: '2026-11-05T22:00:00+10:00', checkpoint: false };
  assert.equal(normalizeReceipt(receipt).createdAt, '2026-11-05T12:00:00.000Z');
  for (const extra of [{ checkpoint: 'false' }, { checkpoint: null }, { checkpoint: undefined },
    { sha256: 'a'.repeat(64) + '\n' }, { bytes: '100\nBAD=1' }, { createdAt: 'bad\nBAD=1' }]) {
    assert.throws(() => normalizeReceipt({ ...receipt, ...extra }), /metadata is invalid/);
  }
});

test('storage normalization separates legacy artifacts from release assets and rejects ambiguous job outputs', () => {
  assert.deepEqual(normalizeStorageLocation({artifactId:'123'}), {artifactId:'123',storageProvider:'github-actions'});
  assert.deepEqual(normalizeStorageLocation({artifactId:'123',storageProvider:'github-release',releaseId:'456'}),
    {artifactId:'123',storageProvider:'github-release',releaseId:'456'});
  for (const input of [
    {artifactId:'123\n'}, {artifactId:'0'}, {artifactId:'0123'}, {artifactId:'123',storageProvider:'github-release'},
    {artifactId:'123',storageProvider:'github-release',releaseId:'456\nBAD=1'},
    {artifactId:'123',storageProvider:'github-release',releaseId:'456\n'},
    {artifactId:'123',storageProvider:'github-release',releaseId:'0'},
    {artifactId:'123',storageProvider:'github-actions\nBAD=1'},
    {artifactId:'123',storageProvider:'github-actions',releaseId:'456'},
    {artifactId:'123',storageProvider:'s3'}, {artifactId:'123',storageProvider:''}
  ]) assert.throws(()=>normalizeStorageLocation(input), /storage metadata is invalid/);
});

test('verified download emits exactly the normalized backup kind before artifact upload', t => {
  const client = require.resolve('../tools/offsite-backup-client');
  const payload = Buffer.from('MWB1offline-encrypted-bundle-fixture');
  const checksum = crypto.createHash('sha256').update(payload).digest('hex');
  for (const checkpoint of [true, false]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moore-kind-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, 'github-output');
    const script = `global.fetch=async url=>{
      if(String(url)==='https://moore-weather.onrender.com/healthz')return Response.json({status:'ok',commit:'${headSha}'});
      if(String(url).startsWith('https://fixture.actions.githubusercontent.com/identity'))return Response.json({value:'fixture-token'});
      if(String(url)==='https://moore-weather.onrender.com/internal/backups/export')return new Response(Buffer.from('${payload.toString('base64')}','base64'),{headers:{
        'x-backup-sha256':'${checksum}','x-backup-checkpoint':'${checkpoint}','x-backup-created-at':'2026-11-05T22:00:00+10:00'}});
      throw Error('Unexpected offline request');
    };require(${JSON.stringify(client)}).download().catch(error=>{console.error(error.message);process.exitCode=1;});`;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: directory, encoding: 'utf8', env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.actions.githubusercontent.com/identity',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-token', GITHUB_OUTPUT: output, GITHUB_SHA: headSha
    } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), 'kind=' + (checkpoint ? 'checkpoint' : 'daily') + '\n');
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'recovery-receipt.json'), 'utf8'));
    assert.equal(receipt.checkpoint, checkpoint); assert.equal(receipt.createdAt, '2026-11-05T12:00:00.000Z');
  }
});

test('backup waits for the intended Render commit before requesting identity or exporting and bounds a superseded run', t => {
  const client = require.resolve('../tools/offsite-backup-client');
  const payload = Buffer.from('MWB1offline-encrypted-bundle-fixture');
  const checksum = crypto.createHash('sha256').update(payload).digest('hex');
  for (const scenario of ['deploys','superseded','invalid-commit']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'moore-deploy-gate-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const output = path.join(directory,'github-output');
    const script = `const assert=require('node:assert/strict');let clock=0,checks=0,identities=0,exports=0,waits=0;
      global.fetch=async (url,options)=>{
        if(String(url)==='https://moore-weather.onrender.com/healthz'){
          checks++;assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'error');assert.ok(options.signal);
          return Response.json({status:'ok',commit:${JSON.stringify(scenario)}==='deploys'&&checks>1?'${headSha}':'${'f'.repeat(40)}'});
        }
        assert.equal(checks,2,'no authenticated request before the intended deployment');
        if(String(url).startsWith('https://fixture.actions.githubusercontent.com/identity')){identities++;return Response.json({value:'fixture-token'});}
        if(String(url)==='https://moore-weather.onrender.com/internal/backups/export'){
          exports++;return new Response(Buffer.from('${payload.toString('base64')}','base64'),{headers:{
            'x-backup-sha256':'${checksum}','x-backup-checkpoint':'true','x-backup-created-at':'2026-11-05T12:00:00.000Z'}});
        }
        throw Error('Unexpected offline request');
      };
      (async()=>{
        let error;
        try {await require(${JSON.stringify(client)}).download({now:()=>clock,wait:async ms=>{assert.equal(ms,30000);clock+=ms;waits++;}});}catch(caught){error=caught;}
        if(${JSON.stringify(scenario)}==='deploys'){
          assert.equal(error,undefined);assert.equal(checks,2);assert.equal(waits,1);assert.equal(identities,1);assert.equal(exports,1);
        }else{
          assert.ok(error);assert.equal(identities,0);assert.equal(exports,0);
          if(${JSON.stringify(scenario)}==='superseded'){assert.equal(checks,50);assert.equal(waits,49);assert.match(error.message,/finish deploying/);}
          else {assert.equal(checks,0);assert.match(error.message,/commit is invalid/);}
        }
      })().catch(error=>{console.error(error.message);process.exitCode=1;});`;
    const child=spawnSync(process.execPath,['-e',script],{cwd:directory,encoding:'utf8',env:{
      GITHUB_SHA:scenario==='invalid-commit'?headSha+'\n':headSha,GITHUB_OUTPUT:output,
      ACTIONS_ID_TOKEN_REQUEST_URL:'https://fixture.actions.githubusercontent.com/identity',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture-request-token'
    }});
    assert.equal(child.status,0,child.stderr);
    assert.equal(fs.existsSync(output),scenario==='deploys');
    assert.equal(fs.existsSync(path.join(directory,'recovery-artifact','backup.mwb')),scenario==='deploys');
    assert.doesNotMatch(child.stdout+child.stderr,/fixture-token|fixture-request-token/);
  }
});

test('workflow rotates draft release assets only after acknowledgment and the receipt without touching legacy Actions artifacts', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/backups.yml'), 'utf8');
  const [backup, receipt] = workflow.split('\n  backup:\n')[1].split('\n  receipt:\n');
  assert.doesNotMatch(workflow, /actions: write|upload-artifact|rotate-backup-artifacts/);
  assert.match(backup, /contents: write/); assert.match(receipt, /contents: write/);
  assert.match(receipt, /id-token: none/);
  assert.ok(backup.indexOf('node tools/release-backup-storage.js upload') < backup.indexOf('node tools/offsite-backup-client.js ack'));
  assert.ok(receipt.indexOf('node tools/record-backup-receipt.js') < receipt.indexOf('node tools/release-backup-storage.js rotate'));
  assert.match(receipt, /BACKUP_RECEIPT_RESULT: \$\{\{ steps.receipt.outcome \}\}/);
  assert.match(receipt, /BACKUP_JOB_RESULT: \$\{\{ needs.backup.result \}\}/);
  assert.match(receipt, /BACKUP_ASSET_ID: \$\{\{ needs.backup.outputs.artifact_id \}\}/);
  assert.match(receipt, /BACKUP_RELEASE_ID: \$\{\{ needs.backup.outputs.release_id \}\}/);
  assert.match(receipt, /BACKUP_STORAGE_PROVIDER: github-release/);
});
