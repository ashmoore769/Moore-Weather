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

function theme(saved = {}, { blocked = false, prefersDark = false, hasMeta = true } = {}) {
  const root = { dataset: {}, style: {} }, meta = {}, ready = {}, windowEvents = {};
  const media = { matches: prefersDark, events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  vm.runInNewContext(source('theme.js'), {
    localStorage: {
      getItem(key) { if (blocked) throw Error('Storage blocked'); return saved[key] ?? null; },
      setItem(key, value) { if (blocked) throw Error('Storage blocked'); saved[key] = value; }
    },
    document: { documentElement: root, querySelector: () => hasMeta ? meta : null,
      addEventListener(type, fn) { ready[type] = fn; } },
    window: { matchMedia: () => media, addEventListener(type, fn) { windowEvents[type] = fn; } }
  });
  // Check the theme before DOMContentLoaded too: this avoids a light first paint.
  const initial = { theme: root.dataset.theme, scheme: root.style.colorScheme, chrome: meta.content };
  ready.DOMContentLoaded();
  return { root, meta, saved, initial,
    changeSystem(matches) { media.matches = matches; media.events.change?.({ matches }); },
    changeSavedTheme(value) {
      saved.mooreWeatherTheme = value;
      windowEvents.storage?.({ key: 'mooreWeatherTheme', newValue: value });
    } };
}

test('all saved preferences and system appearances paint dark before page content', () => {
  for (const saved of [{}, { mooreWeatherThemeVersion: '3', mooreWeatherTheme: 'light' },
    { mooreWeatherThemeVersion: '4', mooreWeatherTheme: 'light' },
    { mooreWeatherThemeVersion: '4', mooreWeatherTheme: 'dark' },
    { mooreWeatherThemeVersion: '5', mooreWeatherTheme: 'light' },
    { mooreWeatherThemeVersion: '4', mooreWeatherTheme: 'invalid' }]) {
    for (const prefersDark of [false, true]) {
      const ui = theme({ ...saved }, { prefersDark });
      assert.deepEqual(ui.initial, { theme: 'dark', scheme: 'dark', chrome: '#0d1722' });
      assert.equal(ui.root.dataset.theme, 'dark');
      assert.equal(ui.root.dataset.themeMode, 'dark');
      assert.equal(ui.saved.mooreWeatherTheme, 'dark');
      assert.equal(ui.saved.mooreWeatherThemeVersion, '5');
    }
  }
});

test('system and old-tab preference changes cannot switch the page or next navigation to light', () => {
  const ui = theme({}, { prefersDark: true });
  ui.changeSystem(false);
  ui.changeSavedTheme('light');
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.root.style.colorScheme, 'dark');
  const nextPage = theme(ui.saved);
  assert.equal(nextPage.initial.theme, 'dark');
  assert.equal(nextPage.saved.mooreWeatherTheme, 'dark');
});

test('blocked browser storage keeps the dark palette and browser controls without errors', () => {
  for (const prefersDark of [false, true]) {
    const ui = theme({ mooreWeatherTheme: 'light' }, { blocked: true, prefersDark });
    assert.equal(ui.initial.theme, 'dark');
    assert.equal(ui.root.style.colorScheme, 'dark');
    assert.equal(ui.meta.content, '#0d1722');
  }
});

test('dark mode also initializes in a page without browser theme metadata', () => {
  const ui = theme({}, { hasMeta: false });
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.root.style.colorScheme, 'dark');
});

test('all Moore Weather pages start dark without a theme switch and use matching release assets', () => {
  for (const name of ['index', 'daily', 'forecast', 'help', 'login', 'terminal']) {
    const html = source(name + '.html');
    assert.ok(/<html\b[^>]*data-theme="dark"/.test(html), name + ' starts dark');
    assert.ok(/<meta\b(?=[^>]*name="color-scheme")(?=[^>]*content="dark")[^>]*>/.test(html), name + ' declares a dark color scheme');
    assert.ok(/<meta\b(?=[^>]*name="theme-color")(?=[^>]*content="#0d1722")[^>]*>/.test(html), name + ' preserves browser theme color');
    assert.ok(/<script src="\/theme\.js\?v=6"><\/script>/.test(html), name + ' uses the current theme bootstrap');
    assert.ok(!/id="themeToggle(?:Btn|Icon|Label)"/.test(html), name + ' has no theme toggle');
    assert.equal(html, fs.readFileSync(path.join(__dirname, '..', name + '.html'), 'utf8'), name + ' root mirror');
  }
  assert.equal(source('theme.js'), fs.readFileSync(path.join(__dirname, '../theme.js'), 'utf8'));
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
