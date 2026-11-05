'use strict';
const crypto = require('node:crypto');

const MAX_ADJUSTMENT_MS = 5 * 60000;
const TOLERANCE_MS = 3000;
const PENDING_MAX_AGE_MS = 15 * 60000;
const PENDING_LIMIT = 8;
const WINDOW_MATCH_LIMIT = 16;

function iso(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error('Clock correction timestamp is invalid');
  return parsed;
}

function recordClockCorrection(db, stationId, { at, stationAt, serverAt, adjustmentMs, windowStartAt, windowEndAt } = {}) {
  const recorded = iso(at), station = iso(stationAt), server = iso(serverAt);
  if (typeof adjustmentMs !== 'number' || !Number.isFinite(adjustmentMs) || Math.abs(adjustmentMs) > MAX_ADJUSTMENT_MS ||
      Math.abs(recorded - server) > TOLERANCE_MS || Math.abs(server - station - adjustmentMs) > TOLERANCE_MS ||
      (adjustmentMs < 0 && server >= station) || (adjustmentMs > 0 && server <= station) || adjustmentMs === 0) {
    throw new Error('Clock correction is outside the verified adjustment bounds');
  }
  const identity = [stationId, at, stationAt, serverAt, adjustmentMs];
  const hasWindow = windowStartAt !== undefined || windowEndAt !== undefined;
  if (hasWindow) {
    const start = iso(windowStartAt), end = iso(windowEndAt);
    if (adjustmentMs >= 0 || start !== Math.floor(server / 1000) * 1000 || end <= start ||
        end - start > MAX_ADJUSTMENT_MS || end < station) {
      throw new Error('Clock correction window is outside the verified adjustment bounds');
    }
    identity.push(windowStartAt, windowEndAt);
  }
  const id = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  // WeatherStore uses WAL + synchronous=FULL. The intent and its optional
  // timing window must both commit durably before the hardware command.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT OR IGNORE INTO weather_clock_corrections
      (id,station_id,recorded_at,station_at,server_at,adjustment_ms,verified_at) VALUES(?,?,?,?,?,?,NULL)`)
      .run(id, stationId, at, stationAt, serverAt, adjustmentMs);
    if (hasWindow) db.prepare(`INSERT OR IGNORE INTO weather_clock_backward_windows
      (correction_id,start_at,end_at) VALUES(?,?,?)`).run(id, windowStartAt, windowEndAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return id;
}

function verifyClockCorrection(db, stationId, id, verifiedAt) {
  const verified = iso(verifiedAt);
  if (typeof id !== 'string' || id.length !== 64 || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Clock correction identity is invalid');
  const correction = db.prepare('SELECT recorded_at,verified_at FROM weather_clock_corrections WHERE station_id=? AND id=?').get(stationId, id);
  if (!correction) throw new Error('Clock correction intent was not recorded for this station');
  if (correction.verified_at) return id;
  const elapsed = verified - Date.parse(correction.recorded_at);
  if (elapsed < 0 || elapsed > PENDING_MAX_AGE_MS) throw new Error('Clock correction verification is outside its recovery window');
  db.prepare('UPDATE weather_clock_corrections SET verified_at=? WHERE station_id=? AND id=? AND verified_at IS NULL')
    .run(verifiedAt, stationId, id);
  return id;
}

function pendingClockCorrections(db, stationId, now) {
  if (!Number.isFinite(now)) throw new Error('Clock correction lookup time is invalid');
  return db.prepare(`SELECT id,recorded_at AS at,station_at AS stationAt,server_at AS serverAt,adjustment_ms AS adjustmentMs
    FROM weather_clock_corrections WHERE station_id=? AND verified_at IS NULL AND recorded_at>=? AND recorded_at<=?
    ORDER BY recorded_at DESC,id DESC LIMIT ?`)
    .all(stationId, new Date(now - PENDING_MAX_AGE_MS).toISOString(), new Date(now).toISOString(), PENDING_LIMIT);
}

function orderVerifiedHistory(db, stationId, rows, receivedAt) {
  const used = new Set();
  let lookup;
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1].utc, next = rows[index].utc;
    if (next >= previous) continue;
    const previousMs = Date.parse(previous), nextMs = Date.parse(next), difference = previousMs - nextMs;
    if (!Number.isFinite(difference) || difference > MAX_ADJUSTMENT_MS + 2 * TOLERANCE_MS) {
      throw new Error('Memory response is not chronological');
    }
    lookup ||= db.prepare(`SELECT c.id,c.adjustment_ms,w.start_at,w.end_at FROM weather_clock_corrections c
      LEFT JOIN weather_clock_backward_windows w ON w.correction_id=c.id
      WHERE c.station_id=? AND c.verified_at IS NOT NULL AND c.adjustment_ms<0 AND c.verified_at<=?
        AND c.server_at>=? AND c.server_at<=?
        AND COALESCE(w.end_at,c.station_at)>=? AND COALESCE(w.start_at,c.server_at)<=?
      ORDER BY c.server_at DESC,c.id DESC LIMIT ?`);
    // Keep the indexed lookup bounded to five minutes plus tolerance. Explicit
    // windows start at the literal whole-second SETTIME target, at most 999ms
    // before server_at. Each event's actual endpoints still require a match.
    // Older intents retain their original projected old/new clock span.
    const matching = lookup.all(stationId, receivedAt,
      new Date(previousMs - MAX_ADJUSTMENT_MS - 2 * TOLERANCE_MS).toISOString(),
      new Date(nextMs + TOLERANCE_MS + 1000).toISOString(), new Date(previousMs - TOLERANCE_MS).toISOString(),
      new Date(nextMs + TOLERANCE_MS).toISOString(), WINDOW_MATCH_LIMIT);
    const correction = matching.find(item => {
      if (used.has(item.id)) return false;
      const span = item.start_at === null ? Math.abs(item.adjustment_ms) : Date.parse(item.end_at) - Date.parse(item.start_at);
      return span > 0 && span <= MAX_ADJUSTMENT_MS && difference <= span + 2 * TOLERANCE_MS;
    });
    if (!correction) throw new Error('Memory response is not chronological');
    used.add(correction.id);
  }
  // Never sort or rewrite the capture itself. The caller still imports its
  // original bytes and line numbers; this copy provides truthful min/max dates.
  return { rows: used.size ? [...rows].sort((a, b) => a.utc.localeCompare(b.utc)) : rows, correctionIds: [...used] };
}

module.exports = { recordClockCorrection, verifyClockCorrection, pendingClockCorrections, orderVerifiedHistory,
  MAX_ADJUSTMENT_MS, TOLERANCE_MS, PENDING_MAX_AGE_MS, PENDING_LIMIT };
