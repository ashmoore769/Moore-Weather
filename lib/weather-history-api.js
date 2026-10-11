'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { normalizeRequest } = require('./weather-history');

function createHistoryApi({ filename, isReady, logger }) {
  let worker, sequence = 0, retryAfter = 0;
  const pending = new Map(), cache = new Map(), inFlight = new Map();
  function stop(error) {
    const previous = worker;
    worker = null;
    retryAfter = Date.now() + 10000;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    if (previous) previous.terminate().catch(() => {});
  }
  function run(request) {
    if (!filename || !isReady() || Date.now() < retryAfter) return Promise.reject(new Error('History database unavailable'));
    if (pending.size >= 8) return Promise.reject(new Error('History reader is busy'));
    if (!worker) {
      worker = new Worker(path.join(__dirname, 'weather-history-worker.js'), { workerData: { filename } });
      const current = worker;
      current.on('error', error => { if (worker === current) stop(error); });
      current.on('exit', code => { if (worker === current) stop(new Error('History reader exited: ' + code)); });
      current.on('message', message => {
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(message.id);
        if (message.error) entry.reject(Object.assign(new Error(message.error), { status: message.status }));
        else entry.resolve(message.result);
      });
      current.unref();
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => stop(new Error('History query timed out')), 15000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, request });
    });
  }
  async function query(request) {
    const key = JSON.stringify(request), existing = cache.get(key);
    if (existing && existing.until > Date.now()) return existing.result;
    if (inFlight.has(key)) return inFlight.get(key);
    const job = run(request).then(result => {
      cache.delete(key);
      cache.set(key, { result, until: Date.now() + 60000 });
      while (cache.size > 32) cache.delete(cache.keys().next().value);
      return result;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  }
  function handler(trends = false) {
    return async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      try { res.json(await query(normalizeRequest(req.query, trends))); }
      catch (error) {
        if (error.status !== 400) logger.warn('[HISTORY] ' + error.message);
        res.status(error.status === 400 ? 400 : 503).json({ error: error.status === 400 ? error.message : 'History is temporarily unavailable. Please try again shortly.' });
      }
    };
  }
  return { handler, query, close: () => stop(new Error('History reader closed')) };
}
module.exports = { createHistoryApi };
