'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recordBackupReceipt } = require('../tools/record-backup-receipt');

const repository = 'ashmoore769/Moore-Weather';
const base = 'https://api.github.com/repos/' + repository + '/git';
const ref = 'refs/heads/recovery-receipts';
const oldSha = '1'.repeat(40), treeSha = '2'.repeat(40), commitSha = '3'.repeat(40), oldTreeSha = '4'.repeat(40);
const secret = 'ghs_test_token_must_only_appear_in_api_authorization';
const createdAt = '2026-11-05T12:00:00.000Z', timestamp = Date.parse('2026-11-05T12:05:00Z');
function environment(extra = {}) {
  return {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: '945419169',
    GITHUB_REPOSITORY_OWNER_ID: '202510356', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: repository + '/.github/workflows/backups.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ID: '987654321', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_TOKEN: secret, GITHUB_API_URL: 'https://untrusted.example',
    BACKUP_JOB_RESULT: 'success', BACKUP_SHA256: 'a'.repeat(64), BACKUP_BYTES: '2048',
    BACKUP_CREATED_AT: createdAt, BACKUP_ARTIFACT_ID: '123456789',
    EXTRA_SECRET: 'private-backup-key-not-for-receipts', ...extra
  };
}
const response = (data, status = 200) => new Response(JSON.stringify(data), {status});
function github(existing = false) {
  const calls = [], logs = [];
  const fetchImpl = async (url, options) => {
    const call = {url, ...options, body: options.body && JSON.parse(options.body)};
    calls.push(call);
    if (calls.length === 1) return existing ? response({ref,object:{type:'commit',sha:oldSha}}) : response({message:'Not found'}, 404);
    if (existing && calls.length === 2) return response({sha:oldSha,tree:{sha:oldTreeSha}});
    const offset = existing ? 1 : 0;
    if (calls.length === 2 + offset) return response({sha:treeSha}, 201);
    if (calls.length === 3 + offset) return response({sha:commitSha}, 201);
    if (calls.length === 4 + offset) return response({ref,object:{type:'commit',sha:commitSha}}, existing ? 200 : 201);
    throw new Error('Unexpected request');
  };
  return {calls,logs,fetchImpl,log:line=>logs.push(line)};
}

test('first successful backup creates an orphan receipt branch containing only public metadata', async () => {
  const api = github();
  const result = await recordBackupReceipt({...api,env:environment(),now:()=>timestamp});
  assert.deepEqual(api.calls.map(call=>[call.method,call.url]), [
    ['GET',base+'/ref/heads/recovery-receipts'], ['POST',base+'/trees'],
    ['POST',base+'/commits'], ['POST',base+'/refs']
  ]);
  const tree = api.calls[1].body;
  assert.equal(tree.base_tree, undefined);
  assert.equal(tree.tree.length, 1);
  assert.deepEqual({ ...tree.tree[0], content: undefined }, {path:'latest.json',mode:'100644',type:'blob',content:undefined});
  const receipt = JSON.parse(tree.tree[0].content);
  assert.deepEqual(Object.keys(receipt).sort(), ['artifactId','bytes','createdAt','recordedAt','repository','runAttempt','runId','runUrl','schema','sha256'].sort());
  assert.equal(receipt.sha256, 'a'.repeat(64));
  assert.equal(receipt.bytes, 2048);
  assert.equal(receipt.createdAt, createdAt);
  assert.equal(receipt.recordedAt, new Date(timestamp).toISOString());
  assert.equal(receipt.artifactId, '123456789');
  assert.deepEqual(api.calls[2].body.parents, []);
  assert.deepEqual(api.calls[3].body, {ref,sha:commitSha});
  assert.equal(result.branch, 'recovery-receipts');
  for (const call of api.calls) {
    assert.equal(call.headers.Authorization, 'Bearer ' + secret);
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal);
    assert.doesNotMatch(call.url, /main|untrusted/);
    assert.doesNotMatch(JSON.stringify(call.body ?? null), /ghs_test_token|private-backup-key/);
  }
  assert.doesNotMatch(JSON.stringify([result,api.logs]), /ghs_test_token|private-backup-key/);
});

test('later receipts preserve other branch files and parent history and only fast-forward the fixed receipt ref', async () => {
  const api = github(true);
  await recordBackupReceipt({...api,env:environment(),now:()=>timestamp});
  assert.equal(api.calls[1].method, 'GET');
  assert.equal(api.calls[1].url, base+'/commits/'+oldSha);
  assert.equal(api.calls[2].body.base_tree, oldTreeSha);
  assert.deepEqual(api.calls[2].body.tree.map(entry=>entry.path), ['latest.json']);
  assert.deepEqual(api.calls[3].body.parents, [oldSha]);
  assert.equal(api.calls[4].method, 'PATCH');
  assert.equal(api.calls[4].url, base+'/refs/heads/recovery-receipts');
  assert.deepEqual(api.calls[4].body, {sha:commitSha,force:false});
  assert.ok(api.calls.every(call=>!call.url.includes('/main')));
});

test('failed, cancelled, skipped or missing backup jobs never produce a receipt request', async () => {
  for (const result of ['failure','cancelled','skipped',undefined]) {
    const api = github();
    await assert.rejects(recordBackupReceipt({...api,env:environment({BACKUP_JOB_RESULT:result}),now:()=>timestamp}), /successful backup job/);
    assert.equal(api.calls.length, 0);
    assert.equal(api.logs.length, 0);
  }
});

test('forks, other workflows and non-main runs cannot invoke the receipt writer', async () => {
  for (const extra of [
    {GITHUB_REPOSITORY:'someone/Moore-Weather'}, {GITHUB_REPOSITORY_ID:'1'}, {GITHUB_REPOSITORY_OWNER_ID:'1'},
    {GITHUB_REF:ref}, {GITHUB_WORKFLOW_REF:repository+'/.github/workflows/monitor.yml@refs/heads/main'},
    {GITHUB_EVENT_NAME:'pull_request'}, {GITHUB_ACTIONS:'false'}
  ]) {
    const api = github();
    await assert.rejects(recordBackupReceipt({...api,env:environment(extra),now:()=>timestamp}), /context is not authorized/);
    assert.equal(api.calls.length, 0);
  }
});

test('invalid or injected receipt outputs fail before any GitHub mutation', async () => {
  for (const extra of [
    {BACKUP_SHA256:'a'.repeat(64)+'\nTOKEN=secret'}, {BACKUP_BYTES:'2048\nTOKEN=secret'},
    {BACKUP_BYTES:'-1'}, {BACKUP_BYTES:String(6*1024**3+1)}, {BACKUP_BYTES:'NaN'},
    {BACKUP_CREATED_AT:'not a date'}, {BACKUP_CREATED_AT:createdAt+'\nTOKEN=secret'},
    {BACKUP_ARTIFACT_ID:'../main'}, {GITHUB_RUN_ID:'../main'}, {GITHUB_RUN_ATTEMPT:'0'},
    {GITHUB_TOKEN:''}, {GITHUB_TOKEN:'token\nheader'}
  ]) {
    const api = github();
    await assert.rejects(recordBackupReceipt({...api,env:environment(extra),now:()=>timestamp}), /invalid|unavailable/);
    assert.equal(api.calls.length, 0);
  }
});

test('an unexpected reference cannot supply main as the receipt parent', async () => {
  let calls = 0;
  await assert.rejects(recordBackupReceipt({env:environment(),now:()=>timestamp,fetchImpl:async()=>{
    calls++; return response({ref:'refs/heads/main',object:{type:'commit',sha:oldSha}});
  }}), /unexpected receipt reference/);
  assert.equal(calls, 1);
});

test('an invalid parent commit or tree stops before writing any new objects', async () => {
  for (const parent of [{sha:commitSha,tree:{sha:oldTreeSha}}, {sha:oldSha,tree:{sha:'../main'}}]) {
    const api = github(true), normal = api.fetchImpl;
    api.fetchImpl = async (url,options) => {
      if (url === base+'/commits/'+oldSha) {api.calls.push({url,...options});return response(parent);}
      return normal(url,options);
    };
    await assert.rejects(recordBackupReceipt({...api,env:environment(),now:()=>timestamp}), /invalid receipt parent tree/);
    assert.equal(api.calls.length, 2);
    assert.ok(api.calls.every(call=>call.method==='GET'));
  }
});

test('a concurrent ref conflict fails without forcing a branch update or exposing API response content', async () => {
  const api = github(true), normal = api.fetchImpl;
  api.fetchImpl = async (url, options) => {
    if (options.method === 'PATCH') {
      api.calls.push({url,...options,body:JSON.parse(options.body)});
      return response({message:secret}, 422);
    }
    return normal(url,options);
  };
  await assert.rejects(recordBackupReceipt({...api,env:environment(),now:()=>timestamp}), error=>{
    assert.equal(error.message, 'GitHub receipt request returned HTTP 422'); return true;
  });
  assert.equal(api.calls.length, 5);
  assert.equal(api.calls[4].body.force, false);
  assert.equal(api.logs.length, 0);
});

test('transport and malformed response errors cannot echo credentials', async () => {
  for (const fetchImpl of [async()=>{throw new Error(secret);}, async()=>new Response(secret)]) {
    await assert.rejects(recordBackupReceipt({env:environment(),now:()=>timestamp,fetchImpl}), error=>{
      assert.doesNotMatch(error.message, /ghs_test_token/);
      assert.match(error.message, /GitHub receipt request failed|GitHub receipt response was invalid/);
      return true;
    });
  }
});

test('acknowledgement emits only four safe job outputs, and emits none when acknowledgement fails', t => {
  const client = require.resolve('../tools/offsite-backup-client');
  for (const accepted of [true,false]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'moore-receipt-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const output = path.join(directory,'github-output');
    fs.writeFileSync(path.join(directory,'recovery-receipt.json'),JSON.stringify({
      sha256:'a'.repeat(64),bytes:2048,createdAt,checkpoint:true,secret:'private-backup-key-not-for-receipts'
    }));
    const script = `global.fetch=async url=>{
      if(String(url).startsWith('https://fixture.actions.githubusercontent.com/identity'))return Response.json({value:'fixture-oidc-token'});
      if(String(url)==='https://moore-weather.onrender.com/internal/backups/ack')return Response.json({accepted:${accepted},retentionCheckpointVerified:true});
      throw new Error('Unexpected offline fixture request');
    };
    require(${JSON.stringify(client)}).acknowledge().catch(error=>{console.error(error.message);process.exitCode=1;});`;
    const child = spawnSync(process.execPath,['-e',script],{cwd:directory,encoding:'utf8',env:{
      ACTIONS_ID_TOKEN_REQUEST_URL:'https://fixture.actions.githubusercontent.com/identity',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture-request-token',BACKUP_ARTIFACT_ID:'123456789',GITHUB_OUTPUT:output
    }});
    assert.equal(child.status, accepted ? 0 : 1, child.stderr);
    assert.doesNotMatch(child.stdout+child.stderr, /fixture-oidc-token|fixture-request-token|private-backup-key/);
    if (accepted) assert.equal(fs.readFileSync(output,'utf8'), 'sha256='+'a'.repeat(64)+'\nbytes=2048\ncreated_at='+createdAt+'\nartifact_id=123456789\n');
    else assert.equal(fs.existsSync(output), false);
  }
});

test('workflow grants write access only to the receipt job after backup success and never gives it OIDC', () => {
  const workflow = fs.readFileSync(path.join(__dirname,'../.github/workflows/backups.yml'),'utf8');
  const [backup,receipt] = workflow.split('\n  backup:\n')[1].split('\n  receipt:\n');
  assert.match(backup,/permissions:\n      contents: read\n      id-token: write/);
  assert.doesNotMatch(backup,/GITHUB_TOKEN:/);
  assert.match(receipt,/needs: backup/);
  assert.match(receipt,/needs\.backup\.result == 'success'/);
  assert.match(receipt,/permissions:\n      contents: write\n      id-token: none/);
  assert.match(receipt,/persist-credentials: false/);
  assert.doesNotMatch(receipt,/download-artifact|offsite-backup-client|internal\/backups/);
  for (const name of ['sha256','bytes','created_at','artifact_id']) {
    assert.match(backup,new RegExp(name+': \\$\\{\\{ steps\\.ack\\.outputs\\.'+name+' \\}\\}'));
  }
});
