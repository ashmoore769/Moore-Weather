'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../public/forecast-summary');
const { HOUR_MS, FRESH_MS, MAX_AGE_MS } = require('../public/forecast-summary-model');

const NOW = Date.parse('2026-11-14T09:17:00Z');
const MINUTE_MS = 60000;
const flush = () => new Promise(setImmediate);

function forecast(fetchedAt = NOW, rainMm = 1) {
  const start = Math.floor(NOW / HOUR_MS) * HOUR_MS;
  return {
    timezone: 'Australia/Brisbane', source: 'Open-Meteo', stale: false,
    fetchedAt: new Date(fetchedAt).toISOString(),
    hourly: Array.from({ length: 49 }, (_, i) => ({
      time: (start + i * HOUR_MS) / 1000, precipitation: rainMm,
      precipitation_probability: 60, temperature_2m: 20,
      weather_code: 3, wind_gusts_10m: 12
    }))
  };
}

function response(body) {
  return { ok: true, status: 200, json: async () => structuredClone(body) };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, initial = forecast()) {
  const listeners = new Map(), timers = new Map(), requests = [];
  const ids = ['forecastSummary', 'forecastSummaryRain', 'forecastSummaryChance',
    'forecastSummaryTemps', 'forecastSummarySignal', 'forecastSummaryTiming',
    'forecastSummarySource', 'forecastSummaryPlot', 'forecastSummaryChart', 'forecastSummaryInspect'];
  const nodes = new Map(ids.map(id => [id, {
    attributes: {}, listeners: new Map(), clientWidth: 360, content: '', markup: '',
    get textContent() { return this.content; },
    set textContent(value) { this.content = String(value); this.markup = String(value); },
    get innerHTML() { return this.markup; },
    set innerHTML(value) { this.markup = String(value); this.content = String(value).replace(/<[^>]*>/g, ''); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    removeEventListener(name, handler) { if (this.listeners.get(name) === handler) this.listeners.delete(name); }
  }]));
  const doc = {
    hidden: false, getElementById: id => nodes.get(id),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); }
  };
  let clock = NOW, nextTimer = 0, responder = async () => response(initial);
  const controller = createController({
    document: doc, now: () => clock, AbortController,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: clock + Math.max(0, delay) });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    fetch(url, options) {
      const request = { url, options, at: clock };
      requests.push(request);
      return responder(request);
    }
  });
  t.after(() => controller.stop());
  return {
    controller, requests, timers, doc,
    node: id => nodes.get(id),
    state: () => nodes.get('forecastSummary').attributes['data-state'],
    now: () => clock,
    replyWith: body => { responder = async () => response(body); },
    fetchWith: handler => { responder = handler; },
    fail: () => { responder = async () => { throw new Error('Synthetic connection failure'); }; },
    hidden(value) { doc.hidden = value; listeners.get('visibilitychange')?.(); },
    async start() { controller.start(); await flush(); },
    async advance(milliseconds) {
      const end = clock + milliseconds;
      let callbacks = 0;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        assert.ok(++callbacks < 1000, 'automatic scheduling must not enter a zero-delay loop');
        const [id, timer] = due;
        clock = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      clock = end;
      await flush();
    }
  };
}

test('concurrent refresh and visibility events share one in-flight request', async t => {
  const f = fixture(t), held = deferred();
  f.fetchWith(() => held.promise);
  await f.start();
  f.controller.start();
  await Promise.all([f.controller.refresh(), f.controller.refresh()]);
  f.hidden(true); f.hidden(false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/api/forecast');
  assert.equal(f.requests[0].options.credentials, 'same-origin');
  assert.equal(f.state(), 'loading');
  held.resolve(response(forecast()));
  await flush();
  assert.equal(f.state(), 'fresh');
  assert.equal(f.node('forecastSummaryRain').textContent, '24.0 mm');
  assert.equal(f.requests.length, 1);
});

test('hidden pages stop automatic work and reevaluate age before refreshing on return', async t => {
  const f = fixture(t);
  f.hidden(true);
  await f.start();
  await f.advance(5 * MINUTE_MS);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
  f.hidden(false); await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.state(), 'fresh');

  f.hidden(true);
  assert.equal(f.timers.size, 0, 'no polling or age-paint timers remain in the background');
  await f.advance(30 * MINUTE_MS);
  assert.equal(f.requests.length, 1);
  const held = deferred();
  f.fetchWith(() => held.promise);
  f.hidden(false);
  assert.equal(f.state(), 'stale', 'the old forecast is labelled delayed before the new fetch finishes');
  assert.equal(f.requests.length, 2);
  held.resolve(response(forecast(f.now()))); await flush();
  assert.equal(f.state(), 'fresh');
});

test('stop aborts its request and a late response cannot overwrite a restarted controller', async t => {
  const f = fixture(t), oldRequest = deferred();
  f.fetchWith(() => oldRequest.promise);
  await f.start();
  const oldSignal = f.requests[0].options.signal;
  f.controller.stop();
  assert.equal(oldSignal.aborted, true);
  assert.equal(f.timers.size, 0);
  f.hidden(true); f.hidden(false);
  assert.equal(f.requests.length, 1, 'stopped visibility listeners cannot restart work');

  f.replyWith(forecast(NOW, 2));
  await f.start();
  assert.equal(f.requests.length, 2);
  assert.equal(f.node('forecastSummaryRain').textContent, '48.0 mm');
  // Simulate a transport that still resolves after its AbortSignal was set.
  oldRequest.resolve(response(forecast(NOW, 8))); await flush();
  assert.equal(f.state(), 'fresh');
  assert.equal(f.node('forecastSummaryRain').textContent, '48.0 mm');
  assert.equal(f.requests[1].options.signal.aborted, false);
});

test('failed refreshes retain usable data only until the six-hour expiry, within one age-paint interval', async t => {
  const f = fixture(t, forecast(NOW - MAX_AGE_MS + 15000));
  await f.start();
  assert.equal(f.state(), 'stale');
  assert.equal(f.node('forecastSummaryRain').textContent, '24.0 mm');
  f.fail();
  await f.controller.refresh();
  assert.equal(f.state(), 'stale');
  await f.advance(30000);
  assert.equal(f.state(), 'expired');
  assert.equal(f.node('forecastSummaryRain').textContent, '–');
  assert.equal(f.node('forecastSummaryChance').textContent, '–');
  assert.equal(f.node('forecastSummaryTemps').textContent, '–');
  assert.equal(f.node('forecastSummaryPlot').attributes['aria-disabled'], 'true');
  assert.equal((f.node('forecastSummaryChart').innerHTML.match(/data-state="missing"/g) || []).length, 24);
  assert.equal(f.requests.length, 2, 'expiry must not depend on another successful network request');
});

test('the next refresh uses the source fetchedAt age and a fresh result resets the cache deadline', async t => {
  const f = fixture(t, forecast(NOW - FRESH_MS + MINUTE_MS));
  await f.start();
  await f.advance(MINUTE_MS - 1);
  assert.equal(f.requests.length, 1);
  await f.advance(1);
  assert.equal(f.requests.length, 2, 'a nineteen-minute-old response refreshes after one minute');
  assert.equal(f.state(), 'stale', 'receiving the same cached payload does not rejuvenate it');
  f.replyWith(forecast(NOW + 2 * MINUTE_MS));
  await f.advance(MINUTE_MS);
  assert.equal(f.requests.length, 3);
  assert.equal(f.state(), 'fresh');
  await f.advance(FRESH_MS - 1);
  assert.equal(f.requests.length, 3);
  await f.advance(1);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[3].at, NOW + 2 * MINUTE_MS + FRESH_MS);
});

test('stale cached responses back off instead of hammering an expired cache deadline', async t => {
  const f = fixture(t, forecast(NOW - 25 * MINUTE_MS));
  await f.start();
  let previousMinute = 0;
  for (const minute of [1, 3, 7, 12, 17]) {
    const count = f.requests.length;
    await f.advance((minute - previousMinute) * MINUTE_MS - 1);
    assert.equal(f.requests.length, count);
    await f.advance(1);
    assert.equal(f.requests.length, count + 1);
    assert.equal(f.requests.at(-1).at, NOW + minute * MINUTE_MS);
    previousMinute = minute;
  }
  assert.equal(f.state(), 'stale');
  f.replyWith(forecast(f.now()));
  await f.controller.refresh();
  assert.equal(f.state(), 'fresh');
  f.fail();
  await f.controller.refresh();
  const count = f.requests.length;
  await f.advance(MINUTE_MS);
  assert.equal(f.requests.length, count + 1, 'success resets failure backoff to one minute');
});

test('a stalled request is aborted at its deadline and a late result cannot clear its failure state', async t => {
  const f = fixture(t), held = deferred();
  f.fetchWith(() => held.promise);
  await f.start();
  await f.advance(15000);
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.state(), 'unavailable');
  held.resolve(response(forecast())); await flush();
  assert.equal(f.state(), 'unavailable');
  f.replyWith(forecast(NOW + 75000));
  await f.advance(MINUTE_MS - 1);
  assert.equal(f.requests.length, 1);
  await f.advance(1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.state(), 'fresh');
});
