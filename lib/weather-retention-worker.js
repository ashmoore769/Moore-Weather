'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { pruneR3Batch } = require('./weather-retention');
const { auditHistoryGaps, historyCompleteness } = require('./weather-history-gaps');

let requestId = 0;
function permitted() {
  return new Promise(resolve => {
    const id = ++requestId;
    const receive = message => {
      if (message.type === 'permission' && message.id === id) {
        parentPort.off('message', receive);
        resolve(message.allowed === true);
      }
    };
    parentPort.on('message', receive);
    parentPort.postMessage({ type: 'permission', id });
  });
}
const pause = () => new Promise(resolve => setTimeout(resolve, 25));

(async () => {
  let db;
  try {
    // A worker may yield under contention, never hold up live station writes
    // for a multi-second busy timeout.
    db = new DatabaseSync(workerData.filename, { timeout: 50 });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    const stations = db.prepare('SELECT id FROM stations').all();
    const cutoff = new Date(workerData.now - workerData.retentionDays * 86400000).toISOString();
    const result = { blocked: false, cutoff, deletedRecords: 0, deletedObservations: 0, deletedSources: 0, deletedRejected: 0,
      totals: { deletedRecords: 0, deletedObservations: 0, deletedSources: 0, deletedRejected: 0, cutoff, retentionDays: workerData.retentionDays },
      stations: {}, completeness: {}, hasMore: false, busy: false };
    const started = Date.now();
    for (const station of stations) {
      // Coverage maintenance is safe even while retention awaits its backup.
      for (let scan = 0; scan < 4 && Date.now() - started < 750; scan++) {
        const coverage = auditHistoryGaps(db, station.id, { now: workerData.now, limit: 3000 });
        if (coverage.checked) break;
        await pause();
      }
      result.completeness[station.id] = historyCompleteness(db, station.id);
      for (let batch = 0; batch < workerData.maxBatches && Date.now() - started < workerData.maxPassMs; batch++) {
        if (!(await permitted())) { result.blocked = true; break; }
        const deletion = pruneR3Batch(db, { stationId: station.id, cutoff, authorized: true, limit: workerData.batchSize, now: workerData.now });
        for (const key of ['deletedRecords', 'deletedObservations', 'deletedSources', 'deletedRejected']) result[key] += deletion[key];
        if (!deletion.deletedRecords && !deletion.deletedSources) break;
        await pause();
      }
      const saved = db.prepare("SELECT value_json FROM weather_maintenance_state WHERE station_id=? AND task='r3-retention'").get(station.id);
      result.stations[station.id] = saved ? JSON.parse(saved.value_json) : null;
      for (const key of ['deletedRecords', 'deletedObservations', 'deletedSources', 'deletedRejected']) {
        result.totals[key] += result.stations[station.id]?.[key] || 0;
      }
      // EXISTS is bounded by the indexed stream/time lookup; don't count the
      // whole backlog just to display maintenance progress.
      result.hasMore ||= Boolean(db.prepare(`SELECT 1 FROM records r WHERE station_id=? AND stream='r3' AND observed_at<?
        AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.record_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.previous_record_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.next_record_id=r.id) LIMIT 1`).get(station.id, cutoff));
    }
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    const freePages = db.prepare('PRAGMA freelist_count').get().freelist_count;
    result.pages = { pageSize, pageCount, freePages, reusableBytes: pageSize * freePages };
    // PASSIVE does not wait for readers or force a compaction. Freed database
    // pages remain available for subsequent inserts.
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    parentPort.postMessage({ type: 'result', result });
  } catch (error) {
    const busy = /busy|locked/i.test(error.message);
    parentPort.postMessage({ type: 'result', result: busy ? { busy: true } : { error: error.message } });
  } finally { if (db) db.close(); }
})().catch(error => parentPort.postMessage({ type: 'result', result: { error: error.message } }));
