(() => {
  'use strict';
  const dailyPage = location.pathname.endsWith('daily.html');
  const $ = id => document.getElementById(id);
  const colors = { air: '#2c9a8c', globe: '#c18a36', humidity: '#6686c4', pressure: '#468dbb', wind: '#249d9b', gust: '#b78641', direction: '#249d9b', solar: '#c39324', rain: '#438fd0', dew: '#698dc1', evaporation: '#708fae', ground: '#a78454' };
  const color = id => colors[id] || (id.startsWith('soil-moisture') ? '#438fd0' : '#2c9a8c');
  const timeFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dateFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short' });
  const fullDateFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric' });
  const monthFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', month: 'short', year: 'numeric' });
  const longFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const localDate = time => new Date(time + 36000000).toISOString().slice(0, 10);
  const stamp = (time, daily = false) => (daily ? fullDateFormat : longFormat).format(time) + (daily ? ' · 9 AM' : '') + ' AEST';
  const fmt = (value, metric) => value === null || value === undefined ? '—' : Number(value).toFixed(metric.precision);
  const svgNode = (name, attrs = {}, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const bindings = dailyPage ? [
    ['tempAvg', 'air'], ['globeAvg', 'globe'], ['humidityAvg', 'humidity'], ['pressureAvg', 'pressure'], ['gustPeak', 'gust'],
    ['windDir', 'direction'], ['solarAvg', 'solar'], ['rainTotal', 'rain'], ['dewAvg', 'dew'], ['evapTotal', 'evaporation-total'], ['batteryMin', 'battery'], ['dirtAvg', 'ground'], ...[10, 20, 30, 40].flatMap(depth => [[`soilTemp${depth}`, `soil-temp-${depth}`], [`soilMoisture${depth}`, `soil-moisture-${depth}`]])
  ] : [
    ['tempVal', 'air'], ['blackGlobeTempVal', 'globe'], ['humidityVal', 'humidity'], ['pressureVal', 'pressure'], ['windSpeedVal', 'wind'],
    ['windDirDegVal', 'direction'], ['solarRadVal', 'solar'], ['rainSince9Val', 'rain'], ['dewPointVal', 'dew'], ['evapRateVal', 'evaporation'],
    ['gardenBedTempVal', 'ground'], ['batteryVal', 'battery'], ['loadVal', 'load'], ['solarPanelVal', 'panel'], ['chargeVal', 'charge'],
    ...[10, 20, 30, 40].flatMap(depth => [[`soilTemp${depth}Val`, `soil-temp-${depth}`], [`moisture${depth}Val`, `soil-moisture-${depth}`]])
  ];
  let catalog = [], trendData, loadingTrends = false, modalRequest, selection, activeSeries, activeIndex = -1, chartGeometry;
  let resetView, loadedSeries, navigationTimer, previewFrame, gesture, pendingWindow, wheelWindow;
  const pointers = new Map();
  const cards = [];
  const guideText = $('historyHint'), browse = $('browseHistory');
  browse.addEventListener('click', () => openHistory('air'));
  for (const [elementId, metric] of bindings) {
    const value = $(elementId);
    const card = value?.closest('.temp-hero, .quick-stat, .soil-reading-value, .soil-surface-temperature, .metric-row, .daily-reading-card, .rain-hero, .soil-depth-reading');
    if (!card) continue;
    card.classList.add('history-card'); card.tabIndex = 0; card.setAttribute('role', 'button');
    card.setAttribute('aria-describedby', elementId);
    card.setAttribute('aria-haspopup', 'dialog'); card.setAttribute('aria-label', 'View history: ' + metric.replaceAll('-', ' '));
    card.style.setProperty('--history-color', color(metric));
    const spark = document.createElement('span'); spark.className = 'history-spark'; spark.setAttribute('aria-hidden', 'true');
    spark.innerHTML = '<svg viewBox="0 0 260 40" preserveAspectRatio="none"></svg><span class="history-spark-caption"><span>Loading history…</span><span class="history-arrow">↗</span></span>';
    card.append(spark);
    card.addEventListener('click', () => openHistory(metric));
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openHistory(metric); } });
    cards.push({ card, spark, metric });
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'history-dialog'; dialog.setAttribute('aria-labelledby', 'historyTitle');
  dialog.innerHTML = `
    <div class="history-header"><div class="history-brand"><strong>Moore Weather</strong><span>Station history</span></div><button type="button" class="history-close" aria-label="Close history"><span>Close</span><span aria-hidden="true">×</span></button></div>
    <div class="history-scroll">
    <div class="history-heading"><h2 id="historyTitle">Weather history</h2><p id="historySubtitle">West Warwick · all times AEST</p></div>
    <div class="history-controls">
      <label>Measurement<select id="historyMetric" aria-label="Measurement"></select></label>
      <label>Time span<select id="historyRange" aria-label="Time span"></select></label>
      <label>End date · AEST<input id="historyEnd" aria-label="End date in AEST" type="date" min="2025-06-12"></label>
      <button class="history-latest" type="button" id="historyLatest">Latest readings</button>
    </div>
    <div class="history-resolution-row"><div class="history-resolutions" role="group" aria-label="Graph resolution">
      <button type="button" data-resolution="10m" aria-pressed="true">10 minute</button><button type="button" data-resolution="hourly" aria-pressed="false">Hourly</button><button type="button" data-resolution="daily" aria-pressed="false">Daily</button>
    </div><span class="history-period" id="historyPeriod"></span></div>
    <div class="history-trend-control"><label><input type="checkbox" id="historyTrend"> Fitted trend line</label><span id="historyTrendStatus" role="status"></span></div>
    <div class="history-navigation" role="group" aria-label="Explore graph">
      <button type="button" id="historyEarlier" aria-label="Pan to earlier readings">Earlier</button>
      <button type="button" id="historyZoomIn" aria-label="Zoom in">+</button>
      <button type="button" id="historyZoomOut" aria-label="Zoom out">−</button>
      <button type="button" id="historyLater" aria-label="Pan to later readings">Later</button>
      <button type="button" id="historyReset">Reset view</button>
      <span id="historyNavigationHint">Drag to pan · scroll or pinch to zoom</span>
    </div>
    <div class="history-body" data-state="loading" aria-busy="true">
      <div class="history-summary" id="historySummary"></div>
      <div class="history-chart" id="historyChart" tabindex="0" role="group" aria-label="Weather history chart. Arrow keys inspect readings. Shift plus arrow keys pan. Plus and minus zoom. Zero resets the view." aria-describedby="historyNavigationHint"><svg aria-hidden="true"></svg><div class="history-chart-message" id="historyMessage" role="status">Loading history…</div></div>
      <div class="history-inspect" id="historyInspect" aria-live="polite">Point to the chart or use the arrow keys to inspect a reading.</div>
      <div class="history-legend" id="historyLegend"></div><p class="history-note" id="historyNote"></p>
      <details class="history-table" id="historyTable"><summary>View readings as a table</summary><div class="history-table-scroll"></div></details>
    </div></div>`;
  document.body.append(dialog);
  const historyBody = dialog.querySelector('.history-body');
  function holdDialogSize() {
    if (!dialog.open || dialog.style.height) return;
    const height = dialog.getBoundingClientRect().height;
    if (height) dialog.style.height = Math.ceil(height) + 'px';
  }
  function setHistoryState(state) {
    historyBody.dataset.state = state;
    historyBody.setAttribute('aria-busy', String(state === 'loading'));
    $('historyChart').setAttribute('aria-busy', String(state === 'loading'));
  }
  const close = () => dialog.close();
  dialog.querySelector('.history-close').addEventListener('click', close);
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } });
  dialog.addEventListener('close', () => { cancelNavigation(); modalRequest?.abort(); activeSeries = loadedSeries = null; chartGeometry = null; dialog.style.removeProperty('height'); });
  window.addEventListener('resize', () => {
    if (dialog.open && historyBody.dataset.state === 'ready') {
      dialog.style.removeProperty('height'); holdDialogSize();
    }
  });

  async function getJson(url, signal) {
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (response.status === 401) throw new Error('Your session has expired. Sign in again to view history.');
    if (!response.ok) throw new Error('History is temporarily unavailable. Please try again shortly.');
    return response.json();
  }
  function setCatalog(data) {
    if (JSON.stringify(catalog) === JSON.stringify(data.catalog)) return;
    catalog = data.catalog;
    const selected = $('historyMetric').value;
    $('historyMetric').replaceChildren(...catalog.map(m => new Option(m.label, m.id)));
    if (selected) $('historyMetric').value = selected;
    for (const entry of cards) {
      const metric = catalog.find(m => m.id === entry.metric);
      if (metric) entry.card.setAttribute('aria-label', `View ${metric.label.toLowerCase()} history`);
    }
  }
  async function refreshTrends() {
    if (loadingTrends) return;
    loadingTrends = true;
    try {
      trendData = await getJson('/api/trends?view=' + (dailyPage ? 'daily' : 'current'), AbortSignal.timeout(20000));
      setCatalog(trendData);
      for (const entry of cards) drawSpark(entry, trendData.series.find(s => s.metric.id === entry.metric));
      guideText.textContent = dailyPage ? '30-day trends' : '5-hour trends';
      guideText.removeAttribute('title');
    } catch (error) {
      guideText.textContent = 'History unavailable'; guideText.title = error.message;
      for (const { spark } of cards) { spark.querySelector('svg').replaceChildren(); spark.querySelector('.history-spark-caption span').textContent = 'History unavailable'; }
    } finally { loadingTrends = false; }
  }
  function paths(svg, series, x, y, baseline, mini = false) {
    const stroke = mini ? 'currentColor' : color(series.metric.id);
    const segments = WeatherChart.segments(series.points, series.metric.kind === 'direction');
    if (series.metric.kind === 'bar') {
      const width = Math.max(1, (x(series.start + series.intervalSeconds * 1000) - x(series.start)) * .65);
      for (const p of series.points.filter(p => p.value !== null)) svg.append(svgNode('rect', { x: x(p.t) - width / 2, y: Math.min(y(p.value), y(0)), width, height: Math.max(1, Math.abs(y(p.value) - y(0))), rx: Math.min(2, width / 3), fill: stroke, opacity: p.estimated ? .45 : .8 }));
      return;
    }
    for (const segment of segments) {
      const d = segment.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');
      if (series.metric.kind !== 'direction' && segment.length > 1) svg.append(svgNode('path', { d: `${d} L${x(segment.at(-1).t)},${baseline} L${x(segment[0].t)},${baseline} Z`, fill: stroke, opacity: .055 }));
      // Draw actual min/max envelopes only where both statistics are available.
      const bands = WeatherChart.segments(segment.map(p => ({ ...p, value: p.min !== null && p.max !== null ? p.value : null })));
      for (const band of bands) if (band.length > 1) svg.append(svgNode('path', { d: band.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.max)}`).join(' ') + ' ' + [...band].reverse().map(p => `L${x(p.t)},${y(p.min)}`).join(' ') + ' Z', fill: stroke, opacity: .15 }));
      svg.append(svgNode('path', { d, fill: 'none', stroke, 'stroke-width': mini ? 1.8 : 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
      const maximums = WeatherChart.segments(segment.map(p => ({ ...p, value: p.min === null ? p.max : null })));
      for (const upper of maximums) if (upper.length > 1) svg.append(svgNode('path', { d: upper.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.value)}`).join(' '), fill: 'none', stroke, opacity: .6, 'stroke-width': 1.3, 'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke' }));
      for (const p of segment) if (p.estimated || segment.length === 1) svg.append(svgNode('circle', { cx: x(p.t), cy: y(p.value), r: p.estimated ? 3.3 : 2, fill: p.estimated ? 'var(--surface)' : stroke, stroke, 'stroke-width': 1.5 }));
    }
    const latest = series.latest;
    if (mini && latest) svg.append(svgNode('circle', { cx: x(latest.t), cy: y(latest.value), r: 2.5, fill: stroke }));
  }
  function drawSpark({ spark }, series) {
    const svg = spark.querySelector('svg'), caption = spark.querySelector('.history-spark-caption span');
    svg.replaceChildren();
    if (!series?.latest) { caption.textContent = 'No readings in this window'; return; }
    const [min, max] = WeatherChart.domain(series);
    const x = t => 3 + (t - series.start) / (series.end - series.start) * 254;
    const y = v => 36 - (v - min) / (max - min) * 32;
    svg.append(svgNode('line', { x1: 0, x2: 260, y1: 38, y2: 38, stroke: 'currentColor', opacity: .12 }));
    paths(svg, series, x, y, 38, true);
    const stale = series.end - series.latest.t > series.intervalSeconds * 2000;
    caption.textContent = stale ? 'Last ' + timeFormat.format(series.latest.t) + ' · gaps' : series.resolution === 'daily' ? '30 days · daily' : series.resolution === 'hourly' ? '5 hours · hourly' : series.metric.id === 'rain' ? '5 hours · 10-min totals' : '5 hours · 10 min';
  }
  const ranges = { '10m': [[5, 'Last 5 hours'], [24, '24 hours'], [48, '2 days'], [168, '7 days']], hourly: [[5, 'Last 5 hours'], [24, '24 hours'], [168, '7 days'], [720, '30 days']], daily: [[168, '7 days'], [720, '30 days'], [2160, '90 days'], [8760, '1 year'], [17520, '2 years']] };
  function configure() {
    const metric = catalog.find(m => m.id === selection.metric);
    if (!metric) return;
    if (!metric.resolutions.includes(selection.resolution)) selection.resolution = metric.resolutions[0];
    const options = ranges[selection.resolution];
    if (!selection.custom && !options.some(([hours]) => hours === selection.hours)) selection.hours = selection.resolution === 'daily' ? 720 : 24;
    $('historyMetric').value = metric.id;
    $('historyTitle').textContent = metric.label;
    $('historyRange').replaceChildren(...options.map(([hours, text]) => new Option(text, String(hours))));
    if (selection.custom) { const custom = new Option('Custom view', 'custom'); custom.disabled = true; $('historyRange').append(custom); }
    $('historyRange').value = selection.custom ? 'custom' : String(selection.hours);
    $('historyEnd').max = localDate(Date.now());
    $('historyEnd').value = selection.custom ? localDate(selection.end) : selection.endDate || localDate(Date.now());
    $('historyReset').disabled = !selection.custom;
    for (const button of dialog.querySelectorAll('[data-resolution]')) {
      button.disabled = !metric.resolutions.includes(button.dataset.resolution);
      button.setAttribute('aria-pressed', String(button.dataset.resolution === selection.resolution));
      button.title = button.disabled ? 'The station does not record this measurement at this resolution' : '';
    }
    try { $('historyTrend').checked = localStorage.getItem('mooreWeatherTrend:'+metric.id) === 'true'; } catch { $('historyTrend').checked = false; }
    dialog.style.setProperty('--history-color', color(metric.id));
  }
  async function openHistory(metric) {
    cancelNavigation(); resetView = null;
    setHistoryState('loading');
    selection = { metric, resolution: dailyPage ? 'daily' : '10m', hours: dailyPage ? 720 : 24, endDate: null };
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.history-scroll').scrollTop = 0;
    $('historyMessage').hidden = false; $('historyMessage').textContent = 'Loading history…';
    if (!catalog.length) {
      try { const data = await getJson('/api/trends?view=current', AbortSignal.timeout(20000)); setCatalog(data); }
      catch (error) { showError(error); return; }
    }
    if (!dialog.open) return;
    configure(); loadHistory();
  }
  function showError(error) {
    setHistoryState('error');
    const message = $('historyMessage'); message.replaceChildren(document.createTextNode(error.message)); message.hidden = false;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again'; retry.addEventListener('click', () => catalog.length ? loadHistory() : openHistory(selection.metric)); message.append(retry);
  }
  async function loadHistory() {
    cancelNavigation();
    modalRequest?.abort(); modalRequest = new AbortController();
    const signal = modalRequest.signal;
    activeSeries = loadedSeries = null; activeIndex = -1; chartGeometry = null;
    setHistoryState('loading');
    for (const id of ['historyEarlier', 'historyLater', 'historyZoomIn', 'historyZoomOut']) $(id).disabled = true;
    // Keep every section in layout while fetching. CSS hides stale readings;
    // the previous plot remains behind the loading overlay, without collapsing
    // the summary, footer, open table or the user's scroll position.
    $('historyMessage').hidden = false; $('historyMessage').textContent = 'Loading history…';
    const params = new URLSearchParams({ metric: selection.metric, resolution: selection.resolution, hours: String(selection.hours) });
    if (selection.end !== undefined) params.set('end', new Date(selection.end).toISOString());
    else if (selection.endDate) params.set('end', new Date(selection.endDate + 'T23:59:59.999+10:00').toISOString());
    try {
      const data = await getJson('/api/history?' + params, AbortSignal.any([signal, AbortSignal.timeout(20000)]));
      if (signal.aborted || !dialog.open) return;
      activeSeries = loadedSeries = data.series[0];
      if (!selection.custom) resetView = { ...selection, end: activeSeries.end };
      setHistoryState('ready');
      for (const id of ['historyEarlier', 'historyLater', 'historyZoomIn', 'historyZoomOut']) $(id).disabled = false;
      renderHistory();
    } catch (error) { if (!signal.aborted && dialog.open) showError(error); }
  }
  function presetChange() { selection.custom = false; delete selection.end; configure(); loadHistory(); }
  $('historyMetric').addEventListener('change', () => {
    selection.metric = $('historyMetric').value;
    const supported = catalog.find(m => m.id === selection.metric).resolutions;
    if (selection.custom) Object.assign(selection, WeatherChart.navigationWindow(selection.end - selection.hours * 3600000, selection.end, supported));
    configure(); loadHistory();
  });
  $('historyRange').addEventListener('change', () => { selection.hours = Number($('historyRange').value); selection.endDate = null; presetChange(); });
  $('historyEnd').addEventListener('change', () => { if ($('historyEnd').value && $('historyEnd').checkValidity()) { selection.endDate = $('historyEnd').value; presetChange(); } });
  $('historyLatest').addEventListener('click', () => { selection.endDate = null; presetChange(); });
  for (const button of dialog.querySelectorAll('[data-resolution]')) button.addEventListener('click', () => { selection.resolution = button.dataset.resolution; selection.hours = selection.resolution === 'daily' ? 720 : selection.resolution === 'hourly' ? 168 : 24; presetChange(); });

  $('historyTrend').addEventListener('change', () => {
    try { localStorage.setItem('mooreWeatherTrend:'+selection.metric, String($('historyTrend').checked)); } catch {}
    if(activeSeries) renderHistory();
  });

  function renderPeriod(s) {
    $('historyPeriod').textContent = `${selection.custom ? 'Custom view · ' : ''}${longFormat.format(s.start)} — ${longFormat.format(s.end)} AEST`;
  }
  function renderHistory() {
    const s = activeSeries, m = s.metric, valid = s.points.filter(p => p.value !== null);
    renderPeriod(s);
    const period = { '10m': '10-minute', hourly: 'Hourly', daily: 'Daily' }[s.resolution];
    const aggregation = { AVERAGE: 'averages', AVGDIR: 'average directions', TOTAL: 'totals', MINIMUM: 'minimums', MAXIMUM: 'maximums', CURRENT: 'end-of-hour readings' }[m.aggregation];
    $('historySubtitle').textContent = `${period} ${aggregation} · ${s.resolution === 'daily' ? '24 hours ending at 9 AM AEST' : 'times shown are the end of each recording period'}`;
    const summary = $('historySummary');
    const items = WeatherChart.summary(s);
    summary.classList.toggle('history-summary-rain', m.id === 'rain');
    summary.replaceChildren(...items.map(([label, value, unit, recording]) => {
      const box = document.createElement('div'), title = document.createElement('span'), number = document.createElement('strong'), suffix = document.createElement('small');
      title.className = 'history-summary-label'; title.textContent = label;
      number.textContent = unit === '' ? value : fmt(value, m); suffix.textContent = unit ?? m.unit;
      number.append(suffix); box.append(title, number);
      if (recording) {
        const detail = document.createElement('span'), caption = document.createElement('span'), when = document.createElement('time');
        detail.className = 'history-summary-time';
        caption.textContent = (recording.estimated ? 'Estimated · ' : '') + ({ '10m': '10 min ending', hourly: 'Hour ending', daily: 'Day ending' }[s.resolution]);
        when.dateTime = new Date(recording.t).toISOString();
        const date = document.createElement('span'), time = document.createElement('span');
        date.textContent = fullDateFormat.format(recording.t); time.textContent = timeFormat.format(recording.t) + ' AEST';
        when.append(date, time); detail.append(caption, when);
        detail.title = 'Recording period: ' + stamp(recording.t - s.intervalSeconds * 1000) + ' to ' + stamp(recording.t) + '. Exact occurrence time is not stored. If tied, the earliest period is shown.';
        box.append(detail);
      }
      return box;
    }));
    const legend = $('historyLegend'); legend.replaceChildren();
    for (const [label, cls] of [[aggregation, 'history-key'], ...(valid.some(p => p.min !== null && p.max !== null) ? [['Recorded low–high range', 'history-key history-key-band']] : []), ...(valid.some(p => p.min === null && p.max !== null) ? [['Recorded maximum · dashed', 'history-key history-key-max']] : [])]) {
      const key = document.createElement('span'); key.className = cls; key.textContent = label; legend.append(key);
    }
    const availability = document.createElement('span'); availability.textContent = `${valid.length} readings · ${s.missing} missing readings`; legend.append(availability);
    const notes = ['Missing or screened readings remain gaps.'];
    if (items.some(item => item[3])) notes.push('Dates beneath temperature extremes identify the recording period; exact occurrence times are not stored.');
    if (valid.some(p => p.estimated)) notes.push('Hollow markers identify interpolated records.');
    if (m.id === 'pressure') notes.push('Recorded station pressure is shown. The live card currently applies a separate −1.9 hPa display correction.');
    if (m.id === 'rain') {
      notes.push(`Each bar is a ${s.resolution === '10m' ? '10-minute' : s.resolution === 'hourly' ? 'one-hour' : '24-hour'} rainfall total. The summary adds recorded bars in the displayed range.`);
      if (s.points.length) notes.push(`Rainfall recording periods: ${stamp(s.points[0].t - s.intervalSeconds * 1000)} to ${stamp(s.points.at(-1).t)}.`);
      if (s.missing || valid.some(p => p.estimated)) notes.push('Incomplete rainfall record: missing, screened and interpolated readings are excluded from the total, not treated as zero.');
    }
    if (m.id === 'panel') notes.push('Recorded panel voltage is shown, including readings below battery voltage.');
    if (m.id === 'solar') notes.push('Small negative sensor readings are shown as zero.');
    if (m.id === 'battery') notes.push('These are recorded minimum voltages; the live card shows the current voltage.');
    if (s.latest && s.end - s.latest.t > s.intervalSeconds * 2000) notes.push('Latest available reading: ' + stamp(s.latest.t, s.resolution === 'daily') + '.');
    const fitted = WeatherChart.fittedTrend(s);
    $('historyTrendStatus').textContent = $('historyTrend').checked && !fitted.some(p=>p.value!==null) ? (m.kind==='direction' && valid.filter(p=>!p.estimated).length>=3 ? 'No clear direction trend in this window.' : 'At least three usable readings are needed.') : '';
    if ($('historyTrend').checked && fitted.some(p=>p.value!==null)) {
      const key=document.createElement('span'); key.className='history-key history-key-trend'; key.textContent='Fitted trend'; legend.append(key);
      notes.push(m.kind==='direction' ? 'The trend fits wind direction as compass vectors; opposing directions can leave gaps.' : 'The dashed trend is a straight-line fit across this time window, not a forecast.');
      if(valid.some(p=>p.estimated)) notes.push('Interpolated readings are excluded from the fit.');
    }
    $('historyNote').textContent = notes.join(' ');
    $('historyMessage').hidden = Boolean(valid.length);
    if (!valid.length) $('historyMessage').textContent = 'No recorded readings in this window. Try an earlier end date or a wider time span.';
    if (activeIndex < 0) $('historyInspect').textContent = 'Point to the chart or use the arrow keys to inspect a reading.';
    drawChart();
    renderTable();
    holdDialogSize();
  }
  function drawChart() {
    if (!activeSeries || !dialog.open) return;
    const s = activeSeries, container = $('historyChart'), svg = container.querySelector('svg');
    const width = container.clientWidth, height = container.clientHeight;
    if (!width) return;
    const left = 51, right = width - 12, top = 14, bottom = height - 35;
    const [min, max] = WeatherChart.domain(s);
    const x = t => left + (t - s.start) / (s.end - s.start) * (right - left);
    const y = v => bottom - (v - min) / (max - min) * (bottom - top);
    chartGeometry = { left, right, top, bottom, x, y };
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.replaceChildren();
    for (let i = 0; i < 5; i++) {
      const value = min + (max - min) * i / 4, py = y(value);
      svg.append(svgNode('line', { x1: left, x2: right, y1: py, y2: py, stroke: 'var(--border)', 'stroke-dasharray': i ? '3 5' : '' }));
      const label = s.metric.kind === 'direction' ? ['N', 'E', 'S', 'W', 'N'][i] : value.toFixed(Math.min(s.metric.precision, max - min > 30 ? 0 : s.metric.precision));
      svg.append(svgNode('text', { x: left - 9, y: py + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 }, label));
    }
    const ticks = width < 450 ? 3 : 5;
    for (let i = 0; i < ticks; i++) {
      const t = s.start + (s.end - s.start) * i / (ticks - 1);
      svg.append(svgNode('text', { x: x(t), y: height - 10, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle', fill: 'var(--muted)', 'font-size': 11 }, (s.end - s.start <= 86400000 ? timeFormat : s.end - s.start > 200 * 86400000 ? monthFormat : dateFormat).format(t)));
    }
    const plotClip = svgNode('clipPath', { id: 'historyDataClip' });
    plotClip.append(svgNode('rect', { x: left, y: top, width: right - left, height: bottom - top })); svg.append(plotClip);
    const plot = svgNode('g', { 'clip-path': 'url(#historyDataClip)' });
    paths(plot, s, x, y, bottom); svg.append(plot);
    if ($('historyTrend').checked) {
      const clip=svgNode('clipPath',{id:'historyPlotClip'});
      clip.append(svgNode('rect',{x:left,y:top,width:right-left,height:bottom-top})); svg.append(clip);
      const group=svgNode('g',{'clip-path':'url(#historyPlotClip)',class:'history-fitted-trend'});
      for(const segment of WeatherChart.segments(WeatherChart.fittedTrend(s),s.metric.kind==='direction')) if(segment.length>1) {
        group.append(svgNode('path',{d:segment.map((p,i)=>(i?'L':'M')+x(p.t)+','+y(p.value)).join(' '),fill:'none',stroke:'var(--text)','stroke-width':2,'stroke-dasharray':'8 5','vector-effect':'non-scaling-stroke'}));
      }
      svg.append(group);
    }
    const cursor = svgNode('g', { id: 'historyCursor', visibility: 'hidden' });
    cursor.append(svgNode('line', { y1: top, y2: bottom, stroke: 'var(--muted)', 'stroke-dasharray': '3 3' }), svgNode('circle', { r: 4, fill: 'var(--surface)', stroke: color(s.metric.id), 'stroke-width': 2 })); svg.append(cursor);
    if (activeIndex >= 0) inspect(activeIndex);
  }
  function inspect(index) {
    if (!activeSeries?.points.length || !chartGeometry) return;
    activeIndex = Math.max(0, Math.min(activeSeries.points.length - 1, index));
    const s = activeSeries, p = s.points[activeIndex], m = s.metric, { x, y } = chartGeometry;
    const cursor = $('historyCursor'); if (!cursor) return;
    cursor.setAttribute('visibility', 'visible');
    const line = cursor.querySelector('line'); line.setAttribute('x1', x(p.t)); line.setAttribute('x2', x(p.t));
    const circle = cursor.querySelector('circle'); circle.setAttribute('visibility', p.value === null ? 'hidden' : 'visible'); circle.setAttribute('cx', x(p.t)); circle.setAttribute('cy', p.value === null ? 0 : y(p.value));
    const output = $('historyInspect'); output.replaceChildren();
    const when = document.createElement('span'); when.textContent = stamp(p.t, s.resolution === 'daily');
    const value = document.createElement('strong'); value.textContent = p.value === null ? 'No valid reading' : fmt(p.value, m) + ' ' + m.unit;
    const detail = document.createElement('span'); detail.textContent = [p.min !== null && p.max !== null ? `${fmt(p.min, m)}–${fmt(p.max, m)} ${m.unit} range` : p.max !== null ? `Maximum ${fmt(p.max, m)} ${m.unit}` : '', p.estimated && p.value !== null ? 'Interpolated' : '', p.adjusted ? 'Zero floor applied' : ''].filter(Boolean).join(' · ');
    output.append(when, value, detail);
  }
  const chart = $('historyChart');
  function cancelNavigation() {
    clearTimeout(navigationTimer); cancelAnimationFrame(previewFrame);
    gesture = pendingWindow = wheelWindow = null; pointers.clear();
    $('historyChart').classList.remove('is-dragging');
    $('historyNavigationHint').textContent = 'Drag to pan · scroll or pinch to zoom';
  }
  function plotFraction(clientX) {
    const rect = chart.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left - chartGeometry.left) / (chartGeometry.right - chartGeometry.left)));
  }
  function previewWindow(start, end, preferred) {
    if (!loadedSeries) return;
    const metric = catalog.find(m => m.id === selection.metric);
    const target = WeatherChart.navigationWindow(start, end, metric.resolutions, Date.now(), preferred);
    if (target.start === activeSeries.start && target.end === activeSeries.end && target.resolution === selection.resolution) return;
    pendingWindow = target;
    Object.assign(selection, target, { custom: true });
    activeSeries = WeatherChart.visibleSeries(loadedSeries, target.start, target.end); activeIndex = -1;
    configure();
    $('historyNavigationHint').textContent = 'Release to load this view';
    cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(() => {
      renderPeriod(activeSeries);
      drawChart();
      // The new window may extend beyond loaded data. Never present its partial
      // preview as a complete total while the gesture is still in progress.
      setHistoryState('preview');
      $('historyMessage').hidden = true;
    });
  }
  function commitNavigation() {
    wheelWindow = null;
    if (!pendingWindow) return;
    loadHistory();
  }
  function zoom(factor, fraction = .5) {
    if (!activeSeries) return;
    const s = pendingWindow || activeSeries, span = s.end - s.start;
    const anchor = s.start + span * fraction, nextSpan = span * factor;
    previewWindow(anchor - nextSpan * fraction, anchor + nextSpan * (1 - fraction));
  }
  function pan(fraction) {
    if (!activeSeries) return;
    const s = pendingWindow || activeSeries, shift = (s.end - s.start) * fraction;
    previewWindow(s.start + shift, s.end + shift, selection.resolution); commitNavigation();
  }
  function resetNavigation() {
    if (!resetView) return;
    selection = { ...resetView, metric: selection.metric, custom: false };
    configure(); loadHistory();
  }
  $('historyEarlier').addEventListener('click', () => pan(-.5));
  $('historyLater').addEventListener('click', () => pan(.5));
  $('historyZoomIn').addEventListener('click', () => { zoom(.5); commitNavigation(); });
  $('historyZoomOut').addEventListener('click', () => { zoom(2); commitNavigation(); });
  $('historyReset').addEventListener('click', resetNavigation);
  function startGesture() {
    const contacts = [...pointers.values()], s = pendingWindow || activeSeries;
    gesture = { start: s.start, end: s.end, resolution: selection.resolution,
      x: contacts[0].x, distance: contacts.length > 1 ? Math.max(1, Math.hypot(contacts[1].x - contacts[0].x, contacts[1].y - contacts[0].y)) : null,
      fraction: plotFraction(contacts.length > 1 ? (contacts[0].x + contacts[1].x) / 2 : contacts[0].x), moved: false };
  }
  chart.addEventListener('pointerdown', event => {
    if (!activeSeries || !chartGeometry || event.button !== 0 || event.target.closest('button')) return;
    clearTimeout(navigationTimer); wheelWindow = null;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); chart.setPointerCapture(event.pointerId);
    chart.focus({ preventScroll: true }); startGesture();
  });
  chart.addEventListener('pointermove', event => {
    if (!activeSeries || !chartGeometry) return;
    if (pointers.has(event.pointerId) && gesture) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const contacts = [...pointers.values()], span = gesture.end - gesture.start;
      if (contacts.length > 1 && gesture.distance) {
        const distance = Math.max(1, Math.hypot(contacts[1].x - contacts[0].x, contacts[1].y - contacts[0].y));
        const nextSpan = span * gesture.distance / distance;
        const fraction = plotFraction((contacts[0].x + contacts[1].x) / 2);
        const anchor = gesture.start + span * gesture.fraction;
        gesture.moved = true;
        previewWindow(anchor - nextSpan * fraction, anchor + nextSpan * (1 - fraction));
      } else {
        const dx = event.clientX - gesture.x;
        if (!gesture.moved && Math.abs(dx) < 5) return;
        gesture.moved = true;
        const shift = -dx / (chartGeometry.right - chartGeometry.left) * span;
        previewWindow(gesture.start + shift, gesture.end + shift, gesture.resolution);
      }
      chart.classList.add('is-dragging'); return;
    }
    if (!pointers.size) {
      const s = activeSeries, t = s.start + plotFraction(event.clientX) * (s.end - s.start);
      inspect(Math.round((t - (s.points[0]?.t || s.start)) / (s.intervalSeconds * 1000)));
    }
  });
  function finishPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    const moved = gesture?.moved;
    pointers.delete(event.pointerId);
    if (pointers.size) { startGesture(); return; }
    gesture = null; chart.classList.remove('is-dragging');
    if (pendingWindow) commitNavigation();
    else if (!moved && activeSeries && chartGeometry) {
      const s = activeSeries, t = s.start + plotFraction(event.clientX) * (s.end - s.start);
      inspect(Math.round((t - (s.points[0]?.t || s.start)) / (s.intervalSeconds * 1000)));
    }
  }
  chart.addEventListener('pointerup', finishPointer);
  chart.addEventListener('pointercancel', finishPointer);
  chart.addEventListener('lostpointercapture', finishPointer);
  chart.addEventListener('wheel', event => {
    if (!activeSeries || !chartGeometry || pointers.size) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chart.clientHeight : 1);
    if (!delta) return;
    // Accumulate small trackpad movements before rounding to supported hours.
    const s = wheelWindow || pendingWindow || activeSeries, fraction = plotFraction(event.clientX);
    const anchor = s.start + (s.end - s.start) * fraction;
    const span = Math.max(3600000, Math.min(17520 * 3600000, (s.end - s.start) * Math.exp(Math.max(-.7, Math.min(.7, delta * .004)))));
    wheelWindow = { start: anchor - span * fraction, end: anchor + span * (1 - fraction) };
    previewWindow(wheelWindow.start, wheelWindow.end);
    clearTimeout(navigationTimer); navigationTimer = setTimeout(commitNavigation, 180);
  }, { passive: false });
  $('historyChart').addEventListener('keydown', event => {
    if (event.key === '0') { event.preventDefault(); resetNavigation(); return; }
    if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoom(event.key === '-' ? 2 : .5); commitNavigation(); return; }
    if (event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); pan(event.key === 'ArrowLeft' ? -.5 : .5); return; }
    if (!activeSeries || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const last = activeSeries.points.length - 1;
    inspect(event.key === 'Home' ? 0 : event.key === 'End' ? last : (activeIndex < 0 ? last : activeIndex) + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  function renderTable() {
    if (!$('historyTable').open || !activeSeries) return;
    const table = document.createElement('table'), head = table.createTHead().insertRow();
    const hasMin = activeSeries.points.some(p => p.value !== null && p.min !== null), hasMax = activeSeries.points.some(p => p.value !== null && p.max !== null);
    for (const text of ['Recording period ending (AEST)', activeSeries.metric.unit, ...(hasMin ? ['Minimum'] : []), ...(hasMax ? ['Maximum'] : []), 'Quality']) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = text; head.append(th); }
    const body = table.createTBody();
    for (const p of activeSeries.points) {
      const row = body.insertRow();
      for (const text of [stamp(p.t, activeSeries.resolution === 'daily'), fmt(p.value, activeSeries.metric), ...(hasMin ? [fmt(p.value === null ? null : p.min, activeSeries.metric)] : []), ...(hasMax ? [fmt(p.value === null ? null : p.max, activeSeries.metric)] : []), p.value === null ? 'Missing / screened' : p.estimated ? 'Interpolated' : p.adjusted ? 'Zero floor applied' : 'Recorded']) row.insertCell().textContent = text;
    }
    $('historyTable').querySelector('.history-table-scroll').replaceChildren(table);
  }
  $('historyTable').addEventListener('toggle', renderTable);
  new ResizeObserver(() => drawChart()).observe($('historyChart'));
  refreshTrends();
  setInterval(() => { if (!document.hidden) refreshTrends(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTrends(); });
})();
