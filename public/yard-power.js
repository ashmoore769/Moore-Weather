/* Independent Yard Power dashboard. No simulated live readings. */
(function () {
  'use strict';
  // Presentation follows the accepted telemetry ranges; invalid/missing values
  // stay neutral and are never converted to an apparent zero measurement.
  const metricMap = [
    ['batteryVoltageV', 'yardBatteryV', 2, 0, 100],
    ['pvVoltageV', 'yardPvV', 2, 0, 200],
    ['pvPowerW', 'yardPvPower', 2, 0, 20000],
    ['chargeCurrentA', 'yardChargeA', 2, 0, 200],
    ['controllerLoadPowerW', 'yardLoadPower', 2, 0, 20000],
    ['controllerTempC', 'yardControllerTemp', 1, -50, 125],
  ];
  const validReading = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  function readingPresentation(sample) {
    const readings = Object.fromEntries(metricMap.map(([key, id, digits, min, max]) => {
      const value = validReading(sample?.[key], min, max) ? sample[key] : null;
      return [id, { value, text: value === null ? '–' : value.toFixed(digits), color: '' }];
    }));
    const battery = readings.yardBatteryV.value, charge = readings.yardChargeA.value;
    readings.yardBatteryV.color = battery === null ? '' : battery >= 12.9 ? 'var(--battery-good)' : 'var(--amber)';
    const load = sample?.controllerLoadCurrentA;
    readings.yardChargeA.title = '';
    // Both measurements are amperes. Controller load excludes any inverter
    // wired directly to the battery; displayed load watts cannot substitute.
    if (battery !== null && battery < 13.8 && charge !== null && validReading(load, 0, 200)) {
      readings.yardChargeA.color = charge > load ? 'var(--battery-good)' : 'var(--battery-bad)';
      readings.yardChargeA.title = 'Charge ' + charge.toFixed(2) + ' A compared with controller load ' + load.toFixed(2) + ' A only. Directly connected inverter loads are excluded.';
    }
    return readings;
  }
  if (typeof module === 'object' && module.exports) { module.exports = { readingPresentation }; return; }
  const card = document.getElementById('yardPower');
  if (!card) return;
  const status = document.getElementById('yardPowerStatus');
  const age = document.getElementById('yardPowerAge');
  const summary = document.getElementById('yardPowerSummary');
  const historySummary = document.getElementById('yardPowerHistoryDetail');
  const graph = document.getElementById('yardPowerChart');
  const controls = [...card.querySelectorAll('[data-yard-range]')];
  const TIMEOUT_MS = 10000;
  let current = null;
  let range = '12h';
  let latestHistory = null;
  let historyPoints = [], historyRange = range, historyEnd = Date.now();
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
  const element = id => document.getElementById(id);
  const escapeSvg = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const series = [
    { field: 'batteryVoltageV', css: 'yard-line yard-line-battery', axis: 'V', label: 'Battery voltage', short: 'Battery' },
    { field: 'pvVoltageV', css: 'yard-line yard-line-panel', axis: 'V', label: 'PV voltage', short: 'PV' },
    { field: 'pvPowerW', css: 'yard-line yard-line-power', axis: 'W', label: 'Solar generation', short: 'Solar' },
    { field: 'controllerLoadPowerW', css: 'yard-line yard-line-load', axis: 'W', label: 'Controller load', short: 'Load' }
  ];
  const durations = { '12h': 43200000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
  const chartControls = window.MoorePowerChartControls?.create({ plot: graph, prefix: 'yardPower', label: 'Yard Power', redraw: drawHistory });

  function drawHistory() {
    graph.replaceChildren();
    const width = Math.max(240, Math.round(graph.clientWidth || 720));
    renderedWidth = width;
    const duration = durations[historyRange], points = historyPoints;
    const bounds = { start: historyEnd - duration, end: historyEnd };
    const { start, end } = chartControls?.window || bounds;
    const height = 134, left = 43, right = width - 45, top = 12, bottom = 106;
    const volts = points.flatMap(point => [point.batteryVoltageV, point.pvVoltageV])
      .filter(value => Number.isFinite(value));
    const watts = points.flatMap(point => [point.pvPowerW, point.controllerLoadPowerW])
      .filter(value => Number.isFinite(value));
    const maxV = Math.max(15, Math.ceil(Math.max(0, ...volts) / 5) * 5);
    const minV = Math.min(0, Math.floor(Math.min(0, ...volts) / 5) * 5);
    const maxW = Math.max(10, Math.ceil(Math.max(0, ...watts) / 10) * 10);
    const minW = 0;
    const shortWindow = duration <= durations['24h'];
    const gap = shortWindow ? 4 * 60000 : historyRange === '7d' ? 25 * 60000 : 75 * 60000;
    const xAt = time => left + (time - start) / (end - start) * (right - left);
    const yAt = (value, min, max) => bottom - (value - min) / Math.max(.1, max - min) * (bottom - top);
    let svg = '';
    for (const fraction of [0, .5, 1]) {
      const x = left + fraction * (right - left), y = top + fraction * (bottom - top);
      svg += '<line class="yard-grid" x1="' + x + '" y1="' + top + '" x2="' + x +
        '" y2="' + bottom + '"/>';
      svg += '<line class="yard-grid" x1="' + left + '" y1="' + y + '" x2="' + right +
        '" y2="' + y + '"/>';
    }
    svg += '<defs><clipPath id="yardPowerPlotClip"><rect x="' + left + '" y="' + top + '" width="' + (right - left) + '" height="' + (bottom - top) + '"/></clipPath></defs><g clip-path="url(#yardPowerPlotClip)">';
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
        if (point.time < bounds.start || point.time > bounds.end || !Number.isFinite(point[item.field])) {
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
    svg += '</g><text class="yard-axis" x="1" y="' + (top + 5) + '">' + maxV.toFixed(0) + ' V</text>' +
      '<text class="yard-axis" x="1" y="' + (bottom + 4) + '">' + minV.toFixed(0) + ' V</text>' +
      '<text class="yard-axis" text-anchor="end" x="' + (width - 1) + '" y="' + (top + 5) + '">' +
        maxW.toFixed(0) + ' W</text>' +
      '<text class="yard-axis" text-anchor="end" x="' + (width - 1) + '" y="' + (bottom + 4) + '">' +
        minW.toFixed(0) + ' W</text>';
    const fullView = end - start >= duration - 1;
    const axisTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane',
      ...(shortWindow ? {} : { day: 'numeric', month: 'short' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    svg += '<text class="yard-axis" x="' + left + '" y="' + (height - 3) + '">' +
      (fullView ? shortWindow ? historyRange + ' ago' : historyRange === '7d' ? '7 days ago' : '30 days ago' : axisTime.format(start)) + '</text>' +
      '<text class="yard-axis" text-anchor="end" x="' + right + '" y="' + (height - 3) + '">' + (fullView ? 'Now' : axisTime.format(end)) + '</text>';
    const drawing = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    drawing.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    drawing.setAttribute('role', 'img');
    drawing.setAttribute('aria-label', 'Yard Power history. Battery and PV voltage use the left scale in volts. Solar generation and controller load use the right scale in watts. Missing measurements are not connected.');
    drawing.innerHTML = svg;
    graph.appendChild(drawing);
    chartControls?.present({ svg: drawing, width, left, right, top, bottom });
    historySummary.textContent = points.length ? points.length + ' recorded intervals · ' + historyRange + ' · AEST' : 'No data recorded in this period.';
  }

  function paint() {
    for (const [id, reading] of Object.entries(readingPresentation(current))) {
      const target = element(id);
      if (!target) continue;
      target.textContent = reading.text;
      target.style.color = reading.color;
      if ('title' in reading) target.title = reading.title;
    }
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
      historyRange = requestedRange; historyEnd = Date.now();
      const bounds = { start: historyEnd - durations[historyRange], end: historyEnd };
      historyPoints = (Array.isArray(latestHistory) ? latestHistory : [])
        .filter(point => Number.isFinite(Date.parse(point?.observedAt)))
        .map(point => ({ ...point, time: Date.parse(point.observedAt) }))
        .filter(point => point.time >= bounds.start && point.time <= bounds.end).sort((a, b) => a.time - b.time);
      chartControls?.setData({ bounds, domainKey: historyRange,
        minSpan: { '12h': 3600000, '24h': 3600000, '7d': 21600000, '30d': 86400000 }[historyRange],
        items: historyPoints.map(point => ({ t: point.time, values: series.map(item => ({
          name: item.short, unit: item.axis, precision: 2, value: point[item.field] })) })) });
      drawHistory();
    } catch {
      historySummary.textContent = 'Historical readings temporarily unavailable.';
    }
  }

  controls.forEach(button => button.addEventListener('click', () => {
    const selected = button.dataset.yardRange;
    if (!Object.hasOwn(durations, selected)) return;
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
      if (latestHistory && graph.clientWidth > 0 && width !== renderedWidth) drawHistory();
    }).observe(graph);
  }
  void begin();
})();
