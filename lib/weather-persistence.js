'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { importCapture, inspectCapture } = require('./terminal-capture');
const { futureLimit, historyCompleteness } = require('./weather-history-gaps');
const clockCorrections = require('./weather-clock-corrections');

function createPersistence(env, logger, { now = Date.now } = {}) {
  const state = { enabled: Boolean(env.WEATHER_DB_PATH), ready: false, lastWrite: null, error: null };
  let store;
  function fail(error) {
    state.error = error.message;
    logger.error('[DATABASE] ' + error.message);
  }
  function clockJournal(operation) {
    if (!state.enabled) return null;
    try {
      if (!state.ready || !store) throw new Error('Weather database unavailable; clock correction cannot be journaled');
      return operation(store.db, store.layout.station.id);
    } catch (error) { fail(error); throw error; }
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
    recordClockCorrection(correction) {
      return clockJournal((db, stationId) => clockCorrections.recordClockCorrection(db, stationId, correction));
    },
    verifyClockCorrection(id, verifiedAt) {
      return clockJournal((db, stationId) => clockCorrections.verifyClockCorrection(db, stationId, id, verifiedAt));
    },
    pendingClockCorrections() {
      return clockJournal((db, stationId) => clockCorrections.pendingClockCorrections(db, stationId, now())) || [];
    },
    status() {
      if (!store) return { ...state };
      try {
        const quarantine = store.db.prepare(`SELECT SUM(future_rows) AS futureRows, MAX(last_received_at) AS lastReceivedAt
          FROM weather_quarantine_state WHERE station_id=?`).get(store.layout.station.id);
        return { ...state, quarantine: { futureRows: quarantine.futureRows || 0, lastReceivedAt: quarantine.lastReceivedAt || null } };
      } catch (error) { fail(error); return { ...state }; }
    },
    latest(stream) {
      if (!store) return null;
      try { return store.latest(stream, now()) || null; } catch (error) { fail(error); return null; }
    },
    historyStatus() {
      if (!store) return { enabled: state.enabled, ready: false, streams: {} };
      try {
        const latest = store.db.prepare(`SELECT MAX(observed_at) AS last FROM records WHERE stream=? AND station_id=? AND observed_at<=?
          AND NOT EXISTS (SELECT 1 FROM record_estimates e WHERE e.record_id=records.id)`);
        return { enabled: state.enabled, ready: true, streams: Object.fromEntries(['mem3', 'mem2', 'mem1'].map(stream =>
          [stream, latest.get(stream, store.layout.station.id, futureLimit(now())).last || null])),
          completeness: historyCompleteness(store.db, store.layout.station.id) };
      } catch (error) { fail(error); return { enabled: state.enabled, ready: false, streams: {} }; }
    },
    record(stream, response) {
      if (!store) return;
      try {
        const lines = response.split(/\r?\n/).filter(line => /^\d{4}\//.test(line.trim()));
        if (lines.length !== 1) throw new Error('Expected one dated ' + stream + ' record');
        const result = store.ingestLive(stream, lines[0].trim(), new Date(now()).toISOString());
        if (result.rejected > result.quarantined) throw new Error('Unmapped ' + stream + ' record retained in rejected_rows; verify the logger layout');
        if (result.quarantined || store.parseRow(lines[0].trim(), stream).utc > futureLimit(now()))
          throw new Error('Future ' + stream + ' timestamp quarantined; check the logger clock');
        state.lastWrite = new Date(now()).toISOString();
        state.error = null;
        return result;
      } catch (error) { fail(error); return null; }
    },
    recordHistory(stream, response) {
      if (!store) throw new Error('Database unavailable');
      const bytes = Buffer.from(response);
      const inspected = inspectCapture(bytes, store.layout, stream);
      if ([...inspected.sections.keys()].some(key => key !== stream)
        || !inspected.notes.some(n => n.kind === 'completed' && n.stream === stream)) throw new Error('Unexpected or incomplete memory response');
      const selected = inspected.sections.get(stream) || new Set();
      const rows = response.split(/\r?\n/).flatMap((line, index) => {
        if (!selected.has(index + 1)) return [];
        const cleaned = line.replace(/^>\s*/, '').trim();
        try { return [store.parseRow(cleaned, stream)]; }
        catch (error) { throw new Error(`${error.message}; reply line ${index + 1}: ${JSON.stringify(cleaned.slice(0, 100))}`); }
      });
      const receivedAt = new Date(now()).toISOString();
      const maximumObservedAt = futureLimit(now());
      const usableRows = rows.filter(row => row.utc <= maximumObservedAt);
      const futureRows = rows.length - usableRows.length;
      // A corrected logger clock can leave future rows followed by valid rows
      // in its bounded tail. Quarantine the future rows before checking order.
      const ordered = clockCorrections.orderVerifiedHistory(store.db, store.layout.station.id, usableRows, receivedAt);
      if (rows.some(row => row.values.some(v => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v) || !Number.isFinite(Number(v))))) throw new Error('Memory response has nonnumeric measurements');
      // Regular memories should contain observations. An empty conditional rain
      // memory is valid when no rain event has been recorded.
      if (!rows.length && stream !== 'mem4') throw new Error(`Empty ${stream} history response (${bytes.length} bytes); existing records preserved`);
      const imported = importCapture(store, bytes, { name: 'live/' + stream + '/recent', verifiedSerial: store.layout.station.serial,
        initialStream: stream, receivedAt, maximumObservedAt });
      const result = imported.imports[0] || { inserted: 0, linked: 0, rejected: 0, quarantined: 0 };
      if (result.rejected > result.quarantined) throw new Error('Rejected memory rows; verify layout');
      state.lastWrite = receivedAt;
      state.error = futureRows ? 'Future logger timestamps quarantined; check the logger clock' : null;
      const firstObservedAt = ordered.rows[0]?.utc || null;
      const lastObservedAt = ordered.rows.at(-1)?.utc || null;
      const storedThrough = store.db.prepare(`SELECT MAX(observed_at) AS last FROM records WHERE stream=? AND station_id=? AND observed_at<=?
        AND NOT EXISTS (SELECT 1 FROM record_estimates e WHERE e.record_id=records.id)`)
        .get(stream, store.layout.station.id, maximumObservedAt).last || null;
      const coverage = historyCompleteness(store.db, store.layout.station.id).streams[stream];
      const gapWarning = coverage?.unresolvedGaps
        ? `No overlap across ${coverage.unresolvedGaps} unresolved history gap(s); ${coverage.missingIntervals} missing intervals need a manual download`
        : null;
      const clockWarning = futureRows ? `${futureRows} future logger row(s) quarantined; check the logger clock` : null;
      const correctionWarning = ordered.correctionIds.length
        ? `${ordered.correctionIds.length} verified clock correction(s) explain timestamp reversal; original logger order retained` : null;
      const warning = [gapWarning, clockWarning, correctionWarning].filter(Boolean).join('; ') || null;
      // Linked rows count imports, not rows received: an identical source is
      // deliberately deduplicated and has zero linked rows on later downloads.
      return { ...result, received: rows.length, replyBytes: bytes.length, firstObservedAt, lastObservedAt, storedThrough, warning,
        clockCorrectionIds: ordered.correctionIds };
    },
    close() { if (store) { store.close(); store = null; state.ready = false; } }
  };
}
module.exports = { createPersistence };
