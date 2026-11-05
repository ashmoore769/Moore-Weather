'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemHealth } = require('../lib/system-health');

test('system health separates fresh readings, storage, backups and blocked retention', () => {
  let now = Date.parse('2026-11-05T12:00:00Z');
  const backup = { enabled: true, lastSuccess: new Date(now).toISOString(), offsiteLastSuccess: new Date(now).toISOString(), retentionCheckpointVerified: true, offsiteConfigured: true };
  let observed = now, available = 1024 ** 3;
  const maintenance = { enabled: true, lastRun: new Date(now).toISOString(), totals: { deletedRecords: 42 } };
  const health = createSystemHealth({ now: () => now, env: { WEATHER_DB_PATH: '/unused/weather.sqlite', WEATHER_HISTORY_ENABLED: 'false' },
    persistence: { status: () => ({ enabled: true, ready: true }), historyStatus: () => ({ ready: true }) },
    backups: { status: () => backup }, retention: { status: () => maintenance }, getObservation: () => observed,
    inspectDisk: () => ({ bavail: available / 4096, bsize: 4096, blocks: 5 * 1024 ** 3 / 4096 }), statFile: () => ({ size: 2000000 }) });
  now += 3 * 60000;
  assert.equal(health.snapshot().status, 'ok');
  assert.equal(health.snapshot().checks.retention.deletedRecords, 42);
  backup.retentionCheckpointVerified = false;
  assert.equal(health.snapshot().checks.retention.status, 'waiting-for-backup');
  assert.equal(health.snapshot().status, 'degraded');
  backup.retentionCheckpointVerified = true;
  observed = now - 11 * 60000;
  assert.equal(health.snapshot().checks.live.status, 'stale');
  observed = now;
  available = 100 * 1024 ** 2; now += 60001;
  assert.equal(health.snapshot().checks.storage.status, 'low');
  assert.equal(health.snapshot().status, 'degraded');
});

test('clock warnings reach operational health while verified corrections restore it', () => {
  let now = Date.parse('2026-11-05T12:00:00Z');
  let clockState = { enabled: true, status: 'checking' };
  const health = createSystemHealth({ now: () => now, env: { WEATHER_HISTORY_ENABLED: 'false' },
    persistence: { status: () => ({ enabled: false }), historyStatus: () => ({ ready: false }) },
    backups: { status: () => ({ enabled: false }) }, retention: { status: () => ({ enabled: false }) },
    clock: { status: () => clockState }, getObservation: () => now });
  now += 3 * 60000;
  clockState = { enabled: true, status: 'warning', driftSeconds: -72, error: 'Station TIME verification did not confirm synchronisation' };
  assert.equal(health.snapshot().status, 'degraded');
  assert.equal(health.snapshot().checks.clock.status, 'warning');
  assert.equal(health.snapshot().checks.clock.driftSeconds, -72);
  assert.equal(health.snapshot().checks.live.status, 'ok');
  clockState = { enabled: true, status: 'corrected', driftSeconds: -0.4, lastVerifiedAt: new Date(now).toISOString() };
  assert.equal(health.snapshot().status, 'ok');
  assert.equal(health.snapshot().checks.clock.status, 'ok');
  assert.equal(health.snapshot().checks.clock.lastVerifiedAt, clockState.lastVerifiedAt);
});
