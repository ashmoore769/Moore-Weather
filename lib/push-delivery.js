'use strict';

const crypto = require('node:crypto');

// Log only documented provider codes. Response bodies can otherwise contain
// subscription endpoints, keys, request metadata or other private data.
const PROVIDER_REASONS = new Set([
  'BadTtl', 'BadUrgency', 'BadWebPushRequest', 'BadWebPushTopic',
  'VapidPkHashMismatch', 'IdleTimeout', 'BadAuthorizationHeader', 'BadJwtToken',
  'BadVapidPublicKey', 'BadPath', 'MethodNotAllowed', 'PayloadTooLarge',
  'TooManyRequests', 'InternalServerError', 'ServiceUnavailable', 'Shutdown',
  'INVALID_ARGUMENT', 'UNREGISTERED', 'SENDER_ID_MISMATCH',
  'QUOTA_EXCEEDED', 'UNAVAILABLE', 'INTERNAL', 'THIRD_PARTY_AUTH_ERROR'
]);

function pushFailureReason(error) {
  const body = error?.body;
  if (typeof body !== 'string' || body.length > 8192) return null;
  try {
    const parsed = JSON.parse(body);
    const reason = parsed?.reason || parsed?.error?.status;
    return PROVIDER_REASONS.has(reason) ? reason : null;
  } catch { return null; }
}

function encodePushTopic(logicalTopic) {
  if (typeof logicalTopic !== 'string' || logicalTopic.length === 0) {
    throw new TypeError('A nonempty push topic is required.');
  }
  // Send an actual, canonical Base64url value instead of relying on providers
  // accepting a human-readable label that merely uses the same alphabet.
  // Twenty-four digest bytes encode to exactly 32 characters without padding,
  // preserving stable, separate coalescing keys within the Web Push limit.
  return crypto.createHash('sha256').update(logicalTopic, 'utf8')
    .digest().subarray(0, 24).toString('base64url');
}

module.exports = { encodePushTopic, pushFailureReason };
