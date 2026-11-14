'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SolarAlerts, POLICY, freshReading, RETRY_MS, DELIVERY_WINDOW_MS } = require('../lib/solar-alerts');
const { MINUTE, FRESH_FOR } = require('../lib/solar-data');

function setup(t, { send, initial = '2026-11-14T05:00:00+10:00', startupGraceMs = 0 } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-alerts-'));
  const file = path.join(folder, 'alerts.sqlite');
  let now = Date.parse(initial), db, alerts;
  const attempts = [], sent = [];
  const open = () => {
    db = new DatabaseSync(file);
    db.exec('CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY,payload TEXT NOT NULL);');
    alerts = new SolarAlerts({ db, now: () => now, startupGraceMs,
      logger: { info() {}, warn() {} },
      deliver: async (row, payload, options) => {
        const attempt = { endpoint: row.endpoint, payload, options };
        attempts.push(attempt);
        const accepted = send ? await send(attempt, db) : true;
        if (accepted) sent.push(attempt);
        return accepted;
      } });
  };
  open();
  t.after(() => { db.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const fixture = {
    get alerts() { return alerts; }, get db() { return db; }, sent, attempts,
    now: () => now, set: value => { now = typeof value === 'number' ? value : Date.parse(value); },
    advance: (ms = MINUTE) => { now += ms; },
    subscribe(id = 'one', key = 'original') {
      const endpoint = 'https://web.push.apple.com/' + id;
      const payload = JSON.stringify({ endpoint, keys: { auth: key, p256dh: 'fixture' } });
      db.prepare('INSERT INTO subscriptions VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET payload=excluded.payload').run(endpoint, payload);
      return endpoint;
    },
    unsubscribe(id = 'one') {
      const endpoint = 'https://web.push.apple.com/' + id;
      db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(endpoint);
      alerts.forget(endpoint);
    },
    snapshot(direction = 'solar', overrides = {}, root = {}) {
      const power = direction === 'solar' ? { inverterPowerW: 1000, loadPowerW: 800, gridPowerW: -200 } :
        direction === 'grid' ? { inverterPowerW: 500, loadPowerW: 800, gridPowerW: 300 } :
          { inverterPowerW: 800, loadPowerW: 800, gridPowerW: 0 };
      const stamp = new Date(now).toISOString();
      return { enabled: true, ready: true, current: { observedAt: stamp, collectedAt: stamp, receivedAt: stamp,
        ...power, batteryPowerW: null, meterLocation: 'grid', mode: 'meter', ...overrides }, ...root };
    },
    async tick(direction = 'solar', overrides, root) { await alerts.tick(fixture.snapshot(direction, overrides, root)); },
    async feed(direction, count, spacing = MINUTE) {
      for (let index = 0; index < count; index++) {
        if (index) fixture.advance(spacing);
        await fixture.tick(direction);
      }
    },
    restart() { db.close(); open(); },
    state() { return JSON.parse(db.prepare('SELECT payload FROM solar_alert_days ORDER BY local_date DESC LIMIT 1').get()?.payload || 'null'); }
  };
  return fixture;
}

test('first morning surplus needs 100 W on both AC balance and grid meter for two minutes', async t => {
  const f = setup(t); f.subscribe();
  for (const overrides of [
    { inverterPowerW: 899, gridPowerW: -99 },
    { inverterPowerW: 1000, gridPowerW: 200 },
    { inverterPowerW: 799, gridPowerW: -200 }
  ]) {
    await f.tick('solar', overrides); f.advance();
  }
  await f.tick('solar', { inverterPowerW: 900, gridPowerW: -100 });
  f.advance(); await f.tick('solar', { inverterPowerW: 900, gridPowerW: -100 });
  assert.equal(f.sent.length, 0);
  f.advance(); await f.tick('solar', { inverterPowerW: 900, gridPowerW: -100 });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.title, 'House is now running on solar');
  assert.match(f.sent[0].payload.body, /Solar 0\.90 kW · House 0\.80 kW · Export 0\.10 kW/);
  assert.equal(f.sent[0].payload.url, '/#homeSolar');
  assert.equal(f.sent[0].options.topic, 'moore-solar-solar');
  assert.ok(f.sent[0].options.TTL <= 180);
});

test('threshold chatter resets confirmation; later dips never repeat the morning notice', async t => {
  const f = setup(t); f.subscribe();
  for (const direction of ['solar', 'solar', 'neutral', 'solar', 'grid', 'solar', 'solar', 'neutral']) {
    await f.tick(direction); f.advance();
  }
  assert.equal(f.sent.length, 0);
  await f.feed('solar', 3);
  assert.equal(f.sent.length, 1);
  for (const direction of ['grid', 'solar', 'grid', 'solar', 'solar', 'solar']) {
    f.advance(); await f.tick(direction);
  }
  assert.equal(f.sent.length, 1);
});

test('daylight cloud and short afternoon appliance loads do not announce the evening crossover', async t => {
  const f = setup(t); f.subscribe(); await f.feed('solar', 3);
  f.set('2026-11-14T12:00:00+10:00'); await f.feed('grid', 40);
  assert.equal(f.sent.length, 1);
  f.set('2026-11-14T15:00:00+10:00'); await f.feed('grid', 7);
  f.advance(); await f.tick('neutral');
  assert.equal(f.sent.length, 1);
  f.advance(); await f.feed('grid', 10);
  assert.equal(f.sent.length, 1);
  f.advance(); await f.tick('grid');
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].payload.title, 'House is now using grid power');
  assert.match(f.sent[1].payload.body, /Grid import 0\.30 kW/);
  assert.notEqual(f.sent[0].options.topic, f.sent[1].options.topic);
  assert.notEqual(f.sent[0].payload.tag, f.sent[1].payload.tag);
  f.advance(); await f.feed('solar', 3);
  f.advance(); await f.feed('grid', 11);
  assert.equal(f.sent.length, 2);
});

test('a day always using the grid has no invented crossover or late morning alert', async t => {
  const f = setup(t); f.subscribe(); await f.feed('grid', 12);
  f.set('2026-11-14T16:00:00+10:00'); await f.feed('grid', 12);
  assert.equal(f.sent.length, 0);
  f.advance(); await f.feed('solar', 3);
  assert.equal(f.sent.length, 0);
  assert.ok(f.state().coveredAt);
  f.advance(); await f.feed('grid', 11);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.kind, 'solar-grid');
});

test('morning window starts at 05:00 AEST; a transition confirmed after 15:00 only arms evening', async t => {
  const f = setup(t, { initial: '2026-11-14T04:55:00+10:00' }); f.subscribe();
  await f.feed('solar', 5); assert.equal(f.sent.length, 0);
  f.advance(); await f.feed('solar', 3); assert.equal(f.sent.length, 1);
  f.set('2026-11-15T14:59:00+10:00'); await f.feed('solar', 3);
  assert.equal(f.sent.length, 1); assert.equal(f.state().events.solar, null);
  f.advance(); await f.feed('grid', 11);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].payload.kind, 'solar-grid');
});

test('held candidates and accepted deliveries survive service restart', async t => {
  const f = setup(t); f.subscribe(); await f.feed('solar', 2); f.restart();
  await f.tick('solar'); assert.equal(f.sent.length, 0);
  f.advance(); await f.tick('solar'); assert.equal(f.sent.length, 1);
  f.restart(); await f.tick('solar'); assert.equal(f.sent.length, 1);
  f.set('2026-11-14T16:00:00+10:00'); await f.feed('grid', 6); f.restart();
  await f.tick('grid'); f.advance(); await f.feed('grid', 5);
  assert.equal(f.sent.length, 2);
  f.restart(); f.advance(); await f.tick('grid'); assert.equal(f.sent.length, 2);
});

test('AEST day boundary rearms once per day and a backward date correction does not resend yesterday', async t => {
  const f = setup(t); f.subscribe(); await f.feed('solar', 3);
  const firstTag = f.sent[0].payload.tag;
  f.set('2026-11-15T05:00:00+10:00'); await f.feed('solar', 3);
  assert.equal(f.sent.length, 2); assert.notEqual(f.sent[1].payload.tag, firstTag);
  f.set('2026-11-14T06:00:00+10:00'); await f.feed('solar', 3);
  assert.equal(f.sent.length, 2);
});

test('duplicate and out-of-order samples cannot accrue a hold period', async t => {
  const f = setup(t); f.subscribe(); const first = f.snapshot();
  await f.alerts.tick(first);
  for (let index = 0; index < 3; index++) { f.advance(); await f.alerts.tick(first); }
  assert.equal(f.sent.length, 0);
  f.advance(); await f.tick(); // Four-minute gap begins a new confirmation.
  const second = f.snapshot(); f.advance(); await f.tick();
  await f.alerts.tick(second); assert.equal(f.sent.length, 0);
  await f.tick('solar', { inverterPowerW: 1500 }); // Same-timestamp revision cannot count.
  assert.equal(f.sent.length, 0);
  f.advance(); await f.tick(); assert.equal(f.sent.length, 1);
});

test('stale, missing, disabled and future data reset confirmation without alerting', async t => {
  const f = setup(t); f.subscribe(); await f.feed('solar', 2);
  f.advance(); await f.alerts.tick({ enabled: true, ready: false, current: null });
  assert.equal(f.state().candidate, null);
  const old = new Date(f.now() - FRESH_FOR - 1).toISOString();
  const future = new Date(f.now() + 1).toISOString();
  for (const key of ['observedAt', 'collectedAt', 'receivedAt']) {
    for (const value of [old, future, 'invalid', null]) {
      await f.tick('solar', { [key]: value });
      assert.equal(f.sent.length, 0);
    }
  }
  await f.tick('solar', {}, { enabled: false });
  await f.tick('solar', {}, { current: null });
  f.advance(); await f.feed('solar', 3); assert.equal(f.sent.length, 1);
});

test('active battery, non-grid meter and invalid powers cannot claim direct solar coverage', async t => {
  const f = setup(t); f.subscribe();
  for (const overrides of [
    { batteryPowerW: 1 }, { batteryPowerW: -1 }, { batteryPowerW: undefined },
    { meterLocation: 'load' }, { meterLocation: null }, { mode: 'produce-only' },
    { inverterPowerW: -1 }, { inverterPowerW: null }, { inverterPowerW: Infinity },
    { loadPowerW: -1 }, { loadPowerW: null }, { gridPowerW: NaN }, { gridPowerW: null }
  ]) {
    assert.equal(freshReading(f.snapshot('solar', overrides), f.now()), null);
    await f.tick('solar', overrides); f.advance();
  }
  assert.equal(f.sent.length, 0);
  for (let index = 0; index < 3; index++) { await f.tick('solar', { batteryPowerW: 0 }); f.advance(); }
  assert.equal(f.sent.length, 1);
});

test('one brief blackout in observations restarts the evening confirmation', async t => {
  const f = setup(t); f.subscribe(); await f.feed('solar', 3);
  f.set('2026-11-14T16:00:00+10:00'); await f.feed('grid', 10);
  f.advance(FRESH_FOR + 1); await f.tick('grid');
  assert.equal(f.sent.length, 1);
  f.advance(); await f.feed('grid', 9); assert.equal(f.sent.length, 1);
  f.advance(); await f.tick('grid'); assert.equal(f.sent.length, 2);
});

test('provider retry is per device, persisted, and only runs while the current condition remains relevant', async t => {
  let failing = true;
  const f = setup(t, { send: async attempt => attempt.endpoint.endsWith('/one') ? !failing : true });
  f.subscribe(); f.subscribe('two'); await f.feed('solar', 3);
  assert.equal(f.attempts.length, 2); assert.equal(f.sent.length, 1);
  f.restart(); f.advance(); await f.tick('solar'); assert.equal(f.attempts.length, 2);
  f.advance(RETRY_MS); await f.tick('grid'); assert.equal(f.attempts.length, 2);
  failing = false; f.advance(); await f.tick('solar');
  assert.equal(f.attempts.length, 3); assert.equal(f.sent.length, 2);
  assert.equal(f.sent.filter(item => item.endpoint.endsWith('/two')).length, 1);
  f.restart(); f.advance(); await f.tick('solar'); assert.equal(f.attempts.length, 3);
});

test('delivery window expires and replaying an old batch cannot revive a pending morning notification', async t => {
  const f = setup(t, { send: async () => false }); f.subscribe(); await f.feed('solar', 3);
  const queued = f.snapshot(); assert.equal(f.attempts.length, 1);
  f.advance(RETRY_MS); await f.alerts.tick({ ...queued, current: { ...queued.current, receivedAt: new Date(f.now()).toISOString() } });
  assert.equal(f.attempts.length, 1);
  f.advance(DELIVERY_WINDOW_MS); await f.tick('solar'); assert.equal(f.attempts.length, 1);
  f.restart(); f.advance(); await f.tick('solar'); assert.equal(f.attempts.length, 1);
});

test('late subscriptions and re-enabling a device do not replay an earlier crossover', async t => {
  const f = setup(t); f.subscribe(); await f.feed('solar', 3);
  f.subscribe('late'); f.advance(); await f.tick(); assert.equal(f.sent.length, 1);
  f.unsubscribe(); f.subscribe(); f.advance(); await f.tick(); assert.equal(f.sent.length, 1);
  f.set('2026-11-14T16:00:00+10:00'); await f.feed('grid', 11);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent.filter(item => item.endpoint.endsWith('/late')).length, 1);
});

test('replaced subscription credentials do not receive another device incarnation’s pending notification', async t => {
  const f = setup(t, { send: async () => false }); f.subscribe(); await f.feed('solar', 3);
  f.subscribe('one', 'replacement'); f.advance(RETRY_MS); await f.tick();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM solar_alert_deliveries').get().count, 0);
});

test('expired endpoints are cleaned up independently and do not block other subscribed devices', async t => {
  const f = setup(t, { send: async (attempt, db) => {
    if (attempt.endpoint.endsWith('/expired')) {
      db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(attempt.endpoint); return false;
    }
    return true;
  } });
  f.subscribe('expired'); f.subscribe('good'); await f.feed('solar', 3);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].endpoint, 'https://web.push.apple.com/good');
  f.advance(); await f.tick();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM solar_alert_deliveries WHERE endpoint=?').get('https://web.push.apple.com/expired').count, 0);
});

test('a pending recipient removed or replaced during another provider request is not sent the old notification', async t => {
  for (const change of ['unsubscribe', 'replace']) {
    let releaseFirst;
    const f = setup(t, { send: async attempt => {
      if (attempt.endpoint.endsWith('/a')) await new Promise(resolve => { releaseFirst = resolve; });
      return true;
    } });
    f.subscribe('a'); f.subscribe('b'); await f.feed('solar', 2); f.advance();
    const delivering = f.tick('solar');
    assert.equal(f.attempts.length, 1);
    assert.equal(typeof releaseFirst, 'function');
    if (change === 'unsubscribe') f.unsubscribe('b');
    else f.subscribe('b', 'replacement');
    releaseFirst(); await delivering;
    assert.equal(f.attempts.length, 1, change);
    assert.equal(f.sent[0].endpoint, 'https://web.push.apple.com/a');
  }
});

test('concurrent checks reserve one delivery and stop sending when the underlying sample grows stale', async t => {
  let f;
  f = setup(t, { send: async () => { await new Promise(resolve => setTimeout(resolve, 5)); f.advance(FRESH_FOR + 1); return true; } });
  f.subscribe('one'); f.subscribe('two'); await f.feed('solar', 2); f.advance();
  const snapshot = f.snapshot(); await Promise.all([f.alerts.tick(snapshot), f.alerts.tick(snapshot)]);
  assert.equal(f.sent.length, 1);
  f.advance(); await f.tick(); assert.equal(f.sent.length, 2);
  assert.equal(new Set(f.sent.map(item => item.endpoint)).size, 2);
});

test('startup grace collects no retrospective samples and requires a fresh confirmation afterward', async t => {
  const f = setup(t, { startupGraceMs: 2 * MINUTE }); f.subscribe(); await f.feed('solar', 3);
  assert.equal(f.sent.length, 0);
  f.advance(); await f.tick(); assert.equal(f.sent.length, 0);
  f.advance(); await f.tick(); assert.equal(f.sent.length, 1);
});

test('day and delivery archives stay bounded while keeping recent deduplication', async t => {
  const f = setup(t); f.subscribe();
  for (let day = 1; day <= 12; day++) {
    f.set('2026-11-' + String(day).padStart(2, '0') + 'T05:00:00+10:00');
    await f.feed('solar', 3);
  }
  assert.equal(f.sent.length, 12);
  assert.ok(f.db.prepare('SELECT COUNT(*) AS count FROM solar_alert_days').get().count <= 8);
  assert.ok(f.db.prepare('SELECT COUNT(*) AS count FROM solar_alert_deliveries').get().count <= 8);
  assert.equal(POLICY.maxNotificationsPerDay, 2);
});
