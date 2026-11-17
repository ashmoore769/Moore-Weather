'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createController, liveView } = require('../public/solar');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const NOW = Date.parse('2026-11-14T02:00:00.000Z');
const iso = time => new Date(time).toISOString();
function payload(time = NOW) {
  return { enabled: true, status: 'fresh', timezone: 'Australia/Brisbane', staleAfterSeconds: 180,
    current: { observedAt: iso(time), collectedAt: iso(time), receivedAt: iso(time), pvPowerW: 6000, inverterPowerW: 5700,
      gridPowerW: -2200, loadPowerW: 3500, batteryPowerW: null, batterySocPercent: null, totalAcEnergyWh: 25000000, meterLocation: 'grid' },
    today: { date: '2026-11-14', energyAcWh: 12340, quality: 'partial', through: iso(time - 5 * 60000), label: 'AC energy recorded since collection began; earlier energy is unavailable.' }, history: { points: [{ observedAt: iso(time), inverterPowerW: 5700, loadPowerW: 3500, gridImportPowerW: 0, gridExportPowerW: 2200 }] },
    rates: { currency: 'AUD', effectiveFrom: '2026-07-01', importPerKwh: .288948, exportPerKwh: .06006, supplyPerDay: 1.805078 },
    energy: { today: { date: '2026-11-14', quality: 'partial', coveragePercent: 20, gridImportWh: 1000, gridExportWh: 3000, importCost: .288948, exportCredit: .18018, supplyCost: 1.805078, netCost: 1.913846, since: iso(time - 600000), through: iso(time) }, days: [] } };
}
function fixture(t, initial = payload(), options = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], { textContent: '', hidden: false, dataset: {}, className: '', style: {}, attributes: {}, listeners: {}, setAttribute(name, value) { this.attributes[name] = String(value); }, addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener(name) { delete this.listeners[name]; }, focus() { doc.activeElement = this; } }]));
  nodes.get('statusBadge').textContent = 'WEATHER STATUS UNCHANGED';
  nodes.get('homeSolar').hidden = true;
  nodes.get('solarChartPlot').getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 190 });
  const listeners = new Map(), windowListeners = new Map(), timers = new Map(), requests = [], redirects = [], timeouts = [], scrolls = [];
  nodes.get('homeSolar').scrollIntoView = options => scrolls.push({ ...options, hidden: nodes.get('homeSolar').hidden });
  const location = { hash: options.hash || '', assign: destination => redirects.push(destination) };
  const window = { addEventListener: (name, handler) => windowListeners.set(name, handler), removeEventListener: name => windowListeners.delete(name) };
  let clock = NOW, nextTimer = 0, body = initial, status = 200, failure = false, gate = null;
  const doc = { hidden: false, getElementById: id => nodes.get(id),
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  const controller = createController({ document: doc, now: () => clock,
    location, window,
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
  return { controller, requests, redirects, timers, timeouts, scrolls, doc,
    node: id => nodes.get(id), fire: (id, name, event = {}) => nodes.get(id).listeners[name]?.(event), setBody: value => { body = value; }, setStatus: value => { status = value; },
    fail: value => { failure = value; }, setTime: value => { clock = value; }, hold: promise => { gate = promise; },
    hidden: value => { doc.hidden = value; listeners.get('visibilitychange')?.(); },
    hash: value => { location.hash = value; windowListeners.get('hashchange')?.(); },
    start: async () => { controller.start(); await new Promise(setImmediate); },
    flush: () => new Promise(setImmediate),
  };
}

test('a solar notification waits for the visible card and navigates once without stealing focus', async t => {
  const f = fixture(t, payload(), { hash: '#homeSolar' });
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  f.doc.activeElement = f.node('stationAlertsBtn');
  await f.start();
  assert.equal(f.scrolls.length, 0, 'do not navigate before the solar response enables the card');
  release(); await f.flush();
  assert.deepEqual(f.scrolls, [{ block: 'start', behavior: 'instant', hidden: false }]);
  assert.equal(f.doc.activeElement, f.node('stationAlertsBtn'));
  f.hold(null);
  await f.controller.refresh(); f.controller.paint();
  f.setTime(NOW + 60000); f.setBody(payload(NOW + 60000)); await f.controller.refresh();
  assert.equal(f.scrolls.length, 1, 'normal polling and age paints never jump back to the card');
});

test('explicit solar fragment navigation works after load and is cancelled when navigating elsewhere', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.scrolls.length, 0);
  f.hash('#homeSolar'); assert.equal(f.scrolls.length, 1);
  f.hash('#localWater'); await f.controller.refresh(); assert.equal(f.scrolls.length, 1);
  f.hash('#homeSolar'); assert.equal(f.scrolls.length, 2);
  f.controller.stop(); f.hash('#homeSolar'); assert.equal(f.scrolls.length, 2, 'stop removes the fragment listener');

  const waiting = fixture(t, payload(), { hash: '#homeSolar' });
  let release;
  waiting.hold(new Promise(resolve => { release = resolve; })); await waiting.start();
  waiting.hash('#localWater'); release(); await waiting.flush();
  assert.equal(waiting.scrolls.length, 0, 'a slow response does not undo later navigation');
});

test('disabled or background solar targets wait until the requested card is visible', async t => {
  const f = fixture(t, { ...payload(), enabled: false, status: 'disabled', current: null }, { hash: '#homeSolar' });
  await f.start(); assert.equal(f.scrolls.length, 0);
  f.setBody(payload()); f.hidden(true);
  await f.controller.refresh(); assert.equal(f.scrolls.length, 0);
  f.hidden(false); await f.flush();
  assert.deepEqual(f.scrolls, [{ block: 'start', behavior: 'instant', hidden: false }]);
});

test('disabled solar stays hidden; enabled without a reading has an explicit waiting state', async t => {
  const disabled = { ...payload(), enabled: false, status: 'disabled', current: null };
  const f = fixture(t, disabled); await f.start();
  assert.equal(f.node('homeSolar').hidden, true);
  f.setBody({ ...payload(), status: 'waiting', current: null, today: { date: '2026-11-14', quality: 'unavailable', energyAcWh: null, label: 'Waiting for first reading.' } });
  await f.controller.refresh();
  assert.equal(f.node('homeSolar').hidden, false);
  assert.equal(f.node('homeSolar').dataset.state, 'waiting');
  assert.equal(f.node('solarPvPower').textContent, '–');
  assert.equal(f.node('solarTodayEnergy').textContent, '–');
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
  assert.equal(f.node('solarLoadPower').textContent, '–');
  assert.equal(f.node('solarBatteryMetric').hidden, true);
  assert.equal(f.node('solarTodayEnergy').textContent, '0.00 kWh');
  assert.equal(f.node('solarTodayQuality').textContent, 'Partial');
  data.current.pvPowerW = null; data.current.inverterPowerW = '0'; data.today.energyAcWh = null;
  f.setBody(data); await f.controller.refresh();
  assert.equal(f.node('solarPvPower').textContent, '–');
  assert.equal(f.node('solarAcPower').textContent, '–');
  assert.equal(f.node('solarTodayEnergy').textContent, '–');
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
  assert.match(f.node('solarMessage').textContent, /update failed.*retained/i);
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
  assert.equal(f.node('solarTodayQuality').textContent, 'From 00:00');
  assert.equal(f.node('solarTodayEnergy').textContent, '12.34 kWh');
  assert.match(f.node('solarEnergyThrough').textContent, /Counter through.*11:55:00 AEST/);
  assert.match(f.node('solarObservedDetail').textContent, /12:00:00 AEST/);
  data.today.quality = 'reset'; data.today.label = 'Counter reset; daily energy unavailable.';
  f.setBody(data); await f.controller.refresh();
  assert.equal(f.node('solarTodayEnergy').textContent, '–');
  assert.equal(f.node('solarTodayQuality').textContent, 'Reset');
  data.today.quality = 'partial'; data.today.label = '<img src=x onerror=alert(1)>Partial coverage';
  f.setBody(data); await f.controller.refresh();
  assert.equal(f.node('solarTodayNote').textContent, data.today.label, 'server labels are plain text');
  assert.equal(f.node('solarTodayNote').innerHTML, undefined);
  f.setTime(Date.parse('2026-11-14T14:00:01.000Z')); f.controller.paint();
  assert.equal(f.node('solarTodayEnergy').textContent, '–');
  assert.equal(f.node('solarTodayQuality').textContent, '–');
  assert.match(f.node('solarTodayNote').textContent, /Waiting for today's readings/);
});

test('polling is bounded, single-flight, local to Render and paused while the tab is hidden', async t => {
  const f = fixture(t); let release;
  f.hold(new Promise(resolve => { release = resolve; })); await f.start();
  await f.controller.refresh(); await f.controller.refresh();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.timeouts, [10000]);
  assert.equal(f.requests[0].url, '/api/solar?history=today');
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
  assert.match(html, /src="\/solar\.js\?v=5"/);
  assert.match(html, /href="\/solar\.css\?v=4"/);
  assert.match(html, /PV generation · DC/); assert.match(html, /Solar · AC/);
  assert.match(html, /Generated/);
  assert.match(html, /Solar radiation<\/span><span class="value" id="solarRadVal"/);
  assert.match(html, /Solar panel<\/span><span class="metric-value" id="solarPanelVal"/);
  const cards = ['localWater', 'homeSolar', 'stationPower', 'yardPower'].map(id => html.indexOf('id="' + id + '"'));
  assert.ok(cards.every((position, i) => position >= 0 && (!i || position > cards[i - 1])), 'power cards follow local water in reading order');
});


test('live guidance uses measured grid flow and AC output, with correct directional dollars', () => {
  const data = payload();
  const good = liveView(data.current, data.rates, true);
  assert.equal(good.tone, 'surplus'); assert.equal(good.value, 2200);
  assert.equal(good.coverage, 100); assert.match(good.money, /\$0.13\/hr/);
  data.current.gridPowerW = 1000; data.current.loadPowerW = 6700;
  const bought = liveView(data.current, data.rates, true);
  assert.equal(bought.tone, 'import'); assert.equal(bought.value, 1000);
  assert.ok(Math.abs(bought.coverage - 5700 / 6700 * 100) < 1e-9);
  assert.match(bought.money, /\$0.29\/hr/);
  data.current.pvPowerW = 9000;
  assert.deepEqual(liveView(data.current, data.rates, true), bought, 'DC is not usable home power');
});

test('stale, missing meters, active batteries and resting solar do not claim spare solar', () => {
  const data = payload();
  const old = liveView(data.current, data.rates, false);
  assert.equal(old.value, null); assert.equal(old.coverage, null); assert.equal(old.tone, 'neutral');
  for (const patch of [{ gridPowerW: null }, { meterLocation: 'load' }, { loadPowerW: -10 }]) {
    const view = liveView({ ...data.current, ...patch }, data.rates, true);
    assert.equal(view.coverage, null); assert.equal(view.value, null);
  }
  const battery = liveView({ ...data.current, batteryPowerW: 2000 }, data.rates, true);
  assert.equal(battery.coverage, null); assert.notEqual(battery.label, 'Spare solar');
  const night = liveView({ ...data.current, inverterPowerW: 0, pvPowerW: 0, gridPowerW: 500, loadPowerW: 500 }, data.rates, true);
  assert.equal(night.tone, 'import'); assert.equal(night.coverage, null); assert.equal(night.title, 'Solar inactive');
  const balanced = liveView({ ...data.current, gridPowerW: 15, loadPowerW: 5715 }, data.rates, true);
  assert.equal(balanced.tone, 'neutral'); assert.equal(balanced.title, 'Balanced'); assert.equal(balanced.value, 15);
});

test('today finance clearly qualifies partial coverage and uses the full supply fee once', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.node('solarTodayImport').textContent, '1.00 kWh');
  assert.equal(f.node('solarTodayImportCost').textContent, '$0.29');
  assert.equal(f.node('solarTodayCredit').textContent, '$0.18');
  assert.equal(f.node('solarTodayNet').textContent, '$1.91');
  assert.match(f.node('solarTodaySupply').textContent, /incl\. \$1.81 supply/);
  assert.match(f.node('solarDayCoverage').textContent, /Partial.*20% recorded/);
  assert.match(f.node('solarDayDetail').textContent, /missing usage.*not included.*Full daily supply/);
  assert.equal(f.node('solarRateImport').textContent, '28.8948c/kWh');
  f.setTime(Date.parse('2026-11-14T14:00:01Z')); f.controller.paint();
  assert.equal(f.node('solarTodayNet').textContent, '–');
  assert.equal(f.node('solarTodayImport').textContent, '–');
  assert.equal(f.node('solarChartEmpty').hidden, false);
});

test('chart data is cached between five-minute requests while current data refreshes each minute', async t => {
  const f = fixture(t); await f.start();
  const initial = f.node('solarChart').innerHTML;
  for (let minute = 1; minute <= 4; minute++) {
    f.setTime(NOW + minute * 60000);
    const data = payload(NOW + minute * 60000); data.history = null; data.energy.days = null;
    f.setBody(data); await f.controller.refresh();
    assert.equal(f.requests.at(-1).url, '/api/solar');
    assert.equal(f.node('solarChart').innerHTML, initial);
  }
  f.setTime(NOW + 5 * 60000); f.setBody(payload(NOW + 5 * 60000)); await f.controller.refresh();
  assert.equal(f.requests.at(-1).url, '/api/solar?history=today');
  assert.notEqual(f.node('solarChart').innerHTML, initial);
});

test('history lines break at missing data and reported raw gaps instead of joining them', async t => {
  const data = payload();
  data.history.points = [0, 1, 2].map(index => ({ observedAt: iso(NOW - (2 - index) * 300000), inverterPowerW: 1000 + index * 100,
    loadPowerW: 500, gridImportPowerW: 0, gridExportPowerW: 500, breakBefore: index === 1, hasGap: index === 1 }));
  const f = fixture(t, data); await f.start();
  const chart = f.node('solarChart').innerHTML;
  const solarPath = /<path d="([^"]*)" class="solar-chart-series solar-chart-series-generation"/.exec(chart)[1];
  assert.equal((solarPath.match(/M/g) || []).length, 3);
  assert.ok(!solarPath.includes('L'));
  for (const series of ['generation', 'home', 'import']) {
    const markers = [...chart.matchAll(new RegExp('<circle cx="([^"]+)" cy="([^"]+)" r="2.5" class="solar-chart-series solar-chart-series-' + series + '"', 'g'))];
    assert.equal(markers.length, 3, 'each isolated ' + series + ' value remains visible without joining a real gap');
    assert.equal(new Set(markers.map(marker => marker[1])).size, 3, 'the final reading is not duplicated');
  }
});

test('isolated valid history points remain visible between missing bins and while zoomed', async t => {
  const data = payload();
  data.history.points = [0, 1, 2, 3, 4].map(index => ({ observedAt: iso(NOW - (4 - index) * 300000),
    inverterPowerW: index % 2 ? null : 3000 + index * 500,
    loadPowerW: index % 2 ? null : 500,
    gridImportPowerW: index % 2 ? null : 0,
    gridExportPowerW: index % 2 ? null : 2500 + index * 500 }));
  const f = fixture(t, data); await f.start();
  const check = () => {
    const chart = f.node('solarChart').innerHTML;
    const path = /<path d="([^"]*)" class="solar-chart-series solar-chart-series-generation"/.exec(chart)[1];
    assert.equal((path.match(/M/g) || []).length, 3);
    assert.ok(!path.includes('L'), 'missing five-minute bins must stay unfilled');
    const markers = [...chart.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="2.5" class="solar-chart-series solar-chart-series-generation"/g)];
    assert.equal(markers.length, 3, 'all real points have a visible SVG marker');
    for (const [index, expectedY] of [77.6, 42.8, 8].entries()) {
      assert.ok(Math.abs(Number(markers[index][2]) - expectedY) < 1e-6, 'marker height must match the recorded power');
    }
    return markers.map(marker => Number(marker[1]));
  };
  const before = check();
  f.fire('solarZoomIn', 'click'); f.fire('solarZoomIn', 'click');
  const after = check();
  assert.ok(after[2] - after[0] > before[2] - before[0], 'markers use the zoomed time positions');
  f.fire('solarChartScrubber', 'input', { target: { value: '2' } });
  assert.match(f.node('solarChartInspect').innerHTML, /Solar 4.00 kW/);
  assert.equal(f.requests.length, 1);
});

test('a missing house measurement only breaks the house line while complete solar and grid lines stay connected', async t => {
  const data = payload();
  data.history.points = [0, 1, 2].map(index => ({ observedAt: iso(NOW - (2 - index) * 300000),
    inverterPowerW: 4000, loadPowerW: 1000, gridImportPowerW: 0, gridExportPowerW: 3000,
    hasGap: index === 1, breakBefore: false,
    seriesGaps: { inverterPowerW: false, loadPowerW: index === 1, gridImportPowerW: false } }));
  const f = fixture(t, data); await f.start();
  const chart = f.node('solarChart').innerHTML;
  for (const series of ['generation', 'home', 'import']) {
    const path = new RegExp('<path d="([^"]*)" class="solar-chart-series solar-chart-series-' + series + '"').exec(chart)[1];
    const markers = [...chart.matchAll(new RegExp('<circle [^>]*class="solar-chart-series solar-chart-series-' + series + '"', 'g'))];
    assert.equal((path.match(/M/g) || []).length, series === 'home' ? 3 : 1);
    assert.equal((path.match(/L/g) || []).length, series === 'home' ? 0 : 2);
    assert.equal(markers.length, series === 'home' ? 3 : 1);
  }
  f.fire('solarChartScrubber', 'input', { target: { value: '1' } });
  assert.match(f.node('solarChartInspect').innerHTML, /Solar 4.00 kW/);
  assert.match(f.node('solarChartInspect').innerHTML, /House 1.00 kW/);

  // A timestamp gap still splits every series regardless of its field quality.
  data.history.points[1].breakBefore = true;
  f.setBody(data); f.setTime(NOW + 5 * 60000); await f.controller.refresh();
  const solarPath = /<path d="([^"]*)" class="solar-chart-series solar-chart-series-generation"/.exec(f.node('solarChart').innerHTML)[1];
  assert.equal((solarPath.match(/M/g) || []).length, 2);
});


test('fresh grid cost remains available when another meter reading is missing', async t => {
  const data = payload(); data.current.inverterPowerW = null; data.current.gridPowerW = 1000;
  const f = fixture(t, data); await f.start();
  assert.equal(f.node('homeSolar').dataset.state, 'partial');
  assert.equal(f.node('solarGridMoney').textContent, 'Cost $0.29/hr');
  assert.equal(f.node('solarHeadroom').textContent, '–');
  assert.equal(f.node('solarCoverageBlock').hidden, true);
  f.setTime(NOW + 181000); f.controller.paint();
  assert.equal(f.node('solarGridMoney').textContent, 'Last recorded exchange');
});


test('data tabs switch one fixed panel with roving focus and keyboard navigation', async t => {
  const f = fixture(t); await f.start();
  const entries = [['chart', 'solarTabChart', 'solarPanelChart'], ['log', 'solarTabLog', 'solarPanelLog'], ['details', 'solarTabDetails', 'solarPanelDetails']];
  const check = active => {
    for (const [name, tab, panel] of entries) {
      assert.equal(f.node(tab).attributes['aria-selected'], String(name === active));
      assert.equal(f.node(tab).attributes.tabindex, name === active ? '0' : '-1');
      assert.equal(f.node(panel).hidden, name !== active);
    }
  };
  check('chart'); f.fire('solarTabLog', 'click'); check('log');
  let prevented = 0;
  const key = (id, value) => f.fire(id, 'keydown', { key: value, preventDefault() { prevented++; } });
  key('solarTabLog', 'ArrowRight'); check('details'); assert.equal(f.doc.activeElement, f.node('solarTabDetails'));
  key('solarTabDetails', 'ArrowRight'); check('chart');
  key('solarTabChart', 'ArrowLeft'); check('details');
  key('solarTabDetails', 'Home'); check('chart');
  key('solarTabChart', 'End'); check('details'); assert.equal(prevented, 5);
  const requests = f.requests.length; f.controller.setPanel('chart');
  assert.equal(f.requests.length, requests, 'tab changes reuse cached data');
});

test('compact public copy retains objective readings and full timestamp access', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.node('solarHeadline').textContent, 'Solar surplus');
  assert.equal(f.node('solarLiveMoney').textContent, 'Export credit $0.13/hr');
  assert.equal(f.node('solarObserved').textContent, '12:00 · just now');
  assert.match(f.node('solarObserved').attributes.title, /14 Nov.*12:00:00 AEST/);
  assert.equal(f.node('solarObserved').attributes.title, f.node('solarObservedDetail').textContent);
  const card = html.slice(html.indexOf('<section id="homeSolar"'), html.indexOf('<section id="stationPower"'));
  assert.doesNotMatch(card, /\byour\b|\byou\b|<details|<summary/i);
  assert.match(card, /aria-label="Download daily solar CSV"/);
  const states = [liveView(payload().current, payload().rates, true), liveView(payload().current, payload().rates, false),
    liveView({ ...payload().current, gridPowerW: 1000 }, payload().rates, true)];
  for (const state of states) assert.doesNotMatch(JSON.stringify(state), /\byour\b|\byou\b|Reduce house|clouds and appliances/i);
});


function chartWindow(f) {
  const attributes = f.node('solarChartPlot').attributes;
  return { start: Number(attributes['data-window-start']), end: Number(attributes['data-window-end']), span: Number(attributes['data-window-span']) };
}

test('solar navigation zooms the cached view, pans to bounds and resets without fetching', async t => {
  const f = fixture(t); await f.start();
  const initial = chartWindow(f), count = f.requests.length;
  assert.equal(initial.span, 86400000);
  assert.equal(f.node('solarZoomReset').disabled, true);
  f.fire('solarZoomIn', 'click');
  assert.equal(chartWindow(f).span, 43200000);
  assert.equal(f.node('solarChartStart').textContent, '06:00');
  assert.equal(f.node('solarChartEnd').textContent, '18:00');
  f.fire('solarPanEarlier', 'click');
  assert.equal(chartWindow(f).start, initial.start);
  assert.equal(f.node('solarPanEarlier').disabled, true);
  for (let i = 0; i < 4; i++) f.fire('solarPanLater', 'click');
  assert.equal(chartWindow(f).end, initial.end);
  assert.equal(f.node('solarPanLater').disabled, true);
  for (let i = 0; i < 12; i++) f.fire('solarZoomIn', 'click');
  assert.equal(chartWindow(f).span, 3600000);
  assert.equal(f.node('solarZoomIn').disabled, true);
  assert.equal(f.node('solarChartWindow').textContent, '1h');
  f.fire('solarZoomReset', 'click');
  assert.deepEqual(chartWindow(f), initial);
  assert.equal(f.requests.length, count);
});

test('pinch follows both contacts and a remaining finger rebases cleanly for pan', async t => {
  const f = fixture(t); await f.start();
  const initial = chartWindow(f);
  const pointer = (type, id, x, y = 80) => f.fire('solarChartPlot', type, { type, pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y });
  pointer('pointerdown', 1, 240); pointer('pointerdown', 2, 480);
  pointer('pointermove', 1, 120); pointer('pointermove', 2, 600);
  assert.equal(chartWindow(f).span, initial.span / 2);
  assert.equal(chartWindow(f).start, initial.start + initial.span / 4);
  pointer('pointerup', 2, 600);
  const beforePan = chartWindow(f);
  pointer('pointermove', 1, 192);
  assert.equal(chartWindow(f).start, beforePan.start - beforePan.span / 10);
  pointer('pointercancel', 1, 192);
  assert.equal(f.node('solarChartPlot').attributes['data-dragging'], 'false');
  const stopped = chartWindow(f);
  pointer('pointermove', 1, 300);
  assert.deepEqual(chartWindow(f), stopped, 'cancelled contacts cannot continue moving the view');
  let prevented = 0;
  f.fire('solarChartPlot', 'touchmove', { touches: [{}], cancelable: true, preventDefault() { prevented++; } });
  f.fire('solarChartPlot', 'touchstart', { touches: [{}, {}], cancelable: true, preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'only the multi-touch gesture blocks native scrolling');
});

test('a one-finger vertical swipe leaves the chart window alone', async t => {
  const f = fixture(t); await f.start(); f.fire('solarZoomIn', 'click');
  const before = chartWindow(f);
  f.fire('solarChartPlot', 'pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 250, clientY: 80 });
  f.fire('solarChartPlot', 'pointermove', { pointerId: 1, pointerType: 'touch', clientX: 255, clientY: 120 });
  assert.deepEqual(chartWindow(f), before);
  f.fire('solarChartPlot', 'pointercancel', { type: 'pointercancel', pointerId: 1, clientX: 255, clientY: 120 });
});

test('zoom survives fresh data and metric changes but resets on period changes and midnight', async t => {
  const data = payload();
  data.energy.days = Array.from({ length: 30 }, (_, index) => ({ date: new Date(NOW - (29 - index) * 86400000).toISOString().slice(0, 10), quality: 'complete', netCost: index / 10 - 1, gridImportWh: 1000, gridExportWh: 2000 }));
  const f = fixture(t, data); await f.start(); f.fire('solarZoomIn', 'click');
  const todayZoom = chartWindow(f);
  f.setTime(NOW + 60000); await f.controller.refresh();
  assert.deepEqual(chartWindow(f), todayZoom);
  f.fire('solarRange7', 'click'); assert.equal(chartWindow(f).span, 7 * 86400000);
  for (let i = 0; i < 5; i++) f.fire('solarZoomIn', 'click');
  assert.equal(chartWindow(f).span, 3 * 86400000);
  const dailyZoom = chartWindow(f);
  f.fire('solarChartMetric', 'change', { target: { value: 'energy' } });
  assert.deepEqual(chartWindow(f), dailyZoom);
  f.fire('solarRange30', 'click'); assert.equal(chartWindow(f).span, 30 * 86400000);
  f.fire('solarZoomIn', 'click'); assert.equal(chartWindow(f).span, 15 * 86400000);
  f.setTime(Date.parse('2026-11-14T14:00:01Z')); f.controller.paint();
  assert.equal(chartWindow(f).span, 30 * 86400000);
});

test('keyboard and scrubber inspection stay within the zoomed period and keep data gaps', async t => {
  const data = payload(), dayStart = Date.parse('2026-11-13T14:00:00Z');
  data.history.points = Array.from({ length: 24 }, (_, hour) => ({ observedAt: iso(dayStart + hour * 3600000), inverterPowerW: hour === 11 ? null : 1000, loadPowerW: 500, gridImportPowerW: 0, breakBefore: hour === 12 }));
  const f = fixture(t, data); await f.start();
  const key = value => f.fire('solarChartPlot', 'keydown', { key: value, preventDefault() {} });
  key('+'); key('+');
  assert.equal(f.node('solarChartStart').textContent, '09:00');
  assert.equal(f.node('solarChartEnd').textContent, '15:00');
  assert.equal(f.node('solarChartScrubber').max, '6');
  key('Home'); assert.match(f.node('solarChartInspect').innerHTML, /09:00 AEST/);
  key('End'); assert.match(f.node('solarChartInspect').innerHTML, /15:00 AEST/);
  f.fire('solarChartScrubber', 'input', { target: { value: '1' } });
  assert.match(f.node('solarChartInspect').innerHTML, /10:00 AEST/);
  const path = /<path d="([^"]*)" class="solar-chart-series solar-chart-series-generation"/.exec(f.node('solarChart').innerHTML)[1];
  assert.equal((path.match(/M/g) || []).length, 2, 'zoom never fills a missing-reading break');
  key('0'); assert.equal(chartWindow(f).span, 86400000);
  assert.equal(f.requests.length, 1);
});
