'use strict';

const { DAY, FRESH_FOR, localDay } = require('./solar-data');

// Rates are AUD, inclusive of GST where charged. They are deliberately dated,
// manual inputs from the household's bills, not a claim of live retailer prices.
const TARIFFS = Object.freeze([
  Object.freeze({ effectiveFrom: '2025-07-01', importPerKwh: 0.329725,
    exportPerKwh: 0.0866, supplyPerDay: 1.688423 }),
  Object.freeze({ effectiveFrom: '2026-07-01', importPerKwh: 0.288948,
    exportPerKwh: 0.06006, supplyPerDay: 1.805078 })
]);
const MAX_GAP = FRESH_FOR;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => Math.max(0, value);
const iso = value => value === null ? null : new Date(value).toISOString();

function ratesFor(value) {
  const date = typeof value === 'string' ? value.slice(0, 10) : localDay(value).date;
  const tariff = TARIFFS.filter(candidate => candidate.effectiveFrom <= date).at(-1);
  return tariff ? { ...tariff, currency: 'AUD', source: 'Verified electricity bills', reviewedAt: '2026-11-14' } : null;
}

function solarToHomePower(sample) {
  if (!sample || !finite(sample.inverterPowerW) || !finite(sample.gridPowerW) ||
      !finite(sample.loadPowerW) || sample.loadPowerW < 0 ||
      (sample.batteryPowerW !== null && sample.batteryPowerW !== undefined && sample.batteryPowerW !== 0)) return null;
  // AC output and the home/grid meter are comparable; panel DC output is not.
  // An active battery makes this simple solar attribution ambiguous.
  return Math.min(positive(sample.inverterPowerW), sample.loadPowerW,
    positive(sample.loadPowerW - positive(sample.gridPowerW)));
}

function linear(a, b, fraction) { return a + (b - a) * fraction; }

// Integrate the positive or negative side of a signed linear power interval.
// Clipping the endpoint values before one trapezoid would over-count a crossing.
function signedAreas(a, b, milliseconds) {
  if (a >= 0 && b >= 0) return [(a + b) / 2 * milliseconds / 3600000, 0];
  if (a <= 0 && b <= 0) return [0, -(a + b) / 2 * milliseconds / 3600000];
  const fraction = -a / (b - a);
  if (a > 0) return [a * fraction / 2 * milliseconds / 3600000,
    -b * (1 - fraction) / 2 * milliseconds / 3600000];
  return [b * (1 - fraction) / 2 * milliseconds / 3600000,
    -a * fraction / 2 * milliseconds / 3600000];
}

function solarArea(a, b, milliseconds) {
  // All possible branches of min(AC+, load, (load-grid+)^+) are linear.
  // Split at their intersections so changing import direction/AC limits does
  // not invent self-consumption within the minute between readings.
  const candidates = [[0, 0], [a.inverterPowerW, b.inverterPowerW],
    [a.loadPowerW, b.loadPowerW], [a.loadPowerW - a.gridPowerW, b.loadPowerW - b.gridPowerW]];
  const cuts = new Set([0, 1]);
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const from = candidates[i][0] - candidates[j][0], to = candidates[i][1] - candidates[j][1];
      if (from !== to) { const fraction = -from / (to - from); if (fraction > 0 && fraction < 1) cuts.add(fraction); }
    }
  }
  const points = [...cuts].sort((left, right) => left - right);
  const at = fraction => solarToHomePower({ inverterPowerW: linear(a.inverterPowerW, b.inverterPowerW, fraction),
    loadPowerW: linear(a.loadPowerW, b.loadPowerW, fraction),
    gridPowerW: linear(a.gridPowerW, b.gridPowerW, fraction), batteryPowerW: 0 });
  let area = 0;
  for (let i = 1; i < points.length; i++) area += (at(points[i - 1]) + at(points[i])) / 2 *
    (points[i] - points[i - 1]) * milliseconds / 3600000;
  return area;
}

function integrateDay(samples, start, now = start + DAY + MAX_GAP) {
  const end = Math.min(start + DAY, now), expectedSeconds = Math.max(0, end - start) / 1000;
  const result = { date: localDay(start).date, since: null, through: null, quality: 'unavailable',
    sampleCount: 0, gapCount: 0, missingIntervalCount: 0, coveredSeconds: 0, expectedSeconds, coveragePercent: 0,
    coverageSeconds: { grid: 0, load: 0, generation: 0, solarToHome: 0 },
    gridImportWh: null, gridExportWh: null, loadWh: null, solarToHomeWh: null, generatedAcWh: null,
    importCost: null, exportCredit: null, selfUseValue: null, supplyCost: null, netCost: null };
  const rates = ratesFor(result.date);
  result.supplyCost = rates?.supplyPerDay ?? null;
  // Never extend the last sample forward or use an observation from the future.
  // The store provides chronological, unique observations plus boundary peers.
  const rows = samples.map(sample => ({ sample, at: Date.parse(sample.observedAt) }))
    .filter(row => Number.isFinite(row.at) && row.at <= now);
  result.sampleCount = rows.filter(row => row.at >= start && row.at < start + DAY).length;
  let first = null, last = null;
  const totals = { gridImportWh: 0, gridExportWh: 0, loadWh: 0, solarToHomeWh: 0, generatedAcWh: 0 };
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1], current = rows[index], span = current.at - previous.at;
    const from = Math.max(start, previous.at), to = Math.min(end, current.at);
    if (to <= from || span <= 0) continue;
    if (span > MAX_GAP) { result.gapCount++; continue; }
    const seconds = (to - from) / 1000, left = (from - previous.at) / span, right = (to - previous.at) / span;
    const clip = key => [linear(previous.sample[key], current.sample[key], left),
      linear(previous.sample[key], current.sample[key], right)];
    const has = key => finite(previous.sample[key]) && finite(current.sample[key]);
    const grid = has('gridPowerW'), load = has('loadPowerW') && previous.sample.loadPowerW >= 0 && current.sample.loadPowerW >= 0;
    const generation = has('inverterPowerW');
    const self = solarToHomePower(previous.sample) !== null && solarToHomePower(current.sample) !== null;
    if (!grid || !load || !generation || !self) result.missingIntervalCount++;
    if (!grid && !load && !generation) continue;
    first = first === null ? from : Math.min(first, from); last = last === null ? to : Math.max(last, to);
    if (grid) {
      const [importWh, exportWh] = signedAreas(...clip('gridPowerW'), to - from);
      totals.gridImportWh += importWh; totals.gridExportWh += exportWh;
      result.coverageSeconds.grid += seconds;
    }
    if (load) { totals.loadWh += signedAreas(...clip('loadPowerW'), to - from)[0]; result.coverageSeconds.load += seconds; }
    if (generation) {
      totals.generatedAcWh += signedAreas(...clip('inverterPowerW'), to - from)[0];
      result.coverageSeconds.generation += seconds;
    }
    if (self) {
      const a = { batteryPowerW: 0 }, b = { batteryPowerW: 0 };
      for (const key of ['inverterPowerW', 'gridPowerW', 'loadPowerW']) [a[key], b[key]] = clip(key);
      totals.solarToHomeWh += solarArea(a, b, to - from); result.coverageSeconds.solarToHome += seconds;
    }
    if (grid && load && generation && self) result.coveredSeconds += seconds;
  }
  for (const [key, coverage] of [['gridImportWh', 'grid'], ['gridExportWh', 'grid'], ['loadWh', 'load'],
    ['generatedAcWh', 'generation'], ['solarToHomeWh', 'solarToHome']]) {
    if (result.coverageSeconds[coverage] > 0) result[key] = totals[key];
  }
  result.since = iso(first); result.through = iso(last);
  result.coveragePercent = expectedSeconds > 0 ? Math.min(100, result.coveredSeconds / expectedSeconds * 100) : 0;
  // Complete means nearly continuous measurements from midnight to now/day end,
  // with at most the normal three-minute freshness tolerance at the boundaries.
  if (first !== null) result.quality = result.coveragePercent >= 98 && result.gapCount === 0 &&
    result.missingIntervalCount === 0 && first <= start + MAX_GAP && last >= end - MAX_GAP ? 'complete' : 'partial';
  if (rates) {
    if (result.gridImportWh !== null) {
      result.importCost = result.gridImportWh / 1000 * rates.importPerKwh;
      result.exportCredit = result.gridExportWh / 1000 * rates.exportPerKwh;
      result.netCost = result.importCost - result.exportCredit + result.supplyCost;
    }
    if (result.solarToHomeWh !== null) result.selfUseValue = result.solarToHomeWh / 1000 * rates.importPerKwh;
  }
  return result;
}

module.exports = { TARIFFS, MAX_GAP, ratesFor, solarToHomePower, signedAreas, integrateDay };
