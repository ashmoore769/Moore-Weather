'use strict';

// Independent regression checks for the financial and coverage failure modes
// found during review. All observations are synthetic and remain offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DAY, MINUTE, localDay } = require('../lib/solar-data');
const { integrateDay } = require('../lib/solar-energy');
const { SolarStore, SOURCE } = require('../lib/solar-store');

const START = localDay(Date.parse('2026-11-14T02:00:00Z')).start;
const sample = (at, values = {}) => ({
  observedAt: new Date(at).toISOString(), collectedAt: new Date(at).toISOString(),
  pvPowerW: 1200, inverterPowerW: 1000, gridPowerW: 500, loadPowerW: 1500,
  batteryPowerW: null, batterySocPercent: null, totalAcEnergyWh: null,
  meterLocation: 'grid', mode: 'meter', ...values
});
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon,
  `${actual} differs from ${expected}`);

test('self-use integration agrees with independent numerical quadrature across changing limiting flows', () => {
  let seed = 6799;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let scenario = 0; scenario < 80; scenario++) {
    const flow = () => ({ inverterPowerW: random() * 15000 - 1000,
      loadPowerW: random() * 15000, gridPowerW: random() * 30000 - 15000 });
    const first = flow(), last = flow();
    const actual = integrateDay([sample(START, first), sample(START + MINUTE, last)], START, START + MINUTE);
    let expected = 0;
    const subdivisions = 10000;
    for (let index = 0; index < subdivisions; index++) {
      const fraction = (index + .5) / subdivisions;
      const ac = first.inverterPowerW + (last.inverterPowerW - first.inverterPowerW) * fraction;
      const house = first.loadPowerW + (last.loadPowerW - first.loadPowerW) * fraction;
      const grid = first.gridPowerW + (last.gridPowerW - first.gridPowerW) * fraction;
      expected += Math.min(Math.max(0, ac), house, Math.max(0, house - Math.max(0, grid))) / subdivisions / 60;
    }
    near(actual.solarToHomeWh, expected, 1e-5);
    assert.ok(actual.solarToHomeWh >= 0);
    assert.ok(actual.solarToHomeWh <= actual.generatedAcWh + 1e-8, 'house solar cannot exceed usable generation');
    assert.ok(actual.solarToHomeWh <= actual.loadWh + 1e-8, 'house solar cannot exceed household use');
  }
});

test('high percentage coverage cannot hide a genuine outage or an unavailable measurement', () => {
  const complete = Array.from({ length: 1441 }, (_, index) => sample(START + index * MINUTE));
  const outage = complete.filter((_, index) => index < 500 || index > 504);
  const missing = complete.map((row, index) => index === 500 ? { ...row, gridPowerW: null } : row);
  for (const rows of [outage, missing]) {
    const value = integrateDay(rows, START, START + DAY);
    assert.ok(value.coveragePercent > 98, 'fixture retains a high percentage of the day');
    assert.equal(value.quality, 'partial', 'measured gaps remain partial even above the percentage threshold');
  }
});

test('a recorded export surplus can produce a net credit without counting self-use as another rebate', () => {
  const rows = Array.from({ length: 241 }, (_, index) => sample(START + index * MINUTE,
    { inverterPowerW: 11000, gridPowerW: -10000, loadPowerW: 1000 }));
  const value = integrateDay(rows, START, START + 4 * 60 * MINUTE);
  near(value.gridImportWh, 0); near(value.gridExportWh, 40000);
  near(value.solarToHomeWh, 4000);
  near(value.netCost, 1.805078 - 40 * .06006);
  assert.ok(value.netCost < 0, 'valid net credits are not clamped to zero');
  near(value.netCost, value.importCost - value.exportCredit + value.supplyCost);
});

test('daily financial archives do not depend on upload chunk sizes or arrival order', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rows = Array.from({ length: 11 }, (_, index) => sample(START + (index - 5) * MINUTE,
    { inverterPowerW: 1500 + index * 31, loadPowerW: 1700,
      gridPowerW: [900, 100, -400, -1000, 0, 1700, 500, -800, -300, 200, 1500][index] }));
  const orders = [rows.map((_, index) => index), [10, 0, 5, 2, 8, 1, 9, 7, 3, 6, 4]];
  const archives = orders.map((order, scenario) => {
    const filename = path.join(directory, `${scenario}.sqlite`);
    new DatabaseSync(filename).close();
    const store = new SolarStore(filename);
    try {
      if (scenario === 0) store.save(rows, START + 10 * MINUTE);
      else for (const index of order) store.save([rows[index]], START + 10 * MINUTE);
      return store.db.prepare('SELECT local_date, summary_json FROM solar_daily WHERE source_id=? ORDER BY local_date')
        .all(SOURCE).map(row => ({ date: row.local_date, summary: JSON.parse(row.summary_json) }));
    } finally { store.close(); }
  });
  assert.equal(archives[0].length, 2, 'fixture crosses Brisbane midnight');
  assert.deepEqual(archives[1], archives[0]);
});
