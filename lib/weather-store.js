'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const defaultLayout = require('../config/station-layout.json');

function timestamp(date, time, offsetMinutes) {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) throw new Error('Invalid timestamp');
  const local = date.replaceAll('/', '-') + 'T' + time;
  const wall = Date.parse(local + 'Z');
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== local) throw new Error('Invalid calendar date or time');
  return { utc: new Date(wall - offsetMinutes * 60000).toISOString(), local };
}

function datedLines(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => /^\d{4}\//.test(line));
}

class WeatherStore {
  constructor(filename, layout = defaultLayout) {
    this.layout = structuredClone(layout);
    this.validateLayout();
    this.layoutId = hash(JSON.stringify(this.layout));
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    try {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 3) throw new Error('Database schema is newer than this application');
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec('BEGIN IMMEDIATE');
      if (version < 3) this.db.exec('DROP VIEW IF EXISTS weather_readings; DROP VIEW IF EXISTS weather_readings_review; DROP VIEW IF EXISTS weather_readings_raw; DROP VIEW IF EXISTS conflicting_records;');
      this.db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
      this.registerLayout();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.db.close();
      throw error;
    }
  }

  validateLayout() {
    const { station, sensors, streams, version } = this.layout;
    if (version !== 1 || !station?.id || !station.serial || !Array.isArray(sensors) || !streams?.mem0) throw new Error('Invalid layout');
    // This station has a fixed offset. Reject unimplemented DST assumptions.
    if (station.timezone !== 'Australia/Brisbane' || station.utcOffsetMinutes !== 600) throw new Error('Only verified Brisbane time conversion is supported');
    const keys = new Set(sensors.map(s => s.key));
    if (keys.size !== sensors.length) throw new Error('Duplicate sensor keys');
    for (const [key, stream] of Object.entries(streams)) {
      if (!/^(r3|mem\d+)$/.test(key) || !Array.isArray(stream.fields)) throw new Error('Invalid stream');
      if (stream.intervalSeconds !== null && (!Number.isInteger(stream.intervalSeconds) || stream.intervalSeconds <= 0)) throw new Error('Invalid interval');
      stream.fields.forEach((field, i) => {
        if (field.position !== i || !keys.has(field.sensorKey) || typeof field.name !== 'string' || typeof field.unit !== 'string' || !field.aggregation) throw new Error('Invalid field definition');
      });
    }
  }

  registerLayout() {
    const s = this.layout.station;
    const existing = this.db.prepare('SELECT * FROM stations WHERE id=?').get(s.id);
    if (existing && (existing.serial !== s.serial || existing.timezone !== s.timezone || existing.utc_offset_minutes !== s.utcOffsetMinutes)) throw new Error('Station identity/timezone changed; use a separate station id');
    this.db.prepare('INSERT OR IGNORE INTO stations VALUES(?,?,?,?,?)').run(s.id, s.name, s.serial, s.timezone, s.utcOffsetMinutes);
    this.db.prepare('INSERT OR IGNORE INTO layouts VALUES(?,?,?,?)').run(this.layoutId, s.id, JSON.stringify(this.layout), new Date().toISOString());
    for (const sensor of this.layout.sensors) this.db.prepare('INSERT OR IGNORE INTO sensors VALUES(?,?)').run(s.id, sensor.key);
    this.fields = {};
    const insert = this.db.prepare('INSERT OR IGNORE INTO fields(layout_id,stream,position,sensor_key,name,unit,aggregation,metadata_json) VALUES(?,?,?,?,?,?,?,?)');
    for (const [stream, definition] of Object.entries(this.layout.streams)) {
      for (const f of definition.fields) insert.run(this.layoutId, stream, f.position, f.sensorKey, f.name, f.unit, f.aggregation, JSON.stringify(f));
      this.fields[stream] = this.db.prepare('SELECT * FROM fields WHERE layout_id=? AND stream=? ORDER BY position').all(this.layoutId, stream);
    }
  }

  importBuffer(buffer, { name, stream, format = 'export', receivedAt = new Date().toISOString(), verifiedSerial, selectedLineNumbers } = {}) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (!this.layout.streams[stream]) throw new Error('Unmapped stream: ' + stream);
    if (!name) throw new Error('Source name is required');
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const declaredSerial = text.match(/^;\s*Serial Number:\s*([^\r\n]+)/mi)?.[1].trim();
    const serial = declaredSerial || verifiedSerial;
    if (serial !== this.layout.station.serial) throw new Error('Source station serial is missing or does not match the layout');
    const declaredMemory = text.match(/^;>\s*mem\s+(\d+)\b/mi)?.[1];
    if (declaredMemory !== undefined && stream !== 'mem' + declaredMemory) throw new Error('Source memory does not match requested stream');
    const digest = hash(buffer);
    const sourceId = hash(JSON.stringify([digest, this.layoutId, stream, name]));
    if (this.db.prepare('SELECT 1 FROM sources WHERE id=?').get(sourceId)) return { source: name, unchanged: true, inserted: 0, linked: 0,
      rejected: this.db.prepare('SELECT COUNT(*) AS count FROM rejected_rows WHERE source_id=?').get(sourceId).count };
    const result = { source: name, unchanged: false, inserted: 0, linked: 0, rejected: 0 };
    // Identical paired diagnostic exports share an ordered batch identity. Do not
    // collapse repeated messages in that batch; a logger event has no sequence id.
    const batchId = hash(datedLines(text).join('\n'));
    let diagnosticOrdinal = 0;
    const reject = this.db.prepare('INSERT INTO rejected_rows VALUES(?,?,?,?)');
    const link = this.db.prepare('INSERT INTO source_records VALUES(?,?,?)');
    const insertRecord = this.db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const insertValue = this.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)').run(sourceId, digest, name, format, this.layout.station.id, stream, this.layoutId, receivedAt, buffer);
      text.split(/\r?\n/).forEach((original, index) => {
        if (selectedLineNumbers && !selectedLineNumbers.has(index + 1)) return;
        const line = (format === 'terminal' ? original.replace(/^>\s*/, '') : original).trim();
        if (!line || /^(;|"?sep=|"?Date\s*,|\\?END\b|>\s*$|r3\s*$|MEM \d+ LAST\s*$)/i.test(line)) return;
        let parsed;
        try { parsed = this.parseRow(line, stream); }
        catch (error) {
          reject.run(sourceId, index + 1, original, error.message);
          result.rejected++;
          return;
        }
        const { utc, local, values, message } = parsed;
        const identity = stream === 'mem0' ? [batchId, diagnosticOrdinal++] : values;
        const id = hash(JSON.stringify([this.layout.station.id, this.layoutId, stream, utc, identity]));
        const seconds = this.layout.streams[stream].intervalSeconds;
        const start = seconds ? new Date(Date.parse(utc) - seconds * 1000).toISOString() : null;
        const reportingDate = stream === 'mem1' ? new Date(Date.parse(local + 'Z') - 86400000).toISOString().slice(0, 10) : null;
        const inserted = insertRecord.run(id, this.layout.station.id, stream, this.layoutId, utc, local, start, reportingDate, original, message, receivedAt).changes;
        if (inserted) {
          values.forEach((raw, position) => {
            const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw));
            const quality = raw === '' ? 'missing' : numeric ? 'valid' : 'invalid';
            insertValue.run(id, this.fields[stream][position].id, numeric ? Number(raw) : null, raw, quality);
          });
          result.inserted++;
        }
        link.run(sourceId, index + 1, id);
        result.linked++;
      });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  parseRow(line, stream) {
    if (stream === 'mem0') {
      const match = line.match(/^(\d{4}\/\d{2}\/\d{2}),(\d{2}:\d{2}:\d{2})\s+(.*)$/);
      if (!match) throw new Error('Malformed diagnostic record');
      return { ...timestamp(match[1], match[2], this.layout.station.utcOffsetMinutes), values: [], message: match[3] };
    }
    const fields = line.split(',').map(value => value.trim());
    if (fields.length !== this.fields[stream].length + 2) throw new Error(`Unexpected field count: ${fields.length}; expected ${this.fields[stream].length + 2}`);
    const time = timestamp(fields[0], fields[1], this.layout.station.utcOffsetMinutes);
    if (stream === 'mem1' && fields[1] !== '09:00:00') throw new Error('Daily record is not at the verified 09:00 boundary');
    return { ...time, values: fields.slice(2), message: null };
  }

  ingestLive(stream, line, receivedAt = new Date().toISOString()) {
    return this.importBuffer(Buffer.from(line + '\n'), { name: 'live/' + stream, stream, format: 'logger', receivedAt, verifiedSerial: this.layout.station.serial });
  }

  latest(stream) {
    // Ambiguous timestamps must not pick a silent winner during cache restoration.
    return this.db.prepare(`SELECT r.* FROM records r WHERE r.station_id=? AND r.layout_id=? AND r.stream=?
      AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.record_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM conflicting_records c WHERE c.station_id=r.station_id AND c.stream=r.stream AND c.observed_at=r.observed_at)
      AND NOT EXISTS(SELECT 1 FROM observations o WHERE o.record_id=r.id AND o.quality!='valid')
      AND NOT EXISTS(SELECT 1 FROM weather_readings_review q WHERE q.record_id=r.id AND q.exclusion_reason IS NOT NULL)
      ORDER BY r.observed_at DESC LIMIT 1`).get(this.layout.station.id, this.layoutId, stream);
  }

  summary() {
    return {
      streams: this.db.prepare('SELECT stream, COUNT(*) AS records, MIN(local_timestamp) AS first, MAX(local_timestamp) AS last FROM records GROUP BY stream ORDER BY stream').all(),
      observations: this.db.prepare('SELECT COUNT(*) AS count FROM observations').get().count,
      usableObservations: this.db.prepare('SELECT COUNT(*) AS count FROM weather_readings').get().count,
      exclusions: this.db.prepare('SELECT exclusion_reason, COUNT(*) AS measurements FROM weather_readings_review WHERE exclusion_reason IS NOT NULL GROUP BY exclusion_reason').all(),
      sources: this.db.prepare('SELECT COUNT(*) AS count FROM sources').get().count,
      rejected: this.db.prepare('SELECT COUNT(*) AS count FROM rejected_rows').get().count,
      nonNumeric: this.db.prepare("SELECT COUNT(*) AS count FROM observations WHERE quality!='valid'").get().count,
      conflicts: this.db.prepare('SELECT COUNT(*) AS count FROM conflicting_records').get().count,
      estimatedRecords: this.db.prepare('SELECT COUNT(*) AS count FROM record_estimates').get().count,
      adjustedObservations: this.db.prepare('SELECT COUNT(*) AS count FROM weather_readings WHERE adjustment IS NOT NULL').get().count,
      integrity: this.db.prepare('PRAGMA integrity_check').get().integrity_check,
      foreignKeyErrors: this.db.prepare('PRAGMA foreign_key_check').all().length
    };
  }

  setQualityPolicy(policy) {
    if (policy.stationId !== this.layout.station.id) throw new Error('Quality policy station does not match');
    const cutoff = policy.earliestLocalTimestamp;
    if (typeof cutoff !== 'string' || cutoff.length !== 19 || cutoff[10] !== 'T') throw new Error('Invalid quality cutoff');
    timestamp(cutoff.slice(0,10).replaceAll('-', '/'), cutoff.slice(11), this.layout.station.utcOffsetMinutes);
    if (!Number.isFinite(policy.pressureMinHpa) || !Number.isFinite(policy.pressureMaxHpa) || policy.pressureMinHpa >= policy.pressureMaxHpa || typeof policy.note !== 'string') throw new Error('Invalid quality thresholds');
    const limits = policy.sensorLimits || [];
    const keys = new Set();
    for (const limit of limits) {
      if (!this.layout.sensors.some(s => s.key === limit.sensorKey) || keys.has(limit.sensorKey)
        || !Number.isFinite(limit.minimum) || !Number.isFinite(limit.maximum) || limit.minimum >= limit.maximum
        || typeof limit.note !== 'string' || (limit.floorZero !== undefined && typeof limit.floorZero !== 'boolean')
        || (limit.floorZero && limit.sensorKey !== '6')) throw new Error('Invalid sensor quality limit');
      keys.add(limit.sensorKey);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
    this.db.prepare(`INSERT INTO data_quality_policies VALUES(?,?,?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET
      earliest_local_timestamp=excluded.earliest_local_timestamp, pressure_min_hpa=excluded.pressure_min_hpa,
      pressure_max_hpa=excluded.pressure_max_hpa, note=excluded.note, updated_at=excluded.updated_at`).run(
      policy.stationId, cutoff, policy.pressureMinHpa, policy.pressureMaxHpa, policy.note, new Date().toISOString());
      this.db.prepare('DELETE FROM sensor_quality_limits WHERE station_id=?').run(policy.stationId);
      const insert = this.db.prepare('INSERT INTO sensor_quality_limits VALUES(?,?,?,?,?,?)');
      for (const limit of limits) insert.run(policy.stationId, limit.sensorKey, limit.minimum, limit.maximum, Number(Boolean(limit.floorZero)), limit.note);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async backup(destination) {
    if (fs.existsSync(destination)) throw new Error('Backup destination already exists');
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
    await backup(this.db, destination);
  }
  close() { this.db.close(); }
}
module.exports = { WeatherStore, timestamp, datedLines, hash };
