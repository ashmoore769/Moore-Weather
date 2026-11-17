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
  let renderedWidth = 0;
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
    const width = Math.max(240, Math.round(graph.clientWidth || 720));
    renderedWidth = width;
    const points = (Array.isArray(history) ? history : [])
      .filter(point => Number.isFinite(Date.parse(point?.observedAt)))
      .map(point => ({ ...point, time: Date.parse(point.observedAt) }))
      .sort((a, b) => a.time - b.time);
    if (!points.length) {
      historySummary.textContent = 'No data recorded in this period.';
      return;
    }
    const duration = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[range];
    const end = Date.now(), start = end - duration;
    const height = 134, left = 43, right = width - 45, top = 12, bottom = 106;
    const series = [
      { field: 'batteryVoltageV', css: 'yard-line', axis: 'V', label: 'Battery voltage' },
      { field: 'pvVoltageV', css: 'yard-line yard-line-panel', axis: 'V', label: 'PV voltage' },
      { field: 'pvPowerW', css: 'yard-line yard-line-power', axis: 'W', label: 'Solar generation' },
      { field: 'controllerLoadPowerW', css: 'yard-line yard-line-load', axis: 'W', label: 'Controller load' }
    ];
    const volts = points.flatMap(point => [point.batteryVoltageV, point.pvVoltageV])
      .filter(value => Number.isFinite(value));
    const watts = points.flatMap(point => [point.pvPowerW, point.controllerLoadPowerW])
      .filter(value => Number.isFinite(value));
    const maxV = Math.max(15, Math.ceil(Math.max(0, ...volts) / 5) * 5);
    const minV = Math.min(0, Math.floor(Math.min(0, ...volts) / 5) * 5);
    const maxW = Math.max(10, Math.ceil(Math.max(0, ...watts) / 10) * 10);
    const minW = 0;
    const gap = range === '24h' ? 4 * 60000 : range === '7d' ? 25 * 60000 : 75 * 60000;
    const xAt = time => left + Math.max(0, Math.min(1, (time - start) / duration)) * (right - left);
    const yAt = (value, min, max) => bottom - (value - min) / Math.max(.1, max - min) * (bottom - top);
    let svg = '';
    for (const fraction of [0, .5, 1]) {
      const x = left + fraction * (right - left), y = top + fraction * (bottom - top);
      svg += '<line class="yard-grid" x1="' + x + '" y1="' + top + '" x2="' + x +
        '" y2="' + bottom + '"/>';
      svg += '<line class="yard-grid" x1="' + left + '" y1="' + y + '" x2="' + right +
        '" y2="' + y + '"/>';
    }
    for (const item of series) {
      const min = item.axis === 'V' ? minV : minW, max = item.axis === 'V' ? maxV : maxW;
      let path = '', previous = null, count = 0, segmentCount = 0, segmentStart = null;
      const dots = [];
      const finishSegment = () => {
        if (segmentCount === 1) dots.push(segmentStart);
        segmentCount = 0;
        segmentStart = null;
      };
      for (const point of points) {
        if (point.time < start || point.time > end || !Number.isFinite(point[item.field])) {
          finishSegment();
          previous = null;
          continue;
        }
        const x = xAt(point.time).toFixed(2), y = yAt(point[item.field], min, max).toFixed(2);
        const continuous = previous && point.time - previous.time <= gap;
        if (!continuous) {
          finishSegment();
          segmentStart = { x, y };
        }
        path += (continuous ? 'L' : 'M') + x + ',' + y;
        segmentCount += 1;
        previous = point; count += 1;
      }
      finishSegment();
      if (!count) continue;
      svg += '<path class="' + item.css + '" d="' + escapeSvg(path) + '"><title>' +
        escapeSvg(item.label + ' (' + item.axis + ')') + '</title></path>';
      for (const dot of dots) svg += '<circle class="' + item.css + ' yard-single-dot" cx="' +
        dot.x + '" cy="' + dot.y + '" r="2.5"/>';
    }
    svg += '<text class="yard-axis" x="1" y="' + (top + 5) + '">' + maxV.toFixed(0) + ' V</text>' +
      '<text class="yard-axis" x="1" y="' + (bottom + 4) + '">' + minV.toFixed(0) + ' V</text>' +
      '<text class="yard-axis" text-anchor="end" x="' + (width - 1) + '" y="' + (top + 5) + '">' +
        maxW.toFixed(0) + ' W</text>' +
      '<text class="yard-axis" text-anchor="end" x="' + (width - 1) + '" y="' + (bottom + 4) + '">' +
        minW.toFixed(0) + ' W</text>';
    svg += '<text class="yard-axis" x="' + left + '" y="' + (height - 3) + '">' +
      (range === '24h' ? '24h ago' : range === '7d' ? '7 days ago' : '30 days ago') + '</text>' +
      '<text class="yard-axis" text-anchor="end" x="' + right + '" y="' + (height - 3) + '">Now</text>';
    const drawing = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    drawing.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    drawing.setAttribute('role', 'img');
    drawing.setAttribute('aria-label', 'Yard Power history. Battery and PV voltage use the left scale in volts. Solar generation and controller load use the right scale in watts. Missing measurements are not connected.');
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
    card.dataset.state = lastAttemptError ? 'unavailable' : state;
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
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      const width = Math.max(240, Math.round(graph.clientWidth || 720));
      if (latestHistory && graph.clientWidth > 0 && width !== renderedWidth) drawHistory(latestHistory);
    }).observe(graph);
  }
  void begin();
})();
