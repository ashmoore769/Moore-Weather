'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const RETENTION_DAYS = 15;
const BATCH_SIZE = 100;
const MAX_BATCHES = 10;
const MAX_PASS_MS = 2000;

// A single bounded delete transaction. The caller must have verified the
// pre-retention checkpoint; fail closed even if called without the scheduler.
function pruneR3Batch(db, { stationId, cutoff, authorized = false, limit = BATCH_SIZE, now = Date.now() } = {}) {
  if (!authorized) return { blocked: true, deletedRecords: 0, deletedObservations: 0, deletedSources: 0, deletedRejected: 0 };
  if (!stationId || !Number.isFinite(Date.parse(cutoff)) || !Number.isInteger(limit) || limit < 1 || limit > BATCH_SIZE) {
    throw new Error('Invalid R3 retention batch');
  }
  // Estimates can refer to measured parents. Protect every such dependency,
  // even though the current app only interpolates MEM3 rather than R3.
  const rows = db.prepare(`SELECT id FROM records r WHERE station_id=? AND stream='r3' AND observed_at<?
    AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.record_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.previous_record_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.next_record_id=r.id)
    ORDER BY observed_at LIMIT ?`).all(stationId, cutoff, limit);
  const result = { blocked: false, deletedRecords: 0, deletedObservations: 0, deletedSources: 0, deletedRejected: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare("SELECT value_json FROM weather_maintenance_state WHERE station_id=? AND task='r3-retention'").get(stationId);
    const old = previous ? JSON.parse(previous.value_json) : {};
    const candidateSources = rows.length ? db.prepare(`SELECT DISTINCT source_id FROM source_records
      WHERE record_id IN (${rows.map(() => '?').join(',')}) LIMIT ?`).all(...rows.map(row => row.id), limit) : [];
    const deleteObservations = db.prepare('DELETE FROM observations WHERE record_id=?');
    const deleteLinks = db.prepare('DELETE FROM source_records WHERE record_id=?');
    const deleteRecord = db.prepare("DELETE FROM records WHERE id=? AND station_id=? AND stream='r3' AND observed_at<?");
    for (const row of rows) {
      result.deletedObservations += Number(deleteObservations.run(row.id).changes);
      deleteLinks.run(row.id);
      result.deletedRecords += Number(deleteRecord.run(row.id, stationId, cutoff).changes);
    }
    // Sources for just-pruned records can be removed immediately, even if a
    // recent manual import brought in old R3 data. Never drop a source still
    // linked to a retained record or containing recent quarantine evidence.
    for (const source of candidateSources) {
      const disposable = db.prepare(`SELECT id FROM sources s WHERE id=? AND station_id=? AND stream='r3'
        AND NOT EXISTS(SELECT 1 FROM source_records sr WHERE sr.source_id=s.id)
        AND (imported_at<? OR NOT EXISTS(SELECT 1 FROM rejected_rows rr WHERE rr.source_id=s.id))`)
        .get(source.source_id, stationId, cutoff);
      if (!disposable) continue;
      result.deletedRejected += Number(db.prepare('DELETE FROM rejected_rows WHERE source_id=?').run(disposable.id).changes);
      result.deletedSources += Number(db.prepare('DELETE FROM sources WHERE id=?').run(disposable.id).changes);
    }
    // A source may cover both old and retained records. Preserve its original
    // bytes until no record refers to it. Old rejected-only R3 sources expire
    // by receipt date; MEM sources and their diagnostic evidence never do.
    // Scan at most `limit` source candidates, retaining a cursor across passes.
    // Limiting only the number of matching orphans would still allow a full
    // scan under the writer lock when most sources remain linked.
    const cursor = old.sourceCursor || { importedAt: '', id: '' };
    const sourceCandidates = db.prepare(`SELECT id,imported_at FROM sources WHERE station_id=? AND stream='r3'
      AND imported_at<? AND (imported_at,id)>(?,?) ORDER BY imported_at,id LIMIT ?`)
      .all(stationId, cutoff, cursor.importedAt, cursor.id, limit);
    for (const source of sourceCandidates) {
      if (db.prepare('SELECT 1 FROM source_records WHERE source_id=? LIMIT 1').get(source.id)) continue;
      result.deletedRejected += Number(db.prepare('DELETE FROM rejected_rows WHERE source_id=?').run(source.id).changes);
      result.deletedSources += Number(db.prepare('DELETE FROM sources WHERE id=?').run(source.id).changes);
    }
    const lastSource = sourceCandidates.at(-1);
    const sourceCursor = sourceCandidates.length === limit ? { importedAt: lastSource.imported_at, id: lastSource.id } : null;
    const totals = {
      retentionDays: RETENTION_DAYS, firstPrunedAt: old.firstPrunedAt || (result.deletedRecords || result.deletedSources ? new Date(now).toISOString() : null),
      lastRunAt: new Date(now).toISOString(), cutoff, sourceCursor,
      deletedRecords: (old.deletedRecords || 0) + result.deletedRecords,
      deletedObservations: (old.deletedObservations || 0) + result.deletedObservations,
      deletedSources: (old.deletedSources || 0) + result.deletedSources,
      deletedRejected: (old.deletedRejected || 0) + result.deletedRejected
    };
    db.prepare(`INSERT INTO weather_maintenance_state VALUES(?,'r3-retention',?,?) ON CONFLICT(station_id,task)
      DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(stationId, JSON.stringify(totals), new Date(now).toISOString());
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function createWeatherRetention(env, { isReady = () => false, canPrune = () => false, logger = console, now = Date.now } = {}) {
  const state = { enabled: Boolean(env.WEATHER_DB_PATH && env.WEATHER_DB_PATH !== ':memory:'), retentionDays: RETENTION_DAYS,
    running: false, blocked: true, busy: false, lastAttempt: null, lastRun: null, error: null, totals: null, pages: null, completeness: null };
  let worker = null;
  let pending = null;
  let closed = false;
  let finishActive = null;
  return {
    status: () => structuredClone(state),
    run() {
      if (closed || !state.enabled || !isReady()) return Promise.resolve(null);
      if (pending) return pending;
      state.running = true;
      state.lastAttempt = new Date(now()).toISOString();
      pending = new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          finishActive = null;
          if (result?.error) {
            state.error = result.error;
            state.busy = false;
            logger.error('[RETENTION] ' + result.error);
          } else if (result?.busy) {
            // A contended attempt did not complete maintenance. Preserve the
            // last successful pass and any earlier error until a pass succeeds.
            state.busy = true;
          } else if (result) {
            Object.assign(state, result, { lastRun: new Date(now()).toISOString(), error: null, busy: false });
          }
          const active = worker;
          worker = null;
          if (active) void active.terminate();
          resolve(result);
        };
        finishActive = finish;
        try {
          worker = new Worker(path.join(__dirname, 'weather-retention-worker.js'), {
            workerData: { filename: path.resolve(env.WEATHER_DB_PATH), now: now(), retentionDays: RETENTION_DAYS,
              batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES, maxPassMs: MAX_PASS_MS }
          });
        } catch (error) { finish({ error: error.message }); return; }
        timer = setTimeout(() => finish({ error: 'Weather maintenance exceeded its time limit' }), 20_000);
        timer.unref();
        worker.on('message', message => {
          if (message.type === 'permission') {
            // Re-evaluate the verified-checkpoint gate for every short batch.
            Promise.resolve().then(() => !closed && isReady() && canPrune()).then(allowed => {
              if (!settled && worker) worker.postMessage({ type: 'permission', id: message.id, allowed: allowed === true });
            }, () => {
              if (!settled && worker) worker.postMessage({ type: 'permission', id: message.id, allowed: false });
            });
          } else if (message.type === 'result') finish(message.result);
        });
        worker.on('error', error => finish({ error: error.message }));
        worker.on('exit', code => { if (!settled) finish({ error: `Weather maintenance worker exited (${code})` }); });
      }).finally(() => {
        // Run after `pending` has been assigned, including when Worker throws
        // synchronously during the Promise executor.
        state.running = false;
        pending = null;
      });
      return pending;
    },
    close() {
      closed = true;
      if (finishActive) finishActive(null);
    }
  };
}

module.exports = { createWeatherRetention, pruneR3Batch, RETENTION_DAYS, BATCH_SIZE, MAX_BATCHES, MAX_PASS_MS };
