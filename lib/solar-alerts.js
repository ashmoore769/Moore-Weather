'use strict';

const crypto = require('node:crypto');
const { DAY, MINUTE, FRESH_FOR, localDay } = require('./solar-data');

const POLICY = Object.freeze({
  timezone: 'Australia/Brisbane', morningStartHour: 5, eveningStartHour: 15,
  marginW: 100, solarHoldMinutes: 2, gridHoldMinutes: 10,
  retryMinutes: 5, deliveryWindowMinutes: 15, maxNotificationsPerDay: 2
});
const RETRY_MS = POLICY.retryMinutes * MINUTE;
const DELIVERY_WINDOW_MS = POLICY.deliveryWindowMinutes * MINUTE;
const fingerprint = payload => crypto.createHash('sha256').update(payload).digest('hex');
const localMinute = now => Math.floor((now - localDay(now).start) / MINUTE);
const kw = value => (value / 1000).toFixed(2) + ' kW';

// The alert source is SolarStore.latest(), not a chart bucket or the server's
// receipt time alone. A fresh upload of yesterday's queue must remain silent.
function freshReading(snapshot, now) {
  const row = snapshot?.current;
  if (snapshot?.enabled !== true || snapshot?.ready !== true || !row ||
      row.meterLocation !== 'grid' || row.mode !== 'meter' ||
      (row.batteryPowerW !== null && row.batteryPowerW !== 0) ||
      !Number.isFinite(row.inverterPowerW) || row.inverterPowerW < 0 ||
      !Number.isFinite(row.loadPowerW) || row.loadPowerW < 0 ||
      !Number.isFinite(row.gridPowerW)) return null;
  const times = ['observedAt', 'collectedAt', 'receivedAt'].map(key =>
    typeof row[key] === 'string' ? Date.parse(row[key]) : NaN);
  if (times.some(time => !Number.isFinite(time) || time > now || now - time > FRESH_FOR)) return null;
  const balance = row.inverterPowerW - row.loadPowerW;
  const direction = balance >= POLICY.marginW && row.gridPowerW <= -POLICY.marginW ? 'solar' :
    balance <= -POLICY.marginW && row.gridPowerW >= POLICY.marginW ? 'grid' : null;
  return { t: times[0], direction, inverterPowerW: row.inverterPowerW,
    loadPowerW: row.loadPowerW, gridPowerW: row.gridPowerW,
    signature: JSON.stringify([...times, row.inverterPowerW, row.loadPowerW, row.gridPowerW]) };
}

class SolarAlerts {
  constructor({ db, now = Date.now, deliver, logger = console, startupGraceMs = 120000 }) {
    this.db = db; this.now = now; this.deliver = deliver; this.logger = logger;
    this.started = now(); this.startupGraceMs = startupGraceMs; this.busy = false;
    db.exec('CREATE TABLE IF NOT EXISTS solar_alert_days (local_date TEXT PRIMARY KEY, payload TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS solar_alert_deliveries (' +
      'endpoint TEXT NOT NULL, local_date TEXT NOT NULL, kind TEXT NOT NULL,' +
      'subscription_hash TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0,' +
      'PRIMARY KEY(endpoint,local_date,kind)) WITHOUT ROWID;');
  }

  save(state) {
    this.db.prepare('INSERT INTO solar_alert_days VALUES(?,?) ON CONFLICT(local_date) DO UPDATE SET payload=excluded.payload')
      .run(state.day, JSON.stringify(state));
  }

  forget(endpoint) { this.db.prepare('DELETE FROM solar_alert_deliveries WHERE endpoint=?').run(endpoint); }

  persist(state, eventKind) {
    if (!eventKind) { this.save(state); return; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(state);
      // Capture the subscribed audience at the crossover. A device enabling
      // notifications later does not receive a retrospective morning message.
      for (const subscription of this.db.prepare('SELECT endpoint,payload FROM subscriptions').all()) {
        this.db.prepare('INSERT OR IGNORE INTO solar_alert_deliveries(endpoint,local_date,kind,subscription_hash) VALUES(?,?,?,?)')
          .run(subscription.endpoint, state.day, eventKind, fingerprint(subscription.payload));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async tick(snapshot) {
    if (this.now() < this.started) this.started = this.now();
    if (this.busy || this.now() - this.started < this.startupGraceMs) return;
    this.busy = true;
    try {
      const now = this.now(), day = localDay(now).date, reading = freshReading(snapshot, now);
      const saved = this.db.prepare('SELECT payload FROM solar_alert_days WHERE local_date=?').get(day);
      const state = saved ? JSON.parse(saved.payload) :
        { day, lastObservedAt: 0, lastSignature: null, candidate: null, coveredAt: null, events: { solar: null, grid: null } };
      // Eight small day records preserve deduplication across a clock correction
      // around midnight without retaining an unbounded notification archive.
      const oldest = localDay(now - 7 * DAY).date;
      this.db.prepare('DELETE FROM solar_alert_days WHERE local_date<?').run(oldest);
      this.db.prepare('DELETE FROM solar_alert_deliveries WHERE local_date<? OR endpoint NOT IN (SELECT endpoint FROM subscriptions)').run(oldest);
      if (!reading || localDay(reading.t).date !== day) {
        if (state.candidate) { state.candidate = null; this.save(state); }
        return;
      }
      // Duplicate/revised timestamps never advance the hold period. A provider
      // retry may use an identical, still-fresh sample without counting it twice.
      if (reading.t < state.lastObservedAt ||
          (reading.t === state.lastObservedAt && reading.signature !== state.lastSignature)) return;
      if (reading.t > state.lastObservedAt) {
        if (reading.t - state.lastObservedAt > FRESH_FOR) state.candidate = null;
        const minute = localMinute(reading.t);
        const kind = !state.coveredAt && minute >= POLICY.morningStartHour * 60 && reading.direction === 'solar' ? 'solar' :
          state.coveredAt && !state.events.grid && minute >= POLICY.eveningStartHour * 60 && reading.direction === 'grid' ? 'grid' : null;
        let eventKind = null;
        if (!kind) state.candidate = null;
        else {
          state.candidate = state.candidate?.kind === kind ?
            { ...state.candidate, count: state.candidate.count + 1 } : { kind, since: reading.t, count: 1 };
          const minutes = kind === 'solar' ? POLICY.solarHoldMinutes : POLICY.gridHoldMinutes;
          if (reading.t - state.candidate.since >= minutes * MINUTE && state.candidate.count >= minutes + 1) {
            if (kind === 'solar') {
              state.coveredAt = reading.t;
              // A new deployment in the afternoon can arm the evening crossover
              // without inventing a morning alert that was never observed.
              if (minute < POLICY.eveningStartHour * 60) eventKind = 'solar';
            } else eventKind = 'grid';
            if (eventKind) state.events[eventKind] = { at: now, observedAt: reading.t };
            state.candidate = null;
          }
        }
        state.lastObservedAt = reading.t;
        state.lastSignature = reading.signature;
        this.persist(state, eventKind);
      }

      const minute = localMinute(now);
      const kind = reading.direction === 'solar' && !state.events.grid &&
        minute >= POLICY.morningStartHour * 60 && minute < POLICY.eveningStartHour * 60 ? 'solar' :
        reading.direction === 'grid' && minute >= POLICY.eveningStartHour * 60 ? 'grid' : null;
      const event = kind && state.events[kind];
      if (!event || event.at > now || now - event.at >= DELIVERY_WINDOW_MS) return;
      const pending = this.db.prepare('SELECT endpoint FROM solar_alert_deliveries ' +
        'WHERE local_date=? AND kind=? AND delivered=0 AND retry_after<=?')
        .all(day, kind, now);
      for (const pendingDelivery of pending) {
        const sendingAt = this.now();
        if (!freshReading(snapshot, sendingAt) || localDay(sendingAt).date !== day ||
            sendingAt - event.at >= DELIVERY_WINDOW_MS ||
            (kind === 'solar' && localMinute(sendingAt) >= POLICY.eveningStartHour * 60)) break;
        // Another device may unsubscribe or replace its keys while the previous
        // provider request awaits. Re-read both consent and pending state before
        // starting the next send; an already in-flight request cannot be recalled.
        const subscription = this.db.prepare('SELECT d.*,s.payload FROM solar_alert_deliveries AS d ' +
          'JOIN subscriptions AS s ON s.endpoint=d.endpoint WHERE d.endpoint=? AND d.local_date=? AND d.kind=? ' +
          'AND d.delivered=0 AND d.retry_after<=?').get(pendingDelivery.endpoint, day, kind, sendingAt);
        if (!subscription) continue;
        if (fingerprint(subscription.payload) !== subscription.subscription_hash) {
          this.db.prepare('DELETE FROM solar_alert_deliveries WHERE endpoint=? AND local_date=? AND kind=?')
            .run(subscription.endpoint, day, kind);
          continue;
        }
        const TTL = Math.floor(Math.min(FRESH_FOR, reading.t + FRESH_FOR - sendingAt,
          event.at + DELIVERY_WINDOW_MS - sendingAt) / 1000);
        if (TTL <= 0) break;
        const payload = {
          title: kind === 'solar' ? 'House is now running on solar' : 'House is now using grid power',
          body: 'Solar ' + kw(reading.inverterPowerW) + ' · House ' + kw(reading.loadPowerW) + ' · ' +
            (kind === 'solar' ? 'Export ' + kw(-reading.gridPowerW) : 'Grid import ' + kw(reading.gridPowerW)) + '.',
          kind: 'solar-' + kind, tag: 'moore-solar-' + kind + '-' + day,
          url: '/#homeSolar', timestamp: reading.t
        };
        this.db.prepare('UPDATE solar_alert_deliveries SET retry_after=? WHERE endpoint=? AND local_date=? AND kind=?')
          .run(sendingAt + RETRY_MS, subscription.endpoint, day, kind);
        let accepted = false;
        try { accepted = await this.deliver(subscription, payload, { TTL, urgency: 'normal', topic: 'moore-solar-' + kind }); }
        catch { this.logger.warn?.('[ALERTS] Solar push delivery failed; retrying later.'); }
        if (accepted) {
          this.db.prepare('UPDATE solar_alert_deliveries SET delivered=1,retry_after=0 ' +
            'WHERE endpoint=? AND local_date=? AND kind=? AND subscription_hash=?')
            .run(subscription.endpoint, day, kind, subscription.subscription_hash);
          this.logger.info?.('[ALERTS] Solar ' + kind + ' notification accepted by push provider.');
        }
      }
    } finally { this.busy = false; }
  }
}

module.exports = { SolarAlerts, POLICY, freshReading, RETRY_MS, DELIVERY_WINDOW_MS };
