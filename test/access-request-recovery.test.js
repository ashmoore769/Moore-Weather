'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestQueue, RETENTION_MS } = require('../lib/access-requests');
const person = { name: 'Visitor', email: 'visitor@example.com' };

function queue(t) {
  const q = new RequestQueue(':memory:');
  t.after(() => q.close());
  return q;
}

test('expired final failed request reopens intake without requiring a worker to succeed', t => {
  const q = queue(t), now = 1000000;
  const old = q.enqueue(person, now);
  q.finish(q.take(now), now, 'network');
  assert.equal(q.availableAt(now), false);
  assert.equal(q.enqueue({ ...person, email: 'next@example.com' }, now + RETENTION_MS - 1).unavailable, true);
  assert.equal(q.availableAt(now + RETENTION_MS), true);
  assert.equal(q.receipt(old.id), undefined);
  const next = q.enqueue({ ...person, email: 'next@example.com' }, now + RETENTION_MS);
  assert.equal(next.accepted, true);
  const item = q.take(now + RETENTION_MS);
  assert.equal(item.id, next.id);
  assert.equal(q.finish(item, now + RETENTION_MS), true);
  assert.equal(q.receipt(next.id).state, 'sent');
});

test('enqueue itself recovers an empty expired outage even without a prior status or worker check', t => {
  const q = queue(t), now = 1000000;
  q.enqueue(person, now); q.finish(q.take(now), now, 'http_403');
  assert.equal(q.enqueue(person, now + RETENTION_MS).accepted, true);
});

test('expiry cannot clear another pending request or shorten a provider Retry-After pause', t => {
  const q = queue(t), now = 1000000;
  q.enqueue(person, now);
  q.enqueue({ ...person, email: 'later@example.com' }, now + 1000);
  q.finish(q.take(now), now, 'network');
  assert.equal(q.availableAt(now + RETENTION_MS), false);
  assert.equal(q.availableAt(now + RETENTION_MS + 1000), true);
  q.enqueue(person, now + RETENTION_MS + 1000);
  const expires = now + 2 * RETENTION_MS + 1000;
  q.finish(q.take(now + RETENTION_MS + 1000), now + RETENTION_MS + 1000, 'http_429', (RETENTION_MS + 60000) / 1000);
  assert.equal(q.availableAt(expires), false);
  assert.equal(q.availableAt(expires + 59999), false);
  assert.equal(q.availableAt(expires + 60000), true);
});

test('retention keeps an active delivery lease until its worker has finished', t => {
  const q = queue(t), now = 1000000;
  q.enqueue(person, now); q.finish(q.take(now), now, 'network');
  const retry = q.take(now + RETENTION_MS - 1000);
  assert.ok(retry);
  assert.equal(q.availableAt(now + RETENTION_MS), false);
  assert.equal(q.finish(retry, now + RETENTION_MS), true);
  assert.equal(q.availableAt(now + RETENTION_MS), true);
});
