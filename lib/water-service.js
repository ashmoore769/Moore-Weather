'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
function createWaterService({ env, isReady, logger }) {
  const state = { enabled: Boolean(env.WEATHER_DB_PATH) && env.WATER_DATA_ENABLED !== 'false', ready: false };
  let worker, retry, closed = false, warwickConfirmed = false;
  function start() {
    if (closed || !state.enabled || worker) return;
    if (!isReady()) { retry = setTimeout(start, 60000); retry.unref(); return; }
    worker = new Worker(path.join(__dirname, 'water-collector-worker.js'), { workerData: { filename: env.WEATHER_DB_PATH } });
    worker.unref();
    worker.on('message', update => {
      Object.assign(state, update);
      if (update.error) logger.warn('[WATER] ' + (update.job || '') + ': ' + update.error);
      if (update.job === 'condamine-warwick-live' && !update.error && !warwickConfirmed) {
        warwickConfirmed = true;
        logger.info(`[WATER] Warwick Alert 041534 saved ${update.rows} observations; coverage ${new Date(update.firstObservation).toISOString()} to ${new Date(update.lastObservation).toISOString()}`);
      }
    });
    worker.on('error', error => { state.error = error.message; logger.warn('[WATER] ' + error.message); });
    worker.on('exit', () => { worker = null; state.ready = false; if (!closed) { retry = setTimeout(start, 60000); retry.unref(); } });
  }
  return { start, status: () => ({ ...state }), close() { closed = true; clearTimeout(retry); return worker?.terminate(); } };
}
module.exports = { createWaterService };
