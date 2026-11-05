'use strict';

// Coverage is separate from freshness. These are the logger's fixed periodic
// archives; the conditional rain memory must not be treated as a regular feed.
const PERIODIC_STREAMS = Object.freeze({ mem3: 600, mem2: 3600, mem1: 86400 });
const MAX_FUTURE_MS = 90_000;
const futureLimit = now => new Date(Number(now) + MAX_FUTURE_MS).toISOString();

function ensureHistoryAudits(db, stationId, now = Date.now()) {
  const insert = db.prepare(`INSERT OR IGNORE INTO weather_history_audits
    (station_id,stream,cursor_at,complete,updated_at) VALUES(?,?,NULL,0,?)`);
  for (const stream of Object.keys(PERIODIC_STREAMS)) insert.run(stationId, stream, new Date(now).toISOString());
  // Recheck on a process/store restart: an older application or an offline
  // import may have written records without updating this additive ledger.
  // Existing gap warnings remain visible until the bounded audit resolves them.
  db.prepare('UPDATE weather_history_audits SET cursor_at=NULL,complete=0,updated_at=? WHERE station_id=?')
    .run(new Date(now).toISOString(), stationId);
}

function historyLowerBound(db, stationId) {
  const policy = db.prepare(`SELECT p.earliest_local_timestamp,s.utc_offset_minutes FROM data_quality_policies p
    JOIN stations s ON s.id=p.station_id WHERE p.station_id=?`).get(stationId);
  return policy ? new Date(Date.parse(policy.earliest_local_timestamp + 'Z') - policy.utc_offset_minutes * 60000).toISOString() : '';
}

function addGap(db, stationId, stream, previous, next, now) {
  const step = PERIODIC_STREAMS[stream];
  if (!step || !previous || !next) return;
  // Logger schedules are exact, but rounding prevents a one-second clock
  // adjustment from claiming a whole missing interval.
  const missing = Math.round((Date.parse(next) - Date.parse(previous)) / (step * 1000)) - 1;
  if (missing < 1) return;
  db.prepare(`INSERT INTO weather_history_gaps
    (station_id,stream,previous_at,next_at,interval_seconds,missing_intervals,detected_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(station_id,stream,previous_at,next_at) DO UPDATE SET
    missing_intervals=excluded.missing_intervals, updated_at=excluded.updated_at`).run(
    stationId, stream, previous, next, step, missing, now, now);
}

// Called in the import transaction only for a newly inserted measured record.
// An out-of-order/manual backfill splits or resolves its existing gap in the
// same transaction as the data, including when the app is later restarted.
function noteHistoryRecord(db, stationId, stream, observedAt, now = Date.now()) {
  if (!PERIODIC_STREAMS[stream] || observedAt > futureLimit(now)) return;
  const lower = historyLowerBound(db, stationId);
  if (observedAt < lower) return;
  const at = new Date(now).toISOString();
  db.prepare('DELETE FROM weather_history_gaps WHERE station_id=? AND stream=? AND previous_at<? AND next_at>?')
    .run(stationId, stream, observedAt, observedAt);
  const predecessor = db.prepare(`SELECT observed_at FROM records WHERE station_id=? AND stream=? AND observed_at<? AND observed_at>=?
    AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.record_id=records.id)
    ORDER BY observed_at DESC LIMIT 1`).get(stationId, stream, observedAt, lower)?.observed_at;
  const successor = db.prepare(`SELECT observed_at FROM records WHERE station_id=? AND stream=? AND observed_at>? AND observed_at<=?
    AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.record_id=records.id)
    ORDER BY observed_at LIMIT 1`).get(stationId, stream, observedAt, futureLimit(now))?.observed_at;
  addGap(db, stationId, stream, predecessor, observedAt, at);
  addGap(db, stationId, stream, observedAt, successor, at);
  db.prepare(`UPDATE weather_history_audits SET cursor_at=CASE WHEN complete=1 AND (cursor_at IS NULL OR cursor_at<?)
    THEN ? ELSE cursor_at END, updated_at=? WHERE station_id=? AND stream=?`)
    .run(observedAt, observedAt, at, stationId, stream);
}

// Bounded bootstrap for databases created by older releases. A separate worker
// calls this; it scans timestamps only, never measurements or logger memory.
function auditHistoryGaps(db, stationId, { now = Date.now(), limit = 1000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('Invalid history audit batch size');
  const at = new Date(now).toISOString();
  let scanned = 0;
  const lower = historyLowerBound(db, stationId);
  for (const stream of Object.keys(PERIODIC_STREAMS)) {
    if (scanned >= limit) break;
    const state = db.prepare('SELECT * FROM weather_history_audits WHERE station_id=? AND stream=?').get(stationId, stream);
    if (!state || state.complete) continue;
    const remaining = Math.min(1000, limit - scanned);
    db.exec('BEGIN IMMEDIATE');
    try {
      // Read again under the writer lock so concurrent imports cannot advance a
      // complete cursor between our snapshot and this transaction.
      const current = db.prepare('SELECT * FROM weather_history_audits WHERE station_id=? AND stream=?').get(stationId, stream);
      db.prepare('DELETE FROM weather_history_gaps WHERE station_id=? AND stream=? AND previous_at<?').run(stationId, stream, lower);
      const rows = db.prepare(`SELECT DISTINCT observed_at FROM records WHERE station_id=? AND stream=?
        AND observed_at>? AND observed_at>=? AND observed_at<=?
        AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.record_id=records.id)
        ORDER BY observed_at LIMIT ?`).all(stationId, stream, current.cursor_at || '', lower, futureLimit(now), remaining + 1);
      let previous = current.cursor_at;
      const removeFilled = db.prepare('DELETE FROM weather_history_gaps WHERE station_id=? AND stream=? AND previous_at<? AND next_at>?');
      for (const row of rows.slice(0, remaining)) {
        // A measured timestamp inside an old gap proves that the old range is
        // obsolete. Rebuild only the actual adjacent gaps as this audit moves
        // forward; checked stays false until the entire stream is reconciled.
        removeFilled.run(stationId, stream, row.observed_at, row.observed_at);
        addGap(db, stationId, stream, previous, row.observed_at, at);
        previous = row.observed_at;
        scanned++;
      }
      db.prepare('UPDATE weather_history_audits SET cursor_at=?, complete=?, updated_at=? WHERE station_id=? AND stream=?')
        .run(previous, Number(rows.length <= remaining), at, stationId, stream);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { scanned, ...historyCompleteness(db, stationId) };
}

function historyCompleteness(db, stationId) {
  const states = db.prepare('SELECT stream,complete FROM weather_history_audits WHERE station_id=?').all(stationId);
  const summaries = db.prepare(`SELECT stream, COUNT(*) AS unresolvedGaps, SUM(missing_intervals) AS missingIntervals,
    MIN(previous_at) AS firstBoundary, MAX(next_at) AS lastBoundary FROM weather_history_gaps
    WHERE station_id=? GROUP BY stream`).all(stationId);
  const streams = Object.fromEntries(Object.entries(PERIODIC_STREAMS).map(([stream, step]) => {
    const row = summaries.find(r => r.stream === stream);
    return [stream, {
      checked: Boolean(states.find(s => s.stream === stream)?.complete),
      unresolvedGaps: row?.unresolvedGaps || 0, missingIntervals: row?.missingIntervals || 0,
      firstMissingAt: row ? new Date(Date.parse(row.firstBoundary) + step * 1000).toISOString() : null,
      lastMissingAt: row ? new Date(Date.parse(row.lastBoundary) - step * 1000).toISOString() : null
    }];
  }));
  const checked = Object.values(streams).every(s => s.checked);
  const unresolvedGaps = Object.values(streams).reduce((sum, s) => sum + s.unresolvedGaps, 0);
  return { complete: checked && unresolvedGaps === 0, checked, unresolvedGaps, streams };
}

module.exports = { PERIODIC_STREAMS, MAX_FUTURE_MS, futureLimit, ensureHistoryAudits, noteHistoryRecord, auditHistoryGaps, historyCompleteness };
