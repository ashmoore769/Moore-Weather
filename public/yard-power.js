/* Independent Yard Power dashboard. No simulated live readings. */
(function () {
  'use strict';
  const card = document.getElementById('yardPower');
  if (!card) return;
  const status = document.getElementById('yardPowerStatus');
  const age = document.getElementById('yardPowerAge');
  const summary = document.getElementById('yardPowerSummary');
  const historySummary = document.getElementById('yardPowerHistoryDetail');
  const graph = document.getElementById('yardPowerChart');
  const controls = [...card.querySelectorAll('[data-yard-range]')];
  const metricMap = [
    ['batteryVoltageV', 'yardBatteryV', 2],
    ['pvVoltageV', 'yardPvV', 2],
    ['pvPowerW', 'yardPvPower', 2],
    ['chargeCurrentA', 'yardChargeA', 2],
    ['controllerLoadPowerW', 'yardLoadPower', 2],
    ['controllerTempC', 'yardControllerTemp', 1],
  ];
  const TIMEOUT_MS = 10000;
  let current = null;
  let range = '24h';
  let latestHistory = null;
  let enabled = null;
  let lastAttemptError = false;
  const formatTime = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const clock = value => {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? formatTime.format(timestamp) + ' AEST' : 'Unavailable';
  };
  const valueText = (value, digits) => Number.isFinite(value) ? value.toFixed(digits) : '–';
  const element = id => document.getElementById(id);
  const setText = (id, value) => { const target = element(id); if (target) target.textContent = value; };
  const escapeSvg = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  function drawHistory(history) {
    graph.replaceChildren();
    const values = Array.isArray(history) ? history : [];
    const points = values.filter(point => Number.isFinite(Date.parse(point.observedAt)));
    if (!points.length) {
      historySummary.textContent = 'No historical readings for this period yet.';
      return;
    }
    const duration = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[range];
    const end = Date.now(), start = end - duration;
    const width = 720, height = 145, left = 43, right = 10, top = 12, bottom = 24;
    const measures = [
      { field: 'batteryVoltageV', css: 'yard-line', maxGap: range === '24h' ? 4 * 60000 : range === '7d' ? 25 * 60000 : 75 * 60000 },
      { field: 'pvPowerW', css: 'yard-line yard-line-power', maxGap: range === '24h' ? 4 * 60000 : range === '7d' ? 25 * 60000 : 75 * 60000 }
    ];
    const timeToX = t => left + Math.max(0, Math.min(1, (t - start) / duration)) * (width - left - right);
    let svg = '';
    for (const item of measures) {
      const usable = points.filter(point => Number.isFinite(point[item.field]))
        .map(point => ({ x: Date.parse(point.observedAt), value: point[item.field] }))
        .filter(point => point.x >= start && point.x <= end);
      if (!usable.length) continue;
      const min = item.field === 'pvPowerW' ? 0 : Math.floor(Math.min(...usable.map(p => p.value)) * 2) / 2 - .1;
      const max = item.field === 'pvPowerW'
        ? Math.max(10, Math.ceil(Math.max(...usable.map(p => p.value)) / 10) * 10)
        : Math.ceil(Math.max(...usable.map(p => p.value)) * 2) / 2 + .1;
      const yOf = value => top + (height - top - bottom) * (1 - (value - min) / Math.max(max - min, .1));
      let path = '';
      let previous = null;
      for (const p of usable) {
        const x = timeToX(p.x).toFixed(2), y = yOf(p.value).toFixed(2);
        path += (!previous || p.x - previous.x > item.maxGap ? 'M' : 'L') + x + ',' + y;
        previous = p;
      }
      svg += '<path class="' + item.css + '" d="' + escapeSvg(path) + '"/>';
      if (item.field === 'batteryVoltageV') {
        svg += '<text class="yard-axis" x="2" y="' + (top + 4) + '">' + escapeSvg(max.toFixed(1)) + 'V</text>';
        svg += '<text class="yard-axis" x="2" y="' + (height - bottom) + '">' + escapeSvg(min.toFixed(1)) + 'V</text>';
      } else {
        svg += '<text class="yard-axis" text-anchor="end" x="' + (width - 1) + '" y="' + (top + 4) + '">' + escapeSvg(max.toFixed(0)) + 'W</text>';
      }
    }
    for (const position of [0, 0.5, 1]) {
      const x = left + position * (width - left - right);
      svg = '<line class="yard-grid" x1="' + x + '" y1="' + top + '" x2="' + x + '" y2="' + (height - bottom) + '"/>' + svg;
    }
    svg += '<text class="yard-axis" x="' + left + '" y="' + (height - 3) + '">' +
      (range === '24h' ? '24h ago' : range === '7d' ? '7 days ago' : '30 days ago') + '</text>';
    svg += '<text class="yard-axis" text-anchor="end" x="' + (width - right) + '" y="' + (height - 3) + '">Now</text>';
    const ns = 'http://www.w3.org/2000/svg';
    const drawing = document.createElementNS(ns, 'svg');
    drawing.setAttribute('viewBox', '0 0 720 145');
    drawing.setAttribute('role', 'img');
    drawing.setAttribute('aria-label', 'Recorded battery voltage and solar generation, with gaps left unconnected');
    // Fixed internal SVG fragments, with numeric data validated above.
    drawing.innerHTML = svg;
    graph.appendChild(drawing);
    historySummary.textContent = points.length + ' recorded intervals · ' + range + ' · AEST';
  }

  function paint() {
    for (const [key, id, digits] of metricMap) setText(id, valueText(current?.[key], digits));
    if (enabled !== true) return;
    const observed = Date.parse(current?.observedAt || '');
    const diff = Number.isFinite(observed) ? Date.now() - observed : Infinity;
    const state = !current ? 'waiting' : diff >= 0 && diff <= 180000 ? 'fresh' : 'stale';
    status.dataset.state = lastAttemptError ? 'unavailable' : state;
    status.textContent = lastAttemptError ? 'UNAVAILABLE' : state === 'fresh' ? 'LIVE' : state === 'stale' ? 'DELAYED' : 'WAITING';
    const ageMin = Number.isFinite(diff) ? Math.max(0, Math.floor(diff / 60000)) : 0;
    age.textContent = current ? (ageMin < 1 ? 'Just updated' : ageMin + ' min ago') : 'No reading';
    age.title = current ? 'Observed ' + clock(current.observedAt) : 'Waiting for first valid reading';
    summary.textContent = lastAttemptError
      ? 'Stored measurements remain available while the feed recovers.'
      : !current ? 'Waiting for the first EPEVER measurement.'
        : state === 'fresh' ? 'MT50 passive telemetry · Updated ' + clock(current.observedAt)
          : 'Last valid measurement ' + clock(current.observedAt) + ' · no fresh readings';
  }

  async function getJson(url) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin',
      signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 401) return null;
    if (response.status === 404) return { enabled: false };
    if (!response.ok) throw Error('Telemetry temporarily unavailable');
    return response.json();
  }

  async function refreshCurrent() {
    try {
      const payload = await getJson('/api/yard-power');
      if (!payload || payload.enabled === false) {
        enabled = false;
        card.hidden = true;
        return;
      }
      enabled = true;
      card.hidden = false;
      current = payload.current || current;
      lastAttemptError = payload.status === 'unavailable';
      paint();
    } catch {
      if (enabled === true) { lastAttemptError = true; paint(); }
    }
  }

  async function refreshHistory() {
    if (enabled !== true) return;
    const requestedRange = range;
    try {
      const payload = await getJson('/api/yard-power?range=' + encodeURIComponent(requestedRange));
      if (!payload || payload.enabled !== true || requestedRange !== range) return;
      latestHistory = payload.history;
      drawHistory(latestHistory);
    } catch {
      historySummary.textContent = 'Historical readings temporarily unavailable.';
    }
  }

  controls.forEach(button => button.addEventListener('click', () => {
    const selected = button.dataset.yardRange;
    if (!['24h', '7d', '30d'].includes(selected)) return;
    range = selected;
    controls.forEach(control => control.setAttribute('aria-pressed', String(control === button)));
    historySummary.textContent = 'Loading historical readings…';
    void refreshHistory();
  }));

  async function begin() {
    await refreshCurrent();
    await refreshHistory();
    setInterval(() => { void refreshCurrent(); }, 60000);
    setInterval(() => { paint(); }, 15000);
    setInterval(() => { void refreshHistory(); }, 300000);
  }
  void begin();
})();
