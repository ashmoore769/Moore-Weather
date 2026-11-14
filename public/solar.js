(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) {
    const controller = api.createController({ document: root.document, fetch: root.fetch.bind(root), location: root.location });
    if (controller) controller.start();
  }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const POLL_MS = 60000, PAINT_MS = 15000, REQUEST_TIMEOUT_MS = 10000;
  const statuses = new Set(['disabled', 'waiting', 'fresh', 'stale', 'unavailable']);
  const qualities = { complete: 'From midnight', partial: 'Partial day', unavailable: 'Unavailable', reset: 'Counter reset' };
  const dateParts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' });
  const observationTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const number = (value, digits = 2) => value.toLocaleString('en-AU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  function power(value) {
    const reading = numeric(value);
    if (reading === null) return '—';
    if (reading !== 0 && Math.abs(reading) < 100) return reading.toLocaleString('en-AU', { maximumFractionDigits: 1 }) + ' W';
    return number(reading / 1000) + ' kW';
  }
  function dayKey(now) {
    const parts = Object.fromEntries(dateParts.formatToParts(now).map(part => [part.type, part.value]));
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  function ageText(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  function createController(options) {
    const doc = options.document, card = doc.getElementById('homeSolar');
    if (!card) return null;
    const request = options.fetch, location = options.location;
    const now = options.now || Date.now;
    const schedule = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    const cancel = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    const timeoutSignal = options.timeoutSignal || (milliseconds => AbortSignal.timeout(milliseconds));
    const node = id => doc.getElementById(id);
    const text = (id, value) => { node(id).textContent = value; };
    let started = false, inFlight = false, failed = false, enabled = null;
    let current = null, today = null, serverStatus = 'waiting', staleAfterMs = 180000;
    let pollTimer = null, paintTimer = null;

    function clearTimers() {
      cancel(pollTimer); cancel(paintTimer);
      pollTimer = null; paintTimer = null;
    }
    function showToday(time) {
      const sameDay = today && today.date === dayKey(time);
      const quality = sameDay && Object.hasOwn(qualities, today.quality) ? today.quality : 'unavailable';
      const energy = sameDay ? numeric(today.energyAcWh) : null;
      const usable = ['complete', 'partial'].includes(quality) && energy !== null && energy >= 0;
      text('solarTodayEnergy', usable ? number(energy / 1000) + ' kWh' : '—');
      text('solarTodayQuality', qualities[quality]);
      const through = sameDay ? timestamp(today.through) : NaN;
      node('solarEnergyThrough').hidden = !usable || !Number.isFinite(through);
      text('solarEnergyThrough', usable && Number.isFinite(through) ? 'Counter through ' + observationTime.format(through) + ' AEST' : '');
      const label = sameDay && typeof today.label === 'string'
        ? today.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180) : '';
      text('solarTodayNote', label || (sameDay ? 'Daily AC energy is unavailable.' : "Waiting for today's readings."));
    }
    function showReadings() {
      text('solarPvPower', power(current?.pvPowerW));
      text('solarAcPower', power(current?.inverterPowerW));
      const grid = numeric(current?.gridPowerW), load = numeric(current?.loadPowerW);
      const battery = numeric(current?.batteryPowerW), rawSoc = numeric(current?.batterySocPercent);
      const soc = rawSoc !== null && rawSoc >= 0 && rawSoc <= 100 ? rawSoc : null;
      node('solarGridMetric').hidden = grid === null;
      node('solarLoadMetric').hidden = load === null;
      node('solarBatteryMetric').hidden = battery === null && soc === null;
      node('solarFlows').hidden = grid === null && load === null && battery === null && soc === null;
      text('solarGridLabel', grid > 0 ? 'Grid import' : grid < 0 ? 'Grid export' : 'Grid exchange');
      text('solarGridPower', power(grid === null ? null : Math.abs(grid)));
      text('solarLoadPower', power(load));
      text('solarBatteryLabel', battery > 0 ? 'Battery discharge' : battery < 0 ? 'Battery charging' : battery === 0 ? 'Battery idle' : 'Battery charge');
      text('solarBatteryPower', battery === null ? (soc === null ? '—' : number(soc, 1) + '%') : power(Math.abs(battery)));
      text('solarBatterySoc', battery !== null && soc !== null ? number(soc, 1) + '% state of charge' : '');
    }
    function paint() {
      card.hidden = enabled === false;
      if (card.hidden) return;
      const time = now();
      const observed = timestamp(current?.observedAt);
      const times = current ? [observed, timestamp(current.collectedAt), timestamp(current.receivedAt)] : [];
      const age = times.length ? time - Math.min(...times) : NaN;
      let state = enabled === null ? 'connecting' : 'waiting', label = enabled === null ? 'CONNECTING' : 'WAITING';
      let message = enabled === null ? 'Connecting to saved solar readings.' : 'Waiting for the first reading from the home collector.';
      if (current) {
        if (times.some(value => value > time + 90000)) {
          state = 'check'; label = 'CHECK'; message = 'The inverter or collector clock is ahead of the current time.';
        } else if (failed || serverStatus === 'stale' || serverStatus === 'waiting' || age > staleAfterMs) {
          state = 'stale'; label = 'STALE';
          message = failed ? 'Latest solar update failed. Last reading retained; retrying automatically.' : 'No recent solar reading. Last reading retained.';
        } else if (serverStatus === 'unavailable') {
          state = 'unavailable'; label = 'UNAVAILABLE'; message = 'Solar readings are temporarily unavailable. Last reading retained.';
        } else if (numeric(current.pvPowerW) === null || numeric(current.inverterPowerW) === null) {
          state = 'partial'; label = 'PARTIAL'; message = 'Some solar measurements are unavailable.';
        } else {
          state = 'fresh'; label = 'LIVE'; message = '';
        }
      } else if (failed || serverStatus === 'unavailable') {
        state = 'unavailable'; label = 'UNAVAILABLE'; message = 'Solar readings could not be loaded. Retrying automatically.';
      }
      card.dataset.state = state;
      text('solarStatus', label);
      node('solarStatus').className = 'solar-badge solar-badge-' + state;
      text('solarObserved', current ? 'Observed ' + observationTime.format(observed) + ' AEST · ' + ageText(time - observed) : 'No reading received yet');
      text('solarMessage', message); node('solarMessage').hidden = !message;
      showReadings(); showToday(time);
    }
    function schedulePaint() {
      cancel(paintTimer);
      if (started && !doc.hidden) paintTimer = schedule(() => { paint(); schedulePaint(); }, PAINT_MS);
    }
    async function refresh() {
      if (!started || doc.hidden || inFlight) return;
      inFlight = true; cancel(pollTimer); pollTimer = null;
      try {
        const response = await request('/api/solar', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: timeoutSignal(REQUEST_TIMEOUT_MS) });
        if (!started) return;
        if (response.status === 401) {
          stop(); card.hidden = true; current = null; today = null;
          location.assign('/login'); return;
        }
        if (!response.ok) throw new Error('Solar response unavailable');
        const body = await response.json();
        if (!started) return;
        if (!body || typeof body.enabled !== 'boolean' || !statuses.has(body.status) || !Object.hasOwn(body, 'current')) throw new Error('Invalid solar response');
        if (body.current !== null && body.current !== undefined &&
            (!body.current || ['observedAt', 'collectedAt', 'receivedAt'].some(key => !Number.isFinite(timestamp(body.current[key]))))) {
          throw new Error('Invalid solar observation time');
        }
        enabled = body.enabled; serverStatus = body.status; failed = false;
        staleAfterMs = typeof body.staleAfterSeconds === 'number' && body.staleAfterSeconds > 0 && body.staleAfterSeconds <= 3600 ? body.staleAfterSeconds * 1000 : 180000;
        if (!enabled) { current = null; today = null; }
        else {
          if (body.current) current = body.current;
          today = body.today && typeof body.today === 'object' ? body.today : null;
        }
        paint();
      } catch {
        if (started) { failed = true; paint(); }
      } finally {
        inFlight = false;
        if (started && !doc.hidden) pollTimer = schedule(refresh, POLL_MS);
      }
    }
    function visibilityChanged() {
      clearTimers();
      if (!doc.hidden && started) { paint(); schedulePaint(); refresh(); }
    }
    function start() {
      if (started) return;
      started = true; doc.addEventListener('visibilitychange', visibilityChanged);
      paint(); schedulePaint(); refresh();
    }
    function stop() {
      started = false; clearTimers(); doc.removeEventListener('visibilitychange', visibilityChanged);
    }
    return { start, stop, refresh, paint };
  }
  return { createController };
});
