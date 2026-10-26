'use strict';
const { METRICS } = require('./water-data');
const METRIC = 'condamine-warwick-level';
const BRIDGE = METRICS[METRIC].bridge;
const MAX_AGE_MS = 30 * 60000, RETRY_MS = 5 * 60000;
const stamp = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane',
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function freshReading(row, now) {
  return row?.metric === METRIC && Number.isFinite(row.value) && Number.isFinite(row.t) &&
    Number.isFinite(row.checkedAt) && row.t <= now + 90000 && row.checkedAt <= now + 90000 &&
    now - row.t <= MAX_AGE_MS && now - row.checkedAt <= MAX_AGE_MS;
}
class BridgeAlerts {
  constructor({ db, now = Date.now, deliver }) {
    this.db = db; this.now = now; this.deliver = deliver; this.busy = false;
    db.exec("CREATE TABLE IF NOT EXISTS bridge_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); " +
      "CREATE TABLE IF NOT EXISTS bridge_deliveries (endpoint TEXT PRIMARY KEY, event_id TEXT NOT NULL, " +
      "near_sent INTEGER NOT NULL DEFAULT 0, cross_sent INTEGER NOT NULL DEFAULT 0, " +
      "near_retry INTEGER NOT NULL DEFAULT 0, cross_retry INTEGER NOT NULL DEFAULT 0);");
  }
  save(state) {
    this.db.prepare('INSERT INTO bridge_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(state));
  }
  forget(endpoint) { this.db.prepare('DELETE FROM bridge_deliveries WHERE endpoint=?').run(endpoint); }
  async tick(reading) {
    if (this.busy || !freshReading(reading, this.now())) return;
    this.busy = true;
    try {
      const db = this.db, saved = db.prepare('SELECT payload FROM bridge_state WHERE id=1').get();
      let state = saved ? JSON.parse(saved.payload) : { t: 0, value: null, event: null };
      // Replayed history and a correction at an already processed timestamp must
      // not create/rearm an incident. Retry only the same still-fresh observation.
      if (reading.t < state.t || (reading.t === state.t && reading.value !== state.value)) return;
      if (reading.t > state.t) {
        state = { ...state, t: reading.t, value: reading.value };
        // Both thresholds rearm only after water falls more than 1m below the
        // reference, so small fluctuations cannot repeatedly alert the household.
        if (reading.value < BRIDGE.level - 1) {
          state.event = null;
          db.prepare('DELETE FROM bridge_deliveries').run();
        } else if (!state.event && reading.value >= BRIDGE.level - .5) {
          state.event = String(reading.t);
        }
        this.save(state);
      }
      db.prepare('DELETE FROM bridge_deliveries WHERE endpoint NOT IN (SELECT endpoint FROM subscriptions)').run();
      if (!state.event || reading.value < BRIDGE.level - .5) return;
      for (const subscription of db.prepare('SELECT * FROM subscriptions').all()) {
        if (!freshReading(reading, this.now())) break;
        db.prepare('INSERT INTO bridge_deliveries(endpoint,event_id) VALUES(?,?) ON CONFLICT(endpoint) DO NOTHING')
          .run(subscription.endpoint, state.event);
        let delivered = db.prepare('SELECT * FROM bridge_deliveries WHERE endpoint=?').get(subscription.endpoint);
        if (delivered.event_id !== state.event) {
          db.prepare('UPDATE bridge_deliveries SET event_id=?,near_sent=0,cross_sent=0,near_retry=0,cross_retry=0 WHERE endpoint=?')
            .run(state.event, subscription.endpoint);
          delivered = { near_sent: 0, cross_sent: 0, near_retry: 0, cross_retry: 0 };
        }
        // If the first observed level is already at/above the bridge, send the
        // stronger message only. A failed warning never delays a crossing alert.
        const crossing = reading.value >= BRIDGE.level;
        const kind = crossing && !delivered.cross_sent ? 'cross' :
          !crossing && !delivered.near_sent && !delivered.cross_sent ? 'near' : null;
        if (!kind || delivered[kind + '_retry'] > this.now()) continue;
        const difference = Math.round((BRIDGE.level - reading.value) * 100) / 100;
        const relative = difference === 0 ? 'at' : Math.abs(difference).toFixed(2) + 'm ' + (difference > 0 ? 'below' : 'above');
        const payload = {
          title: crossing ? 'Warwick river · bridge reference reached' : 'Warwick river · near bridge reference',
          body: reading.value.toFixed(2) + 'm — ' + relative + ' the ' + BRIDGE.level.toFixed(2) + 'm ' +
            BRIDGE.name + ' reference. Recorded ' + stamp.format(reading.t) + ' AEST. Check official road updates.',
          tag: 'moore-river-' + kind + '-' + state.event,
          url: '/#localWater', timestamp: reading.t
        };
        // Reserve the attempt before sending. Accepted delivery and retry state
        // survive restarts; stable tags replace ambiguous retries on the device.
        db.prepare('UPDATE bridge_deliveries SET ' + kind + '_retry=? WHERE endpoint=?')
          .run(this.now() + RETRY_MS, subscription.endpoint);
        const TTL = Math.max(1, Math.min(900, Math.floor((reading.t + MAX_AGE_MS - this.now()) / 1000)));
        const accepted = await this.deliver(subscription, payload, { TTL, urgency: 'high', topic: 'moore-river-' + kind });
        if (accepted) {
          db.prepare('UPDATE bridge_deliveries SET ' + kind + '_sent=1,' + kind + '_retry=0' +
            (crossing ? ',near_sent=1' : '') + ' WHERE endpoint=? AND event_id=?')
            .run(subscription.endpoint, state.event);
        }
      }
    } finally { this.busy = false; }
  }
}
module.exports = { BridgeAlerts, freshReading, MAX_AGE_MS, RETRY_MS };
