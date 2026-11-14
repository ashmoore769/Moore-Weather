'use strict';

const crypto = require('node:crypto');
const { FRESH_FOR, MINUTE, validateBatch, emptyToday } = require('./solar-data');

function configuration(env) {
  const token = env.SOLAR_INGEST_TOKEN;
  return { enabled: Boolean(env.WEATHER_DB_PATH) && typeof token === 'string' && /^[\x21-\x7e]{32,256}$/.test(token),
    token: typeof token === 'string' ? token : '' };
}

function createSolarService({ env = process.env, isReady = () => false, logger = console, now = Date.now,
  openStore = filename => new (require('./solar-store').SolarStore)(filename) } = {}) {
  const { enabled } = configuration(env);
  let store = null, closed = false, retryAt = -Infinity, error = null;
  function failure() {
    error = 'Solar storage is temporarily unavailable.';
    logger.warn?.('[SOLAR] ' + error);
  }
  function ready() {
    if (!enabled || closed) return false;
    try { if (!isReady()) return false; } catch { return false; }
    if (store) return true;
    if (now() < retryAt) return false;
    retryAt = now() + MINUTE;
    try { store = openStore(env.WEATHER_DB_PATH); error = null; return true; }
    catch { failure(); return false; }
  }
  return {
    ingest(samples) {
      if (!ready()) throw new Error('Solar storage is unavailable.');
      try { const result = store.save(samples, now()); error = null; return result; }
      catch (error) {
        if (error.code === 'SOLAR_DAILY_LIMIT') throw error;
        failure(); throw new Error('Solar storage is unavailable.');
      }
    },
    snapshot(options) {
      const timestamp = now();
      const result = { enabled, status: enabled ? 'unavailable' : 'disabled', timezone: 'Australia/Brisbane',
        staleAfterSeconds: FRESH_FOR / 1000, current: null, today: emptyToday(timestamp), history: null };
      if (!ready()) return result;
      try { const snapshot = store.snapshot(timestamp, options); error = null; return { ...result, ...snapshot }; }
      catch { failure(); return result; }
    },
    status() {
      let current = null;
      const storageReady = ready();
      if (storageReady) { try { current = store.latest(); } catch { failure(); } }
      return { enabled, ready: storageReady && !error, lastObservedAt: current?.observedAt || null,
        lastReceivedAt: current?.receivedAt || null, error };
    },
    close() { closed = true; if (store) { store.close(); store = null; } }
  };
}

function mountSolarIngest(app, { env = process.env, getService, now = Date.now, maxRequestsPerMinute = 60,
  maxSamplesPerMinute = 1200 } = {}) {
  const express = require('express'), router = express.Router();
  const config = configuration(env);
  const expected = crypto.createHash('sha256').update(config.token).digest();
  let windowAt = now(), requests = 0, samples = 0;
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.post('/', (req, res, next) => {
    if (!config.enabled) return res.status(404).json({ error: 'Solar ingestion is disabled.' });
    if (req.get('origin') !== undefined) return res.status(403).json({ error: 'Solar collector authorization required.' });
    const match = /^Bearer ([\x21-\x7e]{32,256})$/.exec(req.get('authorization') || '');
    const received = crypto.createHash('sha256').update(match?.[1] || '').digest();
    if (!match || !crypto.timingSafeEqual(received, expected)) {
      return res.status(403).json({ error: 'Solar collector authorization required.' });
    }
    if (now() - windowAt >= MINUTE || now() < windowAt) { windowAt = now(); requests = 0; samples = 0; }
    if (++requests > maxRequestsPerMinute) return res.set('Retry-After', '60').status(429).json({ error: 'Solar upload rate exceeded.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'Solar uploads require application/json.' });
    next();
  }, express.json({ limit: '128kb', inflate: false, strict: true }), (req, res) => {
    let batch;
    try { batch = validateBatch(req.body, now()); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    if (samples + batch.length > maxSamplesPerMinute) {
      return res.set('Retry-After', '60').status(429).json({ error: 'Solar upload rate exceeded.' });
    }
    samples += batch.length;
    try { return res.json(getService().ingest(batch)); }
    catch (error) {
      if (error.code === 'SOLAR_DAILY_LIMIT') {
        return res.set('Retry-After', '3600').status(429).json({ error: 'Solar daily sample limit exceeded.' });
      }
      return res.set('Retry-After', '60').status(503).json({ error: 'Solar storage is temporarily unavailable.' });
    }
  });
  router.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'encoding.unsupported' ? 415 : 400;
    res.status(status).json({ error: status === 413 ? 'Solar upload is too large.' : 'Invalid solar upload body.' });
  });
  app.use('/internal/solar/ingest', router);
}

function mountSolarRead(app, { getService } = {}) {
  app.get('/api/solar', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (Object.keys(req.query).some(key => key !== 'history') ||
      (req.query.history !== undefined && req.query.history !== 'today')) {
      return res.status(400).json({ error: 'Unsupported solar history request.' });
    }
    const snapshot = getService().snapshot({ history: req.query.history === 'today' });
    return res.status(snapshot.status === 'unavailable' ? 503 : 200).json(snapshot);
  });
}

module.exports = { configuration, createSolarService, mountSolarIngest, mountSolarRead };
