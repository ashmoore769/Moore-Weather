'use strict';
const MINUTE = 60000, DAY = 86400000, AEST = 10 * 60 * MINUTE;
const REPEAT_MS = 15 * MINUTE, RETRY_MS = 5 * MINUTE;
const FEEDS = [
  { stream: 'mem3', label: '10-minute', maxAgeMs: 30 * MINUTE },
  { stream: 'mem2', label: 'hourly', maxAgeMs: 120 * MINUTE },
  { stream: 'mem1', label: 'daily' }
];
const stamp = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane',
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function expectedDaily(now) {
  const local = new Date(now + AEST);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 9) - AEST;
  // The 09:00 record is collected at 09:10; allow until 09:30 AEST.
  return now >= today + 30 * MINUTE ? today : today - DAY;
}
function historyHealth(snapshot, now = Date.now()) {
  if (snapshot?.enabled === false) return { enabled: false, available: false, delayed: false, feeds: [], summary: 'Saved history monitoring is off.' };
  const available = snapshot?.ready === true;
  const feeds = FEEDS.map(feed => {
    const raw = snapshot?.streams?.[feed.stream];
    const time = typeof raw === 'string' ? Date.parse(raw) : NaN;
    const valid = available && Number.isFinite(time) && time <= now + 90000;
    const delayed = !valid || (feed.maxAgeMs ? now - time > feed.maxAgeMs : time < expectedDaily(now));
    return { stream: feed.stream, label: feed.label, delayed, lastObservedAt: Number.isFinite(time) ? new Date(time).toISOString() : null };
  });
  const affected = feeds.filter(feed => feed.delayed);
  return { enabled: true, available, delayed: affected.length > 0, checkedAt: new Date(now).toISOString(), repeatMinutes: 15, feeds,
    summary: !available ? 'Saved history is unavailable. Recent graphs may be incomplete.' :
      affected.length ? 'Saved history delayed: ' + affected.map(feed => feed.label).join(', ') + '. Recent graphs may be incomplete.' :
      'Saved weather history is up to date.' };
}
class HistoryAlerts {
  constructor({ db, now = Date.now, deliver, logger = console, startupGraceMs = 120000 }) {
    this.db = db; this.now = now; this.deliver = deliver; this.logger = logger;
    this.started = now(); this.startupGraceMs = startupGraceMs; this.busy = false;
    db.exec('CREATE TABLE IF NOT EXISTS history_alert_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS history_alert_deliveries (endpoint TEXT PRIMARY KEY, event_id INTEGER NOT NULL,' +
      'notified INTEGER NOT NULL DEFAULT 0, recovered INTEGER NOT NULL DEFAULT 0, reminder_after INTEGER NOT NULL DEFAULT 0,' +
      "retry_after INTEGER NOT NULL DEFAULT 0, retry_kind TEXT NOT NULL DEFAULT '');");
  }
  forget(endpoint) { this.db.prepare('DELETE FROM history_alert_deliveries WHERE endpoint=?').run(endpoint); }
  async tick(snapshot) {
    if (this.busy) return;
    const health = historyHealth(snapshot, this.now());
    if (!health.enabled || this.now() - this.started < this.startupGraceMs) return;
    this.busy = true;
    try {
      const db = this.db;
      const saved = db.prepare('SELECT payload FROM history_alert_state WHERE id=1').get();
      let state = saved ? JSON.parse(saved.payload) : { event: 0, active: false };
      if (health.delayed !== state.active) {
        state = { event: state.event + (health.delayed ? 1 : 0), active: health.delayed };
        db.prepare('INSERT INTO history_alert_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(state));
        this.logger.info?.('[ALERTS] ' + (state.active ? health.summary : 'Saved weather history recovered.'));
      }
      db.prepare('DELETE FROM history_alert_deliveries WHERE endpoint NOT IN (SELECT endpoint FROM subscriptions)').run();
      if (!state.event) return;
      for (const subscription of db.prepare('SELECT * FROM subscriptions').all()) {
        let row = db.prepare('SELECT * FROM history_alert_deliveries WHERE endpoint=?').get(subscription.endpoint);
        if (!row || row.event_id !== state.event) {
          if (!state.active) continue; // Do not send a recovery to a device that missed the outage.
          db.prepare('INSERT INTO history_alert_deliveries(endpoint,event_id) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET ' +
            "event_id=excluded.event_id,notified=0,recovered=0,reminder_after=0,retry_after=0,retry_kind=''").run(subscription.endpoint, state.event);
          row = { notified: 0, recovered: 0, reminder_after: 0, retry_after: 0, retry_kind: '' };
        }
        const kind = state.active ? 'missing' : 'recovered';
        if (state.active ? row.notified && row.reminder_after > this.now() : !row.notified || row.recovered) continue;
        if (row.retry_kind === kind && row.retry_after > this.now()) continue;
        const details = health.feeds.filter(feed => feed.delayed).map(feed =>
          feed.label + ': ' + (feed.lastObservedAt ? 'last ' + stamp.format(Date.parse(feed.lastObservedAt)) + ' AEST' : 'no saved record')).join('; ');
        const payload = {
          title: state.active ? (row.notified ? 'Moore Weather · history still missing' : 'Moore Weather · saved history delayed') : 'Moore Weather · history restored',
          body: state.active ? (health.available ? details + '. Check station recording and history collection.' : health.summary) :
            'Fresh 10-minute, hourly and daily records are available again. History reminders have stopped.',
          kind: 'history-' + kind, tag: 'moore-history-' + state.event, url: '/#historyStatus', timestamp: this.now()
        };
        // Persist the attempt before sending. Failed reminders retry in five minutes;
        // successful reminders repeat every fifteen minutes, including after restart.
        db.prepare('UPDATE history_alert_deliveries SET retry_after=?,retry_kind=? WHERE endpoint=?').run(this.now() + RETRY_MS, kind, subscription.endpoint);
        const accepted = await this.deliver(subscription, payload, { topic: 'moore-history-status', urgency: state.active ? 'high' : 'normal', TTL: 900 });
        if (accepted) {
          const sql = state.active ? "notified=1,reminder_after=?,retry_after=0,retry_kind=''" : "recovered=1,reminder_after=?,retry_after=0,retry_kind=''";
          db.prepare('UPDATE history_alert_deliveries SET ' + sql + ' WHERE endpoint=? AND event_id=?').run(this.now() + REPEAT_MS, subscription.endpoint, state.event);
          this.logger.info?.('[ALERTS] History ' + kind + ' notification accepted by push provider.');
        }
      }
    } finally { this.busy = false; }
  }
}
module.exports = { HistoryAlerts, historyHealth, expectedDaily, REPEAT_MS, RETRY_MS };
