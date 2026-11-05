'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBackupIdentityVerifier, ISSUER, AUDIENCE, REPOSITORY, WORKFLOW } = require('../lib/backup-auth');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = kid => ({ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
function token(kid, now, extra = {}) {
  const seconds = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, repository: REPOSITORY,
    repository_id: '945419169', repository_owner_id: '202510356', ref: 'refs/heads/main', workflow_ref: WORKFLOW,
    event_name: 'schedule', run_id: '12345', run_attempt: '1', iat: seconds, nbf: seconds, exp: seconds + 300, ...extra })).toString('base64url');
  const data = header + '.' + payload;
  return data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
}

test('a new issuer signing key refreshes the cache without waiting an hour and unknown keys are bounded', async () => {
  let now = 1000000, calls = 0;
  const verifier = createBackupIdentityVerifier({ now: () => now,
    fetchKeys: async () => ({ keys: [key(++calls === 1 ? 'old' : 'rotated')] }) });
  await verifier(token('old', now)); assert.equal(calls, 1);
  now += 1000;
  await verifier(token('rotated', now)); assert.equal(calls, 2);
  await assert.rejects(verifier(token('invented', now)), /signature/);
  await assert.rejects(verifier(token('another', now)), /signature/);
  assert.equal(calls, 2);
  now += 60000;
  await assert.rejects(verifier(token('invented', now)), /signature/);
  assert.equal(calls, 3);
});

test('tokens that expire during an issuer key fetch cannot authorize a backup', async () => {
  let now = 1000000;
  const signed = token('one', now, { exp: Math.floor(now / 1000) + 1 });
  const verifier = createBackupIdentityVerifier({ now: () => now, fetchKeys: async () => { now += 2000; return { keys: [key('one')] }; } });
  await assert.rejects(verifier(signed), /not authorized/);
});
