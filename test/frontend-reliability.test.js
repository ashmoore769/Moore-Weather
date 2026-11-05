'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const quality = require('../public/sensor-quality');
const { parseSummary } = require('../public/daily-summary');
const { nearestPointIndex, bridgeDifference } = require('../public/history-chart');
const policy = require('../config/data-quality.json');
const layout = require('../config/station-layout.json');
const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).find(source => source.includes('function updateWeatherData'));
const now = Date.parse('2026-11-05T04:30:00Z');
const values = () => quality.currentSensors.map(key => key === '7' ? 1000 : key === '6' ? 400 : key === '3' ? 50 : key === '21' ? 13.8 : key === '23' ? 10 : key === '32' ? 0 : 20);
const currentCSV = (time = '14:30:00', v = values()) => ['2026/11/05', time, ...v].join(',');

function browser() {
  const nodes = new Map(), listeners = new Map(), timers = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', dataset: {}, hidden: false, disabled: false, style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, closest() { return this; },
    });
    return nodes.get(id);
  };
  let weather = currentCSV(), failure = false;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    console, Date: Clock, Intl, Event, AbortSignal, WeatherQuality: quality,
    document: { getElementById: node, querySelector: selector => selector === '[data-current-readings]' ? node('weatherData') : null, body: node('body'), addEventListener() {}, hidden: false },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {}, setInterval() {},
    location: { assign() { throw Error('Unexpected redirect'); } },
    fetch: async (url, options) => {
      assert.ok(options.signal, 'network requests must be bounded');
      if (url === '/ping') return { ok: true, json: async () => ({ stationObservedAt: new Date(now).toISOString(), lastWeatherPoll: new Date(now).toISOString() }) };
      if (failure) throw Error('Network unavailable');
      return { ok: true, text: async () => weather };
    },
  });
  context.window = { addEventListener: (type, fn) => listeners.set(type, fn), dispatchEvent: event => listeners.get(event.type)?.() };
  vm.runInContext(script.slice(0, script.indexOf('const SKYCAM_ENDPOINT')), context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/station-shell.js'), 'utf8'), context);
  return { node, context, timers, setWeather: csv => { weather = csv; }, fail: value => { failure = value; }, update: csv => context.updateWeatherData(csv), refresh: () => context.fetchWeather() };
}

test('Current and Daily quality policy stays identical to the archive configuration', () => {
  assert.deepEqual(quality.policy, policy);
  assert.deepEqual(quality.currentSensors, layout.streams.r3.fields.slice(0,29).map(field => field.sensorKey));
  assert.deepEqual(quality.dailySensors, layout.streams.mem1.fields.map(field => field.sensorKey));
  for (const sensor of layout.sensors) assert.deepEqual(quality.sensors[sensor.key], { name: sensor.name, unit: sensor.unit });
  const v = values(); v[3] = -100; v[2] = 101; v[4] = -1; v[5] = -5.1; v[6] = 849; v[20] = -100; v[24] = -1;
  const result = quality.parseCurrent(currentCSV('14:30:00', v));
  for (const i of [2, 3, 4, 5, 6, 20, 24]) assert.equal(result.values[i], null);
  v[3] = -4; v[5] = -2; v[6] = 1000;
  const valid = quality.parseCurrent(currentCSV('14:30:00', v));
  assert.equal(valid.values[3], -4); assert.equal(valid.values[5], 0); assert.equal(valid.values[6], 1000);
  assert.equal(quality.numeric('18junk'), null);
});

test('Daily screens out a faulty aggregate group and retains unrelated valid sensors', () => {
  const v = Array(41).fill(20); v[12] = -100; v[23] = -100; v[34] = 1000; v[35] = 809.2; v[36] = 1010;
  const result = parseSummary(['2026/11/05', '09:00:00', ...v].join(','));
  for (const i of [11, 12, 13, 23, 34, 35, 36]) assert.equal(result.values[i], null);
  assert.equal(result.values[24], 20); assert.equal(result.values[10], 20);
});

test('a successful ping cannot label undisplayed or failed Current readings LIVE', async () => {
  const b = browser();
  await new Promise(setImmediate);
  assert.equal(b.node('statusBadge').textContent, '● CONNECTING');
  assert.equal(b.node('dateVal').textContent, '');
  b.setWeather(currentCSV('13:30:00')); await b.refresh();
  const oldHeader = b.node('timeVal').textContent;
  b.fail(true); await b.refresh();
  assert.equal(b.node('statusBadge').textContent, '● STALE');
  assert.equal(b.node('timeVal').textContent, oldHeader);
  assert.equal(b.node('weatherData').dataset.observedAt, '2026-11-05T13:30:00+10:00');
  assert.match(b.node('currentReadingStatus').textContent, /previous observation/);
  assert.equal(b.node('fetchBtn').disabled, false);
  assert.ok(b.timers.some(timer => timer.delay === 1000));
  b.fail(false); b.setWeather('broken record'); await b.refresh();
  assert.equal(b.node('timeVal').textContent, oldHeader);
  assert.equal(b.node('tempVal').textContent, '20.0°C');
  b.setWeather(currentCSV()); await b.refresh();
  assert.equal(b.node('statusBadge').textContent, '● LIVE');
  assert.equal(b.node('currentReadingStatus').hidden, true);
});

test('a faulty globe or soil sensor never freezes healthy Current readings or creates derived zeroes', async () => {
  const b = browser(), v = values();
  v[3] = 24.5; v[28] = 'NaN'; v[20] = -100; v[24] = -3;
  b.setWeather(currentCSV('14:30:00', v)); await b.refresh();
  assert.equal(b.node('tempVal').textContent, '24.5°C');
  assert.equal(b.node('blackGlobeTempVal').textContent, '--');
  assert.equal(b.node('soilTemp10Val').textContent, '--');
  assert.equal(b.node('moisture10Val').textContent, '--');
  assert.equal(b.node('radiantDiffVal').textContent, '--');
  assert.notEqual(b.node('feelsLikeVal').textContent, '--');
  assert.equal(b.node('pressureVal').textContent, '998.1 hPa');
  assert.equal(b.node('solarPanelVal').textContent, '🌙 0.0 V');
  assert.equal(b.node('statusBadge').textContent, '● PARTIAL');
  assert.match(b.node('currentReadingStatus').textContent, /Black Globe/);
});

test('irregular council observations inspect the nearest actual timestamp', () => {
  const points = [1, 8, 15].map(day => ({ t: Date.UTC(2026, 9, day), value: 50 + day }));
  assert.equal(nearestPointIndex(points, Date.UTC(2026, 9, 8)), 1);
  assert.equal(nearestPointIndex(points, Date.UTC(2026, 9, 7)), 1);
  assert.equal(nearestPointIndex(points, Date.UTC(2026, 8, 1)), 0);
  assert.equal(nearestPointIndex(points, Date.UTC(2026, 10, 1)), 2);
  assert.equal(nearestPointIndex([], now), -1);
});

test('last-valid Warwick readings are stale even when their timestamp is recent', () => {
  const result = bridgeDifference({ value: 6.8, t: now - 60000, lastAvailable: true, latestValueAvailable: false }, { level: 7 }, now);
  assert.equal(result.stale, true);
  assert.equal(result.text, '0.20m (Below Bridge)');
});

function cameraBrowser() {
  const nodes = new Map(), failures = new Set(), attempts = new Map(), hanging = new Set();
  const frames = [
    { id: 'old', url: '/old.jpg', capturedAt: new Date(now - 600000).toISOString() },
    { id: 'new', url: '/new.jpg', capturedAt: new Date(now - 60000).toISOString() },
  ];
  const timers = new Set();
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay === 12000 ? 20 : Math.min(delay, 5));
    timers.add(timer); return timer;
  };
  class ImageNode {
    constructor() {
      this.dataset = {}; this.style = {}; this.listeners = new Map(); this.attributes = new Map();
      this.complete = false; this.naturalWidth = 0; this.textContent = ''; this.classes = new Set();
      this.classList = { add: (...values) => values.forEach(v => this.classes.add(v)), remove: (...values) => values.forEach(v => this.classes.delete(v)) };
    }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    set src(url) {
      this.attributes.set('src', url); this.complete = false; this.naturalWidth = 0;
      attempts.set(url, (attempts.get(url) || 0) + 1);
      if (hanging.has(url)) return;
      queueMicrotask(() => {
        const okay = !failures.has(url); this.complete = true; this.naturalWidth = okay ? 1 : 0;
        for (const callback of [...this.listeners.get(okay ? 'load' : 'error') || []]) callback();
      });
    }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new ImageNode()); return nodes.get(id); };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    console, Date: Clock, Intl, URL, AbortSignal, Image: ImageNode, WeatherQuality: quality,
    document: { getElementById: node, querySelector() { return null; }, addEventListener() {}, baseURI: 'https://fixture.test/' },
    setTimeout: schedule, clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }, setInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ images: frames }) }),
  });
  context.window = { addEventListener() {}, setTimeout: schedule, requestAnimationFrame: fn => queueMicrotask(fn), location: {assign() {}} };
  vm.runInContext(script, context);
  const show = (index, followLive = true) => vm.runInContext(`showSkyCamHistory(${index}, {manual:false,followLive:${followLive},transitionMs:0})`, context);
  const state = () => vm.runInContext('({entry:skycamDisplayedEntry,index:skycamHistoryIndex,layer:skycamImageLayer,loading:skycamImageLoading})', context);
  return { context, node, frames, failures, hanging, attempts, show, state, close: () => { for (const timer of timers) clearTimeout(timer); } };
}

test('SkyCam timestamps commit only after the actual displayed image loads and failed IDs retry', async () => {
  const b = cameraBrowser();
  try {
    await b.context.refreshSkyCam();
    await b.show(0);
    const before = b.node('skycamTime').textContent;
    b.failures.add('/new.jpg');
    assert.equal(await b.show(1), false);
    assert.equal(b.state().entry.id, 'old');
    assert.equal(b.node('skycamTime').textContent, before);
    assert.equal(b.node('skycamBadge').textContent, 'SKYCAM · STALE');
    const previousAttempts = b.attempts.get('/new.jpg');
    await b.context.refreshSkyCam();
    assert.ok(b.attempts.get('/new.jpg') > previousAttempts);
    assert.equal(b.state().entry.id, 'old');
    b.failures.delete('/new.jpg'); await b.context.refreshSkyCam();
    assert.equal(b.state().entry.id, 'new');
    assert.notEqual(b.node('skycamTime').textContent, before);
    assert.equal(b.node('skycamBadge').textContent, 'SKYCAM · LIVE');
    vm.runInContext('Date.now = () => ' + (now + 3600000) + '; updateSkyCamControls();', b.context);
    assert.equal(b.node('skycamBadge').textContent, 'SKYCAM · STALE');
  } finally { b.close(); }
});

test('SkyCam stalled image has a bounded wait and retains its loaded frame', async () => {
  const b = cameraBrowser();
  try {
    await b.context.refreshSkyCam(); await b.show(0);
    b.hanging.add('/new.jpg');
    assert.equal(await b.show(1), false);
    assert.equal(b.state().entry.id, 'old');
    assert.equal(b.state().loading, false);
    assert.match(b.node('skycamPosition').textContent, /image unavailable/);
  } finally { b.close(); }
});

test('a failed historical SkyCam selection retries without relabelling the visible newer frame', async () => {
  const b = cameraBrowser();
  try {
    await b.context.refreshSkyCam();
    b.failures.add('/old.jpg');
    await b.show(0, false);
    assert.equal(b.state().entry.id, 'new');
    b.failures.delete('/old.jpg');
    await b.context.refreshSkyCam();
    assert.equal(b.state().entry.id, 'old');
    assert.equal(b.node('skycamBadge').textContent, 'SKYCAM · HISTORY');
  } finally { b.close(); }
});
