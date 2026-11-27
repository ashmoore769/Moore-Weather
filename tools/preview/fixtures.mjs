/** Deterministic sample data for local visual review. Never imported by server.js. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { METRICS } = require('../../lib/weather-history.js');
const { METRICS: WATER_METRICS } = require('../../lib/water-data.js');
const { currentSensors } = require('../../public/sensor-quality.js');
const { integrateDay, ratesFor } = require('../../lib/solar-energy.js');

export const HOUR = 3600000, DAY = 24 * HOUR, OFFSET = 10 * HOUR;
export const modes = ['healthy', 'day', 'night', 'stale', 'partial', 'unavailable', 'long'];
const iso = time => new Date(time).toISOString();
const dayKey = time => iso(time + OFFSET).slice(0, 10);
const dayStart = time => Math.floor((time + OFFSET) / DAY) * DAY - OFFSET;
const round = (number, places = 2) => Number(number.toFixed(places));
const localHour = time => ((time + OFFSET) % DAY) / HOUR;
const daylight = time => Math.max(0, Math.sin((localHour(time) - 5.5) / 13 * Math.PI));
const wave = (time, period = DAY, shift = 0) => Math.sin(time / period * Math.PI * 2 + shift);
const observed = (now, mode) => now - (mode === 'stale' ? 38 * HOUR : 12000);

export function metricValue(id, time) {
  const sun = daylight(time), slow = wave(time, DAY * 6), pulse = wave(time, HOUR * 3);
  const values = {
    air: 18.7 + 10.5 * sun + .8 * slow,
    globe: 18.8 + 19.2 * sun + .8 * slow,
    humidity: 81 - 35 * sun + 2 * slow,
    pressure: 1018.1 + 1.7 * wave(time, DAY * 2),
    wind: Math.max(.4, 5.1 + 4.6 * sun + 2.1 * pulse),
    gust: Math.max(3.5, 10.6 + 8 * sun + 4.3 * pulse),
    direction: 215 + 45 * wave(time, DAY / 2),
    solar: Math.max(0, 905 * sun * (1 - .12 * Math.max(0, pulse))),
    rain: wave(time, HOUR * 9) > .97 ? .2 : 0,
    dew: 15.3 + 1.4 * slow + .4 * sun,
    evaporation: .012 + .178 * sun,
    'evaporation-total': 3.1 + .4 * slow,
    ground: 20.8 + 5.8 * sun,
    battery: 12.95 + .72 * sun,
    load: 68.4 + 3.2 * pulse,
    panel: sun > .04 ? 13.8 + 2.7 * sun : .1,
    charge: sun > .04 ? 88 + 278 * sun : 0,
    'connolly-storage': 93.7 + .3 * slow,
    'connolly-volume': 2057 + 8 * slow,
    'leslie-storage': 91.6 + .35 * slow,
    'leslie-volume': 97387 + 376 * slow,
    'condamine-warwick-level': 1.12 + .08 * slow,
    'condamine-level': 1.782 + .07 * slow,
    'condamine-flow': .421 + .035 * slow,
  };
  for (const depth of [10, 20, 30, 40]) {
    values['soil-temp-' + depth] = 23.4 - depth * .035 + (2 - depth * .035) * sun;
    values['soil-moisture-' + depth] = 25.2 + depth * .14 + .5 * slow;
  }
  return round(values[id] ?? 0, 3);
}

export function catalog(now) {
  return [...Object.values(METRICS), ...Object.values(WATER_METRICS)].map(metric => {
    const resolutions = metric.resolutions || ['10m', 'hourly', 'daily'];
    return { ...metric, resolutions, coverage: Object.fromEntries(resolutions.map(resolution => {
      const step = resolution === 'daily' ? DAY : resolution === 'hourly' ? HOUR : HOUR / 6;
      const offset = resolution === 'daily' ? (metric.water ? 14 : 23) * HOUR : 0;
      const through = metric.dateOnly ? dayStart(now) - 2 * DAY : now;
      const last = Math.floor((through - offset) / step) * step + offset;
      const first = last - 365 * DAY + step;
      // Same contract as HistoryReader.availableCatalog / WaterReader.catalog:
      // `first` is the first observation; `start` includes its recording period.
      return [resolution, { first, last, start: first - step }];
    })) };
  });
}

export function makeSeries(metric, now, options = {}) {
  const resolution = options.resolution || (metric.water ? metric.resolutions[0] : '10m');
  const hours = Math.max(1, Math.min(Number(options.hours) || (resolution === 'daily' ? 720 : 24), 175200));
  const end = Math.min(Number(options.end) || now, now);
  const nativeStep = resolution === 'daily' ? DAY : resolution === 'hourly' ? HOUR : HOUR / 6;
  const step = nativeStep * Math.max(1, Math.ceil(hours * HOUR / nativeStep / 800));
  const start = end - hours * HOUR;
  const points = [];
  const offset = resolution === 'daily' ? (metric.water ? 14 : 23) * HOUR : 0;
  for (let t = Math.floor((start - offset) / step) * step + offset + step; t <= end; t += step) {
    let value = metricValue(metric.id, t);
    if (metric.id === 'rain' && resolution !== '10m') value *= resolution === 'daily' ? 8 : 2;
    if (options.mode === 'partial' && points.length % 21 === 8) value = null;
    if (options.mode === 'stale' && t > now - 38 * HOUR) value = null;
    if (options.mode === 'unavailable') value = null;
    const spread = metric.id === 'pressure' ? .12 : metric.id === 'battery' ? .015 : metric.water ? .008 : Math.abs(value) * .02;
    const hasBand = metric.kind === 'line' && !['load', 'panel', 'charge'].includes(metric.id);
    points.push({ t, value, min: value === null || !hasBand ? null : round(value - spread, 3),
      max: value === null || !hasBand ? null : round(value + spread, 3), estimated: false, adjusted: false,
      observedAt: t, quality: 'Preview sample', reportingDate: dayKey(t) });
  }
  const valid = points.filter(point => point.value !== null);
  return { metric, resolution, intervalSeconds: step / 1000, start, end, points, latest: valid.at(-1) || null,
    missing: points.length - valid.length, groupSize: step / nativeStep,
    subtitle: 'Sample history for design review · all times AEST', note: 'Preview values only. No live source was queried.' };
}

export function currentCsv(now, mode = 'healthy') {
  const time = observed(now, mode), key = iso(time + OFFSET);
  const values = [
    metricValue('wind', time), metricValue('direction', time), metricValue('humidity', time), metricValue('air', time), 0,
    metricValue('solar', time), metricValue('pressure', time), metricValue('ground', time), metricValue('battery', time),
    metricValue('load', time), metricValue('panel', time), metricValue('charge', time), metricValue('gust', time),
    metricValue('wind', time) * .8, metricValue('direction', time), 0.8, metricValue('evaporation', time), 1,
    3.218, metricValue('dew', time), ...[10, 20, 30, 40].map(d => metricValue('soil-temp-' + d, time)),
    ...[10, 20, 30, 40].map(d => metricValue('soil-moisture-' + d, time)), metricValue('globe', time),
  ];
  if (mode === 'partial') { values[currentSensors.indexOf('58')] = 'NaN'; values[currentSensors.indexOf('54')] = 'NaN'; }
  if (mode === 'long') {
    // Match check-dashboard.cjs currentRecord() defaults and long-value case
    // exactly, so CUA can inspect the same overflow regression as CI.
    values.splice(0, values.length, ...currentSensors.map(sensor => sensor === '7' ? 1000 : sensor === '6' ? 400 :
      sensor === '3' ? 50 : sensor === '21' ? 13.8 : sensor === '23' ? 10 : sensor === '32' ? 0 : 20));
    Object.assign(values, { 0: 199.9, 1: 292.5, 2: 100, 3: -12.3, 4: 9.9, 5: 1399.9,
      6: 1099.9, 12: 199.9, 15: 225, 16: 9.99, 19: -24.5, 28: 49.9 });
  }
  return ['r3 ' + key.slice(0, 10).replaceAll('-', '/'), key.slice(11, 19), ...values, 'END'].join(',');
}

export function dailyCsv(now, mode = 'healthy') {
  // The logger's MEM1 date is the completed weather day's ending date, at
  // 09:00 AEST. UTC arithmetic shifted by one hour selects that same boundary.
  const endDate = iso(observed(now, mode) + HOUR).slice(0, 10).replaceAll('-', '/');
  const values = [17.2, 6.1, .4, 278, 184, 24.3, 4.9, 229, 87.2, 42.1, 65.4,
    29.8, 17.9, 23.7, .8, 281.4, 3.218, 16.4, 12.95, 1, 69.1, 9.2, 148.3,
    24.6, 23.8, 23.1, 22.4, 26.8, 28.1, 29.4, 30.7, 24.3, 29.7, 19.5,
    1018.3, 1020.1, 1016.8, 923.1, 27.3, 40.2, 18.1];
  if (mode === 'partial') values[38] = 'NaN';
  return [endDate, '09:00:00', ...values].join(',');
}

export function historyPayload(now, mode, params, trends = false) {
  const all = catalog(now);
  const selected = trends ? all.filter(m => !m.water) : all.filter(m => m.id === (params.get('metric') || 'air'));
  let end = params.get('end');
  if (end && !/^\d+$/.test(end)) end = Date.parse(end);
  return { timezone: 'Australia/Brisbane', generatedAt: iso(now), catalog: all,
    series: selected.map(metric => makeSeries(metric, now, { mode, end, hours: params.get('hours') || (params.get('view') === 'daily' ? 720 : 24),
      resolution: params.get('resolution') || (params.get('view') === 'daily' ? 'daily' : undefined) })) };
}

export function forecast(now, mode) {
  const hour = Math.floor(now / HOUR) * HOUR;
  const hourly = Array.from({ length: 168 }, (_, index) => {
    const t = hour + index * HOUR, rain = index >= 17 && index <= 20 ? [0.2, 0.6, 1.1, .3][index - 17] : 0;
    return { time: t / 1000, temperature_2m: round(metricValue('air', t), 1), precipitation: rain,
      precipitation_probability: rain ? 42 + index % 4 * 9 : 7 + index % 5,
      weather_code: rain ? 80 : index % 7 > 3 ? 2 : 1, wind_speed_10m: round(metricValue('wind', t), 1),
      wind_gusts_10m: round(metricValue('gust', t), 1), wind_direction_10m: 215 };
  });
  const daily = Array.from({ length: 7 }, (_, i) => ({ time: (dayStart(now) + i * DAY) / 1000,
    temperature_2m_max: 29 + i % 3, temperature_2m_min: 18 + i % 2, precipitation_sum: i < 2 ? 2.2 : .4,
    precipitation_probability_max: i < 2 ? 61 : 22, weather_code: i < 2 ? 80 : 2,
    wind_speed_10m_max: 16, wind_gusts_10m_max: 25, uv_index_max: 10.4,
    sunrise: (dayStart(now) + i * DAY + 4.9 * HOUR) / 1000, sunset: (dayStart(now) + i * DAY + 18.55 * HOUR) / 1000 }));
  return { timezone: 'Australia/Brisbane', fetchedAt: iso(now - (mode === 'stale' ? 3 * HOUR : 90000)),
    stale: mode === 'stale', hourly, daily, location: { latitude: -28.213713, longitude: 151.9893045 } };
}

export function yard(now, mode, range = '12h') {
  const span = { '12h': 12 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }[range] || 12 * HOUR;
  const step = span > 7 * DAY ? HOUR : span > DAY ? HOUR / 3 : 2 * 60000;
  const row = t => ({ observedAt: iso(t), receivedAt: iso(t + 1000), batteryVoltageV: round(metricValue('battery', t), 2),
    pvVoltageV: round(daylight(t) > .05 ? 18.8 + 1.7 * daylight(t) : .1), pvPowerW: round(123 * daylight(t)),
    chargeCurrentA: round(8.1 * daylight(t)), controllerLoadPowerW: 3.82, controllerLoadCurrentA: .29,
    controllerTempC: round(22.6 + 9 * daylight(t), 1) });
  const time = observed(now, mode);
  const history = [];
  for (let t = now - span; t <= Math.min(time, now); t += step) history.push(row(t));
  let current = mode === 'unavailable' ? null : row(time);
  if (current && mode === 'partial') current.pvPowerW = null;
  return { enabled: true, status: mode === 'unavailable' ? 'unavailable' : mode === 'stale' ? 'stale' : 'fresh', current,
    history, timezone: 'Australia/Brisbane', staleAfterSeconds: 180 };
}

export function solar(now, mode) {
  const start = dayStart(now), time = observed(now, mode);
  const row = t => {
    const generation = round(daylight(t) * 6220), load = round(460 + 240 * Math.max(0, wave(t, HOUR * 3)) + 900 * Math.max(0, wave(t, HOUR * 6)) ** 8);
    return { observedAt: iso(t), collectedAt: iso(t + 1000), receivedAt: iso(t + 2000), meterLocation: 'grid', pvPowerW: round(generation * 1.03),
      inverterPowerW: generation, loadPowerW: load, gridPowerW: load - generation,
      gridImportPowerW: Math.max(0, load - generation), gridExportPowerW: Math.max(0, generation - load),
      solarToHomePowerW: Math.min(load, generation), batteryPowerW: null, batterySocPercent: null, hasGap: false };
  };
  const sourceThrough = mode === 'unavailable' ? -Infinity : time;
  const sample = (t, since) => {
    const reading = row(t);
    const missingLoad = mode === 'partial' && [8, 9].includes(Math.floor((t - since) / 300000) % 21);
    if (missingLoad) { reading.loadPowerW = null; reading.solarToHomePowerW = null; }
    reading.seriesGaps = { inverterPowerW: false, loadPowerW: missingLoad, gridImportPowerW: false };
    return reading;
  };
  const points = [];
  for (let t = start; t <= Math.min(sourceThrough, now - 30000); t += 5 * 60000) points.push(sample(t, start));
  let current = mode === 'unavailable' ? null : row(time);
  if (current && mode === 'day') Object.assign(current, { pvPowerW: 5078, inverterPowerW: 4930, loadPowerW: 782, gridPowerW: -4148 });
  if (current && mode === 'night') Object.assign(current, { pvPowerW: 0, inverterPowerW: 0, loadPowerW: 628, gridPowerW: 628 });
  if (current && mode === 'partial') current.loadPowerW = null;
  const rates = ratesFor(now);
  const energyDay = since => {
    const through = Math.min(since + DAY, sourceThrough), samples = [];
    for (let t = since; t <= through; t += 2 * 60000) samples.push(sample(t, since));
    if (through >= since && samples.at(-1)?.observedAt !== iso(through)) samples.push(sample(through, since));
    return integrateDay(samples, since, now);
  };
  const today = energyDay(start);
  const counterAvailable = Number.isFinite(today.generatedAcWh);
  return { enabled: true, status: mode === 'stale' ? 'stale' : mode === 'unavailable' ? 'unavailable' : 'fresh',
    timezone: 'Australia/Brisbane', staleAfterSeconds: 180, current, rates,
    today: { date: dayKey(now), quality: counterAvailable ? 'complete' : 'unavailable', energyAcWh: today.generatedAcWh,
      through: today.through, label: counterAvailable ? 'Sample AC counter readings for design review.' : 'No sample readings available for today.' },
    history: { points }, energy: { today, days: Array.from({ length: 30 }, (_, i) => i === 29 ? today : energyDay(start - (29 - i) * DAY)) } };
}

export function water(now, mode) {
  const all = catalog(now).filter(m => m.water), readings = {};
  for (const metric of all) {
    const t = metric.dateOnly ? dayStart(now) - DAY * 2 : now - 22 * 60000;
    readings[metric.id] = { value: mode === 'unavailable' ? null : metricValue(metric.id, t), t, latestObservedAt: t,
      latestValueAvailable: mode !== 'unavailable', lastAvailable: false, quality: 'Preview sample',
      capacity: metric.id === 'leslie-volume' ? 106200 : metric.id === 'connolly-volume' ? 2197 : null };
  }
  const jobs = ['condamine-warwick-live', 'condamine-level-backfill', 'condamine-flow-backfill', 'leslie-daily', 'leslie-current', 'connolly-current'];
  return { catalog: all, readings, imports: Object.fromEntries(jobs.map(job => [job, { complete: true,
    imported: 300, lastSuccess: iso(now - 5 * 60000), error: null }])), collector: { enabled: true, error: null },
    series: all.filter(m => ['leslie-storage', 'connolly-storage', 'condamine-warwick-level', 'condamine-level'].includes(m.id))
      .map(metric => makeSeries(metric, now, { mode: mode === 'unavailable' ? mode : 'healthy',
        end: metric.dateOnly ? dayStart(now) - 2 * DAY : now,
        hours: metric.id.includes('storage') ? 720 : 168, resolution: metric.id.includes('storage') ? 'daily' : 'hourly' })) };
}

export function historyHealth(now, mode) {
  const delayed = mode === 'stale' || mode === 'unavailable';
  return { enabled: true, delayed, incomplete: mode === 'partial',
    summary: delayed ? 'Station collection is delayed. Last saved readings are retained.' : mode === 'partial' ? 'Current collection is healthy. Older gaps remain in the saved archive.' : 'All saved weather feeds are up to date.',
    feeds: [['mem3', '10-minute readings'], ['mem2', 'Hourly readings'], ['mem1', 'Daily readings']].map(([id, label], i) => ({
      id, label, delayed, lastObservedAt: iso(observed(now, mode) - i * HOUR), coverageChecked: true,
      missingIntervals: mode === 'partial' ? 3 : 0, unresolvedGaps: mode === 'partial' ? 1 : 0 })) };
}

export function systemHealth(now, mode) {
  const last = iso(observed(now, mode));
  return { status: mode === 'stale' ? 'warning' : 'ok', checkedAt: iso(now), version: 'preview-fixture', checks: {
    live: { status: mode === 'stale' ? 'stale' : 'ok', observedAt: last },
    clock: { status: 'ok', accuracySeconds: 2, lastVerifiedAt: iso(now) },
    storage: { status: 'ok', freeBytes: 14611366871, dbBytes: 128411412 },
    database: { status: 'ok', lastWrite: last },
    backups: { status: 'ok', lastSuccess: iso(now - HOUR), offsiteConfigured: true, offsiteLastSuccess: iso(now - HOUR) },
    retention: { status: 'ok', days: 90, lastRun: iso(now - HOUR * 4), deletedRecords: 284 },
    history: { status: mode === 'partial' ? 'incomplete' : 'ok', unresolvedGaps: mode === 'partial' ? 1 : 0, checked: true },
  } };
}

export function skyManifest(now, mode) {
  const end = Math.floor(observed(now, mode) / 600000) * 600000;
  return { images: mode === 'unavailable' ? [] : Array.from({ length: 72 }, (_, i) => {
    const t = end - (71 - i) * 20 * 60000;
    return { id: 'preview-' + t, capturedAt: iso(t), url: '/__preview/skycam.svg?time=' + t };
  }) };
}

export function cameraSvg(time) {
  const night = localHour(time) < 5.5 || localHour(time) > 18.8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${night ? '#101a30' : '#537fa1'}"/><stop offset="1" stop-color="${night ? '#607086' : '#b8d0d6'}"/></linearGradient><linearGradient id="land" x2="0" y2="1"><stop stop-color="#526451"/><stop offset="1" stop-color="#263d32"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="7"/></filter></defs>
  <rect width="1280" height="720" fill="url(#sky)"/>
  <g fill="${night ? '#e5e9dd' : '#f0f4e9'}" opacity="${night ? '.1' : '.62'}" filter="url(#soft)"><ellipse cx="252" cy="211" rx="270" ry="40"/><ellipse cx="922" cy="160" rx="335" ry="34"/><ellipse cx="702" cy="265" rx="194" ry="22"/></g>
  <path d="M0 465 130 427 282 449 440 408 590 436 734 405 915 448 1107 420 1280 450V720H0Z" fill="#66786c"/>
  <path d="M0 514 179 486 343 503 489 477 640 511 830 480 1034 502 1280 479V720H0Z" fill="url(#land)"/>
  <path d="M0 589Q350 537 690 593T1280 574V720H0Z" fill="#425640"/>
  <g fill="#253c31"><path d="M20 535v-66h10v66M0 487q24-65 50 0M1083 538v-75h12v75M1048 481q41-83 79 0M1182 544v-86h11v86M1158 474q30-79 62 0"/></g>
  <path d="M0 670 1280 641M138 720 145 613M525 720 527 606M911 720 908 598" stroke="#1e302a" stroke-width="4"/>
  <rect x="20" y="20" width="290" height="39" rx="4" fill="#102029" opacity=".76"/>
  <text x="36" y="46" fill="#ecf2ee" font-family="system-ui,sans-serif" font-size="18">SKYCAM · PREVIEW ILLUSTRATION</text>
  <text x="1247" y="688" text-anchor="end" fill="#fff" font-family="monospace" font-size="20">${iso(time + OFFSET).slice(0, 19).replace('T', ' ')} AEST</text></svg>`;
}

export function radarSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><filter id="rain"><feGaussianBlur stdDeviation="9"/></filter></defs><g filter="url(#rain)" opacity=".47"><path fill="#2d9fbc" d="M140 105q80-90 120-45t-20 75q-25 60-82 28t-18-58"/><path fill="#389c74" d="M171 111q32-47 64-24t-15 43q-25 17-49-19"/><path fill="#3a9eb0" d="M314 353q28-45 67-20t1 66q-45 18-68-46"/></g></svg>';
}
