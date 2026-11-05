(() => {
  const badge = document.getElementById('statusBadge'), detail = document.getElementById('freshnessText');
  if (!badge) return;
  // On Current, the timestamp belongs to the readings that rendered. /ping is
  // useful for connectivity but must never relabel an older displayed record.
  const current = document.querySelector('[data-current-readings]');
  let stationObserved = NaN, polled = NaN, failed = false, busy = false;
  const date = new Intl.DateTimeFormat('en-AU', {timeZone:'Australia/Brisbane', weekday:'short', day:'numeric', month:'short',year:'numeric'});
  const time = new Intl.DateTimeFormat('en-AU', {timeZone:'Australia/Brisbane',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function paint() {
    const observed = current ? Date.parse(current.dataset.observedAt) : stationObserved;
    const received = current ? Date.parse(current.dataset.renderedAt) : polled;
    const age = Date.now() - Math.min(observed, received);
    const updateFailed = current ? current.dataset.fetchError === 'true' : failed;
    let label = 'CONNECTING', cls = 'fetching', text = 'Waiting for station';
    if (observed > Date.now() + 90000) { label = 'CHECK'; cls = 'error'; text = 'Check station clock'; }
    else if (Number.isFinite(age)) {
      label = age <= 90000 ? 'LIVE' : age <= 180000 ? 'DELAYED' : 'STALE';
      cls = age <= 90000 ? 'connected' : age <= 180000 ? 'fetching' : 'error';
      const seconds = Math.max(0, Math.floor(age / 1000));
      text = 'Observed ' + (seconds < 5 ? 'just now' : seconds < 60 ? seconds + 's ago' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : Math.floor(seconds / 3600) + 'h ' + Math.floor(seconds % 3600 / 60) + 'm ago');
      if (current && Number(current.dataset.unavailableSensors) > 0 && age <= 90000) { label = 'PARTIAL'; cls = 'fetching'; text += ' · some sensors unavailable'; }
    }
    if (updateFailed) {
      label = Number.isFinite(observed) ? 'STALE' : 'OFFLINE'; cls = 'error';
      text = Number.isFinite(observed) ? text + ' · update failed' : 'Readings unavailable; retrying';
    }
    badge.textContent = '● ' + label;
    badge.className = 'status-badge ' + cls;
    if (detail) detail.textContent = text;
    if (Number.isFinite(observed)) {
      const dateNode = document.getElementById('dateVal'), timeNode = document.getElementById('timeVal');
      if (dateNode) dateNode.textContent = date.format(observed);
      if (timeNode) timeNode.textContent = time.format(observed) + ' AEST';
    }
  }
  async function refresh() {
    if (busy) return; busy = true;
    try {
      const response = await fetch('/ping', {cache:'no-store', signal:AbortSignal.timeout(10000)});
      if (response.status === 401) { location.assign('/login'); return; }
      if (!response.ok) throw Error('Status unavailable');
      const data = await response.json(); stationObserved = Date.parse(data.stationObservedAt); polled = Date.parse(data.lastWeatherPoll); failed = false;
    } catch { failed = true; }
    finally { busy = false; paint(); }
  }
  window.addEventListener('weather-reading-update', paint);
  paint(); refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  setInterval(() => { if (!document.hidden) paint(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
