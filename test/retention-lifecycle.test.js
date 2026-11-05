'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { WeatherStore } = require('../lib/weather-store');
const { createWeatherRetention } = require('../lib/weather-retention');
const { createSystemHealth } = require('../lib/system-health');
const layout = require('../config/station-layout.json');
const logger = { error() {} };
const initialTime = Date.parse('2026-11-05T02:00:00.000Z');

function mockedMaintenance(t, outcomes) {
  let launches = 0, clock = initialTime;
  class Worker extends EventEmitter {
    constructor() {
      super();
      const outcome = outcomes[launches++];
      if (outcome.throw) throw new Error(outcome.throw);
      queueMicrotask(() => this.emit('message', { type: 'result', result: outcome.result }));
    }
    terminate() { return Promise.resolve(0); }
  }
  const filename = path.resolve(__dirname, '../lib/weather-retention.js');
  const context = { module: { exports: {} }, __dirname: path.dirname(filename), structuredClone, setTimeout, clearTimeout,
    require(name) { return name === 'node:worker_threads' ? { Worker } : require(name); } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const maintenance = context.module.exports.createWeatherRetention({ WEATHER_DB_PATH: '/unused.sqlite' }, {
    isReady: () => true, canPrune: () => true, now: () => clock, logger
  });
  t.after(() => maintenance.close());
  return { maintenance, launches: () => launches, advance: ms => { clock += ms; }, now: () => new Date(clock).toISOString() };
}

test('a synchronous retention worker-start failure releases the latch and permits a successful retry', async t => {
  const h = mockedMaintenance(t, [
    { throw: 'temporary worker initialization failure' },
    { result: { blocked: false, busy: false, hasMore: false, deletedRecords: 0 } }
  ]);
  const first = h.maintenance.run();
  assert.strictEqual(h.maintenance.run(), first);
  assert.match((await first).error, /temporary worker/);
  assert.equal(h.maintenance.status().running, false);
  assert.equal(h.maintenance.status().lastRun, null);
  h.advance(60000);
  assert.equal((await h.maintenance.run()).blocked, false);
  assert.equal(h.launches(), 2);
  assert.equal(h.maintenance.status().lastRun, h.now());
  assert.equal(h.maintenance.status().lastAttempt, h.now());
  assert.equal(h.maintenance.status().error, null);
  assert.equal(h.maintenance.status().running, false);
});

test('a busy retention result preserves an earlier error and successful-pass timestamp until recovery', async t => {
  const h = mockedMaintenance(t, [
    { result: { blocked: false, busy: false, hasMore: false, totals: { deletedRecords: 7 } } },
    { result: { error: 'retention verification failed' } },
    { result: { busy: true } },
    { result: { blocked: false, busy: false, hasMore: false, totals: { deletedRecords: 8 } } }
  ]);
  await h.maintenance.run();
  const completedAt = h.maintenance.status().lastRun;
  h.advance(60000); await h.maintenance.run();
  h.advance(60000); await h.maintenance.run();
  const busy = h.maintenance.status();
  assert.equal(busy.busy, true);
  assert.equal(busy.lastAttempt, h.now());
  assert.equal(busy.lastRun, completedAt);
  assert.equal(busy.error, 'retention verification failed');
  assert.equal(busy.totals.deletedRecords, 7);
  h.advance(60000); await h.maintenance.run();
  const recovered = h.maintenance.status();
  assert.equal(recovered.busy, false);
  assert.equal(recovered.error, null);
  assert.equal(recovered.lastRun, h.now());
  assert.equal(recovered.totals.deletedRecords, 8);
});

test('real SQLite contention tolerates a short delay, reports prolonged stalled maintenance, and recovers normally', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-lifecycle-'));
  const filename = path.join(directory, 'weather.sqlite');
  const store = new WeatherStore(filename);
  let clock = initialTime;
  // Retained exactly at the first cutoff, then due for deletion on later passes.
  const csv = ['2026/10/21', '12:00:00', ...layout.streams.r3.fields.map(f => f.sensorKey === '7' ? '1018.2' : '0')].join(',');
  store.ingestLive('r3', csv, new Date(clock).toISOString());
  const maintenance = createWeatherRetention({ WEATHER_DB_PATH: filename }, {
    isReady: () => true, canPrune: () => true, now: () => clock, logger
  });
  t.after(() => { maintenance.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const health = createSystemHealth({ env: { WEATHER_DB_PATH: filename, WEATHER_HISTORY_ENABLED: 'false' },
    persistence: { status: () => ({ enabled: true, ready: true }), historyStatus: () => ({ enabled: false, ready: true, streams: {} }) },
    backups: { status: () => ({ enabled: true, lastSuccess: new Date(clock).toISOString(), offsiteLastSuccess: new Date(clock).toISOString(), retentionCheckpointVerified: true }) },
    retention: maintenance, getObservation: () => clock, now: () => clock,
    inspectDisk: () => ({ bavail: 1024 ** 3 / 4096, bsize: 4096, blocks: 5 * 1024 ** 3 / 4096 }) });
  await maintenance.run();
  const completedAt = maintenance.status().lastRun;
  for (let attempt = 1; attempt <= 2; attempt++) {
    clock += 10 * 60000;
    store.db.exec('BEGIN IMMEDIATE');
    try { assert.equal((await maintenance.run()).busy, true); }
    finally { store.db.exec('ROLLBACK'); }
    assert.equal(maintenance.status().lastRun, completedAt);
    assert.equal(maintenance.status().lastAttempt, new Date(clock).toISOString());
    assert.equal(maintenance.status().error, null, 'ordinary lock contention is not a permanent error');
    const report = health.snapshot();
    assert.equal(report.checks.retention.status, attempt === 1 ? 'ok' : 'pending');
    assert.equal(report.status, attempt === 1 ? 'ok' : 'degraded');
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE stream='r3'").get().n, 1);
  clock += 60000;
  assert.equal((await maintenance.run()).deletedRecords, 1);
  assert.equal(maintenance.status().busy, false);
  assert.equal(maintenance.status().lastRun, new Date(clock).toISOString());
  assert.equal(health.snapshot().status, 'ok');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE stream='r3'").get().n, 0);
});
