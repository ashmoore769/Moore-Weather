'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBackupIdentityVerifier, ISSUER, AUDIENCE, REPOSITORY, WORKFLOW } = require('../lib/backup-auth');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'test-key' };
const NOW = Date.parse('2026-11-05T12:00:00Z');
const claims = { iss: ISSUER, aud: AUDIENCE, repository: REPOSITORY, repository_id: '945419169', repository_owner_id: '202510356',
  ref: 'refs/heads/main', workflow_ref: WORKFLOW, event_name: 'push', run_id: '123456', run_attempt: '1',
  iat: NOW / 1000, nbf: NOW / 1000 - 5, exp: NOW / 1000 + 300 };
function token(changes = {}, headerChanges = {}) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key', ...headerChanges })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), privateKey).toString('base64url');
  return head + '.' + body + '.' + signature;
}
function verifier() { return createBackupIdentityVerifier({ now: () => NOW, fetchKeys: async () => ({ keys: [jwk] }) }); }

test('backup accepts the signed identity of only the designated main branch workflow', async () => {
  const verify = verifier();
  assert.equal((await verify(token())).repository_id, '945419169');
  assert.equal((await verify(token({ event_name: 'schedule' }))).event_name, 'schedule');
  for (const change of [
    { repository_id: '999' }, { repository_owner_id: '999' }, { repository: 'someone/Moore-Weather' },
    { ref: 'refs/heads/other' }, { workflow_ref: REPOSITORY + '/.github/workflows/attacker.yml@refs/heads/main' },
    { event_name: 'pull_request' }, { event_name: 'pull_request_target' }, { aud: 'different-service' }, { iss: 'https://attacker.invalid' },
    { exp: NOW / 1000 - 1 }, { iat: NOW / 1000 + 100 }, { exp: NOW / 1000 + 3600 }, { run_id: '../../x' }
  ]) await assert.rejects(verify(token(change)), /not authorized/);
});

test('backup rejects tampered signatures, algorithm substitution, unknown keys and oversize tokens', async () => {
  const verify = verifier();
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { kid: 'other-key' }, { crit: ['jku'], jku: 'https://attacker.invalid/keys' }]) {
    await assert.rejects(verify(token({}, header)), /signature/);
  }
  const signed = token();
  const parts = signed.split('.');
  parts[2] = Buffer.alloc(256).toString('base64url');
  await assert.rejects(verify(parts.join('.')), /signature/);
  await assert.rejects(verify('x'.repeat(17000)), /Invalid backup identity token/);
});
