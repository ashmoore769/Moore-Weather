'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { StationAlerts, mountAlerts } = require('../lib/station-alerts');
const { historyHealth, expectedDaily, REPEAT_MS, RETRY_MS } = require('../lib/history-alerts');
const { createPersistence } = require('../lib/weather-persistence');
const layout = require('../config/station-layout.json');
const MINUTE = 60000;
const sub = (id = 'one') => ({ endpoint: 'https://web.push.apple.com/' + id,
  keys: { auth: Buffer.alloc(16, 1).toString('base64url'), p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString('base64url') } });
function setup(t, sender) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-alerts-'));
  let clock = Date.parse('2026-11-02T00:00:00Z');
  const sent = [], logs = [];
  const options = { filename: path.join(dir, 'alerts.sqlite'), now: () => clock, startupGraceMs: 0,
    logger: { info: s => logs.push(s), warn: s => logs.push(s) },
    send: async (device, payload, settings) => { if (sender) await sender(device, payload, settings); sent.push({ payload: JSON.parse(payload), settings }); } };
  let alerts = new StationAlerts(options);
  t.after(() => { alerts.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get alerts() { return alerts; }, sent, logs, now: () => clock, advance: ms => clock += ms,
    restart() { alerts.close(); alerts = new StationAlerts(options); } };
}
function fresh(now, overrides = {}) {
  return { enabled: true, ready: true, streams: { mem3: new Date(now - 10 * MINUTE).toISOString(),
    mem2: new Date(now - 60 * MINUTE).toISOString(), mem1: new Date(expectedDaily(now)).toISOString(), ...overrides } };
}
const staleTen = '2026-11-01T21:40:00.000Z';

test('fresh live readings cannot conceal stalled history; repeating warnings and recovery survive restarts', async t => {
  const f = setup(t); f.alerts.subscribe(sub());
  await f.alerts.tick(f.now());
  await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen }));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.kind, 'history-missing');
  assert.match(f.sent[0].payload.body, /10-minute: last/);
  assert.equal(f.sent[0].settings.topic, 'moore-history-status');
  for (let i = 0; i < 3; i++) {
    f.advance(REPEAT_MS - 1); f.restart();
    await f.alerts.tick(f.now());
    await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen }));
    assert.equal(f.sent.length, i + 1);
    f.advance(1); await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen }));
    assert.equal(f.sent.length, i + 2);
  }
  assert.equal(new Set(f.sent.map(n => n.payload.tag)).size, 1);
  await f.alerts.history.tick(fresh(f.now()));
  assert.equal(f.sent.length, 5);
  assert.equal(f.sent.at(-1).payload.kind, 'history-recovered');
  f.restart(); await f.alerts.history.tick(fresh(f.now())); assert.equal(f.sent.length, 5);
  f.advance(REPEAT_MS); await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen }));
  assert.equal(f.sent.length, 6);
  assert.notEqual(f.sent.at(-1).payload.tag, f.sent[0].payload.tag);
});

test('ten-minute and hourly thresholds tolerate normal download delay but not missing records or future timestamps', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  assert.equal(historyHealth(fresh(now, { mem3: new Date(now - 30 * MINUTE).toISOString(), mem2: new Date(now - 120 * MINUTE).toISOString() }), now).delayed, false);
  for (const [stream, value] of [['mem3', now - 30 * MINUTE - 1], ['mem2', now - 120 * MINUTE - 1], ['mem3', now + 90001]]) {
    const health = historyHealth(fresh(now, { [stream]: new Date(value).toISOString() }), now);
    assert.equal(health.delayed, true);
    assert.equal(health.feeds.find(f => f.stream === stream).delayed, true);
  }
  for (const value of [null, '', 'invalid']) assert.equal(historyHealth(fresh(now, { mem3: value }), now).delayed, true);
});

test('daily deadline is 09:30 AEST and remains correct across month and year boundaries', () => {
  for (const day of ['2026-10-31', '2026-12-31']) {
    const before = Date.parse(day + 'T23:29:59.999Z');
    const last = new Date(expectedDaily(before)).toISOString();
    assert.equal(historyHealth(fresh(before, { mem1: last }), before).delayed, false);
    const due = before + 1;
    assert.equal(expectedDaily(due) - expectedDaily(before), 86400000);
    assert.equal(historyHealth(fresh(due, { mem1: last }), due).feeds.find(f => f.stream === 'mem1').delayed, true);
    assert.equal(historyHealth(fresh(due), due).delayed, false);
  }
});

test('startup grace and unavailable or disabled monitoring cannot announce false recovery', async t => {
  const f = setup(t); f.alerts.subscribe(sub()); f.alerts.history.startupGraceMs = 120000;
  await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen })); assert.equal(f.sent.length, 0);
  f.advance(120000); await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen })); assert.equal(f.sent.length, 1);
  f.advance(REPEAT_MS);
  await f.alerts.history.tick({ enabled: true, ready: false });
  assert.equal(f.sent.at(-1).payload.kind, 'history-missing');
  assert.match(f.sent.at(-1).payload.body, /unavailable/);
  await f.alerts.history.tick({ enabled: false });
  assert.equal(f.sent.length, 2);
  await f.alerts.history.tick(fresh(f.now(), { mem1: null })); assert.equal(f.sent.length, 2);
  await f.alerts.history.tick(fresh(f.now())); assert.equal(f.sent.at(-1).payload.kind, 'history-recovered');
});

test('an hourly or daily failure alone triggers history alerts and partial recovery keeps reminders active', async t => {
  const f = setup(t); f.alerts.subscribe(sub());
  await f.alerts.history.tick(fresh(f.now(), { mem2: staleTen, mem1: null }));
  assert.match(f.sent[0].payload.body, /hourly:.*daily:/);
  f.advance(REPEAT_MS); await f.alerts.history.tick(fresh(f.now(), { mem1: null }));
  assert.equal(f.sent[1].payload.kind, 'history-missing');
  assert.doesNotMatch(f.sent[1].payload.body, /hourly:/);
  await f.alerts.history.tick(fresh(f.now())); assert.equal(f.sent[2].payload.kind, 'history-recovered');
});

test('provider failures back off across restart and successful recovery is not delayed by an outage retry', async t => {
  let fail = true, attempts = 0;
  const f = setup(t, async () => { attempts++; if (fail) throw Object.assign(Error('temporary'), { statusCode: 503 }); });
  f.alerts.subscribe(sub()); await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen }));
  assert.equal(attempts, 1); f.restart();
  await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen })); assert.equal(attempts, 1);
  f.advance(RETRY_MS); fail = false;
  await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen })); assert.equal(f.sent.length, 1);
  f.advance(REPEAT_MS); fail = true;
  await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen })); assert.equal(attempts, 3);
  fail = false; await f.alerts.history.tick(fresh(f.now()));
  assert.equal(attempts, 4); assert.equal(f.sent.at(-1).payload.kind, 'history-recovered');
});

test('a failed initial warning does not create a recovery notice for a device never notified', async t => {
  const f = setup(t, async () => { throw Object.assign(Error('temporary'), { statusCode: 503 }); });
  f.alerts.subscribe(sub()); await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen }));
  await f.alerts.history.tick(fresh(f.now())); assert.equal(f.sent.length, 0);
});

test('concurrent checks, new subscribers and expired or removed endpoints do not duplicate deliveries', async t => {
  let expired = false;
  const f = setup(t, async device => { await new Promise(r => setTimeout(r, 5)); if (expired && device.endpoint.endsWith('/two')) throw Object.assign(Error('gone'), { statusCode: 410 }); });
  f.alerts.subscribe(sub());
  await Promise.all([f.alerts.history.tick(fresh(f.now(), { mem3: staleTen })), f.alerts.history.tick(fresh(f.now(), { mem3: staleTen }))]);
  assert.equal(f.sent.length, 1);
  f.alerts.subscribe(sub('two'));
  await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen })); assert.equal(f.sent.length, 2);
  f.alerts.unsubscribe(sub()); assert.equal(f.alerts.db.prepare('SELECT COUNT(*) n FROM history_alert_deliveries').get().n, 1);
  f.advance(REPEAT_MS); expired = true;
  await f.alerts.history.tick(fresh(f.now(), { mem3: staleTen }));
  assert.equal(f.alerts.db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0);
  await f.alerts.history.tick(fresh(f.now()));
  assert.equal(f.alerts.db.prepare('SELECT COUNT(*) n FROM history_alert_deliveries').get().n, 0);
  assert.equal(f.sent.length, 2);
});

test('saved-history health reads native SQL times, not successful repeated downloads or live writes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-health-sql-'));
  const p = createPersistence({ WEATHER_DB_PATH: path.join(dir, 'weather.sqlite') }, { error() {} });
  t.after(() => { p.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const row = (stream, time) => ['2026/11/02', time, ...layout.streams[stream].fields.map(f => f.sensorKey === '7' ? '1020' : '0')].join(',');
  const reply = 'MEM 3 LAST 8\r\n' + row('mem3', '07:40:00') + '\r\n\\END OF DATA\r\n';
  p.recordHistory('mem3', reply); p.recordHistory('mem3', reply);
  p.record('r3', row('r3', '10:00:00'));
  assert.equal(p.historyStatus().streams.mem3, '2026-11-01T21:40:00.000Z');
  assert.equal(p.historyStatus().streams.mem2, null);
  assert.equal(historyHealth(p.historyStatus(), Date.parse('2026-11-02T00:00:00Z')).delayed, true);
  p.recordHistory('mem3', reply.replace('07:40:00', '10:00:00'));
  assert.equal(p.historyStatus().streams.mem3, '2026-11-02T00:00:00.000Z');
});

test('history health is available without push support and exposes no subscriber secrets', async t => {
  const app = require('express')();
  const now = Date.now();
  mountAlerts(app, { env: {}, logger: { info() {}, error() {} }, getObservation: () => now,
    getHistoryObservation: () => fresh(now, { mem3: staleTen }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/alerts/history');
  assert.match(response.headers.get('cache-control'), /no-store/);
  const result = await response.json(); assert.equal(result.delayed, true);
  assert.equal(result.feeds.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /endpoint|publicKey|vapid|p256dh/);
});

function withGap(snapshot, { checked = true, missing = 2 } = {}) {
  return { ...snapshot, completeness: { checked, complete: checked && missing === 0, unresolvedGaps: missing ? 1 : 0,
    streams: Object.fromEntries(['mem3', 'mem2', 'mem1'].map(stream => [stream, { checked,
      unresolvedGaps: stream === 'mem3' && missing ? 1 : 0, missingIntervals: stream === 'mem3' ? missing : 0,
      firstMissingAt: stream === 'mem3' && missing ? '2026-11-01T21:50:00.000Z' : null,
      lastMissingAt: stream === 'mem3' && missing ? '2026-11-01T22:00:00.000Z' : null }])) } };
}

test('older gaps stay visible while fresh feeds stop recurring notifications across restarts', async t => {
  const f = setup(t); f.alerts.subscribe(sub());
  const health = historyHealth(withGap(fresh(f.now())), f.now());
  assert.equal(health.incomplete, true); assert.equal(health.delayed, false); assert.equal(health.complete, false);
  assert.equal(health.feeds[0].stale, false); assert.equal(health.feeds[0].missingIntervals, 2);
  assert.match(health.summary, /up to date/); assert.match(health.summary, /unresolved gaps/);
  await f.alerts.history.tick(withGap(fresh(f.now())));
  f.restart(); f.advance(REPEAT_MS);
  await f.alerts.history.tick(withGap(fresh(f.now()), { missing: 1 }));
  assert.equal(f.sent.length, 0);
  await f.alerts.history.tick(withGap(fresh(f.now(), { mem3: staleTen })));
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].payload.body, /2 missing intervals/);
  assert.match(f.sent[0].payload.body, /2026-11-01/);
  assert.equal(f.sent[0].payload.kind, 'history-missing');
  await f.alerts.history.tick(withGap(fresh(f.now()), { missing: 1 }));
  assert.equal(f.sent[1].payload.kind, 'history-recovered');
  assert.match(f.sent[1].payload.body, /Older archive gaps remain/);
  assert.doesNotMatch(f.sent[1].payload.body, /no tracked gaps/i);
  f.restart(); f.advance(REPEAT_MS);
  await f.alerts.history.tick(withGap(fresh(f.now()), { missing: 1 }));
  assert.equal(f.sent.length, 2);
  await f.alerts.history.tick(withGap(fresh(f.now()), { missing: 0 }));
  assert.equal(f.sent.length, 2);
  assert.equal(historyHealth(withGap(fresh(f.now()), { missing: 0 }), f.now()).complete, true);
});

test('current-feed recovery during an unfinished coverage audit does not claim complete history', async t => {
  const f = setup(t); f.alerts.subscribe(sub());
  await f.alerts.history.tick(withGap(fresh(f.now(), { mem3: staleTen })));
  const pending = withGap(fresh(f.now()), { missing: 0, checked: false });
  const health = historyHealth(pending, f.now());
  assert.equal(health.delayed, false); assert.equal(health.checking, true); assert.equal(health.complete, false);
  assert.match(health.summary, /completeness is not yet confirmed/);
  await f.alerts.history.tick(pending);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].payload.kind, 'history-recovered');
  assert.match(f.sent[1].payload.body, /coverage is still being checked/);
  assert.doesNotMatch(f.sent[1].payload.body, /no tracked.*gaps/i);
  f.restart(); f.advance(REPEAT_MS);
  await f.alerts.history.tick(withGap(fresh(f.now()), { missing: 0, checked: false }));
  await f.alerts.history.tick(withGap(fresh(f.now()), { missing: 0 }));
  assert.equal(f.sent.length, 2);
});
