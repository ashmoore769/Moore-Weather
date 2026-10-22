'use strict';
const { HOUR, DAY, OFFSET, damCurrent, damDaily, riverTrace, riverExtent } = require('./water-data');
const nextHour = now => Math.floor((now - HOUR / 2) / HOUR) * HOUR + HOUR * 1.5;
const nextDay = now => Math.floor((now + OFFSET) / DAY) * DAY - OFFSET + DAY + 10 * 60000;
// Each step performs at most one provider request. All checkpoints survive restarts.
class WaterCollector {
  constructor(store, client) { this.store = store; this.client = client; }
  jobs() {
    return ['leslie-current', 'river-extent', 'condamine-level-live', 'condamine-flow-live', 'leslie-daily',
      'condamine-level-review', 'condamine-flow-review', 'condamine-level-backfill', 'condamine-flow-backfill'];
  }
  async step(now = Date.now()) {
    const store = this.store;
    const job = this.jobs().filter(id => {
      const state = store.state(id);
      if (id.endsWith('-backfill') && !store.state('river-extent')?.earliest) return false;
      return !state?.complete && (!state?.due || state.due <= now);
    }).sort((a, b) => (store.state(a)?.due || 0) - (store.state(b)?.due || 0))[0];
    if (!job) return null;
    const prior = store.state(job) || {};
    try {
      let rows = [], state = { ...prior, error: null, failures: 0, lastSuccess: new Date(now).toISOString() };
      if (job === 'leslie-current') {
        rows = damCurrent(await this.client.current()); state.due = nextHour(now);
      } else if (job === 'river-extent') {
        const response = await this.client.extent();
        state = { ...state, earliest: riverExtent(response), metadata: response, complete: true };
      } else if (job === 'leslie-daily') {
        const initial = !prior.archiveComplete;
        const start = prior.start ?? (initial ? Date.UTC(1900, 0, 1) : now - 7 * DAY);
        const end = prior.end ?? (Math.floor((now + OFFSET) / DAY) * DAY - OFFSET + DAY);
        const response = await this.client.daily(start, end, prior.token);
        rows = damDaily(response);
        const token = response.continuationToken;
        if (rows.length && token && token === prior.token) throw new Error('Sunwater returned a repeated continuation token');
        const finished = !rows.length || !token;
        state = { ...state, start: finished ? null : start, end: finished ? null : end, token: finished ? null : token,
          archiveComplete: initial ? finished : true, imported: (prior.imported || 0) + rows.length, due: finished ? nextDay(now) : now + 30000 };
      } else {
        const metric = job.startsWith('condamine-level') ? 'condamine-level' : 'condamine-flow';
        const backfill = job.endsWith('-backfill'), review = job.endsWith('-review');
        let start, end;
        const days = prior.batchDays || 31;
        if (backfill) {
          end = prior.cursor ?? now;
          start = Math.max(store.state('river-extent').earliest, end - days * DAY);
        } else if (review) {
          end = prior.cursor ?? now;
          start = Math.max(prior.floor ?? now - 90 * DAY, end - days * DAY);
        } else {
          start = Math.min(prior.lastEnd ?? now, now) - 2 * DAY;
          end = Math.min(now, start + days * DAY);
        }
        rows = riverTrace(await this.client.trace(metric, start, end), metric);
        // Boundary points are allowed; a wider response is never silently imported.
        if (rows.some(s => s.t < start - 1000 || s.t > end + 1000)) throw new Error('WMIP returned readings outside the requested period');
        state.imported = (prior.imported || 0) + rows.length;
        if (backfill) {
          state.cursor = start; state.complete = start <= store.state('river-extent').earliest;
          state.due = now + 30000;
        } else if (review) {
          const floor = prior.floor ?? now - 90 * DAY, finished = start <= floor;
          state.floor = finished ? null : floor; state.cursor = finished ? null : start;
          state.due = finished ? now + DAY : now + 30000;
        } else { state.lastEnd = end; state.due = end < now ? now + 30000 : nextHour(now); }
      }
      store.save(rows, job, state);
      return { job, rows: rows.length, error: null };
    } catch (error) {
      const failures = (prior.failures || 0) + 1;
      store.setState(job, { ...prior, failures, error: error.message,
        batchDays: error.code === 'BATCH_SIZE' ? Math.max(1, Math.floor((prior.batchDays || 31) / 2)) : prior.batchDays,
        due: now + Math.min(6 * HOUR, 60000 * 2 ** Math.min(failures, 9)) });
      return { job, error: error.message };
    }
  }
}
module.exports = { WaterCollector, nextHour };
