'use strict';

// Independent, optional yard-power feed. Shares the existing backed-up weather
// database, but never the station or Fronius tables, routes or credentials.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const MINUTE = 60000;
const DAY = 86400000;
const FRESH_MS = 3 * MINUTE;
const MAX_AGE_MS = 14 * DAY;
const RETAIN_MS = 32 * DAY;
const FIELDS = Object.freeze({
  batteryVoltageV: [0, 100],
  pvVoltageV: [0, 200],
  pvPowerW: [0, 20000],
  chargeCurrentA: [0, 200],
  controllerLoadPowerW: [0, 20000],
  controllerTempC: [-50, 125],
  pvCurrentA: [0, 200],
  controllerLoadCurrentA: [0, 200],
  chargingPowerW: [0, 20000]
});
const FIELD_NAMES = Object.keys(FIELDS);
const SAMPLE_KEYS = ['observedAt', 'collectedAt', ...FIELD_NAMES];
const RANGES = { '24h': [DAY, MINUTE], '7d': [7 * DAY, 10 * MINUTE], '30d': [30 * DAY, 30 * MINUTE] };

function configuration(env) {
  const token = env.YARD_POWER_INGEST_TOKEN;
  return {
    enabled: Boolean(env.WEATHER_DB_PATH) && typeof token === 'string' && /^[\x21-\x7e]{32,256}$/.test(token),
    token: typeof token === 'string' ? token : ''
  };
}

function validateBatch(body, now = Date.now()) {
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
    Object.keys(body).sort().join(',') !== 'samples,version' ||
    body.version !== 1 || !Array.isArray(body.samples) ||
    body.samples.length < 1 || body.samples.length > 120) {
    throw new Error('Expected version 1 and 1 to 120 yard power samples.');
  }
  return body.samples.map(input => {
    if (!input || Array.isArray(input) || typeof input !== 'object' ||
      Object.keys(input).sort().join(',') !== [...SAMPLE_KEYS].sort().join(',')) {
      throw new Error('Invalid yard power sample fields.');
    }
    const observed = Date.parse(input.observedAt), collected = Date.parse(input.collectedAt);
    const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    if (typeof input.observedAt !== 'string' || typeof input.collectedAt !== 'string' ||
      !iso.test(input.observedAt) || !iso.test(input.collectedAt) ||
      !Number.isFinite(observed) || !Number.isFinite(collected) ||
      new Date(observed).toISOString() !== input.observedAt ||
      new Date(collected).toISOString() !== input.collectedAt ||
      observed < now - MAX_AGE_MS || collected < now - MAX_AGE_MS ||
      observed > now + 5 * MINUTE || collected > now + 5 * MINUTE ||
      observed > collected + 5 * MINUTE) {
      throw new Error('Yard power sample time is outside the accepted window.');
    }
    const sample = { observedAt: observed, collectedAt: collected };
    let valid = 0;
    for (const [name, [min, max]] of Object.entries(FIELDS)) {
      const value = input[name];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) {
        throw new Error('Invalid yard power measurement.');
      }
      if (value !== null) valid += 1;
      sample[name] = value;
    }
    if (!valid) throw new Error('Empty yard power measurement.');
    return sample;
  });
}

function present(row) {
  if (!row) return null;
  const out = {
    observedAt: new Date(row.observed_at).toISOString(),
    collectedAt: new Date(row.collected_at).toISOString(),
    receivedAt: new Date(row.received_at).toISOString()
  };
  for (const name of FIELD_NAMES) out[name] = row[name];
  return out;
}

class YardPowerStore {
  constructor(filename) {
    if (!fs.statSync(filename).isFile()) throw new Error('Existing weather database required');
    this.db = new DatabaseSync(filename, { timeout: 250 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ' +
        'CREATE TABLE IF NOT EXISTS yard_power_samples (' +
        'observed_at INTEGER PRIMARY KEY, collected_at INTEGER NOT NULL, received_at INTEGER NOT NULL, ' +
        FIELD_NAMES.map(name => name + ' REAL').join(', ') +
        ') STRICT;');
      this.insert = this.db.prepare('INSERT OR IGNORE INTO yard_power_samples VALUES (' +
        Array(3 + FIELD_NAMES.length).fill('?').join(',') + ')');
      this.latestQuery = this.db.prepare('SELECT * FROM yard_power_samples ORDER BY observed_at DESC LIMIT 1');
      this.historyQuery = this.db.prepare('SELECT * FROM yard_power_samples WHERE observed_at>=? AND observed_at<=? ORDER BY observed_at LIMIT 46081');
      this.pruneQuery = this.db.prepare('DELETE FROM yard_power_samples WHERE observed_at < ?');
    } catch (error) { this.db.close(); throw error; }
  }
  save(samples, now) {
    let accepted = 0, duplicates = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const sample of samples) {
        const values = [sample.observedAt, sample.collectedAt, now,
          ...FIELD_NAMES.map(name => sample[name])];
        if (this.insert.run(...values).changes) accepted += 1;
        else duplicates += 1;
      }
      this.pruneQuery.run(now - RETAIN_MS);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { accepted, duplicates };
  }
  latest() { return present(this.latestQuery.get()); }
  snapshot(now, range) {
    const current = this.latest();
    const age = current ? now - Date.parse(current.observedAt) : null;
    const status = !current ? 'waiting' : age >= 0 && age <= FRESH_MS ? 'fresh' : 'stale';
    const result = { enabled: true, status, staleAfterSeconds: FRESH_MS / 1000,
      timezone: 'Australia/Brisbane', current, range: range || null, history: null };
    if (!range) return result;
    const [windowMs, bucketMs] = RANGES[range];
    const rows = this.historyQuery.all(now - windowMs, now);
    const bins = new Map();
    for (const row of rows) {
      const bucket = Math.floor(row.observed_at / bucketMs);
      // Keep the newest real observation per bucket. Never interpolate gaps.
      bins.set(bucket, present(row));
    }
    result.history = Array.from(bins.values());
    return result;
  }
  close() { this.db.close(); }
}

function createYardPowerService({ env = process.env, isReady = () => false,
  logger = console, now = Date.now, openStore = file => new YardPowerStore(file) } = {}) {
  const { enabled } = configuration(env);
  let store = null, closed = false, retryAt = -Infinity;
  function ready() {
    if (!enabled || closed) return false;
    try { if (!isReady()) return false; } catch { return false; }
    if (store) return true;
    if (now() < retryAt) return false;
    retryAt = now() + MINUTE;
    try { store = openStore(env.WEATHER_DB_PATH); return true; }
    catch { logger.warn?.('[YARD POWER] Storage unavailable'); return false; }
  }
  return {
    ingest(samples) {
      if (!ready()) throw new Error('Yard power storage unavailable');
      return store.save(samples, now());
    },
    snapshot({ range = null } = {}) {
      const disabled = { enabled, status: enabled ? 'unavailable' : 'disabled',
        staleAfterSeconds: FRESH_MS / 1000, timezone: 'Australia/Brisbane',
        current: null, range, history: null };
      if (!ready()) return disabled;
      try { return store.snapshot(now(), range); }
      catch { logger.warn?.('[YARD POWER] Snapshot unavailable'); return disabled; }
    },
    close() { closed = true; if (store) { store.close(); store = null; } }
  };
}

function mountYardPowerIngest(app, { env = process.env, getService, now = Date.now } = {}) {
  const express = require('express');
  const router = express.Router();
  const config = configuration(env);
  const expected = crypto.createHash('sha256').update(config.token).digest();
  let windowAt = now(), requests = 0, samples = 0;
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.post('/', (req, res, next) => {
    if (!config.enabled) return res.status(404).json({ error: 'Yard power ingestion disabled.' });
    if (req.get('origin') !== undefined) return res.status(403).json({ error: 'Collector authorization required.' });
    const match = /^Bearer ([\x21-\x7e]{32,256})$/.exec(req.get('authorization') || '');
    const received = crypto.createHash('sha256').update(match?.[1] || '').digest();
    if (!match || !crypto.timingSafeEqual(expected, received)) {
      return res.status(403).json({ error: 'Collector authorization required.' });
    }
    if (now() < windowAt || now() - windowAt >= MINUTE) { windowAt = now(); requests = 0; samples = 0; }
    if (++requests > 60) return res.set('Retry-After', '60').status(429).json({ error: 'Upload rate exceeded.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required.' });
    next();
  }, express.json({ limit: '128kb', inflate: false, strict: true }), (req, res) => {
    let batch;
    try { batch = validateBatch(req.body, now()); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    if (samples + batch.length > 1200) {
      return res.set('Retry-After', '60').status(429).json({ error: 'Upload rate exceeded.' });
    }
    samples += batch.length;
    try { return res.json(getService().ingest(batch)); }
    catch { return res.set('Retry-After', '60').status(503).json({ error: 'Yard power storage unavailable.' }); }
  });
  router.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'encoding.unsupported' ? 415 : 400;
    res.status(status).json({ error: 'Invalid yard power upload.' });
  });
  app.use('/internal/yard-power/ingest', router);
}

function mountYardPowerRead(app, { getService } = {}) {
  app.get('/api/yard-power', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (Object.keys(req.query).some(key => key !== 'range') ||
      (req.query.range !== undefined && !Object.hasOwn(RANGES, req.query.range))) {
      return res.status(400).json({ error: 'Unsupported yard power history request.' });
    }
    const snapshot = getService().snapshot({ range: req.query.range || null });
    return res.status(snapshot.status === 'unavailable' ? 503 : 200).json(snapshot);
  });
}

module.exports = { configuration, validateBatch, YardPowerStore, createYardPowerService,
  mountYardPowerIngest, mountYardPowerRead, FIELDS, FRESH_MS };
