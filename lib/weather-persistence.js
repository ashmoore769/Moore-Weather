'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { importCapture, inspectCapture } = require('./terminal-capture');

function createPersistence(env, logger) {
  const state = { enabled: Boolean(env.WEATHER_DB_PATH), ready: false, lastWrite: null, error: null };
  let store;
  function fail(error) {
    state.error = error.message;
    logger.error('[DATABASE] ' + error.message);
  }
  if (state.enabled) {
    try {
      if (env.RENDER === 'true') {
        // Render's application checkout is ephemeral. Only permit a database
        // below an actual separate /var/data mount (the documented disk setup).
        const directory = fs.realpathSync(path.dirname(path.resolve(env.WEATHER_DB_PATH)));
        const mounted = fs.readFileSync('/proc/mounts', 'utf8').split('\n').some(line => {
          const [, mount, type] = line.split(' ');
          return mount === '/var/data' && !['tmpfs', 'overlay'].includes(type);
        });
        if (!mounted || !(directory === '/var/data' || directory.startsWith('/var/data/'))) throw new Error('Render database requires a persistent disk mounted at /var/data');
        if (!fs.existsSync(env.WEATHER_DB_PATH)) throw new Error('Initial database must be uploaded and verified before enabling recording');
      }
      const { WeatherStore } = require('./weather-store');
      const layout = env.WEATHER_DB_LAYOUT ? JSON.parse(fs.readFileSync(env.WEATHER_DB_LAYOUT, 'utf8')) : undefined;
      store = new WeatherStore(env.WEATHER_DB_PATH, layout);
      store.setQualityPolicy(require('../config/data-quality.json'));
      state.ready = true;
    } catch (error) { fail(error); }
  }
  return {
    status: () => ({ ...state }),
    latest(stream) {
      if (!store) return null;
      try { return store.latest(stream) || null; } catch (error) { fail(error); return null; }
    },
    record(stream, response) {
      if (!store) return;
      try {
        const lines = response.split(/\r?\n/).filter(line => /^\d{4}\//.test(line.trim()));
        if (lines.length !== 1) throw new Error('Expected one dated ' + stream + ' record');
        const result = store.ingestLive(stream, lines[0].trim());
        if (result.rejected) throw new Error('Unmapped ' + stream + ' record retained in rejected_rows; verify the logger layout');
        state.lastWrite = new Date().toISOString();
        state.error = null;
      } catch (error) { fail(error); }
    },
    recordHistory(stream, response) {
      if (!store) throw new Error('Database unavailable');
      const bytes = Buffer.from(response);
      const inspected = inspectCapture(bytes, store.layout, stream);
      if ([...inspected.sections.keys()].some(key => key !== stream)
        || !inspected.notes.some(n => n.kind === 'completed' && n.stream === stream)) throw new Error('Unexpected or incomplete memory response');
      const selected = inspected.sections.get(stream) || new Set();
      const rows = response.split(/\r?\n/).flatMap((line, index) => selected.has(index + 1)
        ? [store.parseRow(line.replace(/^>\s*/, '').trim(), stream)] : []);
      if (rows.some((row, i) => i > 0 && row.utc < rows[i - 1].utc)) throw new Error('Memory response is not chronological');
      if (rows.some(row => row.values.some(v => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)))) throw new Error('Memory response has nonnumeric measurements');
      const prior = store.db.prepare(`SELECT MAX(observed_at) AS last FROM records WHERE stream=? AND station_id=?
        AND NOT EXISTS (SELECT 1 FROM record_estimates e WHERE e.record_id=records.id)`).get(stream, store.layout.station.id).last;
      let warning = null;
      if (prior && rows.length && rows[0].utc > prior) warning = 'No overlap with stored history; older records may need a manual download';
      const imported = importCapture(store, bytes, { name: 'live/' + stream + '/recent', verifiedSerial: store.layout.station.serial, initialStream: stream });
      const result = imported.imports[0] || { inserted: 0, linked: 0, rejected: 0 };
      if (result.rejected) throw new Error('Rejected memory rows; verify layout');
      state.lastWrite = new Date().toISOString();
      state.error = null;
      return { ...result, warning };
    },
    close() { if (store) { store.close(); store = null; state.ready = false; } }
  };
}
module.exports = { createPersistence };
