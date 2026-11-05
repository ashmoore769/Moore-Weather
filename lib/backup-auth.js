'use strict';
const crypto = require('node:crypto');

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = ISSUER + '/.well-known/jwks';
const AUDIENCE = 'https://moore-weather.onrender.com/backups';
const REPOSITORY = 'ashmoore769/Moore-Weather';
const WORKFLOW = REPOSITORY + '/.github/workflows/backups.yml@refs/heads/main';

function validateClaims(claims, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.repository !== REPOSITORY ||
      claims.repository_id !== '945419169' || claims.repository_owner_id !== '202510356' ||
      claims.ref !== 'refs/heads/main' || claims.workflow_ref !== WORKFLOW ||
      !['push', 'schedule', 'workflow_dispatch'].includes(claims.event_name) ||
      !/^\d{1,24}$/.test(claims.run_id || '') || !/^\d{1,8}$/.test(claims.run_attempt || '') ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.nbf) || !Number.isSafeInteger(claims.exp) ||
      claims.iat > seconds + 30 || claims.nbf > seconds + 30 || claims.exp <= seconds ||
      claims.exp - claims.iat > 15 * 60 || claims.exp <= claims.iat || claims.iat < seconds - 15 * 60) {
    throw new Error('Backup identity is not authorized');
  }
  return claims;
}

function createBackupIdentityVerifier({ fetchKeys, now = Date.now } = {}) {
  let cached = null, fetchedAt = 0, inFlight = null, generation = 0, lastUnknownRefreshAt = -Infinity;
  async function keys(force = false) {
    if (inFlight) return inFlight;
    if (!force && cached && now() - fetchedAt < 3600000) return cached;
    inFlight = (async () => {
      let data;
      if (fetchKeys) data = await fetchKeys();
      else {
        const response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) throw new Error('Backup identity provider unavailable');
        let bytes = 0; const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 65536) throw new Error('Backup identity keys exceeded size limit');
          chunks.push(Buffer.from(chunk));
        }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      if (!Array.isArray(data.keys) || data.keys.length > 20) throw new Error('Invalid backup identity keys');
      cached = data.keys.filter(key => key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256' && typeof key.kid === 'string')
        .map(key => ({ kid: key.kid, key: crypto.createPublicKey({ key, format: 'jwk' }) }));
      if (!cached.length) throw new Error('No valid backup identity keys');
      fetchedAt = now(); generation++; return cached;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  return async token => {
    if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error('Invalid backup identity token');
    }
    const [head, body, signature] = token.split('.');
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // Tokens cannot choose a key URL, repository, branch or output destination.
    validateClaims(claims, now());
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string' || header.kid.length > 200 || header.crit) {
      throw new Error('Invalid backup identity signature');
    }
    const before = generation;
    let signingKey = (await keys()).find(key => key.kid === header.kid);
    // GitHub can rotate signing keys before the normal cache expires. Refresh
    // once on a cache miss, while bounding untrusted unknown-kid requests to
    // one forced refresh per minute. Never fetch a URL supplied by the token.
    if (!signingKey && generation === before && now() - lastUnknownRefreshAt >= 60000) {
      lastUnknownRefreshAt = now();
      signingKey = (await keys(true)).find(key => key.kid === header.kid);
    }
    if (!signingKey || !crypto.verify('RSA-SHA256', Buffer.from(head + '.' + body), signingKey.key, Buffer.from(signature, 'base64url'))) {
      throw new Error('Invalid backup identity signature');
    }
    // A slow key fetch must not extend the lifetime of an expired token.
    return validateClaims(claims, now());
  };
}

function mountBackupRoutes(app, { getScheduler, logger = console, verifier = createBackupIdentityVerifier() }) {
  const express = require('express');
  let exporting = false;
  async function authorize(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.get('authorization') || '');
    try { req.backupIdentity = await verifier(match?.[1]); next(); }
    catch { res.status(403).json({ error: 'Backup workflow authorization required.' }); }
  }
  app.get('/internal/backups/export', authorize, async (_req, res) => {
    if (exporting) return res.status(409).json({ error: 'Recovery export is already running.' });
    exporting = true;
    try {
      const result = await getScheduler().exportLatest();
      res.set('X-Backup-SHA256', result.sha256);
      res.set('X-Backup-Created-At', result.createdAt);
      res.set('X-Backup-Checkpoint', String(result.checkpoint));
      if (['github-actions', 'github-release'].includes(result.storageProvider)) res.set('X-Backup-Storage-Provider', result.storageProvider);
      if (result.storageProvider === 'github-release' && /^[1-9]\d{0,23}$/.test(result.releaseId || '') && !/\D/.test(result.releaseId)) {
        res.set('X-Backup-Release-Id', result.releaseId);
      }
      res.type('application/octet-stream');
      res.download(result.absolutePath, result.file, error => {
        exporting = false;
        if (error && !res.headersSent) res.status(503).end();
      });
    } catch (error) {
      exporting = false;
      logger.warn('[DATABASE] Offsite export is temporarily unavailable: ' + error.message);
      if (!res.headersSent) res.status(503).json({ error: 'Verified recovery copy is temporarily unavailable.' });
    }
  });
  app.post('/internal/backups/ack', authorize, express.json({ limit: '1kb', inflate: false }), (req, res) => {
    try { res.json(getScheduler().acknowledge({ sha256: req.body?.sha256, artifactId: req.body?.artifactId,
      storageProvider: req.body?.storageProvider, releaseId: req.body?.releaseId, runId: req.backupIdentity.run_id })); }
    catch { res.status(400).json({ error: 'Backup acknowledgment was not accepted.' }); }
  });
}

module.exports = { createBackupIdentityVerifier, validateClaims, mountBackupRoutes, ISSUER, AUDIENCE, REPOSITORY, WORKFLOW };
