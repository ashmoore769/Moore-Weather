'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MAINTENANCE, maintenanceWindow, createStationMaintenance } = require('../lib/station-maintenance');
const time = value => Date.parse(value + '+10:00');

test('known modem schedule produces the exact five-minute outage and bounded reconnection grace in AEST', () => {
  const window = maintenanceWindow(time('2026-11-15T05:02:00'));
  assert.deepEqual(window, {
    date: '2026-11-15', start: time('2026-11-15T04:55:00'), end: time('2026-11-15T05:00:00'),
    graceUntil: time('2026-11-15T05:05:00'), active: true, reconnecting: true
  });
  assert.equal(DEFAULT_MAINTENANCE.timezone, 'Australia/Brisbane');
});

test('suppression starts at 04:55 and ends exactly at 05:05, without extending the reading clock', () => {
  const policy = createStationMaintenance();
  const lastGood = time('2026-11-15T04:54:00');
  const input = { now: time('2026-11-15T04:54:59.999'), lastGood };
  assert.equal(policy.suppressOffline(input), false);
  input.now = time('2026-11-15T04:55:00');
  assert.equal(policy.suppressOffline(input), true);
  input.now = time('2026-11-15T05:04:59.999');
  assert.equal(policy.suppressOffline(input), true);
  input.now = time('2026-11-15T05:05:00');
  assert.equal(policy.suppressOffline(input), false);
  input.now = time('2026-11-15T05:10:00');
  assert.equal(policy.suppressOffline(input), false);
  assert.equal(input.lastGood, lastGood);
});

test('readings already stale before maintenance cannot use the planned window', () => {
  const policy = createStationMaintenance();
  const now = time('2026-11-15T04:59:00');
  assert.equal(policy.suppressOffline({ now, lastGood: time('2026-11-15T04:52:00') }), true);
  assert.equal(policy.suppressOffline({ now, lastGood: time('2026-11-15T04:51:59.999') }), false);
  assert.equal(policy.suppressOffline({ now, lastGood: time('2026-11-15T04:30:00') }), false);
  assert.equal(policy.suppressOffline({ now, lastGood: time('2026-11-14T04:54:00') }), false);
});

test('a device already notified of a real outage keeps its recovery eligibility', () => {
  const policy = createStationMaintenance();
  const event = { now: time('2026-11-15T04:59:00'), lastGood: time('2026-11-15T04:54:00') };
  assert.equal(policy.suppressOffline({ ...event, alreadyAlerted: true }), false);
  assert.equal(policy.suppressOffline({ ...event, alreadyAlerted: 1 }), false);
  assert.equal(policy.suppressOffline({ ...event, alreadyAlerted: false }), true);
});

test('suppression is deterministic after restart and a previous incident cannot carry into the next day', () => {
  const event = { now: time('2026-11-15T05:02:00'), lastGood: time('2026-11-15T04:54:00') };
  assert.equal(createStationMaintenance().suppressOffline(event), true);
  assert.equal(createStationMaintenance().suppressOffline({ ...event }), true);
  const nextDay = { ...event, now: event.now + 86400000 };
  assert.equal(createStationMaintenance().suppressOffline(nextDay), false);
});

test('Brisbane timing stays the same in winter and summer and has no midnight suppression', () => {
  for (const day of ['2026-01-01', '2026-07-01', '2026-11-15']) {
    assert.equal(maintenanceWindow(time(day + 'T04:59:00')).active, true);
    assert.equal(maintenanceWindow(time(day + 'T00:00:00')).active, false);
    assert.equal(maintenanceWindow(time(day + 'T23:59:59')).active, false);
    assert.equal(maintenanceWindow(time(day + 'T05:05:00')).active, false);
  }
});

test('disabled policy and missing, future or invalid time evidence cannot suppress alerts', () => {
  const event = { now: time('2026-11-15T04:59:00'), lastGood: time('2026-11-15T04:54:00') };
  assert.equal(createStationMaintenance({ WEATHER_PLANNED_MODEM_OUTAGE_ENABLED: 'false' }).suppressOffline(event), false);
  const policy = createStationMaintenance();
  for (const lastGood of [null, undefined, NaN, Infinity, '2026-11-15T04:54:00+10:00', event.now + 1]) {
    assert.equal(policy.suppressOffline({ ...event, lastGood }), false);
  }
  for (const now of [null, undefined, NaN, Infinity, 1e100]) {
    assert.equal(policy.suppressOffline({ ...event, now }), false);
    assert.equal(maintenanceWindow(now), null);
  }
  assert.equal(policy.suppressOffline(), false);
  assert.ok(Object.isFrozen(policy.config));
});

test('history grace covers only a newly overdue feed within the current modem window', () => {
  const policy = createStationMaintenance();
  const overdueSince = time('2026-11-15T05:00:00');
  const event = { now: time('2026-11-15T05:00:58'), overdueSince };
  assert.equal(policy.suppressHistory(event), true);
  assert.equal(policy.suppressHistory({ ...event, now: time('2026-11-15T05:04:59.999') }), true);
  assert.equal(policy.suppressHistory({ ...event, now: time('2026-11-15T05:05:00') }), false);
  assert.equal(policy.suppressHistory({ ...event, overdueSince: time('2026-11-15T04:54:59.999') }), false);
  assert.equal(policy.suppressHistory({ ...event, overdueSince: time('2026-11-14T05:00:00') }), false);
  assert.equal(policy.suppressHistory({ ...event, alreadyAlerted: true }), false);
  assert.equal(createStationMaintenance({ WEATHER_PLANNED_MODEM_OUTAGE_ENABLED: 'false' }).suppressHistory(event), false);
  for (const value of [null, undefined, NaN, Infinity, '2026-11-15T05:00:00+10:00', event.now + 1]) {
    assert.equal(policy.suppressHistory({ ...event, overdueSince: value }), false);
  }
  for (const now of [null, undefined, NaN, Infinity, 1e100]) {
    assert.equal(policy.suppressHistory({ ...event, now }), false);
  }
  assert.equal(policy.suppressHistory(), false);
});
