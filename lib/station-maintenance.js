'use strict';

const MINUTE = 60000, AEST = 10 * 60 * MINUTE;
const FRESH_BEFORE_WINDOW_MS = 3 * MINUTE;

// Ash supplied the current MODEMTIME HOUR 5 1435 1 setting on 14 Nov 2026:
// power on at 05:00 AEST for 1,435 minutes, then off for five minutes.
// This policy changes notification eligibility only. It never changes logger
// scheduling, observation timestamps, collection, or the displayed data status.
const DEFAULT_MAINTENANCE = Object.freeze({
  timezone: 'Australia/Brisbane',
  start: '04:55',
  end: '05:00',
  graceMinutes: 5
});

function maintenanceWindow(now) {
  if (!Number.isFinite(now)) return null;
  const local = new Date(now + AEST);
  if (!Number.isFinite(local.getTime())) return null;
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - AEST;
  const start = midnight + (4 * 60 + 55) * MINUTE;
  const end = midnight + 5 * 60 * MINUTE;
  const graceUntil = end + DEFAULT_MAINTENANCE.graceMinutes * MINUTE;
  return { date: new Date(midnight + AEST).toISOString().slice(0, 10),
    start, end, graceUntil, active: now >= start && now < graceUntil,
    reconnecting: now >= end && now < graceUntil };
}

function createStationMaintenance(env = {}) {
  const config = Object.freeze({ enabled: env.WEATHER_PLANNED_MODEM_OUTAGE_ENABLED !== 'false', ...DEFAULT_MAINTENANCE });
  return Object.freeze({
    config,
    window: maintenanceWindow,
    suppressOffline({ now, lastGood, alreadyAlerted = false } = {}) {
      if (!config.enabled || alreadyAlerted || !Number.isFinite(lastGood) || lastGood > now) return false;
      const window = maintenanceWindow(now);
      if (!window?.active) return false;
      // A station already stale before maintenance is a genuine incident. Only
      // readings fresh immediately before (or during) this same day's window
      // can qualify. A previous day's reading must never silence a long outage.
      return lastGood >= window.start - FRESH_BEFORE_WINDOW_MS;
    },
    suppressHistory({ now, overdueSince, alreadyAlerted = false } = {}) {
      if (!config.enabled || alreadyAlerted || !Number.isFinite(overdueSince) || overdueSince > now) return false;
      const window = maintenanceWindow(now);
      // A missed collection during the modem pause can make an otherwise
      // healthy hourly feed overdue before its quiet five-minute retry. Allow
      // that retry to complete, without covering incidents already overdue
      // before the pause or extending the grace beyond the same day's window.
      return Boolean(window?.active && overdueSince >= window.start);
    }
  });
}

module.exports = { DEFAULT_MAINTENANCE, FRESH_BEFORE_WINDOW_MS, maintenanceWindow, createStationMaintenance };
