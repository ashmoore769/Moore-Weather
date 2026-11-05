'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { uploadReleaseBackup, rotateReleaseBackups, candidate, assetName, assetLabel,
  TAG, RELEASE_NAME, RELEASE_BODY, MAX_BYTES } = require('../tools/release-backup-storage');

const repository = 'ashmoore769/Moore-Weather', repositoryId = 945419169;
const api = 'https://api.github.com/repos/' + repository, uploads = 'https://uploads.github.com/repos/' + repository;
const timestamp = Date.parse('2026-11-05T12:00:00Z'), DAY = 86400000;
const context = { runId: '42014542145', attempt: 1, headSha: 'a'.repeat(40) };
const token = 'ghs_fixture_never_printed';
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function environment(extra = {}) {
  return { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: String(repositoryId),
    GITHUB_REPOSITORY_OWNER_ID: '202510356', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: context.headSha,
    GITHUB_WORKFLOW_REF: repository + '/.github/workflows/backups.yml@refs/heads/main', GITHUB_EVENT_NAME: 'schedule',
    GITHUB_RUN_ID: context.runId, GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: token,
    GITHUB_API_URL: 'https://untrusted.example', ...extra };
}
function release(extra = {}) {
  return { id: 7, tag_name: TAG, name: RELEASE_NAME, body: RELEASE_BODY, draft: true, prerelease: true,
    target_commitish: 'main', published_at: null, immutable: false, author: bot,
    upload_url: 'https://untrusted.example/never-follow', assets_url: 'https://untrusted.example/never-follow', ...extra };
}
function receipt(kind = 'checkpoint', age = 0, bytes = Buffer.from('MWB1encrypted-fixture')) {
  return { sha256: digest(bytes), bytes: bytes.length, createdAt: new Date(timestamp - age).toISOString(), checkpoint: kind === 'checkpoint' };
}
function asset(id, kind = 'daily', age = 0, extra = {}) {
  const metadata = receipt(kind, age, Buffer.from('MWB1encrypted-fixture-' + id));
  const provenance = { ...context, runId: String(100000 + id) };
  return { id, name: assetName(metadata), label: assetLabel(metadata, provenance), size: metadata.bytes,
    digest: 'sha256:' + metadata.sha256, content_type: 'application/octet-stream', state: 'uploaded',
    created_at: new Date(timestamp - age + 1000).toISOString(), uploader: bot, ...extra };
}
function localFiles(t, metadata = receipt(), content = Buffer.from('MWB1encrypted-fixture')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'recovery-artifact'));
  fs.writeFileSync(path.join(directory, 'recovery-artifact/backup.mwb'), content);
  fs.writeFileSync(path.join(directory, 'recovery-receipt.json'), JSON.stringify(metadata));
  return { directory, output: path.join(directory, 'github-output') };
}
function forReceipt(id, metadata, extra = {}) {
  return asset(id, metadata.checkpoint ? 'checkpoint' : 'daily', 0, { name: assetName(metadata), label: assetLabel(metadata, context),
    size: metadata.bytes, digest: 'sha256:' + metadata.sha256, ...extra });
}
function rotationEnvironment(current, extra = {}) {
  const value = candidate(current);
  return environment({ BACKUP_JOB_RESULT: 'success', BACKUP_RECEIPT_RESULT: 'success', BACKUP_STORAGE_PROVIDER: 'github-release',
    BACKUP_KIND: value.kind, BACKUP_RELEASE_ID: '7', BACKUP_ASSET_ID: String(value.id),
    BACKUP_SHA256: value.sha256, BACKUP_BYTES: String(value.bytes), BACKUP_CREATED_AT: value.createdAt, ...extra });
}

function fixture({ releases = [release()], assets = [], runChanges = {}, onRequest, uploadChanges = {} } = {}) {
  const state = { releases: [...releases], assets: [...assets], calls: [], deleted: [], logs: [], uploads: [], created: [], assetLists: 0 };
  const fetchImpl = async (url, options) => {
    state.calls.push({ url, ...options });
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer ' + token);
    assert.ok(url.startsWith(api + '/') || url.startsWith(uploads + '/'));
    const parsed = new URL(url), route = parsed.pathname.slice(('/repos/' + repository).length);
    if (onRequest) { const response = await onRequest({ url, options, parsed, route, state }); if (response) return response; }
    const run = /^\/actions\/runs\/([0-9]+)\/attempts\/([0-9]+)$/.exec(route);
    if (run) {
      const source = state.assets.map(candidate).find(item => item?.runId === run[1] && item.attempt === Number(run[2]));
      return Response.json({ id: Number(run[1]), run_attempt: Number(run[2]), path: '.github/workflows/backups.yml',
        head_branch: 'main', head_sha: source?.headSha || context.headSha, repository: { id: repositoryId },
        head_repository: { id: repositoryId }, event: 'schedule', status: run[1] === context.runId ? 'in_progress' : 'completed',
        ...(runChanges[run[1] + '/' + run[2]] || {}) });
    }
    if (route === '/releases' && options.method === 'GET') {
      const page = Number(parsed.searchParams.get('page'));
      return Response.json(state.releases.slice((page - 1) * 100, page * 100));
    }
    if (route === '/releases' && options.method === 'POST') {
      const body = JSON.parse(options.body); state.created.push(body);
      const result = release(body); state.releases.push(result); return Response.json(result, { status: 201 });
    }
    const list = /^\/releases\/([0-9]+)\/assets$/.exec(route);
    if (list && options.method === 'GET') {
      assert.equal(Number(list[1]), 7); state.assetLists++;
      const page = Number(parsed.searchParams.get('page'));
      return Response.json(state.assets.slice((page - 1) * 100, page * 100));
    }
    if (list && options.method === 'POST') {
      assert.equal(parsed.origin, 'https://uploads.github.com'); assert.equal(options.duplex, 'half');
      assert.ok(options.body && !Buffer.isBuffer(options.body) && typeof options.body !== 'string');
      const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
      const content = Buffer.concat(chunks); state.uploads.push(content);
      assert.equal(options.headers['Content-Length'], String(content.length));
      const result = asset(500, 'checkpoint', 0, { name: parsed.searchParams.get('name'), label: parsed.searchParams.get('label'),
        size: content.length, digest: 'sha256:' + digest(content), ...uploadChanges });
      state.assets.push(result); return Response.json(result, { status: 201 });
    }
    const detail = /^\/releases\/assets\/([0-9]+)$/.exec(route);
    if (detail) {
      const item = state.assets.find(value => value.id === Number(detail[1]));
      if (options.method === 'DELETE') {
        state.deleted.push(Number(detail[1])); state.assets = state.assets.filter(value => value.id !== Number(detail[1]));
        return new Response(null, { status: 204 });
      }
      return item ? Response.json(item) : Response.json({ message: 'not found' }, { status: 404 });
    }
    const detailRelease = /^\/releases\/([0-9]+)$/.exec(route);
    if (detailRelease && options.method === 'GET') return Response.json(state.releases.find(value => value.id === Number(detailRelease[1])));
    throw new Error('Unexpected offline request');
  };
  return { state, fetchImpl, now: () => timestamp, log: message => state.logs.push(message) };
}
const mutations = f => f.state.calls.filter(call => call.method !== 'GET');
const rotate = (f, current, extra = {}) => rotateReleaseBackups({ ...f, env: rotationEnvironment(current, extra) });

test('upload creates only the marked unpublished draft and streams a hash-verified encrypted asset', async t => {
  const files = localFiles(t), f = fixture({ releases: [] });
  const result = await uploadReleaseBackup({ ...f, ...files, env: environment({ GITHUB_OUTPUT: files.output }) });
  assert.equal(result.assetId, '500'); assert.equal(result.releaseId, '7'); assert.equal(result.kind, 'checkpoint');
  assert.equal(result.reused, false); assert.equal(f.state.created.length, 1);
  assert.deepEqual(f.state.created[0], { tag_name: TAG, target_commitish: 'main', name: RELEASE_NAME, body: RELEASE_BODY,
    draft: true, prerelease: true, make_latest: 'false', generate_release_notes: false });
  assert.equal(f.state.uploads[0].toString(), 'MWB1encrypted-fixture');
  assert.equal(fs.readFileSync(files.output, 'utf8'), 'asset_id=500\nrelease_id=7\nkind=checkpoint\n');
  assert.ok(mutations(f).every(call => call.method === 'POST'));
  assert.doesNotMatch(JSON.stringify(f.state.logs), /ghs_fixture/);
});

test('a matching checkpoint is reused across workflow runs without uploading duplicate ciphertext', async t => {
  const metadata = receipt(), files = localFiles(t, metadata);
  const existing = forReceipt(12, metadata, { label: assetLabel(metadata, { ...context, runId: '12345', attempt: 2 }) });
  const f = fixture({ assets: [existing] });
  const first = await uploadReleaseBackup({ ...f, ...files, env: environment() });
  const second = await uploadReleaseBackup({ ...f, ...files, env: environment() });
  assert.equal(first.assetId, '12'); assert.equal(first.reused, true); assert.equal(second.assetId, '12');
  assert.equal(mutations(f).length, 0);
  assert.ok(f.state.calls.some(call => call.url.endsWith('/actions/runs/12345/attempts/2')));
});

test('daily uploads use a distinct strict name and preserve the original checkpoint', async t => {
  const metadata = receipt('daily'), files = localFiles(t, metadata), original = asset(4, 'checkpoint', 10 * DAY);
  const f = fixture({ assets: [original] });
  const result = await uploadReleaseBackup({ ...f, ...files, env: environment() });
  assert.equal(result.kind, 'daily'); assert.ok(f.state.assets.some(item => item.id === original.id));
  assert.deepEqual(f.state.deleted, []);
});

test('local size, checksum, encrypted format and 2 GiB limit fail before any GitHub request', async t => {
  const cases = [
    { metadata: { ...receipt(), sha256: 'b'.repeat(64) } },
    { metadata: { ...receipt(), bytes: 999 } },
    { content: Buffer.from('plain text database'), metadata: receipt('checkpoint', 0, Buffer.from('plain text database')) },
    { metadata: { ...receipt(), bytes: MAX_BYTES + 1 } },
    { metadata: { ...receipt(), checkpoint: 'true' } }
  ];
  for (const item of cases) {
    const files = localFiles(t, item.metadata, item.content), f = fixture();
    await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment() }));
    assert.equal(f.state.calls.length, 0);
  }
});

test('deadline while hashing closes the local descriptor without any API request or asynchronous cleanup error', async t => {
  const files = localFiles(t), f = fixture();
  let calls = 0;
  await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment(),
    now: () => timestamp + (calls++ > 1 ? 600001 : 0) }), /time limit/);
  assert.equal(f.state.calls.length, 0);
});

test('workflow context rejects forks, non-main refs, unrelated workflows, injection and missing credentials', async t => {
  const files = localFiles(t);
  for (const extra of [{ GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_ACTIONS: 'false' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_WORKFLOW_REF: repository + '/.github/workflows/other.yml@refs/heads/main' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_SHA: context.headSha + '\n' }, { GITHUB_RUN_ID: '12\n' },
    { GITHUB_RUN_ATTEMPT: '1\n' }, { GITHUB_TOKEN: '' }]) {
    const f = fixture(); await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment(extra) }));
    assert.equal(f.state.calls.length, 0);
  }
});

test('current workflow metadata must confirm the exact main run and attempt before creating a release', async t => {
  const files = localFiles(t);
  for (const extra of [{ head_branch: 'feature' }, { path: '.github/workflows/checks.yml' }, { head_sha: 'b'.repeat(40) },
    { head_repository: { id: 1 } }, { repository: { id: 1 } }, { status: 'completed' }, { run_attempt: 2 }]) {
    const f = fixture({ releases: [], runChanges: { [context.runId + '/1']: extra } });
    await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment() }), /workflow identity/);
    assert.equal(mutations(f).length, 0);
  }
  const f = fixture({ runChanges: { [context.runId + '/1']: { path: '.github/workflows/backups.yml@main' } } });
  assert.equal((await uploadReleaseBackup({ ...f, ...files, env: environment() })).assetId, '500');
});

test('existing releases must match the exact marker, identity and unpublished state', async t => {
  const files = localFiles(t);
  for (const extra of [{ draft: false }, { published_at: new Date(timestamp).toISOString() }, { body: 'unrelated release' },
    { prerelease: false }, { target_commitish: 'feature' }, { name: 'renamed' }, { tag_name: 'different-tag' },
    { author: { id: 1, login: 'github-actions[bot]', type: 'Bot' } }]) {
    const f = fixture({ releases: [release(extra)] });
    await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment() }), /release identity/);
    assert.equal(mutations(f).length, 0);
  }
  const f = fixture({ releases: [release(), release({ id: 8 })] });
  await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment() }), /ambiguous/);
  assert.equal(mutations(f).length, 0);
});

test('complete paginated discovery finds a matching draft and asset beyond the first page', async t => {
  const metadata = receipt(), files = localFiles(t, metadata), existing = forReceipt(500, metadata);
  const unrelatedReleases = Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, tag_name: 'v' + index, name: null, draft: false, body: null }));
  const unrelatedAssets = Array.from({ length: 100 }, (_, index) => ({ id: 2000 + index, name: 'manual-' + index }));
  const f = fixture({ releases: [...unrelatedReleases, release()], assets: [...unrelatedAssets, existing] });
  const result = await uploadReleaseBackup({ ...f, ...files, env: environment() });
  assert.equal(result.reused, true); assert.equal(mutations(f).length, 0);
  assert.ok(f.state.calls.some(call => call.url === api + '/releases?per_page=100&page=3'));
  assert.ok(f.state.calls.some(call => call.url === api + '/releases/7/assets?per_page=100&page=3'));
});

test('ambiguous, malformed, duplicate or unbounded inventories never authorize upload or deletion', async t => {
  const files = localFiles(t);
  for (const mode of ['shape', 'duplicate', 'unbounded']) {
    const f = fixture({ releases: [], onRequest({ route, parsed }) {
      if (route !== '/releases') return;
      if (mode === 'shape') return Response.json({ releases: [] });
      if (mode === 'duplicate') return Response.json([release(), release()]);
      const page = Number(parsed.searchParams.get('page'));
      return Response.json([{ id: page, tag_name: 'unrelated-' + page, draft: false }]);
    } });
    await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment() }), /inventory/);
    assert.equal(mutations(f).length, 0);
  }
});

test('same-name mismatches are preserved and never overwritten or deleted', async t => {
  const metadata = receipt(), files = localFiles(t, metadata);
  for (const extra of [{ digest: 'sha256:' + 'c'.repeat(64) }, { size: metadata.bytes + 1 }, { label: 'manual upload' },
    { uploader: { ...bot, id: 1 } }, { state: 'starter' }]) {
    const f = fixture({ assets: [forReceipt(12, metadata, extra)] });
    await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment() }), /Existing recovery asset/);
    assert.equal(mutations(f).length, 0);
  }
});

test('returned raw-content checksum, size and ownership must verify before outputs are emitted', async t => {
  for (const extra of [{ digest: 'sha256:' + 'c'.repeat(64) }, { size: 1 }, { digest: null },
    { uploader: { ...bot, id: 1 } }, { name: 'other.mwb' }, { label: 'manual' }]) {
    const files = localFiles(t), f = fixture({ uploadChanges: extra });
    await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment({ GITHUB_OUTPUT: files.output }) }), /Uploaded recovery asset/);
    assert.equal(fs.existsSync(files.output), false); assert.deepEqual(f.state.deleted, []);
  }
});

test('publication during upload fails final verification without outputs or automatic cleanup', async t => {
  const files = localFiles(t);
  const f = fixture({ onRequest({ route, options, state }) {
    if (route === '/releases/7' && options.method === 'GET' && state.uploads.length) return Response.json(release({ draft: false }));
  } });
  await assert.rejects(uploadReleaseBackup({ ...f, ...files, env: environment({ GITHUB_OUTPUT: files.output }) }), /unpublished state/);
  assert.equal(fs.existsSync(files.output), false); assert.deepEqual(f.state.deleted, []);
});

test('API and transport errors do not print response bodies or reflected credentials', async t => {
  const files = localFiles(t);
  for (const fetchImpl of [async () => { throw Error('reflected ' + token); }, async () => new Response(token, { status: 500 }),
    async () => new Response(token, { status: 302, headers: { location: 'https://untrusted.example' } })]) {
    await assert.rejects(uploadReleaseBackup({ ...files, env: environment(), fetchImpl, log() {} }), error => {
      assert.doesNotMatch(error.message, /ghs_fixture|untrusted/); return true;
    });
  }
});

test('rotation preserves every checkpoint and three newest daily copies without an Actions quota', async () => {
  const current = asset(100, 'daily'), oldCheckpoint = asset(20, 'checkpoint', 40 * DAY), checkpoint = asset(90, 'checkpoint', 5 * DAY);
  const otherWorkflow = asset(70, 'daily', 12 * DAY);
  const unknown = asset(71, 'daily', 13 * DAY, { uploader: { ...bot, id: 1 } });
  const badDigest = asset(72, 'daily', 14 * DAY, { digest: 'sha256:' + 'e'.repeat(64) });
  const f = fixture({ assets: [current, checkpoint, oldCheckpoint, asset(99, 'daily', DAY), asset(98, 'daily', 2 * DAY),
    asset(97, 'daily', 3 * DAY), asset(96, 'daily', 4 * DAY), otherWorkflow, unknown, badDigest, { id: 200, name: 'manual-copy.mwb' }],
    runChanges: { [candidate(otherWorkflow).runId + '/1']: { path: '.github/workflows/other.yml' } } });
  const result = await rotate(f, current);
  assert.deepEqual(new Set(result.retained), new Set([20, 90, 100, 99, 98]));
  assert.deepEqual(f.state.deleted, [97, 96]);
  assert.ok(f.state.assets.some(item => item.id === 70)); assert.ok(f.state.assets.some(item => item.id === 200));
  assert.ok(mutations(f).every(call => call.method === 'DELETE' && /^\/releases\/assets\/\d+$/.test(new URL(call.url).pathname.slice(('/repos/' + repository).length))));
  assert.doesNotMatch(JSON.stringify(f.state.logs), /ghs_fixture/);
});

test('an older original checkpoint may be reused and remains protected alongside later checkpoints', async () => {
  const current = asset(10, 'checkpoint', 80 * DAY);
  const f = fixture({ assets: [current, asset(90, 'checkpoint', DAY), asset(100, 'daily'), asset(99, 'daily', DAY),
    asset(98, 'daily', 2 * DAY), asset(97, 'daily', 3 * DAY)] });
  const result = await rotate(f, current);
  assert.deepEqual(new Set(result.retained), new Set([10, 90, 100, 99, 98]));
  assert.deepEqual(result.deleted, [97]);
});

test('rotation requires accepted-job and committed-receipt success plus strict release metadata', async () => {
  const current = asset(100, 'daily');
  for (const extra of [{ BACKUP_JOB_RESULT: 'failure' }, { BACKUP_RECEIPT_RESULT: 'skipped' },
    { BACKUP_STORAGE_PROVIDER: 'github-actions' }, { BACKUP_KIND: 'checkpoint\nX=1' }, { BACKUP_RELEASE_ID: '7\n' },
    { BACKUP_ASSET_ID: '100\n' }, { BACKUP_BYTES: '23\n' }, { BACKUP_CREATED_AT: '2026-11-05T12:00:00+00:00' },
    { BACKUP_SHA256: 'bad' }, { BACKUP_BYTES: String(MAX_BYTES + 1) }]) {
    const f = fixture({ assets: [current, asset(90, 'checkpoint')] });
    await assert.rejects(rotate(f, current, extra)); assert.equal(f.state.calls.length, 0);
  }
});

test('current asset must belong to the discovered draft and exactly match the acknowledged receipt', async () => {
  const current = asset(100, 'daily');
  for (const extra of [{ BACKUP_RELEASE_ID: '8' }, { BACKUP_ASSET_ID: '999' }, { BACKUP_SHA256: 'f'.repeat(64) },
    { BACKUP_BYTES: '999' }, { BACKUP_CREATED_AT: '2026-11-01T12:00:00.000Z' }]) {
    const f = fixture({ assets: [current, asset(90, 'checkpoint'), asset(99, 'daily', DAY), asset(98, 'daily', 2 * DAY), asset(97, 'daily', 3 * DAY)] });
    await assert.rejects(rotate(f, current, extra)); assert.deepEqual(f.state.deleted, []);
  }
});

test('no daily asset can be deleted without a valid owned checkpoint', async () => {
  const current = asset(100, 'daily'), checkpoint = asset(90, 'checkpoint');
  for (const entry of [null, { ...checkpoint, uploader: { ...bot, id: 1 } }, { ...checkpoint, digest: null }]) {
    const f = fixture({ assets: [current, asset(99, 'daily', DAY), asset(98, 'daily', 2 * DAY), asset(97, 'daily', 3 * DAY), ...(entry ? [entry] : [])] });
    await assert.rejects(rotate(f, current), /valid owned checkpoint/); assert.deepEqual(f.state.deleted, []);
  }
});

test('a changing complete inventory prevents all deletion', async () => {
  const current = asset(100, 'daily');
  const f = fixture({ assets: [current, asset(90, 'checkpoint'), asset(99, 'daily', DAY), asset(98, 'daily', 2 * DAY), asset(97, 'daily', 3 * DAY)],
    onRequest({ route, parsed, state }) {
      if (route === '/releases/7/assets' && parsed.searchParams.get('page') === '1' && state.assetLists >= 4) {
        state.assets.push({ id: 555, name: 'new-manual-asset' });
      }
    } });
  await assert.rejects(rotate(f, current), /inventory changed/); assert.deepEqual(f.state.deleted, []);
});

test('mutable candidate identity and draft status are rechecked immediately before deletion', async () => {
  const current = asset(100, 'daily');
  for (const mode of ['asset', 'release', 'checkpoint', 'current']) {
    const f = fixture({ assets: [current, asset(90, 'checkpoint'), asset(99, 'daily', DAY), asset(98, 'daily', 2 * DAY), asset(97, 'daily', 3 * DAY)],
      onRequest({ route, state }) {
        if (state.assetLists < 6) return;
        if (mode === 'release' && route === '/releases/7') return Response.json(release({ draft: false }));
        const target = mode === 'asset' ? 97 : mode === 'checkpoint' ? 90 : mode === 'current' ? 100 : null;
        if (route === '/releases/assets/' + target) return Response.json({ ...state.assets.find(item => item.id === target), name: 'renamed-unrelated-copy' });
      } });
    await assert.rejects(rotate(f, current), /identity|unpublished/); assert.deepEqual(f.state.deleted, []);
  }
});

test('an acknowledged daily copy older than the newest three cannot authorize its own deletion', async () => {
  const current = asset(80, 'daily', 5 * DAY);
  const f = fixture({ assets: [current, asset(90, 'checkpoint'), asset(100, 'daily'), asset(99, 'daily', DAY), asset(98, 'daily', 2 * DAY)] });
  await assert.rejects(rotate(f, current), /would not be retained/); assert.deepEqual(f.state.deleted, []);
});

test('bounded candidate count and request deadline fail closed before deleting anything', async () => {
  const current = asset(1000, 'daily');
  const many = fixture({ assets: [current, asset(500, 'checkpoint'), ...Array.from({ length: 100 }, (_, index) => asset(200 + index, 'daily', (index + 1) * DAY))] });
  await assert.rejects(rotate(many, current), /Too many recovery assets/); assert.deepEqual(many.state.deleted, []);
  const f = fixture({ assets: [current, asset(500, 'checkpoint')] });
  let calls = 0;
  await assert.rejects(rotateReleaseBackups({ ...f, env: rotationEnvironment(current), now: () => timestamp + (calls++ ? 180001 : 0) }), /time limit/);
  assert.deepEqual(f.state.deleted, []);
});

test('strict candidate metadata excludes suffix injection, forged bot identity and digest-size mismatch', () => {
  const current = asset(10, 'checkpoint');
  assert.ok(candidate(current));
  for (const extra of [{ name: current.name + '\n' }, { label: current.label + '\n' }, { size: current.size + 1 },
    { uploader: { ...bot, login: 'other[bot]' } }, { uploader: { ...bot, type: 'User' } },
    { digest: current.digest + '\n' }, { content_type: 'text/plain' }]) assert.equal(candidate({ ...current, ...extra }), null);
});
