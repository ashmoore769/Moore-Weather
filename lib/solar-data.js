'use strict';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const OFFSET = 10 * 60 * MINUTE;
const MAX_AGE = 14 * DAY;
const MAX_FUTURE = 5 * MINUTE;
const FRESH_FOR = 3 * MINUTE;
const NUMERIC_LIMITS = Object.freeze({
  pvPowerW: [0, 1000000],
  inverterPowerW: [-1000000, 1000000],
  gridPowerW: [-1000000, 1000000],
  loadPowerW: [-1000000, 1000000],
  batteryPowerW: [-1000000, 1000000],
  batterySocPercent: [0, 100],
  totalAcEnergyWh: [0, 1000000000000]
});
const MODES = new Set(['produce-only', 'meter', 'vague-meter', 'bidirectional', 'ac-coupled', 'isolated']);
const METER_LOCATIONS = new Set(['grid', 'load', 'unknown']);
const SAMPLE_KEYS = ['observedAt', 'collectedAt', ...Object.keys(NUMERIC_LIMITS), 'meterLocation', 'mode'];

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length > 35) throw new Error('Invalid solar timestamp.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error('Invalid solar timestamp.');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 2000 || wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 ||
      wall.getUTCDate() !== day || wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute ||
      wall.getUTCSeconds() !== second || Number(match[10] || 0) > 14 || Number(match[11] || 0) > 59 ||
      (Number(match[10]) === 14 && Number(match[11]) !== 0)) throw new Error('Invalid solar timestamp.');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid solar timestamp.');
  return result;
}

function validateBatch(body, now = Date.now()) {
  if (!plainObject(body) || !exactKeys(body, ['version', 'samples']) || body.version !== 1 ||
      !Array.isArray(body.samples) || body.samples.length < 1 || body.samples.length > 120) {
    throw new Error('Expected version 1 and 1 to 120 solar samples.');
  }
  return body.samples.map(sample => {
    if (!plainObject(sample) || !exactKeys(sample, SAMPLE_KEYS)) throw new Error('Invalid solar sample fields.');
    const observed = parseTimestamp(sample.observedAt), collected = parseTimestamp(sample.collectedAt);
    if (observed < now - MAX_AGE || collected < now - MAX_AGE || observed > now + MAX_FUTURE ||
        collected > now + MAX_FUTURE || observed > collected + MAX_FUTURE) {
      throw new Error('Solar sample time is outside the accepted window.');
    }
    const result = { observedAt: new Date(observed).toISOString(), collectedAt: new Date(collected).toISOString() };
    for (const [key, [minimum, maximum]] of Object.entries(NUMERIC_LIMITS)) {
      const value = sample[key];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)) {
        throw new Error('Invalid solar measurement.');
      }
      result[key] = value;
    }
    if (sample.mode !== null && !MODES.has(sample.mode)) throw new Error('Invalid solar operating mode.');
    if (sample.meterLocation !== null && !METER_LOCATIONS.has(sample.meterLocation)) throw new Error('Invalid solar meter location.');
    result.mode = sample.mode;
    result.meterLocation = sample.meterLocation;
    return result;
  });
}

function localDay(now) {
  const date = new Date(now + OFFSET).toISOString().slice(0, 10);
  return { date, start: Date.parse(date + 'T00:00:00.000Z') - OFFSET };
}

function emptyToday(now) {
  return { date: localDay(now).date, energyAcWh: null, quality: 'unavailable', since: null, through: null,
    sampleCount: 0, gapCount: 0, counterReset: false, label: 'No AC energy counter readings today.' };
}

function todayEnergy(samples, now) {
  const { start } = localDay(now), result = emptyToday(now);
  const counters = samples.filter(sample => sample.totalAcEnergyWh !== null &&
    Date.parse(sample.observedAt) >= start - 10 * MINUTE && Date.parse(sample.observedAt) <= now);
  const today = counters.filter(sample => Date.parse(sample.observedAt) >= start);
  result.sampleCount = today.length;
  if (!today.length) return result;
  const previous = counters.filter(sample => Date.parse(sample.observedAt) < start).at(-1);
  const first = today[0], last = today.at(-1);
  let baseline = first, completeBaseline = Date.parse(first.observedAt) === start;

  // The GEN24 counter updates only every five minutes. Matching fresh readings
  // across midnight, including one at least five minutes after it, establish a
  // stable counter baseline without pretending the first daytime reading is zero.
  if (!completeBaseline && previous && Date.parse(previous.observedAt) >= start - 5 * MINUTE) {
    const after = today.find(sample => Date.parse(sample.observedAt) >= start + 5 * MINUTE &&
      Date.parse(sample.observedAt) <= start + 10 * MINUTE);
    if (after) {
      const window = [previous, ...today.filter(sample => sample.observedAt <= after.observedAt)];
      const stable = window.every(sample => sample.totalAcEnergyWh === previous.totalAcEnergyWh);
      const continuous = window.every((sample, index) => index === 0 ||
        Date.parse(sample.observedAt) - Date.parse(window[index - 1].observedAt) <= FRESH_FOR);
      if (stable && continuous) { baseline = previous; completeBaseline = true; }
    }
  }
  const relevant = counters.filter(sample => sample.observedAt >= baseline.observedAt);
  result.since = completeBaseline ? new Date(start).toISOString() : first.observedAt;
  result.through = last.observedAt;
  result.gapCount = relevant.reduce((count, sample, index) => count + Number(index > 0 &&
    Date.parse(sample.observedAt) - Date.parse(relevant[index - 1].observedAt) > FRESH_FOR), 0);
  // A fresh power reading can have a missing counter. Its arrival must not make
  // an older energy total look current or fill the trailing counter gap.
  result.gapCount += Number(now - Date.parse(last.observedAt) > FRESH_FOR);
  result.counterReset = counters.some((sample, index) => index > 0 && Date.parse(sample.observedAt) >= start &&
    sample.totalAcEnergyWh < counters[index - 1].totalAcEnergyWh);
  if (result.counterReset) {
    result.quality = 'reset';
    result.label = 'AC counter reset; daily energy is unavailable.';
    return result;
  }
  if (last.observedAt === baseline.observedAt) {
    result.quality = 'partial';
    result.label = 'Waiting for another AC counter reading.';
    return result;
  }
  result.energyAcWh = last.totalAcEnergyWh - baseline.totalAcEnergyWh;
  result.quality = completeBaseline && !result.gapCount ? 'complete' : 'partial';
  result.label = result.quality === 'complete' ? 'Today, derived from the AC counter (up to 5 min delay).' :
    completeBaseline ? 'Since midnight, from the AC counter; readings have gaps.' :
      'Since the first reading today; a full midnight baseline is unavailable.' +
        (result.gapCount ? ' Counter readings also have gaps.' : '');
  return result;
}

module.exports = { DAY, MINUTE, OFFSET, MAX_AGE, MAX_FUTURE, FRESH_FOR, NUMERIC_LIMITS,
  SAMPLE_KEYS, validateBatch, parseTimestamp, localDay, emptyToday, todayEnergy };
