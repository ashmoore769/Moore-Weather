'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/analytics.js'), 'utf8');
class Hub {
  constructor() { this.listeners = {}; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
}
function boot(options = {}) {
  let now = 0, timerId = 0;
  const timers = new Map(), values = new Map(options.excluded ? [['umami.disabled', '1']] : []);
  const calls = [], scripts = [];
  const button = new Hub(); button.attributes = {}; button.setAttribute = (k, v) => button.attributes[k] = v;
  const status = {};
  const document = new Hub();
  Object.assign(document, {
    visibilityState: options.hidden ? 'hidden' : 'visible',
    referrer: options.referrer || 'https://example.org/private?email=do-not-send#secret',
    getElementById: id => id === 'analyticsExclude' ? button : id === 'analyticsStatus' ? status : null,
    createElement: () => ({ attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, remove() { this.removed = true; } }),
    head: { append: script => scripts.push(script) }
  });
  const win = new Hub();
  const context = Object.assign(win, {
    window: win, document, location: new URL(options.url || 'https://moore-weather.onrender.com/?email=private#secret'),
    navigator: { doNotTrack: options.dnt, globalPrivacyControl: options.gpc },
    URL, Promise, performance: { now: () => now },
    localStorage: {
      getItem: key => { if (options.storageFails) throw Error('blocked'); return values.get(key) || null; },
      setItem: (key, value) => { if (options.storageFails) throw Error('blocked'); values.set(key, value); },
      removeItem: key => { if (options.storageFails) throw Error('blocked'); values.delete(key); }
    },
    setInterval: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id)
  });
  vm.runInNewContext(source, context, { filename: 'analytics.js' });
  function load() {
    context.umami = { track(name, data) {
      const raw = { website: 'wrong', hostname: 'wrong', url: context.location.href,
        title: 'private dynamic title', referrer: document.referrer, screen: '393x852', language: 'en-AU',
        id: 'never-send', email: 'never-send', password: 'never-send' };
      if (name) { raw.name = name; raw.data = data; }
      const clean = context.mooreAnalyticsBeforeSend('event', raw);
      if (clean) calls.push(JSON.parse(JSON.stringify(clean)));
      return Promise.resolve();
    }};
    scripts.at(-1).onload();
  }
  function tick(ms) { now += ms; for (const fn of [...timers.values()]) fn(); }
  function advance(ms) { while (ms > 0) { const step = Math.min(ms, 15000); tick(step); ms -= step; } }
  function visibility(state) { document.visibilityState = state; document.emit('visibilitychange'); }
  return { context, document, button, status, scripts, calls, values, timers, load, tick, advance, visibility };
}
test('production pages use one tracker and strip all private URL and payload fields', () => {
  const a = boot({ url: 'https://moore-weather.onrender.com/login?next=%2Fprivate&email=secret#token' });
  assert.equal(a.scripts.length, 1);
  assert.equal(a.scripts[0].src, 'https://cloud.umami.is/script.js');
  assert.equal(a.scripts[0].attributes['data-website-id'], 'cc26784e-27b2-48ef-80d6-a6da05212489');
  a.load();
  assert.equal(a.calls.length, 1);
  assert.deepEqual(a.calls[0], { website: 'cc26784e-27b2-48ef-80d6-a6da05212489',
    hostname: 'moore-weather.onrender.com', url: '/login', title: 'Moore Weather · Sign in',
    referrer: 'https://example.org', screen: '393x852', language: 'en-AU' });
  assert.equal(a.context.mooreAnalyticsBeforeSend('identify', { id: 'secret' }), false);
});
test('local, staging, unknown pages, excluded devices and privacy signals never load the provider', () => {
  for (const options of [{ url: 'http://localhost/' }, { url: 'https://preview.onrender.com/' },
    { url: 'https://moore-weather.onrender.com/api/water' }, { excluded: true }, { dnt: '1' }, { gpc: true }]) {
    const a = boot(options);
    a.context.mooreAnalytics.track('radar-playback');
    assert.equal(a.scripts.length, 0);
    assert.equal(a.calls.length, 0);
  }
});
test('feature events queue until ready and accept only named features and measurements', () => {
  const a = boot();
  a.context.mooreAnalytics.track('history-open', { measurement: 'rain', email: 'secret' });
  a.context.mooreAnalytics.track('history-open', { measurement: 'rain' }); // Double-tap.
  a.context.mooreAnalytics.track('history-open', { measurement: 'secret-email@example.org' });
  a.context.mooreAnalytics.track('password', { value: 'secret' });
  a.load();
  assert.equal(a.calls.length, 2);
  assert.equal(a.calls[1].name, 'history-open');
  assert.deepEqual(a.calls[1].data, { measurement: 'rain' });
  a.context.mooreAnalytics.track('history-measurement', { measurement: 'condamine-warwick-level' });
  assert.equal(a.calls.at(-1).data.measurement, 'condamine-warwick-level');
});
test('visible time flushes at five minutes, excludes background time, and does not double-count pagehide', () => {
  const a = boot(); a.load();
  a.advance(300000);
  assert.deepEqual(a.calls.filter(c => c.name === 'visible-time').map(c => c.data.seconds), [300]);
  a.advance(30000); a.visibility('hidden');
  a.context.emit('pagehide');
  a.advance(600000);
  a.visibility('visible'); a.advance(15000); a.visibility('hidden');
  assert.deepEqual(a.calls.filter(c => c.name === 'visible-time').map(c => c.data.seconds), [300, 30, 15]);
});
test('sleep gaps and hidden initial loads do not become recorded usage', () => {
  const a = boot({ hidden: true }); a.load();
  a.advance(120000); a.visibility('visible');
  a.tick(3600000); // Suspended browser/computer.
  a.advance(15000); a.visibility('hidden');
  assert.deepEqual(a.calls.filter(c => c.name === 'visible-time').map(c => c.data.seconds), [15]);
});
test('back-forward restoration counts a new pageview and resumes timing once', () => {
  const a = boot(); a.load(); a.advance(15000); a.context.emit('pagehide');
  a.tick(3600000); a.context.emit('pageshow', { persisted: true });
  a.advance(15000); a.visibility('hidden');
  assert.equal(a.calls.filter(c => !c.name).length, 2);
  assert.deepEqual(a.calls.filter(c => c.name === 'visible-time').map(c => c.data.seconds), [15, 15]);
});
test('exclude control persists the standard flag and immediately stops collection in all open tabs', () => {
  const a = boot(); a.load(); a.advance(15000);
  a.button.emit('click');
  assert.equal(a.values.get('umami.disabled'), '1');
  assert.equal(a.timers.size, 0);
  a.context.mooreAnalytics.track('skycam-download');
  a.visibility('hidden');
  assert.equal(a.calls.length, 1);
  assert.match(a.status.textContent, /excluded/);
  a.button.emit('click');
  assert.equal(a.values.has('umami.disabled'), false);
  assert.equal(a.calls.filter(c => !c.name).length, 2);
  a.values.set('umami.disabled', '1');
  a.context.emit('storage', { key: 'umami.disabled' });
  assert.equal(a.timers.size, 0);
  assert.equal(a.context.mooreAnalyticsBeforeSend('event', {}), false);
});
test('excluding while the script loads prevents even the initial pageview', () => {
  const a = boot(); a.button.emit('click'); a.load();
  assert.equal(a.calls.length, 0);
  assert.equal(a.timers.size, 0);
});
test('storage and tracker failures cannot break the page; an unsaved exclusion is clearly labelled', async () => {
  const a = boot({ storageFails: true }); a.load(); a.button.emit('click');
  assert.match(a.status.textContent, /could not save/);
  assert.equal(a.context.mooreAnalyticsBeforeSend('event', {}), false);
  const b = boot(); b.scripts[0].onerror(); assert.equal(b.scripts[0].removed, true);
  const c = boot(); c.load(); c.context.umami.track = () => Promise.reject(Error('blocked'));
  c.context.mooreAnalytics.track('radar-reset'); await new Promise(resolve => setImmediate(resolve));
});
test('control clicks and a committed radar slider change record usage without values or coordinates', () => {
  const a = boot(); a.load();
  a.document.emit('click', { target: { closest: () => ({ id: 'skycamDownload', disabled: false }) } });
  a.document.emit('click', { target: { closest: () => ({ id: 'radarPlay', disabled: true }) } });
  a.document.emit('change', { target: { id: 'radarSlider', disabled: false, value: 'private' } });
  assert.deepEqual(a.calls.filter(c => c.name).map(c => c.name), ['skycam-download', 'radar-timeline']);
  assert.ok(a.calls.every(c => !c.data));
});
test('internal referrers are canonical and unknown/private paths are dropped', () => {
  for (const [input, expected] of [
    ['https://moore-weather.onrender.com/index.html?token=private#private', '/'],
    ['https://moore-weather.onrender.com/private-token', ''],
    ['javascript:alert(1)', '']
  ]) {
    const a = boot({ referrer: input }); a.load(); assert.equal(a.calls[0].referrer, expected);
  }
});
test('every shipped page and root mirror has exactly one early analytics loader', () => {
  const root = path.join(__dirname, '..');
  for (const name of ['index', 'daily', 'forecast', 'login', 'help']) {
    const publicHtml = fs.readFileSync(path.join(root, 'public', name + '.html'), 'utf8');
    assert.equal(publicHtml, fs.readFileSync(path.join(root, name + '.html'), 'utf8'));
    assert.equal((publicHtml.match(/src="\/analytics.js\?v=1"/g) || []).length, 1);
    assert.ok(publicHtml.indexOf('/analytics.js?v=1') < publicHtml.indexOf('</head>'));
  }
});
