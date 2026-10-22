'use strict';
const { DatabaseSync } = require('node:sqlite');
const { HOUR, DAY, OFFSET } = require('./water-data');
class WaterStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename, { timeout: 3000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS water_samples (
        metric TEXT NOT NULL, stream TEXT NOT NULL, observed_at INTEGER NOT NULL,
        value REAL, minimum REAL, maximum REAL, quality INTEGER, quality_text TEXT NOT NULL,
        priority INTEGER NOT NULL, raw_json TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY(metric,stream,observed_at)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS water_buckets (
        metric TEXT NOT NULL, resolution TEXT NOT NULL, observed_at INTEGER NOT NULL,
        value REAL, minimum REAL, maximum REAL, sample_count INTEGER NOT NULL,
        quality_text TEXT NOT NULL, last_sample_at INTEGER, source TEXT NOT NULL,
        PRIMARY KEY(metric,resolution,observed_at)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS water_ingestion (
        job TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL) WITHOUT ROWID;`);
  }
  state(job) {
    const row = this.db.prepare('SELECT state_json FROM water_ingestion WHERE job=?').get(job);
    return row ? JSON.parse(row.state_json) : null;
  }
  setState(job, value) {
    this.db.prepare('INSERT INTO water_ingestion VALUES(?,?,?) ON CONFLICT(job) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at')
      .run(job, JSON.stringify(value), new Date().toISOString());
  }
  save(samples, job, state) {
    // One response and its cursor commit together; an interrupted import is replayable.
    const db = this.db, buckets = new Map(), now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO water_samples VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(metric,stream,observed_at) DO UPDATE SET value=excluded.value, minimum=excluded.minimum,maximum=excluded.maximum,
      quality=excluded.quality,quality_text=excluded.quality_text,priority=excluded.priority,raw_json=excluded.raw_json,received_at=excluded.received_at
      WHERE excluded.priority >= water_samples.priority`);
    const bucketInsert = db.prepare(`INSERT INTO water_buckets VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(metric,resolution,observed_at) DO UPDATE SET value=excluded.value, minimum=excluded.minimum,
      maximum=excluded.maximum,sample_count=excluded.sample_count,quality_text=excluded.quality_text,last_sample_at=excluded.last_sample_at,source=excluded.source`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const s of samples) {
        insert.run(s.metric, s.stream, s.t, s.value, s.min, s.max, s.quality, s.qualityText, s.priority, s.raw, now);
        if (s.stream === 'daily') {
          bucketInsert.run(s.metric, 'daily', s.t, s.value, s.min, s.max, s.value === null ? 0 : 1, s.qualityText, s.t - DAY, 'sunwater-daily');
        } else for (const [resolution, step] of [['hourly', HOUR], ['daily', DAY]]) {
          const offset = resolution === 'daily' ? OFFSET : 0;
          const t = Math.ceil((s.t + offset) / step) * step - offset;
          buckets.set(s.metric + ':' + resolution + ':' + t, { metric: s.metric, resolution, step, t });
        }
      }
      const select = db.prepare(`SELECT * FROM water_samples WHERE metric=? AND stream='point' AND observed_at>? AND observed_at<=? ORDER BY observed_at`);
      for (const b of buckets.values()) {
        // Daily official storage ranges take precedence over locally sampled data.
        if (b.metric === 'leslie-storage' && b.resolution === 'daily' && db.prepare("SELECT 1 FROM water_samples WHERE metric=? AND stream='daily' AND observed_at=?").get(b.metric, b.t)) continue;
        const rows = select.all(b.metric, b.t - b.step, b.t), good = rows.filter(r => r.value !== null), last = good.at(-1);
        const quality = [...new Set(rows.map(r => r.quality === null ? r.quality_text : 'QC ' + r.quality + ' — ' + r.quality_text))].join('; ');
        bucketInsert.run(b.metric, b.resolution, b.t, last?.value ?? null,
          good.length ? Math.min(...good.map(r => r.value)) : null, good.length ? Math.max(...good.map(r => r.value)) : null,
          good.length, quality || 'No usable data', last?.observed_at ?? null, 'sampled');
      }
      if (job) this.setState(job, state);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return samples.length;
  }
  close() { this.db.close(); }
}
module.exports = { WaterStore };
