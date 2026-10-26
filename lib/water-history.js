'use strict';
const { METRICS, HOUR, DAY, OFFSET } = require('./water-data');
class WaterReader {
  constructor(db) { this.db = db; }
  ready() { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='water_buckets'").get()); }
  catalog(now = Date.now()) {
    const ready = this.ready();
    return Object.values(METRICS).map(metric => ({ ...metric, coverage: Object.fromEntries(metric.resolutions.map(resolution => {
      const step = resolution === 'daily' ? DAY : HOUR;
      const edge = direction => ready ? this.db.prepare(`SELECT observed_at FROM water_buckets
        WHERE metric=? AND resolution=? AND value IS NOT NULL AND observed_at<=?
        ORDER BY observed_at ${direction} LIMIT 1`).get(metric.id, resolution, now)?.observed_at : undefined;
      const first = edge('ASC'), last = edge('DESC');
      return [resolution, first === undefined ? null : { first, last, start: first - step }];
    })) }));
  }
  bridgeObservation() {
    if (!this.ready()) return null;
    const job = this.db.prepare("SELECT state_json FROM water_ingestion WHERE job='condamine-warwick-live'").get();
    const state = job ? JSON.parse(job.state_json) : null;
    if (!state?.lastSuccess || state.error) return null;
    // Include an unusable newest value rather than falling back to an older high.
    const row = this.db.prepare("SELECT observed_at,value FROM water_samples WHERE metric='condamine-warwick-level' AND stream='point' ORDER BY observed_at DESC LIMIT 1").get();
    return row ? { metric: 'condamine-warwick-level', t: row.observed_at, value: row.value, checkedAt: Date.parse(state.lastSuccess) } : null;
  }
  snapshot() {
    const catalog = this.catalog();
    if (!this.ready()) return { catalog, readings: {}, imports: {}, series: [] };
    const readings = {};
    for (const metric of catalog) {
      const row = this.db.prepare("SELECT * FROM water_samples WHERE metric=? AND stream='point' AND value IS NOT NULL ORDER BY observed_at DESC LIMIT 1").get(metric.id);
      readings[metric.id] = row ? { value: row.value, t: row.observed_at, quality: row.quality_text,
        capacity: ['leslie-volume', 'connolly-volume'].includes(metric.id) ? JSON.parse(row.raw_json).totalCapacityMegaLitres ?? null : null } : null;
    }
    const imports = Object.fromEntries(this.db.prepare('SELECT * FROM water_ingestion').all().map(r => {
      const s = JSON.parse(r.state_json);
      return [r.job, { complete: Boolean(s.complete || s.archiveComplete), imported: s.imported || 0,
        cursor: s.cursor ?? null, earliest: s.earliest ?? null, lastSuccess: s.lastSuccess || null,
        error: s.error ? 'Source update delayed; retry scheduled.' : null }];
    }));
    const end = Date.now();
    return { catalog, readings, imports, series: [
      this.series({ metric: 'leslie-storage', resolution: 'daily', hours: 720, end }),
      this.series({ metric: 'condamine-warwick-level', resolution: 'hourly', hours: 168, end }),
      this.series({ metric: 'condamine-level', resolution: 'hourly', hours: 168, end }),
      this.series({ metric: 'connolly-storage', resolution: 'daily', hours: 720, end })] };
  }
  series({ metric: id, resolution, hours, end }, suppliedMetric) {
    const metric = suppliedMetric || this.catalog().find(m => m.id === id), start = end - hours * HOUR;
    const nativeStep = resolution === 'daily' ? DAY : HOUR;
    // Keep decades navigable without shipping tens of thousands of SVG points.
    // Each group retains the lowest and highest observations; no daily source
    // observations are discarded from the database.
    const factor = Math.max(1, Math.ceil(hours * HOUR / nativeStep / 1500));
    const step = nativeStep * factor, offset = resolution === 'daily' ? -OFFSET : 0;
    const rows = this.ready() ? this.db.prepare(`SELECT * FROM water_buckets WHERE metric=? AND resolution=? AND observed_at>? AND observed_at<=? ORDER BY observed_at`)
      .all(id, resolution, start, end) : [];
    const groups = new Map();
    const first = Math.floor((start - offset) / nativeStep) * nativeStep + offset + nativeStep;
    for (const row of rows) {
      const group = Math.floor((row.observed_at - first) / step);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    }
    const reported = metric.reporting === 'published';
    const points = [];
    for (let t = first, i = 0; t <= end; t += step, i++) {
      const all = groups.get(i) || [], good = all.filter(r => r.value !== null), last = good.at(-1);
      if (reported && !all.length) continue;
      points.push({ t, value: last?.value ?? null, min: !reported && good.length ? Math.min(...good.map(r => r.minimum ?? r.value)) : null,
        max: !reported && good.length ? Math.max(...good.map(r => r.maximum ?? r.value)) : null, estimated: false, adjusted: false,
        observedAt: last?.last_sample_at ?? null, quality: [...new Set(all.map(r => r.quality_text))].join('; '),
        partial: !reported && good.length < Math.min(factor, Math.floor((end - t) / nativeStep) + 1), samples: good.reduce((sum, r) => sum + r.sample_count, 0) });
    }
    const good = points.filter(p => p.value !== null);
    const extrema = {};
    for (const [stat, column] of [['min', 'minimum'], ['max', 'maximum']]) {
      const winner = rows.filter(r => r.value !== null).reduce((best, row) => {
        const value = row[column] ?? row.value;
        return !best || (stat === 'min' ? value < best.value : value > best.value) ? { row, value } : best;
      }, null);
      if (!winner) continue;
      const { row, value } = winner;
      if (row.source === 'sunwater-daily') {
        extrema[stat] = { value, t: row.observed_at - DAY, dateOnly: true };
      } else {
        // Only inspect the winning native bucket, using the raw sample index.
        // A grouped point's plotting date is not the date its extremum occurred.
        const sample = this.db.prepare(`SELECT observed_at FROM water_samples
          WHERE metric=? AND stream='point' AND observed_at>? AND observed_at<=? AND value=?
          ORDER BY observed_at LIMIT 1`).get(id, row.observed_at - nativeStep, row.observed_at, value);
        if (sample) extrema[stat] = { value, t: sample.observed_at, dateOnly: Boolean(metric.dateOnly) };
      }
    }
    if (reported) return {
      metric, resolution, start, end, intervalSeconds: step / 1000, points, extrema, latest: good.at(-1) || null,
      missing: 0, groupSize: factor, subtitle: 'Council-published storage reports - report dates in AEST',
      note: 'Source: Southern Downs Regional Council. Each point represents a published report date, not a live reading or daily measurement. Lines connect reports; no measurements are inferred between them. Exact observation times are not published. History starts with reports collected by Moore Weather.'
    };
    const storageDaily = id === 'leslie-storage' && resolution === 'daily';
    return { metric, resolution, start, end, intervalSeconds: step / 1000, points, extrema, latest: good.at(-1) || null,
      missing: points.filter(p => p.value === null).length, groupSize: factor,
      subtitle: `${factor > 1 ? factor + '-day groups' : resolution === 'daily' ? 'Daily' : 'Hourly'} — ${storageDaily ? 'published daily storage highs and low–high ranges' : 'last recorded value and observed low–high range'} — AEST`,
      note: (storageDaily ? 'Sunwater publishes daily minimum and maximum percentages; its average field is not used. Days end at midnight AEST. ' :
        'Lines show the last available reading in each group, with the observed low–high range. Sampling may be incomplete; ranges are not guaranteed continuous extrema. ') +
        (id === 'leslie-volume' ? 'Historical volume begins with collection on this website; past volumes are not inferred from today’s dam capacity. ' : '') +
        (id === 'condamine-warwick-level' ? 'Source: Bureau of Meteorology, Warwick Alert 041534 (CC BY 4.0 Australia). Unverified operational observations; metres above the local gauge datum, not water depth. Reference lines: minor 5 m, moderate 6 m, major and McCahon Bridge 7 m. The bridge reference is not O. O. Madsen Bridge and does not indicate road closure or safe access. The initial import contains only BOM’s available 14-day window; subsequent observations are saved automatically. ' :
          id.startsWith('condamine') ? 'Source: State of Queensland, WMIP (CC BY 4.0), Scots College 422310C / BOM 041503. Quality codes are retained; recent telemetry is unvalidated. This is a separate upstream gauge; its height and flow must not be treated as measurements at Warwick Alert. ' : 'Source: Sunwater. Automated readings are unverified. ') +
        (factor > 1 ? 'This wide view groups daily records and preserves their low–high range. Zoom in to see individual days. ' : '') +
        (id === 'condamine-warwick-level' ? 'Collection continues automatically; gaps are never filled with invented readings.' : 'Historical imports continue in the background; gaps are never filled with invented readings.') };
  }
}
module.exports = { WaterReader };
