'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const webpush = require('web-push');
const { encodePushTopic, pushFailureReason } = require('../lib/push-delivery');

const topics = ['moore-station-status', 'moore-history-status', 'moore-solar-solar',
  'moore-solar-grid', 'moore-river-near', 'moore-river-cross'];

function assertCanonicalTopic(topic) {
  assert.match(topic, /^[A-Za-z0-9_-]{32}$/);
  const decoded = Buffer.from(topic, 'base64url');
  assert.equal(decoded.length, 24);
  assert.equal(decoded.toString('base64url'), topic);
}

test('every notification family has a distinct stable canonical Web Push topic', () => {
  const encoded = topics.map(encodePushTopic);
  assert.equal(new Set(encoded).size, topics.length);
  for (const [index, topic] of encoded.entries()) {
    assertCanonicalTopic(topic);
    assert.equal(topic, encodePushTopic(topics[index]));
  }
});

test('logical topic length and characters cannot create an invalid transport header', () => {
  for (const logical of ['a', 'solar coverage / grid import', '☀ solar', 'x'.repeat(500)]) {
    assertCanonicalTopic(encodePushTopic(logical));
  }
  for (const invalid of ['', null, undefined, 123, {}, Buffer.from('topic')]) {
    assert.throws(() => encodePushTopic(invalid), /nonempty push topic/);
  }
});

test('actual encrypted Web Push requests carry canonical topics without sending a notification', () => {
  const deviceKey = crypto.createECDH('prime256v1');
  const publicKey = deviceKey.generateKeys().toString('base64url');
  const subscription = { endpoint: 'https://web.push.apple.com/local-test-fixture',
    keys: { p256dh: publicKey, auth: Buffer.alloc(16, 7).toString('base64url') } };
  const options = { TTL: 180, urgency: 'normal',
    vapidDetails: { subject: 'https://moore-weather.onrender.com', ...webpush.generateVAPIDKeys() } };
  for (const logical of topics) {
    const request = webpush.generateRequestDetails(subscription,
      JSON.stringify({ title: 'Local test fixture' }), { ...options, topic: encodePushTopic(logical) });
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.TTL, 180);
    assert.equal(request.headers.Urgency, 'normal');
    assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(request.headers.Topic, encodePushTopic(logical));
    assertCanonicalTopic(request.headers.Topic);
  }
  // The library's alphabet-only validation accepts these raw 17-character
  // labels, even though neither can be decoded and encoded back unchanged.
  for (const logical of ['moore-solar-solar', 'moore-river-cross']) {
    const raw = webpush.generateRequestDetails(subscription, 'fixture', { ...options, topic: logical });
    assert.equal(raw.headers.Topic.length % 4, 1);
    assert.notEqual(Buffer.from(raw.headers.Topic, 'base64url').toString('base64url'), raw.headers.Topic);
  }
});

test('provider failures expose only known reason codes and never raw private details', () => {
  assert.equal(pushFailureReason({ body: '{"reason":"BadWebPushTopic","endpoint":"private"}' }), 'BadWebPushTopic');
  assert.equal(pushFailureReason({ body: '{"error":{"status":"INVALID_ARGUMENT","message":"private"}}' }), 'INVALID_ARGUMENT');
  for (const body of ['{"reason":"private-token"}', 'private-token', '{"reason":{"secret":"private"}}',
    '{"error":{"message":"private"}}', 'x'.repeat(8193), null, undefined]) {
    assert.equal(pushFailureReason({ body }), null);
  }
});
