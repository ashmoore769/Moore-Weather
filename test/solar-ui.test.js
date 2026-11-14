'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createController } = require('../public/solar');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const NOW = Date.parse('2026-11-14T02:00:00.000Z');
const iso = time => new Date(time).toISOString();
function payload(time = NOW) {
  return { enabled: true, status: 'fresh', timezone: 'Australia/Brisbane', staleAfterSeconds: 180,
    current: { observedAt: iso(time), collectedAt: iso(time), receivedAt: iso(time), pvPowerW: 6000, inverterPowerW: 5700,
      gridPowerW: -2200, loadPowerW: 3500, batteryPowerW: null, batterySocPercent: null, totalAcEnergyWh: 25000000 },
    today: { date: '2026-11-14', energyAcWh: 12340, quality: 'partial', through: iso(time - 5 * 60000), label: 'AC energy recorded since collection began; earlier energy is unavailable.' }, history: null };
}
function fixture(t, initial = payload()) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], { textContent: '', hidden: false, dataset: {}, className: '' }]));
  nodes.get('statusBadge').textContent = 'WEATHER STATUS UNCHANGED';
  const listeners = new Map(), timers = new Map(), requests = [], redirects = [], timeouts = [];
  let clock = NOW, nextTimer = 0, body = initial, status = 200, failure = false, gate = null;
  const doc = { hidden: false, getElementById: id => nodes.get(id),
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  const controller = createController({ document: doc, now: () => clock,
    location: { assign: destination => redirects.push(destination) },
    setTimeout: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout: id => timers.delete(id),
    timeoutSignal: milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const result = structuredClone(body), resultStatus = status, reject = failure, wait = gate;
      if (wait) await wait;
      if (reject) throw new Error('Synthetic network failure');
      return { status: resultStatus, ok: resultStatus >= 200 && resultStatus < 300, json: async () => result };
    },
  });
  t.after(() => controller.stop());
  return { controller, requests, redirects, timers, timeouts, doc,
    node: id => nodes.get(id), setBody: value => { body = value; }, setStatus: value => { status = value; },
    fail: value => { failure = value; }, setTime: value => { clock = value; }, hold: promise => { gate = promise; },
    hidden: value => { doc.hidden = value; listeners.get('visibilitychange')?.(); },
    start: async () => { controller.start(); await new Promise(setImmediate); },
    flush: () => new Promise(setImmediate),
  };
}

test('disabled solar stays hidden; enabled without a reading has an explicit waiting state', async t => {
  const disabled = { ...payload(), enabled: false, status: 'disabled', current: null };
  const f = fixture(t, disabled); await f.start();
  assert.equal(f.node('homeSolar').hidden, true);
  f.setBody({ ...payload(), status: 'waiting', current: null, today: { date: '2026-11-14', quality: 'unavailable', energyAcWh: null, label: 'Waiting for first reading.' } });
  await f.controller.refresh();
  assert.equal(f.node('homeSolar').hidden, false);
  assert.equal(f.node('homeSolar').dataset.state, 'waiting');
  assert.equal(f.node('solarPvPower').textContent, '—');
  assert.equal(f.node('solarTodayEnergy').textContent, '—');
  assert.match(f.node('solarMessage').textContent, /first reading/);
  assert.equal(f.node('statusBadge').textContent, 'WEATHER STATUS UNCHANGED');
});

test('valid night-time zero is shown while null and nonnumeric measurements never become zero', async t => {
  const data = payload(); Object.assign(data.current, { pvPowerW: 0, inverterPowerW: 0, gridPowerW: 0, loadPowerW: null });
  data.today.energyAcWh = 0;
  const f = fixture(t, data); await f.start();
  assert.equal(f.node('solarPvPower').textContent, '0.00 kW');
  assert.equal(f.node('solarAcPower').textContent, '0.00 kW');
  assert.equal(f.node('solarGridPower').textContent, '0.00 kW');
  assert.equal(f.node('solarGridMetric').hidden, false);
  assert.equal(f.node('solarLoadMetric').hidden, true);
  assert.equal(f.node('solarBatteryMetric').hidden, true);
  assert.equal(f.node('solarTodayEnergy').textContent, '0.00 kWh');
  assert.equal(f.node('solarTodayQuality').textContent, 'Partial day');
  data.current.pvPowerW = null; data.current.inverterPowerW = '0'; data.today.energyAcWh = null;
  f.setBody(data); await f.controller.refresh();
  assert.equal(f.node('solarPvPower').textContent, '—');
  assert.equal(f.node('solarAcPower').textContent, '—');
  assert.equal(f.node('solarTodayEnergy').textContent, '—');
  assert.equal(f.node('homeSolar').dataset.state, 'partial');
});

test('DC and AC remain distinct and directional flows use the normalized signs', async t => {
  const data = payload(); data.current.batteryPowerW = -500; data.current.batterySocPercent = 63.5;
  const f = fixture(t, data); await f.start();
  assert.equal(f.node('solarPvPower').textContent, '6.00 kW');
  assert.equal(f.node('solarAcPower').textContent, '5.70 kW');
  assert.equal(f.node('solarGridLabel').textContent, 'Grid export');
  assert.equal(f.node('solarGridPower').textContent, '2.20 kW');
  assert.equal(f.node('solarBatteryLabel').textContent, 'Battery charging');
  assert.equal(f.node('solarBatteryPower').textContent, '0.50 kW');
  assert.equal(f.node('solarBatterySoc').textContent, '63.5% state of charge');
  data.current.gridPowerW = 100; data.current.batteryPowerW = 10;
  f.setBody(data); await f.controller.refresh();
  assert.equal(f.node('solarGridLabel').textContent, 'Grid import');
  assert.equal(f.node('solarBatteryLabel').textContent, 'Battery discharge');
  assert.equal(f.node('solarBatteryPower').textContent, '10 W');
});

test('successful requests cannot disguise old observations, old collection times or server-declared staleness', async t => {
  const data = payload(); data.current.observedAt = iso(NOW - 10 * 60000);
  const f = fixture(t, data); await f.start();
  assert.equal(f.node('homeSolar').dataset.state, 'stale');
  const recent = payload(); recent.current.collectedAt = iso(NOW - 4 * 60000);
  f.setBody(recent); await f.controller.refresh();
  assert.equal(f.node('homeSolar').dataset.state, 'stale');
  f.setBody({ ...payload(), status: 'stale' }); await f.controller.refresh();
  assert.equal(f.node('homeSolar').dataset.state, 'stale');
  f.setBody(payload()); await f.controller.refresh();
  assert.equal(f.node('homeSolar').dataset.state, 'fresh');
  f.setTime(NOW + 181000); f.controller.paint();
  assert.equal(f.node('homeSolar').dataset.state, 'stale');
});

test('failed and malformed updates retain the displayed observation and recover only with a valid reading', async t => {
  const f = fixture(t); await f.start();
  const observed = f.node('solarObserved').textContent;
  f.fail(true); await f.controller.refresh();
  assert.equal(f.node('homeSolar').dataset.state, 'stale');
  assert.equal(f.node('solarPvPower').textContent, '6.00 kW');
  assert.equal(f.node('solarObserved').textContent, observed);
  assert.match(f.node('solarMessage').textContent, /update failed.*retained/);
  f.fail(false); const invalid = payload(); invalid.current.observedAt = 'invalid'; invalid.current.pvPowerW = 9999;
  f.setBody(invalid); await f.controller.refresh();
  assert.equal(f.node('solarPvPower').textContent, '6.00 kW');
  assert.equal(f.node('solarObserved').textContent, observed);
  const recovered = payload(NOW + 60000); recovered.current.pvPowerW = 7000;
  f.setTime(NOW + 60000); f.setBody(recovered); await f.controller.refresh();
  assert.equal(f.node('homeSolar').dataset.state, 'fresh');
  assert.equal(f.node('solarPvPower').textContent, '7.00 kW');
  assert.notEqual(f.node('solarObserved').textContent, observed);
  assert.equal(f.node('solarMessage').hidden, true);
});

test('future source clocks are flagged and never shown as live', async t => {
  const f = fixture(t, payload(NOW + 120000)); await f.start();
  assert.equal(f.node('homeSolar').dataset.state, 'check');
  assert.equal(f.node('solarStatus').textContent, 'CHECK');
  assert.match(f.node('solarMessage').textContent, /clock/);
});

test('daily energy remains qualified, suppresses reset totals and expires at Brisbane midnight', async t => {
  const data = payload(); data.today.quality = 'complete'; data.today.label = 'AC energy recorded from midnight.';
  const f = fixture(t, data); await f.start();
  assert.equal(f.node('solarTodayQuality').textContent, 'From midnight');
  assert.equal(f.node('solarTodayEnergy').textContent, '12.34 kWh');
  assert.match(f.node('solarEnergyThrough').textContent, /Counter through.*11:55:00 AEST/);
  assert.match(f.node('solarObserved').textContent, /12:00:00 AEST/);
  data.today.quality = 'reset'; data.today.label = 'Counter reset; daily energy unavailable.';
  f.setBody(data); await f.controller.refresh();
  assert.equal(f.node('solarTodayEnergy').textContent, '—');
  assert.equal(f.node('solarTodayQuality').textContent, 'Counter reset');
  data.today.quality = 'partial'; data.today.label = '<img src=x onerror=alert(1)>Partial coverage';
  f.setBody(data); await f.controller.refresh();
  assert.equal(f.node('solarTodayNote').textContent, data.today.label, 'server labels are plain text');
  assert.equal(f.node('solarTodayNote').innerHTML, undefined);
  f.setTime(Date.parse('2026-11-14T14:00:01.000Z')); f.controller.paint();
  assert.equal(f.node('solarTodayEnergy').textContent, '—');
  assert.equal(f.node('solarTodayQuality').textContent, 'Unavailable');
  assert.match(f.node('solarTodayNote').textContent, /Waiting for today's readings/);
});

test('polling is bounded, single-flight, local to Render and paused while the tab is hidden', async t => {
  const f = fixture(t); let release;
  f.hold(new Promise(resolve => { release = resolve; })); await f.start();
  await f.controller.refresh(); await f.controller.refresh();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.timeouts, [10000]);
  assert.equal(f.requests[0].url, '/api/solar');
  assert.equal(f.requests[0].options.cache, 'no-store');
  assert.ok(f.requests[0].options.signal instanceof AbortSignal);
  f.hidden(true); release(); await f.flush();
  assert.equal(f.timers.size, 0);
  await f.controller.refresh(); assert.equal(f.requests.length, 1);
  f.hold(null); f.hidden(false); await f.flush();
  assert.equal(f.requests.length, 2);
  assert.deepEqual([...f.timers.values()].map(timer => timer.milliseconds).sort((a, b) => a - b), [15000, 60000]);
});

test('expired authentication hides private values, redirects once and stops polling', async t => {
  const f = fixture(t); await f.start(); f.setStatus(401); await f.controller.refresh();
  assert.deepEqual(f.redirects, ['/login']);
  assert.equal(f.node('homeSolar').hidden, true);
  assert.equal(f.timers.size, 0);
  const count = f.requests.length; await f.controller.refresh(); assert.equal(f.requests.length, count);
});

test('solar assets and labels stay separate from existing weather and station measurements', () => {
  assert.equal(html, fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'));
  assert.match(html, /src="\/solar\.js\?v=1"/);
  assert.match(html, /href="\/solar\.css\?v=1"/);
  assert.match(html, /PV generation · DC/); assert.match(html, /Inverter output · AC/);
  assert.match(html, /AC energy recorded today/);
  assert.match(html, /Solar radiation<\/span><span class="value" id="solarRadVal"/);
  assert.match(html, /Solar panel<\/span><span class="metric-value" id="solarPanelVal"/);
  assert.ok(html.indexOf('id="homeSolar"') < html.indexOf('aria-label="Station power and maintenance"'));
});
