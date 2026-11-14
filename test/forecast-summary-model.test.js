'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildSummary, HOUR_MS, FRESH_MS, MAX_AGE_MS } = require('../public/forecast-summary-model');

const NOW = Date.parse('2026-11-14T09:17:00Z'); // 19:17 AEST
const START = Date.parse('2026-11-14T09:00:00Z');
function fixture(now = NOW) {
  const start = Math.floor(now / HOUR_MS) * HOUR_MS;
  return {
    timezone: 'Australia/Brisbane', source: 'Open-Meteo', fetchedAt: new Date(now).toISOString(), stale: false,
    hourly: Array.from({ length: 27 }, (_, i) => ({
      time: (start + (i - 1) * HOUR_MS) / 1000,
      temperature_2m: 20, precipitation: 0, precipitation_probability: 0,
      weather_code: 3, wind_gusts_10m: 12
    }))
  };
}
const at = (data, hour) => data.hourly.find(row => row.time * 1000 === START + hour * HOUR_MS);

test('the rain window uses the ongoing AEST hour and preceding-hour API intervals', () => {
  const data = fixture();
  at(data, 0).precipitation = 9; // Already ended at 19:00, so exclude.
  at(data, 1).precipitation = 2;
  at(data, 1).temperature_2m = 27;
  at(data, 24).precipitation = 3;
  at(data, 25).precipitation = 11; // Outside the 24-hour window.
  const model = buildSummary(data, NOW);
  assert.equal(model.status, 'fresh'); assert.equal(model.usable, true);
  assert.equal(model.startMs, START); assert.equal(model.endMs, START + 24 * HOUR_MS);
  assert.equal(model.hours.length, 24);
  assert.equal(model.hours[0].startMs, START); assert.equal(model.hours[0].endMs, START + HOUR_MS);
  assert.equal(model.hours[0].rainMm, 2); assert.equal(model.hours[0].tempC, 27);
  assert.equal(model.rain.totalMm, 5); assert.equal(model.rain.nextWet, model.hours[0]);
  assert.equal(model.rain.wettest, model.hours[23]);
});

test('the same rolling window supplies peak hourly chance and temperature high/low', () => {
  const data = fixture();
  at(data, 0).precipitation_probability = 100;
  at(data, 2).precipitation_probability = 51;
  at(data, 3).precipitation_probability = 82;
  at(data, 4).temperature_2m = 16;
  at(data, 20).temperature_2m = 32;
  data.daily = [{ time: START / 1000, precipitation_probability_max: 99, precipitation_sum: 70,
    temperature_2m_max: 45, temperature_2m_min: 2 }];
  const model = buildSummary(data, NOW);
  assert.equal(model.rain.peakChancePercent, 82);
  assert.equal(model.temperature.highC, 32); assert.equal(model.temperature.lowC, 16);
  assert.equal(model.rain.totalMm, 0);
});

test('a genuinely dry full window retains numeric zero rather than becoming unavailable', () => {
  const model = buildSummary(fixture(), NOW);
  assert.equal(model.rain.totalMm, 0); assert.equal(model.rain.knownTotalMm, 0);
  assert.equal(model.rain.peakChancePercent, 0); assert.equal(model.rain.hasRain, false);
  assert.equal(model.rain.nextWet, null); assert.equal(model.rain.wettest, null);
  assert.equal(model.rain.complete, true); assert.equal(model.rain.traceOnly, false);
});

test('traces remain in bars and totals without becoming a substantive next-rain interval', () => {
  const data = fixture(); at(data, 1).precipitation = 0.05;
  let model = buildSummary(data, NOW);
  assert.equal(model.rain.hasRain, true); assert.equal(model.rain.traceOnly, true);
  assert.equal(model.rain.totalMm, 0.05); assert.equal(model.rain.nextWet, null);
  assert.equal(model.rain.wettest, model.hours[0]);
  at(data, 4).precipitation = 0.1;
  model = buildSummary(data, NOW);
  assert.equal(model.rain.traceOnly, false); assert.equal(model.rain.nextWet, model.hours[3]);
});

test('missing hours remain gaps and cannot produce a complete total or all-clear storm signal', () => {
  const data = fixture(); data.hourly = data.hourly.filter(row => row.time * 1000 !== START + 5 * HOUR_MS);
  at(data, 2).precipitation = 2.5;
  const model = buildSummary(data, NOW);
  assert.equal(model.hours.length, 24); assert.equal(model.hours[4].present, false);
  assert.equal(model.hours[4].rainMm, null); assert.equal(model.hours[4].storm, null);
  assert.equal(model.rain.knownHours, 23); assert.equal(model.rain.complete, false);
  assert.equal(model.rain.totalMm, null); assert.equal(model.rain.knownTotalMm, 2.5);
  assert.equal(model.rain.hasRain, true); assert.equal(model.rain.peakChancePercent, null);
  assert.equal(model.temperature.highC, null); assert.equal(model.temperature.lowC, null);
  assert.equal(model.storms.signal, 'unknown');
});

test('missing measurements invalidate only their own window metrics', () => {
  const data = fixture();
  at(data, 5).precipitation = null;
  at(data, 6).precipitation_probability = null;
  at(data, 7).temperature_2m = null;
  const model = buildSummary(data, NOW);
  assert.equal(model.rain.totalMm, null); assert.equal(model.rain.knownTotalMm, 0);
  assert.equal(model.rain.hasRain, null); assert.equal(model.rain.chanceComplete, false);
  assert.equal(model.temperature.complete, false); assert.equal(model.storms.signal, 'none');
  assert.equal(model.storms.knownHours, 24); assert.equal(model.status, 'fresh');
});

test('invalid numeric bounds and unknown weather codes stay missing instead of being coerced', () => {
  const data = fixture();
  Object.assign(at(data, 1), { precipitation: -1, precipitation_probability: 101, temperature_2m: 90,
    weather_code: 999, wind_gusts_10m: -3 });
  Object.assign(at(data, 2), { precipitation: '2', precipitation_probability: false, temperature_2m: Infinity,
    weather_code: '95', wind_gusts_10m: NaN });
  const model = buildSummary(data, NOW);
  for (const h of model.hours.slice(0, 2)) {
    for (const key of ['rainMm', 'chancePercent', 'tempC', 'weatherCode', 'storm', 'gustKmh']) assert.equal(h[key], null, key);
  }
  assert.equal(model.rain.totalMm, null); assert.equal(model.rain.peakChancePercent, null);
  assert.equal(model.temperature.highC, null); assert.equal(model.storms.signal, 'unknown');
});

test('every documented thunderstorm code including97 raises a model signal without inventing probability', () => {
  for (const code of [95, 96, 97, 99]) {
    const data = fixture(); at(data, 3).weather_code = code;
    const model = buildSummary(data, NOW);
    assert.equal(model.storms.signal, 'forecast', String(code));
    assert.equal(model.storms.firstAtMs, START + 3 * HOUR_MS);
    assert.equal(model.storms.lastAtMs, START + 3 * HOUR_MS);
    assert.equal(model.storms.hours.length, 1); assert.equal(model.storms.hours[0].weatherCode, code);
    assert.equal(model.rain.peakChancePercent, 0); assert.equal(model.rain.totalMm, 0);
  }
});

test('rain certainty never substitutes for a thunderstorm code and daily codes do not invent timed storms', () => {
  const data = fixture(); data.hourly.forEach(row => { row.precipitation_probability = 100; row.precipitation = 10; });
  data.daily = [{ time: START / 1000, weather_code: 99 }];
  let model = buildSummary(data, NOW);
  assert.equal(model.storms.signal, 'none'); assert.equal(model.storms.hours.length, 0);
  at(data, 5).weather_code = null;
  model = buildSummary(data, NOW);
  assert.equal(model.storms.signal, 'unknown'); assert.equal(model.storms.hours.length, 0);
  at(data, 6).weather_code = 95;
  model = buildSummary(data, NOW);
  assert.equal(model.storms.signal, 'forecast'); assert.equal(model.storms.complete, false);
});

test('separate storm signals are not combined into an uninterrupted storm window', () => {
  const data = fixture();
  for (const h of [2, 3, 9]) at(data, h).weather_code = 95;
  const model = buildSummary(data, NOW);
  assert.deepEqual(model.storms.windows.map(w => [w.firstAtMs, w.lastAtMs, w.hours.length]), [
    [START + 2 * HOUR_MS, START + 3 * HOUR_MS, 2],
    [START + 9 * HOUR_MS, START + 9 * HOUR_MS, 1]
  ]);
});

test('the window moves across AEST midnight without reusing the previous hour', () => {
  const before = Date.parse('2026-11-14T13:59:00Z'); // 23:59 AEST
  const after = Date.parse('2026-11-14T14:00:00Z'); // Next local day.
  const data = fixture(before);
  data.hourly.find(row => row.time * 1000 === after).precipitation = 4;
  const first = buildSummary(data, before), second = buildSummary(data, after);
  assert.equal(first.hours[0].endMs, after); assert.equal(first.rain.totalMm, 4);
  assert.equal(second.startMs, after); assert.equal(second.hours[0].endMs, after + HOUR_MS);
  assert.equal(second.rain.totalMm, 0); assert.equal(second.hours.length, 24);
});

test('staleness and expiry are computed locally even if the server flag has not changed', () => {
  const data = fixture();
  assert.equal(buildSummary(data, NOW + FRESH_MS - 1).status, 'fresh');
  assert.equal(buildSummary(data, NOW + FRESH_MS).status, 'stale');
  data.stale = true;
  assert.equal(buildSummary(data, NOW).status, 'stale');
  const expired = buildSummary(data, NOW + MAX_AGE_MS);
  assert.equal(expired.status, 'expired'); assert.equal(expired.usable, false);
  assert.equal(expired.rain.totalMm, null); assert.equal(expired.rain.knownTotalMm, null);
  assert.equal(expired.storms.signal, 'unknown'); assert.ok(expired.hours.every(h => h.rainMm === null));
});

test('missing, future or invalid metadata cannot display a usable forecast', () => {
  for (const alter of [data => { data.fetchedAt = null; }, data => { data.fetchedAt = 'not a date'; },
    data => { data.fetchedAt = new Date(NOW + 1).toISOString(); }, data => { data.timezone = 'UTC'; },
    data => { data.hourly = []; }, data => { data.hourly = 'invalid'; }]) {
    const data = fixture(); alter(data);
    const model = buildSummary(data, NOW);
    assert.equal(model.status, 'unavailable'); assert.equal(model.usable, false);
    assert.equal(model.rain.totalMm, null); assert.equal(model.storms.signal, 'unknown');
  }
  assert.equal(buildSummary(null, NOW).usable, false);
  assert.equal(buildSummary(fixture(), NaN).usable, false);
});

test('duplicate timestamps invalidate that hour and unordered valid rows keep their actual intervals', () => {
  const data = fixture(); at(data, 3).precipitation = 2;
  const ordered = buildSummary(data, NOW);
  data.hourly.reverse();
  assert.deepEqual(buildSummary(data, NOW), ordered);
  data.hourly.push({ ...at(data, 3), precipitation: 50 });
  const duplicate = buildSummary(data, NOW);
  assert.equal(duplicate.hours[2].present, false); assert.equal(duplicate.hours[2].rainMm, null);
  assert.equal(duplicate.rain.totalMm, null); assert.equal(duplicate.rain.knownTotalMm, 0);
});

test('off-grid and nonnumeric times cannot move rainfall into a nearby hour', () => {
  const data = fixture();
  at(data, 3).time += 60;
  at(data, 4).time = String(at(data, 4).time);
  const model = buildSummary(data, NOW);
  assert.equal(model.hours[2].present, false); assert.equal(model.hours[3].present, false);
  assert.equal(model.rain.knownHours, 22); assert.equal(model.rain.totalMm, null);
});

test('building a summary is pure and the browser export matches the CommonJS API', () => {
  const data = fixture(), original = structuredClone(data);
  data.source = '<script>untrusted</script>';
  original.source = data.source;
  const model = buildSummary(data, NOW);
  assert.deepEqual(data, original); assert.equal(model.source, 'Open-Meteo');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../public/forecast-summary-model'), 'utf8'), context);
  assert.equal(typeof context.MooreForecastSummary.buildSummary, 'function');
  assert.equal(context.MooreForecastSummary.buildSummary(data, NOW).rain.totalMm, 0);
});
