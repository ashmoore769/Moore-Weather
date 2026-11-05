'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { historyHealth } = require('./history-alerts');

function createSystemHealth({ env, persistence, backups, retention, clock, getObservation, now = Date.now,
  inspectDisk = fs.statfsSync, statFile = fs.statSync }) {
  const startedAt = now();
  let storage = null, storageCheckedAt = -Infinity;
  function storageStatus() {
    if (!env.WEATHER_DB_PATH) return { status: 'disabled', freeBytes: null, totalBytes: null, dbBytes: null };
    if (storage && now() - storageCheckedAt < 60000) return { ...storage };
    storageCheckedAt = now();
    try {
      const disk = inspectDisk(path.dirname(path.resolve(env.WEATHER_DB_PATH)));
      const freeBytes = Number(disk.bavail) * Number(disk.bsize);
      const totalBytes = Number(disk.blocks) * Number(disk.bsize);
      const dbBytes = statFile(env.WEATHER_DB_PATH).size;
      storage = { status: freeBytes < 512 * 1024 * 1024 ? 'low' : 'ok', freeBytes, totalBytes, dbBytes };
    } catch { storage = { status: 'unavailable', freeBytes: null, totalBytes: null, dbBytes: null }; }
    return { ...storage };
  }
  return {
    snapshot() {
      const timestamp = now();
      const warmingUp = timestamp - startedAt < 2 * 60000;
      const database = persistence.status();
      const saved = backups.status();
      const cleanup = retention.status();
      const clockState = clock?.status() || { enabled: false, status: 'disabled' };
      const disk = storageStatus();
      const historySnapshot = persistence.historyStatus();
      const history = historyHealth({ ...historySnapshot, enabled: env.WEATHER_HISTORY_ENABLED === 'true' }, timestamp);
      const observedAt = getObservation();
      const live = Number.isFinite(observedAt) && observedAt <= timestamp + 90000 && timestamp - observedAt <= 10 * 60000;
      const backupFresh = saved.lastSuccess && timestamp - Date.parse(saved.lastSuccess) < 36 * 3600000;
      const offsiteFresh = saved.offsiteLastSuccess && timestamp - Date.parse(saved.offsiteLastSuccess) < 48 * 3600000;
      const backupStatus = !saved.enabled ? 'disabled' : saved.error ? 'error' : !backupFresh || !offsiteFresh ? 'pending' : 'ok';
      const retentionStatus = !cleanup.enabled ? 'disabled' : cleanup.error ? 'error' : !saved.retentionCheckpointVerified ? 'waiting-for-backup' :
        cleanup.blocked || !cleanup.lastRun || timestamp - Date.parse(cleanup.lastRun) > 15 * 60000 ? 'pending' : cleanup.hasMore ? 'catching-up' : 'ok';
      const checks = {
        clock: { status: !clockState.enabled ? 'disabled' : ['in-sync', 'corrected'].includes(clockState.status) ? 'ok' :
          clockState.status === 'warning' ? 'warning' : 'pending',
          driftSeconds: clockState.driftSeconds ?? null, lastCheckedAt: clockState.lastCheckedAt || null,
          driftMinimumSeconds: clockState.driftMinimumSeconds ?? null, driftMaximumSeconds: clockState.driftMaximumSeconds ?? null,
          accuracySeconds: clockState.accuracySeconds ?? null,
          lastVerifiedAt: clockState.lastVerifiedAt || null, lastCorrectionAt: clockState.lastCorrectionAt || null,
          nextCheckAt: clockState.nextCheckAt || null, summary: clockState.error ||
            (clockState.enabled ? 'Checks at 06:05 and 18:05 Brisbane time' : 'Automatic clock checks disabled') },
        storage: disk,
        backups: { status: backupStatus, lastSuccess: saved.lastSuccess, offsiteConfigured: saved.offsiteConfigured,
          offsiteLastSuccess: saved.offsiteLastSuccess, running: saved.running, error: saved.error || null,
          checkpointVerified: saved.retentionCheckpointVerified },
        retention: { status: retentionStatus, days: 15, lastRun: cleanup.lastRun, blocked: cleanup.blocked,
          deletedRecords: cleanup.totals?.deletedRecords || 0, cutoff: cleanup.totals?.cutoff || null,
          reusableBytes: cleanup.pages?.reusableBytes || 0, hasMore: Boolean(cleanup.hasMore), error: cleanup.error || null },
        database: { status: !database.enabled ? 'disabled' : database.ready && !database.error ? 'ok' : 'error',
          lastWrite: database.lastWrite, quarantine: database.quarantine || null },
        live: { status: live ? 'ok' : 'stale', observedAt: Number.isFinite(observedAt) ? new Date(observedAt).toISOString() : null },
        history: { status: !history.enabled ? 'disabled' : history.delayed ? 'delayed' : history.incomplete ? 'incomplete' : history.checking ? 'checking' : 'ok',
          completeness: historySnapshot.completeness || null }
      };
      const unhealthy = !live || (database.enabled && (!database.ready || database.error || disk.status !== 'ok' ||
        backupStatus !== 'ok' || !['ok', 'catching-up'].includes(retentionStatus))) || (history.enabled && history.delayed) ||
        (clockState.enabled && clockState.status === 'warning');
      return { checkedAt: new Date(timestamp).toISOString(), status: warmingUp && unhealthy ? 'starting' : unhealthy ? 'degraded' : 'ok',
        version: require('../package.json').version, checks };
    }
  };
}

module.exports = { createSystemHealth };
