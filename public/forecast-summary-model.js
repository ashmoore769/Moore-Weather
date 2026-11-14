(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MooreForecastSummary = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const HOUR_MS = 3600000, FRESH_MS = 20 * 60000, MAX_AGE_MS = 6 * HOUR_MS;
  const TIMEZONE = 'Australia/Brisbane', HOURS = 24, WET_MM = 0.1;
  const WEATHER_CODES = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65,
    66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99]);
  const STORM_CODES = new Set([95, 96, 97, 99]);
  const number = (value, low, high) => typeof value === 'number' && Number.isFinite(value)
    && value >= low && value <= high ? value : null;
  const timestamp = value => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  const maximum = values => values.length ? Math.max(...values) : null;
  const minimum = values => values.length ? Math.min(...values) : null;

  function hour(startMs, row) {
    const weatherCode = row && WEATHER_CODES.has(row.weather_code) ? row.weather_code : null;
    return {
      startMs, endMs: startMs + HOUR_MS, present: Boolean(row),
      rainMm: number(row?.precipitation, 0, 1000),
      chancePercent: number(row?.precipitation_probability, 0, 100),
      tempC: number(row?.temperature_2m, -100, 70),
      weatherCode, storm: weatherCode === null ? null : STORM_CODES.has(weatherCode),
      gustKmh: number(row?.wind_gusts_10m, 0, 500)
    };
  }

  function summarize(hours) {
    const rainHours = hours.filter(h => h.rainMm !== null);
    const chanceHours = hours.filter(h => h.chancePercent !== null);
    const temperatureHours = hours.filter(h => h.tempC !== null);
    const weatherHours = hours.filter(h => h.weatherCode !== null);
    const stormHours = hours.filter(h => h.storm === true);
    const wetHours = rainHours.filter(h => h.rainMm > 0);
    const complete = rainHours.length === HOURS;
    const chanceComplete = chanceHours.length === HOURS;
    const temperatureComplete = temperatureHours.length === HOURS;
    const weatherComplete = weatherHours.length === HOURS;
    const knownTotalMm = rainHours.length ? rainHours.reduce((total, h) => total + h.rainMm, 0) : null;
    const wettest = wetHours.reduce((chosen, h) => !chosen || h.rainMm > chosen.rainMm ? h : chosen, null);
    const windows = [];
    for (const h of stormHours) {
      const previous = windows.at(-1);
      if (previous && h.endMs === previous.lastAtMs + HOUR_MS) {
        previous.lastAtMs = h.endMs;
        previous.hours.push(h);
      } else windows.push({ firstAtMs: h.endMs, lastAtMs: h.endMs, hours: [h] });
    }
    return {
      rain: {
        totalMm: complete ? knownTotalMm : null, knownTotalMm, complete, knownHours: rainHours.length,
        peakChancePercent: chanceComplete ? maximum(chanceHours.map(h => h.chancePercent)) : null,
        chanceComplete, chanceKnownHours: chanceHours.length,
        nextWet: hours.find(h => h.rainMm !== null && h.rainMm >= WET_MM) || null,
        wettest, hasRain: wetHours.length > 0 ? true : complete ? false : null,
        traceOnly: Boolean(complete && wettest && wettest.rainMm < WET_MM)
      },
      temperature: {
        highC: temperatureComplete ? maximum(temperatureHours.map(h => h.tempC)) : null,
        lowC: temperatureComplete ? minimum(temperatureHours.map(h => h.tempC)) : null,
        complete: temperatureComplete, knownHours: temperatureHours.length
      },
      storms: {
        signal: stormHours.length ? 'forecast' : weatherComplete ? 'none' : 'unknown',
        complete: weatherComplete, knownHours: weatherHours.length,
        firstAtMs: stormHours[0]?.endMs ?? null, lastAtMs: stormHours.at(-1)?.endMs ?? null,
        hours: stormHours, windows
      }
    };
  }

  function buildSummary(data, now = Date.now()) {
    const clockValid = typeof now === 'number' && Number.isFinite(now) && Number.isFinite(new Date(now).getTime());
    // Brisbane has an integral UTC offset and no DST, so UTC hour boundaries
    // are also AEST hour boundaries. The ongoing hour stays in the window.
    const startMs = clockValid ? Math.floor(now / HOUR_MS) * HOUR_MS : null;
    const endMs = startMs === null ? null : startMs + HOURS * HOUR_MS;
    const fetched = timestamp(data?.fetchedAt);
    const timeValid = clockValid && Number.isFinite(fetched) && fetched <= now;
    const fetchedAtMs = timeValid ? fetched : null;
    const ageMs = timeValid ? now - fetched : null;
    const shapeValid = data?.timezone === TIMEZONE && Array.isArray(data?.hourly)
      && data.hourly.length > 0 && data.hourly.length <= 200;
    let status = !timeValid || !shapeValid ? 'unavailable'
      : ageMs >= MAX_AGE_MS ? 'expired'
        : data.stale === true || ageMs >= FRESH_MS ? 'stale' : 'fresh';
    const rows = new Map();
    if (status === 'fresh' || status === 'stale') {
      for (const row of data.hourly) {
        const time = typeof row?.time === 'number' && Number.isInteger(row.time) ? row.time * 1000 : NaN;
        // Precipitation and probability belong to the PRECEDING hour. A row
        // stamped 20:00 therefore supplies the 19:00-20:00 rain bar. Temperature
        // and weather code remain instantaneous values at that row's end time.
        if (!Number.isSafeInteger(time) || time % HOUR_MS !== 0 || time <= startMs || time > endMs) continue;
        // Conflicting/repeated timestamps must not silently replace a value or
        // add an extra hour to the total. Keep that interval explicitly missing.
        rows.set(time, rows.has(time) ? null : row);
      }
    }
    const hours = startMs === null ? [] : Array.from({ length: HOURS }, (_, i) => {
      const from = startMs + i * HOUR_MS;
      return hour(from, rows.get(from + HOUR_MS));
    });
    const usable = (status === 'fresh' || status === 'stale') && hours.some(h =>
      h.rainMm !== null || h.chancePercent !== null || h.tempC !== null || h.weatherCode !== null || h.gustKmh !== null);
    if (!usable && status !== 'expired') status = 'unavailable';
    return {
      status, usable, fetchedAtMs, ageMs, timezone: TIMEZONE, source: 'Open-Meteo',
      startMs, endMs, hours, ...summarize(hours)
    };
  }

  return { buildSummary, HOUR_MS, FRESH_MS, MAX_AGE_MS };
});
