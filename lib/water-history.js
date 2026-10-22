'use strict';
const { METRICS, HOUR, DAY, OFFSET } = require('./water-data');
class WaterReader {
  constructor(db) { this.db = db; }
  ready() { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='water_buckets'").get()); }
  snapshot() {
    const catalog = Object.values(METRICS);
    if (!this.ready()) return { catalog, readings: {}, imports: {}, series: [] };
    const readings = {};
    for (const metric of catalog) {
      const row = this.db.prepare("SELECT * FROM water_samples WHERE metric=? AND stream='point' AND value IS NOT NULL ORDER BY observed_at DESC LIMIT 1").get(metric.id);
      readings[metric.id] = row ? { value: row.value, t: row.observed_at, quality: row.quality_text,
        capacity: metric.id === 'leslie-volume' ? JSON.parse(row.raw_json).totalCapacityMegaLitres ?? null : null } : null;
    }
    const imports = Object.fromEntries(this.db.prepare('SELECT * FROM water_ingestion').all().map(r => {
      const s = JSON.parse(r.state_json);
      return [r.job, { complete: Boolean(s.complete || s.archiveComplete), imported: s.imported || 0,
        cursor: s.cursor ?? null, earliest: s.earliest ?? null, lastSuccess: s.lastSuccess || null,
        error: s.error ? 'Source update delayed; retry scheduled.' : null }];
    }));
    const end = Date.now();
    return { catalog, readings, imports, series: ['leslie-storage', 'condamine-level'].map(metric =>
      this.series({ metric, resolution: 'daily', hours: 720, end })) };
  }
  series({ metric: id, resolution, hours, end }) {
    const metric = METRICS[id], start = end - hours * HOUR;
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
    const points = [];
    for (let t = first, i = 0; t <= end; t += step, i++) {
      const all = groups.get(i) || [], good = all.filter(r => r.value !== null), last = good.at(-1);
      points.push({ t, value: last?.value ?? null, min: good.length ? Math.min(...good.map(r => r.minimum ?? r.value)) : null,
        max: good.length ? Math.max(...good.map(r => r.maximum ?? r.value)) : null, estimated: false, adjusted: false,
        observedAt: last?.last_sample_at ?? null, quality: [...new Set(all.map(r => r.quality_text))].join('; '),
        partial: good.length < Math.min(factor, Math.floor((end - t) / nativeStep) + 1), samples: good.reduce((sum, r) => sum + r.sample_count, 0) });
    }
    const good = points.filter(p => p.value !== null);
    const storageDaily = id === 'leslie-storage' && resolution === 'daily';
    return { metric, resolution, start, end, intervalSeconds: step / 1000, points, latest: good.at(-1) || null,
      missing: points.filter(p => p.value === null).length, groupSize: factor,
      subtitle: `${factor > 1 ? factor + '-day groups' : resolution === 'daily' ? 'Daily' : 'Hourly'} — ${storageDaily ? 'published daily storage highs and low–high ranges' : 'last recorded value and observed low–high range'} — AEST`,
      note: (storageDaily ? 'Sunwater publishes daily minimum and maximum percentages; its average field is not used. Days end at midnight AEST. ' :
        'Lines show the last available reading in each group, with the observed low–high range. Sampling may be incomplete; ranges are not guaranteed continuous extrema. ') +
        (id === 'leslie-volume' ? 'Historical volume begins with collection on this website; past volumes are not inferred from today’s dam capacity. ' : '') +
        (id.startsWith('condamine') ? 'Source: State of Queensland, WMIP (CC BY 4.0). Quality codes are retained; recent telemetry is unvalidated. River level is height above the Warwick gauge datum, not water depth. ' : 'Source: Sunwater. Automated readings are unverified. ') +
        (factor > 1 ? 'This wide view groups daily records and preserves their low–high range. Zoom in to see individual days. ' : '') +
        'Historical imports continue in the background; gaps are never filled with invented readings.' };
  }
}
module.exports = { WaterReader };
