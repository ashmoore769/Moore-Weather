'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DAY, MINUTE, localDay } = require('../lib/solar-data');
const { ratesFor, signedAreas, solarToHomePower, integrateDay } = require('../lib/solar-energy');

const START = localDay(Date.parse('2026-11-14T02:00:00Z')).start;
function sample(at, overrides = {}) {
  return { observedAt: new Date(at).toISOString(), inverterPowerW: 1000, pvPowerW: 1500,
    gridPowerW: 1000, loadPowerW: 2000, batteryPowerW: null, ...overrides };
}
function near(actual, expected, message) { assert.ok(Math.abs(actual - expected) < 1e-8, message || `${actual} != ${expected}`); }

test('imports and exports integrate their own sides of a zero crossing without cancelling purchases', () => {
  const [imports, exports] = signedAreas(1000, -1000, MINUTE);
  near(imports, 25 / 6); near(exports, 25 / 6);
  assert.deepEqual(signedAreas(0, 0, MINUTE), [0, 0]);
  near(signedAreas(-1000, -2000, MINUTE)[1], 25);
  const value = integrateDay([sample(START), sample(START + MINUTE, { gridPowerW: -1000 })], START, START + MINUTE);
  near(value.gridImportWh, 25 / 6); near(value.gridExportWh, 25 / 6);
  near(value.importCost, 25 / 6 / 1000 * 0.288948);
  near(value.exportCredit, 25 / 6 / 1000 * 0.06006);
});

test('one complete hour prices recorded AC/grid energy and adds the daily supply charge only once', () => {
  const rows = Array.from({ length: 61 }, (_, index) => sample(START + index * MINUTE));
  const value = integrateDay(rows, START, START + 60 * MINUTE);
  near(value.gridImportWh, 1000); assert.equal(value.gridExportWh, 0);
  near(value.loadWh, 2000); near(value.generatedAcWh, 1000); near(value.solarToHomeWh, 1000);
  near(value.importCost, 0.288948); near(value.selfUseValue, 0.288948);
  near(value.netCost, 0.288948 + 1.805078, 'avoided purchase is not deducted again from the net bill');
  assert.equal(value.supplyCost, 1.805078);
  assert.equal(value.coveredSeconds, 3600); assert.equal(value.coveragePercent, 100);
  assert.equal(value.quality, 'complete'); assert.equal(value.sampleCount, 61);
});

test('large gaps and last readings are never held forward; a new installation remains a partial day', () => {
  const none = integrateDay([sample(START), sample(START + 10 * MINUTE)], START, START + 10 * MINUTE);
  assert.equal(none.gridImportWh, null); assert.equal(none.netCost, null);
  assert.equal(none.quality, 'unavailable'); assert.equal(none.gapCount, 1);
  const first = START + 12 * 60 * MINUTE;
  const partial = integrateDay([sample(first), sample(first + MINUTE)], START, first + 10 * MINUTE);
  near(partial.gridImportWh, 1000 / 60);
  assert.equal(partial.coveredSeconds, 60); assert.equal(partial.quality, 'partial');
  assert.equal(partial.since, new Date(first).toISOString());
  assert.equal(partial.through, new Date(first + MINUTE).toISOString());
  assert.equal(integrateDay([sample(first)], START, first + 10 * MINUTE).gridImportWh, null);
});

test('missing channels are unknown, genuine zero is measured, and only shared coverage can be complete', () => {
  const rows = [sample(START, { gridPowerW: null }), sample(START + MINUTE, { gridPowerW: null })];
  const missing = integrateDay(rows, START, START + MINUTE);
  assert.equal(missing.gridImportWh, null); assert.equal(missing.importCost, null);
  assert.equal(missing.netCost, null); assert.equal(missing.solarToHomeWh, null);
  near(missing.generatedAcWh, 1000 / 60);
  assert.equal(missing.quality, 'partial'); assert.equal(missing.coveredSeconds, 0);
  assert.deepEqual(missing.coverageSeconds, { grid: 0, load: 60, generation: 60, solarToHome: 0 });
  const zeros = [sample(START, { inverterPowerW: 0, gridPowerW: 0, loadPowerW: 0 }),
    sample(START + MINUTE, { inverterPowerW: 0, gridPowerW: 0, loadPowerW: 0 })];
  const measured = integrateDay(zeros, START, START + MINUTE);
  assert.equal(measured.gridImportWh, 0); assert.equal(measured.gridExportWh, 0);
  assert.equal(measured.solarToHomeWh, 0); assert.equal(measured.quality, 'complete');
  assert.equal(measured.netCost, 1.805078);
});

test('solar-to-home uses AC, handles branch crossings, and withholds battery attribution', () => {
  const rows = [sample(START, { inverterPowerW: 2000, loadPowerW: 1000, gridPowerW: 1000 }),
    sample(START + 2 * MINUTE, { inverterPowerW: 2000, loadPowerW: 1000, gridPowerW: -1000 })];
  near(integrateDay(rows, START, START + 2 * MINUTE).solarToHomeWh, 25);
  assert.equal(solarToHomePower(sample(START, { inverterPowerW: 500, pvPowerW: 10000, gridPowerW: -500 })), 500);
  assert.equal(solarToHomePower(sample(START, { inverterPowerW: -5, gridPowerW: -500 })), 0);
  assert.equal(solarToHomePower(sample(START, { loadPowerW: -1 })), null);
  for (const batteryPowerW of [-100, 100]) {
    const value = integrateDay(rows.map(row => ({ ...row, batteryPowerW })), START, START + 2 * MINUTE);
    assert.equal(value.solarToHomeWh, null); assert.equal(value.selfUseValue, null);
    assert.equal(value.quality, 'partial'); assert.ok(value.gridImportWh > 0);
  }
});

test('Brisbane midnight splits intervals and applies each day\'s effective tariff', () => {
  const midnight = Date.parse('2026-06-30T14:00:00Z');
  const rows = [sample(midnight - MINUTE), sample(midnight + MINUTE)];
  const previous = integrateDay(rows, midnight - DAY, midnight + MINUTE);
  const next = integrateDay(rows, midnight, midnight + MINUTE);
  assert.equal(previous.date, '2026-06-30'); assert.equal(next.date, '2026-07-01');
  near(previous.gridImportWh, 1000 / 60); near(next.gridImportWh, 1000 / 60);
  near(previous.importCost, 1000 / 60 / 1000 * 0.329725);
  near(next.importCost, 1000 / 60 / 1000 * 0.288948);
  assert.equal(previous.supplyCost, 1.688423); assert.equal(next.supplyCost, 1.805078);
  assert.equal(ratesFor(midnight - 1).effectiveFrom, '2025-07-01');
  assert.equal(ratesFor(midnight).effectiveFrom, '2026-07-01');
  assert.equal(ratesFor('2025-06-30'), null, 'unverified older prices are not fabricated');
});

test('future timestamps and changing energy counters cannot invent or duplicate integrated power', () => {
  const rows = [sample(START, { totalAcEnergyWh: 10000 }),
    sample(START + MINUTE, { totalAcEnergyWh: 0 }), sample(START + 2 * MINUTE, { totalAcEnergyWh: 100000 })];
  const value = integrateDay(rows, START, START + MINUTE);
  near(value.generatedAcWh, 1000 / 60); near(value.gridImportWh, 1000 / 60);
  assert.equal(value.sampleCount, 2); assert.equal(value.coveredSeconds, 60);
  assert.equal(value.through, rows[1].observedAt);
});
