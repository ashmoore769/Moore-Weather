'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch, parseTimestamp, localDay, todayEnergy, DAY, MINUTE } = require('../lib/solar-data');

const NOW = Date.parse('2026-11-14T02:00:00.000Z');
function sample(observedAt = '2026-11-14T01:59:00.000Z', overrides = {}) {
  return { observedAt, collectedAt: observedAt, pvPowerW: 1000, inverterPowerW: 950, gridPowerW: -400,
    loadPowerW: 550, batteryPowerW: null, batterySocPercent: null, totalAcEnergyWh: 120000,
    meterLocation: 'grid', mode: 'meter', ...overrides };
}
const body = samples => ({ version: 1, samples });

test('solar contract preserves valid zero, signed power and unavailable readings without coercion', () => {
  const input = sample(undefined, { pvPowerW: 0, inverterPowerW: -5, gridPowerW: 0, loadPowerW: -200,
    batteryPowerW: -1500, batterySocPercent: 0, totalAcEnergyWh: null });
  assert.deepEqual(validateBatch(body([input]), NOW), [input]);
  for (const [key, value] of [['pvPowerW', '0'], ['pvPowerW', -1], ['inverterPowerW', Infinity],
    ['loadPowerW', NaN], ['gridPowerW', 1000001], ['batterySocPercent', 101], ['totalAcEnergyWh', -1]]) {
    assert.throws(() => validateBatch(body([sample(undefined, { [key]: value })]), NOW), /Invalid solar measurement/);
  }
  assert.throws(() => validateBatch(body([sample(undefined, { serial: 'not-accepted' })]), NOW), /fields/);
  assert.throws(() => validateBatch({ ...body([sample()]), sourceId: 'different-house' }, NOW), /Expected/);
  assert.throws(() => validateBatch(body([sample(undefined, { mode: '<script>' })]), NOW), /mode/);
  assert.throws(() => validateBatch(body([sample(undefined, { meterLocation: 'anywhere' })]), NOW), /location/);
});

test('timestamps require real calendar values and an explicit timezone, with bounded replay and future skew', () => {
  const equivalent = sample('2026-11-14T11:59:00+10:00', { collectedAt: '2026-11-14T01:59:00.000000Z' });
  assert.equal(validateBatch(body([equivalent]), NOW)[0].observedAt, '2026-11-14T01:59:00.000Z');
  for (const at of ['2026-02-30T01:00:00Z', '2026-11-14T25:00:00Z', '2026-11-14T01:00:00',
    '2026-11-14T01:00:00+14:01', 'not-a-date']) assert.throws(() => parseTimestamp(at), /timestamp/);
  for (const at of [NOW - 14 * DAY - 1, NOW + 5 * MINUTE + 1]) {
    assert.throws(() => validateBatch(body([sample(new Date(at).toISOString())]), NOW), /window/);
  }
  assert.equal(validateBatch(body([sample(new Date(NOW - 14 * DAY).toISOString())]), NOW).length, 1);
  assert.throws(() => validateBatch(body([sample('2026-11-14T02:00:00Z', {
    collectedAt: '2026-11-14T01:54:59Z' })]), NOW), /window/);
  assert.throws(() => validateBatch(body([]), NOW), /1 to 120/);
  assert.throws(() => validateBatch(body(Array.from({ length: 121 }, () => sample())), NOW), /1 to 120/);
});

test('today is Brisbane midnight, and an incomplete first day never pretends to have a full daily total', () => {
  assert.deepEqual(localDay(Date.parse('2026-11-13T14:01:00Z')),
    { date: '2026-11-14', start: Date.parse('2026-11-13T14:00:00Z') });
  const rows = [sample('2026-11-14T01:58:00.000Z', { totalAcEnergyWh: 1000 }),
    sample('2026-11-14T01:59:00.000Z', { totalAcEnergyWh: 1100 })];
  const value = todayEnergy(rows, NOW);
  assert.equal(value.date, '2026-11-14');
  assert.equal(value.energyAcWh, 100);
  assert.equal(value.quality, 'partial');
  assert.equal(value.since, rows[0].observedAt);
  assert.match(value.label, /first reading/);
  assert.equal(todayEnergy([rows[0]], NOW).energyAcWh, null);
  assert.equal(todayEnergy([sample(undefined, { totalAcEnergyWh: null })], NOW).energyAcWh, null);
  assert.equal(todayEnergy([], NOW).quality, 'unavailable');
});

test('midnight counter baseline requires evidence spanning the GEN24 update interval; gaps stay explicit', () => {
  const start = localDay(NOW).start;
  const rows = Array.from({ length: 8 }, (_, i) => sample(new Date(start + (i - 1) * MINUTE + 1000).toISOString(),
    { totalAcEnergyWh: 1000, pvPowerW: 0, inverterPowerW: 0 }));
  const beforeFullInterval = todayEnergy(rows.slice(0, 5), start + 4 * MINUTE);
  assert.equal(beforeFullInterval.quality, 'partial');
  const complete = todayEnergy(rows, start + 7 * MINUTE);
  assert.equal(complete.quality, 'complete');
  assert.equal(complete.energyAcWh, 0);
  assert.equal(complete.since, new Date(start).toISOString());
  const missingCounter = rows.map((row, i) => ({ ...row, totalAcEnergyWh: i >= 1 && i <= 4 ? null : 1000 }));
  assert.equal(todayEnergy(missingCounter, start + 7 * MINUTE).quality, 'partial');
  const gap = todayEnergy([...rows, sample(new Date(start + 30 * MINUTE).toISOString(), { totalAcEnergyWh: 1100 })], start + 31 * MINUTE);
  assert.equal(gap.energyAcWh, 100);
  assert.equal(gap.quality, 'partial');
  assert.equal(gap.gapCount, 1);
});

test('counter reset withholds a derived daily total and new day excludes the previous day reset', () => {
  const start = localDay(NOW).start;
  const rows = [sample(new Date(start).toISOString(), { totalAcEnergyWh: 2000 }),
    sample(new Date(start + MINUTE).toISOString(), { totalAcEnergyWh: 10 }),
    sample(new Date(start + 2 * MINUTE).toISOString(), { totalAcEnergyWh: 20 })];
  const reset = todayEnergy(rows, start + 3 * MINUTE);
  assert.equal(reset.energyAcWh, null);
  assert.equal(reset.quality, 'reset');
  assert.equal(reset.counterReset, true);
  const nextDay = todayEnergy([...rows, sample(new Date(start + DAY).toISOString(), { totalAcEnergyWh: 1000 }),
    sample(new Date(start + DAY + MINUTE).toISOString(), { totalAcEnergyWh: 1005 })], start + DAY + 2 * MINUTE);
  assert.equal(nextDay.energyAcWh, 5);
  assert.equal(nextDay.quality, 'complete');
  assert.equal(nextDay.counterReset, false);
});

test('fresh power without a fresh energy counter cannot claim a complete current daily total', () => {
  const start = localDay(NOW).start;
  const rows = [sample(new Date(start).toISOString(), { totalAcEnergyWh: 1000 }),
    sample(new Date(start + MINUTE).toISOString(), { totalAcEnergyWh: 1005 }),
    sample(new Date(start + 6 * MINUTE).toISOString(), { totalAcEnergyWh: null })];
  const value = todayEnergy(rows, start + 6 * MINUTE);
  assert.equal(value.quality, 'partial');
  assert.equal(value.energyAcWh, 5);
  assert.equal(value.through, rows[1].observedAt);
  assert.equal(value.gapCount, 1);
});
