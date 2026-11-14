'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { DAY, MINUTE, FRESH_FOR, localDay, todayEnergy } = require('./solar-data');
const { MAX_GAP, ratesFor, solarToHomePower, integrateDay } = require('./solar-energy');

// A server-owned source identifier prevents a submitted body from choosing a
// different household or writing into the weather logger's station namespace.
const SOURCE = 'home-fronius';
const MAX_DAILY_SAMPLES = 6000;
const COLUMNS = ['pvPowerW', 'inverterPowerW', 'gridPowerW', 'loadPowerW', 'batteryPowerW',
  'batterySocPercent', 'totalAcEnergyWh', 'meterLocation', 'mode'];

function present(row) {
  if (!row) return null;
  const sample = { observedAt: new Date(row.observed_at).toISOString(),
    collectedAt: new Date(row.collected_at).toISOString(), receivedAt: new Date(row.received_at).toISOString() };
  for (const column of COLUMNS) sample[column] = row[column];
  return sample;
}

class SolarStore {
  constructor(filename, { dailySampleLimit = MAX_DAILY_SAMPLES } = {}) {
    // This is the already-verified weather database, never a new fourth backup
    // database. CREATE TABLE is additive and does not change user_version.
    if (!fs.statSync(filename).isFile()) throw new Error('Existing weather database is required');
    if (!Number.isInteger(dailySampleLimit) || dailySampleLimit < 1 || dailySampleLimit > MAX_DAILY_SAMPLES) {
      throw new Error('Invalid solar daily sample limit');
    }
    this.dailySampleLimit = dailySampleLimit;
    this.snapshotCache = new Map();
    this.db = new DatabaseSync(filename, { timeout: 250 });
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS solar_samples (
          source_id TEXT NOT NULL,
          observed_at INTEGER NOT NULL, collected_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
          pvPowerW REAL, inverterPowerW REAL, gridPowerW REAL, loadPowerW REAL, batteryPowerW REAL,
          batterySocPercent REAL, totalAcEnergyWh REAL, meterLocation TEXT, mode TEXT,
          PRIMARY KEY(source_id, observed_at)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS solar_daily (
          source_id TEXT NOT NULL, local_date TEXT NOT NULL, summary_json TEXT NOT NULL,
          PRIMARY KEY(source_id, local_date)
        ) STRICT, WITHOUT ROWID;`);
      this.insert = this.db.prepare(`INSERT OR IGNORE INTO solar_samples
        VALUES (${Array(13).fill('?').join(',')})`);
      this.exists = this.db.prepare('SELECT 1 FROM solar_samples WHERE source_id=? AND observed_at=?');
      this.dayCount = this.db.prepare('SELECT COUNT(*) AS count FROM solar_samples WHERE source_id=? AND observed_at>=? AND observed_at<?');
      this.prune = this.db.prepare(`DELETE FROM solar_samples WHERE source_id=? AND observed_at IN
        (SELECT observed_at FROM solar_samples WHERE source_id=? AND observed_at<? ORDER BY observed_at LIMIT 500)`);
      this.current = this.db.prepare('SELECT * FROM solar_samples WHERE source_id=? ORDER BY observed_at DESC LIMIT 1');
      this.day = this.db.prepare('SELECT * FROM solar_samples WHERE source_id=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at LIMIT 20001');
      this.dailyWrite = this.db.prepare(`INSERT INTO solar_daily VALUES (?, ?, ?)
        ON CONFLICT(source_id, local_date) DO UPDATE SET summary_json=excluded.summary_json`);
      this.dailyRead = this.db.prepare('SELECT local_date, summary_json FROM solar_daily WHERE source_id=? AND local_date>=? AND local_date<=? ORDER BY local_date');
      // Populate only missing archives. A later reopen must never replace a
      // completed archive with the partial raw day left at the retention edge.
      const missingDays = this.db.prepare(`SELECT DISTINCT date(observed_at / 1000, 'unixepoch', '+10 hours') AS local_date
        FROM solar_samples AS s WHERE source_id=? AND NOT EXISTS
          (SELECT 1 FROM solar_daily AS d WHERE d.source_id=s.source_id
           AND d.local_date=date(s.observed_at / 1000, 'unixepoch', '+10 hours'))`).all(SOURCE);
      if (missingDays.length) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of missingDays) this.refreshDay(Date.parse(row.local_date + 'T00:00:00+10:00'));
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    } catch (error) { this.db.close(); throw error; }
  }

  refreshDay(start) {
    const rows = this.day.all(SOURCE, start - MAX_GAP, start + DAY + MAX_GAP);
    if (rows.length > 20000) throw new Error('Solar daily sample limit exceeded');
    if (!rows.some(row => row.observed_at >= start && row.observed_at < start + DAY)) return;
    const summary = integrateDay(rows.map(present), start);
    this.dailyWrite.run(SOURCE, summary.date, JSON.stringify(summary));
  }

  save(samples, now) {
    let accepted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Enforce growth limits inside the same write transaction as insertion.
      // At the shortest supported 15-second interval a day has 5760 readings.
      // Replayed timestamps do not consume this allowance or block recovery.
      const pending = new Set(), byDay = new Map();
      for (const sample of samples) {
        const observed = Date.parse(sample.observedAt);
        if (pending.has(observed) || this.exists.get(SOURCE, observed)) continue;
        pending.add(observed);
        const start = localDay(observed).start;
        byDay.set(start, (byDay.get(start) || 0) + 1);
      }
      for (const [start, additional] of byDay) {
        if (this.dayCount.get(SOURCE, start, start + DAY).count + additional > this.dailySampleLimit) {
          const error = new Error('Solar daily sample limit exceeded.');
          error.code = 'SOLAR_DAILY_LIMIT';
          throw error;
        }
      }
      for (const sample of samples) {
        accepted += Number(this.insert.run(SOURCE, Date.parse(sample.observedAt), Date.parse(sample.collectedAt), now,
          ...COLUMNS.map(column => sample[column])).changes);
      }
      // Recompute rather than increment: a late observation replaces one
      // interpolated interval with two, and a midnight pair affects both days.
      const affected = new Set();
      for (const start of byDay.keys()) for (const offset of [-DAY, 0, DAY]) affected.add(start + offset);
      for (const start of affected) this.refreshDay(start);
      // Only this feature's samples expire. Existing weather/water data and
      // recovery retention remain untouched. Daily archives do not expire.
      // The bounded batch keeps writes short and runs only after aggregation.
      this.prune.run(SOURCE, SOURCE, now - 90 * DAY);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.snapshotCache.clear();
    return { accepted, duplicates: samples.length - accepted };
  }

  latest() { return present(this.current.get(SOURCE)); }

  snapshot(now, { history = false } = {}) {
    const key = Boolean(history), cached = this.snapshotCache.get(key);
    // Read traffic cannot repeatedly scan today's raw rows or all month history.
    // Every committed upload invalidates this short-lived, bounded cache.
    if (cached && now >= cached.at && now - cached.at < 10000 && localDay(cached.at).date === localDay(now).date) {
      return structuredClone(cached.value);
    }
    const current = this.latest(), { start } = localDay(now);
    const rows = this.day.all(SOURCE, start - 10 * MINUTE, now);
    // A compromised/misconfigured producer cannot make a public request scan
    // unbounded history. With the normal minute cadence a day has 1440 rows.
    if (rows.length > 20000) throw new Error('Solar daily sample limit exceeded');
    const samples = rows.map(present);
    let chart = null;
    if (history) {
      const step = 5 * MINUTE;
      const bins = new Map();
      for (const sample of samples) {
        const observed = Date.parse(sample.observedAt);
        if (observed < start) continue;
        const bucket = Math.floor((observed - start) / step);
        let bin = bins.get(bucket);
        if (!bin) {
          bin = { samples: 0, first: observed, last: null, hasGap: false,
            pv: [], ac: [], load: [], grid: [], imports: [], exports: [], self: [] };
          bins.set(bucket, bin);
        }
        if ((bin.last !== null && observed - bin.last > MAX_GAP) || sample.inverterPowerW === null ||
          sample.loadPowerW === null || sample.loadPowerW < 0 || sample.gridPowerW === null) bin.hasGap = true;
        bin.last = observed;
        bin.samples++;
        if (sample.pvPowerW !== null) bin.pv.push(sample.pvPowerW);
        if (sample.inverterPowerW !== null) bin.ac.push(sample.inverterPowerW);
        if (sample.loadPowerW !== null && sample.loadPowerW >= 0) bin.load.push(sample.loadPowerW);
        if (sample.gridPowerW !== null) {
          bin.grid.push(sample.gridPowerW); bin.imports.push(Math.max(0, sample.gridPowerW));
          bin.exports.push(Math.max(0, -sample.gridPowerW));
        }
        const self = solarToHomePower(sample);
        if (self !== null) bin.self.push(self);
      }
      const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      chart = { resolutionSeconds: 300, points: [] };
      let previousObserved = null;
      for (let bucket = 0; bucket <= Math.floor((now - start) / step) && bucket < 288; bucket++) {
        const bin = bins.get(bucket);
        chart.points.push({ observedAt: new Date(start + bucket * step).toISOString(),
          pvPowerW: bin ? mean(bin.pv) : null, inverterPowerW: bin ? mean(bin.ac) : null,
          loadPowerW: bin ? mean(bin.load) : null, gridPowerW: bin ? mean(bin.grid) : null,
          gridImportPowerW: bin ? mean(bin.imports) : null, gridExportPowerW: bin ? mean(bin.exports) : null,
          solarToHomeW: bin ? mean(bin.self) : null, samples: bin?.samples || 0,
          firstObservedAt: bin ? new Date(bin.first).toISOString() : null,
          lastObservedAt: bin ? new Date(bin.last).toISOString() : null,
          breakBefore: Boolean(bin && previousObserved !== null && bin.first - previousObserved > MAX_GAP),
          hasGap: Boolean(bin?.hasGap) });
        if (bin) previousObserved = bin.last;
      }
    }
    const energyToday = integrateDay(samples, start, now);
    let days = null;
    if (history) {
      const storedDays = new Map(this.dailyRead.all(SOURCE, localDay(start - 29 * DAY).date, localDay(now).date)
        .map(row => [row.local_date, JSON.parse(row.summary_json)]));
      days = [];
      for (let offset = 29; offset >= 0; offset--) {
        const dayStart = start - offset * DAY, date = localDay(dayStart).date;
        days.push(offset === 0 ? energyToday : storedDays.get(date) || integrateDay([], dayStart));
      }
    }
    const observed = current ? Date.parse(current.observedAt) : null;
    const result = { status: !current ? 'waiting' : observed > now + 5000 || now - observed > FRESH_FOR ? 'stale' : 'fresh',
      current, today: todayEnergy(samples, now), history: chart, rates: ratesFor(now),
      energy: { method: 'power-integration', maxGapSeconds: MAX_GAP / 1000, today: energyToday, days } };
    this.snapshotCache.set(key, { at: now, value: result });
    return structuredClone(result);
  }

  close() { this.db.close(); }
}

module.exports = { SolarStore, SOURCE, MAX_DAILY_SAMPLES };
