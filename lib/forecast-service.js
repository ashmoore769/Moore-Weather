'use strict';

// Independent, on-demand public feeds. No station commands or observation writes.
const MINUTE = 60_000;
const TIMEZONE = 'Australia/Brisbane';
const LOCATION = Object.freeze({ name: 'Warwick area', latitude: -28.22, longitude: 152.03 });
const DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max', 'wind_gusts_10m_max', 'sunrise', 'sunset', 'uv_index_max'];
const HOURLY = ['temperature_2m', 'precipitation_probability', 'precipitation', 'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];

function forecastUrl() {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  for (const [key, value] of Object.entries({ latitude: LOCATION.latitude, longitude: LOCATION.longitude,
    timezone: TIMEZONE, timeformat: 'unixtime', forecast_days: 7, temperature_unit: 'celsius',
    wind_speed_unit: 'kmh', precipitation_unit: 'mm', daily: DAILY.join(','), hourly: HOURLY.join(',') })) url.searchParams.set(key, value);
  return url.href;
}

function numeric(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function rows(group, fields, limit) {
  if (!Array.isArray(group?.time) || !group.time.length || group.time.length > limit) throw Error('Incomplete forecast');
  if (fields.some(field => !Array.isArray(group[field]) || group[field].length !== group.time.length)) throw Error('Incomplete forecast fields');
  return group.time.map((time, i) => {
    if (!Number.isInteger(time) || (i && time <= group.time[i - 1])) throw Error('Invalid forecast times');
    return Object.fromEntries([['time', time], ...fields.map(field => [field, numeric(group[field][i])])]);
  });
}

function normalizeForecast(data, now = Date.now()) {
  if (data?.timezone !== TIMEZONE || data.utc_offset_seconds !== 36000 || data.daily_units?.temperature_2m_max !== '°C'
    || data.daily_units?.precipitation_sum !== 'mm' || data.hourly_units?.wind_speed_10m !== 'km/h') throw Error('Unexpected forecast units');
  const daily = rows(data.daily, DAILY, 8), hourly = rows(data.hourly, HOURLY, 200);
  if (daily.length < 7 || daily[0].time * 1000 > now || daily[0].time * 1000 < now - 24 * 60 * MINUTE
    || !daily.some(row => row.temperature_2m_max !== null) || !hourly.some(row => row.temperature_2m !== null)) throw Error('Forecast is out of date or empty');
  return { source: 'Open-Meteo', timezone: TIMEZONE, location: LOCATION, daily, hourly };
}

function normalizeRadar(data, now = Date.now()) {
  if (data?.host !== 'https://tilecache.rainviewer.com' || !Array.isArray(data.radar?.past)) throw Error('Invalid radar feed');
  const frames = [...new Map(data.radar.past.filter(frame => Number.isInteger(frame.time)
    && frame.time * 1000 <= now + 5 * MINUTE && frame.time * 1000 >= now - 3 * 60 * MINUTE
    && /^\/v2\/radar\/[a-zA-Z0-9_-]+$/.test(frame.path)).map(frame => [frame.time, { time: frame.time, path: frame.path }])).values()]
    .sort((a, b) => a.time - b.time).slice(-13);
  if (!frames.length) throw Error('No recent radar frames');
  return { source: 'RainViewer', host: data.host, frames, location: LOCATION, nativeZoom: 7 };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json', 'User-Agent': 'MooreWeather/1.0 (+https://moore-weather.onrender.com)' } });
  if (!response.ok) { await response.body?.cancel(); throw Error('Weather feed unavailable'); }
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 512 * 1024) throw Error('Weather feed too large'); chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createFeed({ url, normalize, ttl, maxAge, now, read, logger }) {
  let cached, fetchedAt = 0, retryAt = 0, pending;
  async function get() {
    const age = now() - fetchedAt;
    if (!(cached && age < ttl) && now() >= retryAt) {
      if (!pending) pending = (async () => {
        try { const value = normalize(await read(url), now()); cached = value; fetchedAt = now(); retryAt = 0; }
        catch (error) { retryAt = now() + MINUTE; logger?.warn?.('[FORECAST] Public weather feed refresh failed; retrying later.'); }
        finally { pending = null; }
      })();
      await pending;
    }
    if (!cached || now() - fetchedAt >= maxAge) throw Error('Weather feed temporarily unavailable');
    return { ...cached, fetchedAt: new Date(fetchedAt).toISOString(), stale: now() - fetchedAt >= ttl };
  }
  return get;
}

function createForecastService({ now = Date.now, read = fetchJson, logger = console } = {}) {
  const getForecast = createFeed({ url: forecastUrl(), normalize: normalizeForecast, ttl: 20 * MINUTE, maxAge: 6 * 60 * MINUTE, now, read, logger });
  const radar = createFeed({ url: 'https://api.rainviewer.com/public/weather-maps.json', normalize: normalizeRadar, ttl: 5 * MINUTE, maxAge: 60 * MINUTE, now, read, logger });
  async function getRadar() {
    const value = await radar();
    const age = now() - value.frames.at(-1).time * 1000;
    if (age > 2 * 60 * MINUTE) throw Error('Radar is out of date');
    return { ...value, stale: value.stale || age > 20 * MINUTE };
  }
  function mount(app) {
    for (const [route, getter] of [['/api/forecast', getForecast], ['/api/radar', getRadar]]) {
      app.get(route, async (_req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try { res.json(await getter()); }
        catch { res.set('Retry-After', '60').status(503).json({ error: 'This weather feed is taking a break. Please try again shortly.' }); }
      });
    }
  }
  return { mount, getForecast, getRadar };
}

module.exports = { createForecastService, normalizeForecast, normalizeRadar, forecastUrl, LOCATION, DAILY, HOURLY };
