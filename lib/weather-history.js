'use strict';

// Explicit measurement identities: positions and similarly named channels are
// not interchangeable. A future layout must retain the unit and aggregation.
const RESOLUTIONS = {
  '10m': { stream: 'mem3', seconds: 600, maxHours: 168, label: '10-minute' },
  hourly: { stream: 'mem2', seconds: 3600, maxHours: 744, label: 'Hourly' },
  daily: { stream: 'mem1', seconds: 86400, maxHours: 17520, label: 'Daily' }
};
const definitions = [
  ['air', 'Air temperature', '4', 'DegC', '°C', 1],
  ['globe', 'Black globe temperature', '58', 'DegC', '°C', 1],
  ['humidity', 'Humidity', '3', '%', '%', 1],
  ['pressure', 'Barometric pressure', '7', 'hPa', 'hPa', 1],
  ['wind', 'Wind speed', '1', 'km/h', 'km/h', 1],
  ['gust', 'Peak wind gust', '25', 'km/h', 'km/h', 1, 'MAXIMUM'],
  ['direction', 'Wind direction', '2', 'Degs', '°', 0, 'AVGDIR', 'direction'],
  ['solar', 'Solar radiation', '6', 'Watts/m2', 'W/m²', 1],
  ['rain', 'Rainfall', '5', 'mm', 'mm', 1, 'TOTAL', 'bar'],
  ['dew', 'Dew point', '34', 'DegC', '°C', 1],
  ['evaporation', 'Evaporation rate', '31', 'mm/h', 'mm/h', 3, 'CURRENT'],
  ['evaporation-total', 'Daily evaporation', '33', 'mm', 'mm', 2, 'TOTAL', 'bar'],
  ['ground', 'Ground temperature', '9', 'DegC', '°C', 1],
  ...[10, 20, 30, 40].flatMap((depth, i) => [
    ['soil-temp-' + depth, 'Soil temperature · ' + depth + ' cm', String(46 + i), 'deg C', '°C', 1],
    ['soil-moisture-' + depth, 'Soil moisture · ' + depth + ' cm', String(54 + i), 'VWC %', '%', 1]
  ]),
  ['battery', 'Battery minimum', '21', 'V', 'V', 2, 'MINIMUM'],
  ['load', 'Station load', '22', 'mA', 'mA', 1],
  ['panel', 'Solar panel voltage', '23', 'V', 'V', 2],
  ['charge', 'Charging current', '24', 'mA', 'mA', 1]
];
const METRICS = Object.fromEntries(definitions.map(([id, label, sensor, sourceUnit, unit, precision, aggregation = 'AVERAGE', kind = 'line']) =>
  [id, { id, label, sensor, sourceUnit, unit, precision, aggregation, kind }]));

function requestError(message) { return Object.assign(new Error(message), { status: 400 }); }
function normalizeRequest(query, trends = false, now = Date.now()) {
  const allowed = trends ? ['view'] : ['metric', 'resolution', 'hours', 'end'];
  if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(v => typeof v !== 'string')) throw requestError('Invalid history parameters.');
  if (trends) {
    if (query.view && !['current', 'daily'].includes(query.view)) throw requestError('Unknown history view.');
    return { trends: true, daily: query.view === 'daily', end: Math.floor(now / 60000) * 60000 };
  }
  if (!Object.hasOwn(METRICS, query.metric || '')) throw requestError('Unknown measurement.');
  const resolution = query.resolution || '10m';
  if (!Object.hasOwn(RESOLUTIONS, resolution)) throw requestError('Unknown resolution.');
  if (query.hours && !/^\d+$/.test(query.hours)) throw requestError('Invalid time range.');
  const hours = Number(query.hours || (resolution === 'daily' ? 720 : resolution === 'hourly' ? 168 : 24));
  if (!Number.isInteger(hours) || hours < 1 || hours > RESOLUTIONS[resolution].maxHours) throw requestError('Time range is too large for this resolution.');
  let end = Math.floor(now / 60000) * 60000;
  if (query.end) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.end)) throw requestError('End time must be an ISO UTC timestamp.');
    end = Date.parse(query.end);
    if (!Number.isFinite(end) || new Date(end).toISOString() !== query.end || end < Date.UTC(2000, 0, 1) || end > now + 86400000) throw requestError('Invalid end time.');
    end = Math.min(end, now);
  }
  return { metric: query.metric, resolution, hours, end };
}

class HistoryReader {
  constructor(db, stationId = 'moore-weather') {
    this.db = db;
    this.stationId = stationId;
    this.fields = db.prepare(`SELECT f.* FROM fields f JOIN layouts l ON l.id=f.layout_id WHERE l.station_id=?`).all(stationId);
    this.catalog = Object.values(METRICS).map(metric => ({
      ...metric,
      resolutions: Object.keys(RESOLUTIONS).filter(resolution => this.fields.some(f => this.matches(f, metric, resolution)))
    })).filter(m => m.resolutions.length);
  }

  matches(field, metric, resolution, aggregation = metric.aggregation) {
    return field.stream === RESOLUTIONS[resolution].stream && field.sensor_key === metric.sensor && field.unit === metric.sourceUnit && field.aggregation === aggregation;
  }

  series(ids, resolution, hours, end) {
    const spec = RESOLUTIONS[resolution], start = end - hours * 3600000;
    const metrics = ids.map(id => this.catalog.find(m => m.id === id));
    if (metrics.some(m => !m || !m.resolutions.includes(resolution))) throw requestError('This measurement is not recorded at that resolution.');
    const fieldMap = new Map();
    for (const metric of metrics) {
      for (const f of this.fields) {
        if (this.matches(f, metric, resolution)) fieldMap.set(f.id, [metric.id, 'value']);
        else if (metric.aggregation === 'AVERAGE' && this.matches(f, metric, resolution, 'MINIMUM')) fieldMap.set(f.id, [metric.id, 'min']);
        else if (metric.aggregation === 'AVERAGE' && this.matches(f, metric, resolution, 'MAXIMUM')) fieldMap.set(f.id, [metric.id, 'max']);
      }
    }
    // Use the station/time index before joining observations. Never scan the
    // complete observation archive for a chart. Conflicting measured records
    // are withheld, while a later measured record supersedes an estimate.
    const records = this.db.prepare(`SELECT r.id, r.observed_at, r.reporting_date, r.layout_id,
      EXISTS(SELECT 1 FROM record_estimates e WHERE e.record_id=r.id) AS estimated
      FROM records r WHERE station_id=? AND stream=? AND observed_at>? AND observed_at<=?
      ORDER BY observed_at LIMIT 10001`).all(this.stationId, spec.stream, new Date(start).toISOString(), new Date(end).toISOString());
    if (records.length > 10000) throw new Error('Too many record variants in this window');
    const byTime = new Map();
    for (const r of records) {
      if (!byTime.has(r.observed_at)) byTime.set(r.observed_at, []);
      byTime.get(r.observed_at).push(r);
    }
    const values = new Map();
    const statement = this.db.prepare(`SELECT field_id, value, adjustment FROM weather_readings
      WHERE record_id=? AND quality='valid' AND value IS NOT NULL AND field_id IN (${[...fieldMap.keys()].map(() => '?').join(',')})`);
    for (const [time, variants] of byTime) {
      const measured = variants.filter(r => !r.estimated);
      const candidates = measured.length ? measured : variants;
      if (candidates.length !== 1) continue;
      const record = candidates[0];
      const readings = {};
      for (const row of statement.all(record.id, ...fieldMap.keys())) {
        const [id, stat] = fieldMap.get(row.field_id);
        readings[id] ||= {};
        // Two fields with the same meaning in one layout are ambiguous.
        if (Object.hasOwn(readings[id], stat)) readings[id][stat] = null;
        else readings[id][stat] = row.value;
        if (row.adjustment) readings[id].adjusted = true;
      }
      values.set(Date.parse(time), { readings, record });
    }
    const step = spec.seconds * 1000;
    // 09:00 AEST is 23:00 UTC on the preceding day.
    const offset = resolution === 'daily' ? 23 * 3600000 : 0;
    const times = [];
    for (let t = Math.floor((start - offset) / step) * step + offset + step; t <= end; t += step) times.push(t);
    return metrics.map(metric => {
      const points = times.map(t => {
        const entry = values.get(t), reading = entry?.readings[metric.id];
        return { t, value: reading?.value ?? null, min: reading?.min ?? null, max: reading?.max ?? null,
          estimated: Boolean(entry?.record.estimated), adjusted: Boolean(reading?.adjusted),
          reportingDate: entry?.record.reporting_date || null };
      });
      const valid = points.filter(p => p.value !== null);
      return { metric, resolution, intervalSeconds: spec.seconds, start, end, points,
        latest: valid.at(-1) || null, missing: points.length - valid.length };
    });
  }

  query(request) {
    const { end } = request;
    let series;
    if (request.trends) {
      series = [];
      for (const resolution of (request.daily ? ['daily'] : ['10m', 'hourly'])) {
        const ids = this.catalog.filter(m => m.resolutions.includes(resolution) &&
          (request.daily || resolution === '10m' || !m.resolutions.includes('10m'))).map(m => m.id);
        if (ids.length) series.push(...this.series(ids, resolution, request.daily ? 720 : 5, end));
      }
    } else series = this.series([request.metric], request.resolution, request.hours, end);
    return { timezone: 'Australia/Brisbane', generatedAt: new Date().toISOString(), catalog: this.catalog, series };
  }
}
module.exports = { HistoryReader, METRICS, RESOLUTIONS, normalizeRequest };
