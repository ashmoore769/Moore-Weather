'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/login.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function screen(provider, enabled = true, copy = async () => {}) {
  const nodes = {}, posts = [];
  for (const id of ['nextPath', 'loginMessage', 'accessRequestForm', 'requestAccessButton', 'requestMessage', 'requestRetry', 'requestContact', 'copyContact', 'requestContactAddress']) {
    nodes[id] = { value: '', hidden: false, disabled: false, textContent: '', dataset: {}, events: {},
      addEventListener(type, fn) { this.events[type] = fn; }, setAttribute() {}, removeAttribute() {} };
  }
  const form = nodes.accessRequestForm;
  form.fields = { name: 'Visitor', email: 'visitor@example.com', website: '' };
  form.reportValidity = () => true;
  form.reset = () => { form.fields = { name: '', email: '', website: '' }; };
  class Data { constructor(form) { this.data = Object.entries(form.fields); } *[Symbol.iterator]() { yield* this.data; } }
  vm.runInNewContext(source, {
    document: { getElementById: id => nodes[id] }, location: { search: '?next=%2Fdaily.html' },
    URLSearchParams, FormData: Data, AbortSignal, navigator: { clipboard: { writeText: copy } },
    fetch: async (url, options) => {
      assert.equal(url, '/api/access-request');
      if (options.method !== 'POST') return { ok: true, json: async () => ({ enabled, retryAfter: 0 }) };
      posts.push(options); return provider(posts.length);
    }
  });
  await flush();
  return { nodes, form, posts, button: nodes.requestAccessButton, feedback: nodes.requestMessage,
    submit: () => form.events.submit({ preventDefault() {} }) };
}

test('one click saves, double-click is suppressed, and success says received without claiming email delivery', async () => {
  let release;
  const ui = await screen(() => new Promise(resolve => { release = resolve; }));
  assert.equal(ui.button.disabled, false);
  const saving = ui.submit();
  assert.equal(ui.button.disabled, true); assert.match(ui.button.textContent, /Saving/);
  await ui.submit(); assert.equal(ui.posts.length, 1);
  assert.equal(ui.form.fields.email, 'visitor@example.com');
  release({ ok: true, status: 202, json: async () => ({ ok: true, message: 'Request received. Your details have been saved.' }) });
  await saving;
  assert.equal(ui.button.textContent, 'Request saved'); assert.equal(ui.button.disabled, true);
  assert.equal(ui.feedback.dataset.kind, ''); assert.match(ui.feedback.textContent, /saved/);
  assert.equal(ui.form.fields.email, ''); assert.equal(ui.nodes.nextPath.value, '/daily.html');
});

test('a storage error keeps entered details and allows retry immediately without a countdown', async () => {
  const ui = await screen(async () => ({ ok: false, status: 503, json: async () => ({ error: 'Could not save your request.' }) }));
  await ui.submit();
  assert.equal(ui.button.disabled, false); assert.equal(ui.button.textContent, 'Request access');
  assert.equal(ui.form.fields.email, 'visitor@example.com'); assert.equal(ui.feedback.dataset.kind, 'error');
  await ui.submit(); assert.equal(ui.posts.length, 2);
});

test('a lost response preserves the form and permits a safe immediate retry of the same request', async () => {
  const ui = await screen(async count => {
    if (count === 1) throw new TypeError('connection lost');
    return { ok: true, status: 202, json: async () => ({ ok: true, message: 'Request received.' }) };
  });
  await ui.submit();
  assert.equal(ui.button.disabled, false); assert.equal(ui.form.fields.email, 'visitor@example.com');
  assert.match(ui.feedback.textContent, /same request will not be added twice/);
  assert.doesNotMatch(ui.feedback.textContent, /five minutes|Try again in/);
  await ui.submit();
  assert.equal(ui.posts.length, 2);
  assert.equal(ui.posts[0].body.toString(), ui.posts[1].body.toString());
  assert.equal(ui.button.textContent, 'Request saved');
});


test('known outage disables requests and exposes contact without opening a mail app', async () => {
  const ui = await screen(async () => { throw Error('Must not submit'); }, false);
  assert.equal(ui.button.disabled, true); assert.equal(ui.nodes.requestContact.hidden, false);
  assert.equal(ui.nodes.requestRetry.hidden, false);
  await ui.submit(); assert.equal(ui.posts.length, 0);
});

test('an outage discovered during submission keeps fields and stops further submissions', async () => {
  const ui = await screen(async () => ({ ok: false, status: 503, json: async () => ({ unavailable: true, error: 'Email unavailable.' }) }));
  await ui.submit();
  assert.equal(ui.form.fields.email, 'visitor@example.com'); assert.equal(ui.button.disabled, true);
  assert.equal(ui.nodes.requestContact.hidden, false); assert.equal(ui.nodes.requestRetry.hidden, false);
  await ui.submit(); assert.equal(ui.posts.length, 1);
});

test('contact copy handles both clipboard success and unavailable clipboard', async () => {
  let copied;
  const ui = await screen(async () => {}, false, async value => { copied = value; });
  ui.nodes.requestContactAddress.textContent = 'ashmoore01@hotmail.com';
  await ui.nodes.copyContact.events.click();
  assert.equal(copied, 'ashmoore01@hotmail.com'); assert.equal(ui.nodes.copyContact.textContent, 'Address copied');
  const blocked = await screen(async () => {}, false, async () => { throw Error('Denied'); });
  await blocked.nodes.copyContact.events.click();
  assert.match(blocked.nodes.copyContact.textContent, /Select and copy/);
});
