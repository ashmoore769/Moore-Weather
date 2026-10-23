'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

function element() {
  return { hidden: true, disabled: false, textContent: '', dataset: {}, attributes: {}, events: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    addEventListener(type, fn) { this.events[type] = fn; } };
}

function theme(saved = {}, blocked = false) {
  const root = { dataset: {} }, meta = {}, button = element(), ready = {};
  vm.runInNewContext(source('theme.js'), {
    localStorage: {
      getItem(key) { if (blocked) throw Error('Storage blocked'); return saved[key] ?? null; },
      setItem(key, value) { if (blocked) throw Error('Storage blocked'); saved[key] = value; }
    },
    document: { documentElement: root, querySelector: () => meta,
      getElementById: id => id === 'themeToggleBtn' ? button : null,
      addEventListener(type, fn) { ready[type] = fn; } }
  });
  // Check the theme before DOMContentLoaded too: this avoids a light first paint.
  const initial = root.dataset.theme;
  ready.DOMContentLoaded();
  return { root, meta, button, saved, initial, toggle: () => button.events.click() };
}

test('new visitors, legacy light defaults and invalid preferences start dark before page content', () => {
  for (const saved of [{}, { mooreWeatherThemeVersion: '3', mooreWeatherTheme: 'light' },
    { mooreWeatherThemeVersion: '4', mooreWeatherTheme: 'invalid' }]) {
    const ui = theme(saved);
    assert.equal(ui.initial, 'dark'); assert.equal(ui.root.dataset.theme, 'dark');
    assert.equal(ui.meta.content, '#0b1119');
    assert.equal(ui.button.attributes['aria-label'], 'Switch to light theme');
  }
});

test('an explicit light or dark choice survives navigation and reloads', () => {
  const ui = theme(); ui.toggle();
  assert.equal(ui.root.dataset.theme, 'light');
  const nextPage = theme(ui.saved); assert.equal(nextPage.initial, 'light');
  nextPage.toggle(); assert.equal(theme(ui.saved).initial, 'dark');
});

test('blocked browser storage still gives a working dark default and theme switch', () => {
  const ui = theme({}, true); assert.equal(ui.initial, 'dark');
  ui.toggle(); assert.equal(ui.root.dataset.theme, 'light');
});

function help({ ua = '', platform = '', touch = 0, installed = false, clipboard, secure = false } = {}) {
  const ids = ['installAction', 'installAppButton', 'installStatus', 'installPlatforms', 'install-ios',
    'install-android', 'install-desktop', 'installBrowserNote', 'installAddress', 'copyInstallAddress', 'installCopyStatus'];
  const nodes = Object.fromEntries(ids.map(id => [id, element()]));
  const controls = ['ios', 'android', 'desktop'].map(name => Object.assign(element(), { dataset: { platform: name } }));
  const events = {}, registrations = [], media = { matches: installed, addEventListener(type, fn) { this[type] = fn; } };
  vm.runInNewContext(source('install-help.js'), {
    document: { getElementById: id => nodes[id], querySelectorAll: () => controls },
    navigator: { userAgent: ua, platform, maxTouchPoints: touch, clipboard,
      serviceWorker: { register: async url => { registrations.push(url); } } },
    location: { href: 'https://moore-weather.onrender.com/help.html?next=private' }, URL,
    window: { matchMedia: () => media, isSecureContext: secure, addEventListener(type, fn) { events[type] = fn; } }
  });
  return { nodes, controls, events, media, registrations,
    click: () => nodes.installAppButton.events.click(),
    offer(prompt, userChoice) { let prevented = false;
      events.beforeinstallprompt({ preventDefault() { prevented = true; }, prompt, userChoice });
      assert.equal(prevented, true);
    } };
}

test('help selects iPhone, desktop-mode iPad, Android and computer instructions and permits switching', () => {
  for (const [options, expected] of [[{ ua: 'iPhone' }, 'ios'], [{ platform: 'MacIntel', touch: 5 }, 'ios'],
    [{ ua: 'Android Chrome' }, 'android'], [{ ua: 'Windows Chrome' }, 'desktop']]) {
    const ui = help(options);
    assert.equal(ui.nodes['install-' + expected].hidden, false);
    assert.equal(ui.controls.find(x => x.dataset.platform === expected).attributes['aria-pressed'], 'true');
    ui.controls[0].events.click();
    assert.equal(ui.nodes['install-ios'].hidden, false); assert.equal(ui.nodes['install-desktop'].hidden, true);
  }
});

test('native installation waits for a click, suppresses double clicks and confirms only browser events', async () => {
  const ui = help({ secure: true }); let release, count = 0;
  assert.deepEqual(ui.registrations, ['/sw.js']);
  assert.equal(ui.nodes.installAction.hidden, true);
  ui.offer(() => { count++; return new Promise(resolve => { release = resolve; }); });
  assert.equal(count, 0); assert.equal(ui.nodes.installAction.hidden, false);
  const pending = ui.click(); await ui.click();
  assert.equal(count, 1); assert.equal(ui.nodes.installAppButton.disabled, true);
  release({ outcome: 'accepted' }); await pending;
  assert.match(ui.nodes.installStatus.textContent, /browser is adding/);
  assert.equal(ui.nodes.installAction.hidden, true);
  ui.events.appinstalled(); assert.match(ui.nodes.installStatus.textContent, /has been added/);
});

test('a dismissed or failed install leaves the manual instructions available', async () => {
  const ui = help();
  ui.offer(async () => undefined, Promise.resolve({ outcome: 'dismissed' }));
  await ui.click(); assert.match(ui.nodes.installStatus.textContent, /later/);
  assert.equal(ui.nodes['install-desktop'].hidden, false);
  ui.offer(async () => { throw Error('Browser rejected prompt'); });
  await ui.click(); assert.match(ui.nodes.installStatus.textContent, /steps below/);
  assert.equal(ui.nodes.installAppButton.disabled, false);
});

test('installed apps suppress late install prompts and pending results cannot overwrite installed status', async () => {
  const installed = help({ installed: true });
  installed.offer(() => { throw Error('Must not prompt'); }); await installed.click();
  assert.equal(installed.nodes.installAction.hidden, true);
  assert.match(installed.nodes.installStatus.textContent, /already opening/);
  const ui = help(); let release;
  ui.offer(() => new Promise(resolve => { release = resolve; }));
  const pending = ui.click(); ui.events.appinstalled();
  release({ outcome: 'accepted' }); await pending;
  assert.match(ui.nodes.installStatus.textContent, /has been added/);
});

test('embedded browsers explain how to open the site and copying excludes private paths and query strings', async () => {
  let copied;
  const ui = help({ ua: 'iPhone Instagram', clipboard: { writeText: async value => { copied = value; } } });
  assert.equal(ui.nodes.installBrowserNote.hidden, false);
  await ui.nodes.copyInstallAddress.events.click();
  assert.equal(copied, 'https://moore-weather.onrender.com/');
  assert.match(ui.nodes.installCopyStatus.textContent, /Address copied/);
  const blocked = help(); await blocked.nodes.copyInstallAddress.events.click();
  assert.match(blocked.nodes.installCopyStatus.textContent, /Select the address/);
});
