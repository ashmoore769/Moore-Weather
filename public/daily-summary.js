(function () {
  'use strict';
  // MEM 1 is a completed 9 AM–9 AM weather day. Use UTC only as calendar
  // arithmetic here so the visitor's timezone cannot change its reporting day.
  function parseSummary(csv) {
    const fields = csv.trim().split(',');
    if (fields.length !== 43) throw new Error('The station summary is incomplete. Please try again shortly.');
    const [date, time, ...raw] = fields;
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date) || time !== '09:00:00') throw new Error('The station summary has an unexpected reporting time.');
    const [year, month, day] = date.split('/').map(Number);
    const end = Date.UTC(year, month - 1, day);
    if (new Date(end).toISOString().slice(0,10) !== date.replaceAll('/','-')) throw new Error('The station summary has an invalid date.');
    const values = raw.map(value => value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
    // Preserve stored values. The presentation floor matches Current and history.
    for (const index of [15,37]) if (values[index] !== null) values[index] = Math.max(0, values[index]);
    return { values, start: end - 86400000, end, reportingDate: new Date(end - 86400000).toISOString().slice(0,10) };
  }
  const format = (value, precision = 1) => value === null || !Number.isFinite(value) ? '—' : value.toFixed(precision);
  const direction = value => value === null ? '—' : ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(((value % 360 + 360) % 360) / 22.5) % 16];
  // Shift into Brisbane's 9 AM weather day, then select the completed day.
  const expectedReportingDate = (now = Date.now()) => new Date(now + 3600000 - 86400000).toISOString().slice(0,10);
  const cacheDate = value => typeof value === 'string' ? value.replaceAll('/','-') : null;
  if (typeof module !== 'undefined' && module.exports) { module.exports = { parseSummary, format, direction, expectedReportingDate }; return; }
  const $ = id => document.getElementById(id);
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  let summary, loading = false, statusPayload, statusFailed = false;
  const dateLabel = new Intl.DateTimeFormat('en-AU', { timeZone:'UTC', weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const shortDate = new Intl.DateTimeFormat('en-AU', { timeZone:'UTC', day:'numeric', month:'short', year:'numeric' });
  function temperatureColor(value) {
    if (value === null) return 'var(--text)';
    if (value < 6) return 'var(--daily-very-cold)';
    if (value < 16) return 'var(--daily-cold)';
    if (value < 28) return 'var(--daily-mild)';
    if (value < 36) return 'var(--daily-warmer)';
    return 'var(--daily-extreme-hot)';
  }
  function paintTemperature(prefix, min, max, avg, noteId, air = false) {
    for (const [suffix, value] of [['Min',min],['Max',max],['Avg',avg]]) {
      set(prefix + suffix, format(value));
      const strong = $(prefix + suffix)?.closest('strong');
      if (strong) strong.style.color = suffix === 'Avg' ? '' : temperatureColor(value);
    }
    let note = min !== null && max !== null ? format(max - min) + '°C range' : 'Daily range';
    if (air && min !== null && min <= 0) note = 'Below freezing';
    else if (air && min !== null && min <= 2) note = 'Frost possible';
    if (air && max !== null && max >= 36) note += ' · Very hot';
    set(noteId, note);
  }
  function render(next) {
    summary = next;
    const v = next.values;
    const fields = { windMax:0, windAvg:1, gustPeak:5, windDir:7, humidityAvg:10, evapTotal:16, dewAvg:17, batteryMin:18, pressureAvg:34, solarAvg:15, solarMax:37 };
    for (const [id,index] of Object.entries(fields)) set(id, format(v[index], id === 'evapTotal' || id === 'batteryMin' ? 2 : 1));
    set('windDirText', direction(v[7]));
    set('rainTotal', format(v[14]) + ' mm');
    set('rainNote', v[14] === null ? '24-hour total' : v[14] < .2 ? 'No measurable rain' : '24-hour total');
    set('gustNote', v[5] === null ? 'Highest gust' : v[5] < 10 ? 'Light gusts' : v[5] < 25 ? 'Breezy at times' : v[5] < 40 ? 'Windy at times' : 'Strong gusts');
    set('humidityDesc', v[10] === null ? 'Unavailable' : v[10] <= 40 ? 'Dry' : v[10] <= 60 ? 'Moderate' : v[10] <= 80 ? 'Humid' : 'Very humid');
    set('batteryNote', v[18] === null ? 'Unavailable' : v[18] < 12 ? 'Low voltage' : v[18] < 12.3 ? 'Monitor charge' : 'Healthy');
    $('batteryMin').style.color = v[18] === null ? '' : v[18] < 12 ? 'var(--red)' : v[18] < 12.3 ? 'var(--amber)' : 'var(--green)';
    paintTemperature('temp', v[12], v[11], v[13], 'frostNote', true);
    paintTemperature('globe', v[40], v[39], v[38], 'globeNote');
    paintTemperature('dirt', v[33], v[32], v[31], 'dirtNote');
    [10,20,30,40].forEach((depth,i) => {
      set('soilTemp' + depth, format(v[23+i]));
      set('soilMoisture' + depth, format(v[27+i]));
    });
    set('summaryForDay', dateLabel.format(next.start));
    set('summaryPeriod', `9 AM ${shortDate.format(next.start)} → 9 AM ${shortDate.format(next.end)} · AEST`);
    $('errorMessage').style.display = 'none';
    paintStatus();
  }
  function paintStatus() {
    const p = statusPayload;
    let badge = 'CHECKING', detail = 'Reading status', style = 'fetching';
    if (statusFailed) { badge = 'OFFLINE'; detail = summary ? 'Showing saved summary' : 'Status unavailable'; style = 'error'; }
    else if (p?.dailyRefreshInProgress || p?.dailyStationRequestInProgress) { badge = 'UPDATING'; detail = 'Checking station'; }
    else if (p && summary?.reportingDate === expectedReportingDate()) { badge = 'CURRENT'; detail = 'Latest complete day'; style = 'connected'; }
    else if (summary) { badge = 'STORED'; detail = 'Earlier weather day'; }
    else if (p) { badge = 'WAITING'; detail = 'Summary not available'; }
    set('dailyStatusBadge', '● ' + badge); $('dailyStatusBadge').className = 'status-badge ' + style;
    set('dailyStatusText', detail);
    const busy = loading || Boolean(p?.dailyRefreshInProgress || p?.dailyStationRequestInProgress);
    $('stationRefreshBtn').disabled = busy;
    $('stationRefreshBtn').setAttribute('aria-busy', String(busy));
  }
  async function loadSummary(manual = false) {
    if (loading) return;
    loading = true; paintStatus();
    $('spinnerContainer').style.display = 'block';
    if (manual) set('refreshFeedback', 'Requesting the latest completed day…');
    try {
      const response = await fetch(manual ? '/daily?force=1&manual=1' : '/daily', { cache:'no-store', signal:AbortSignal.timeout(20000) });
      if (response.status === 401) { location.assign('/login'); return; }
      if (!response.ok) throw new Error('The daily summary is temporarily unavailable.');
      render(parseSummary(await response.text()));
      if (manual) set('refreshFeedback', 'Station checked. The latest available summary is shown.');
    } catch (error) {
      if (!summary) set('summaryForDay', 'Daily summary');
      set('errorMessage', `${summary ? 'Your saved summary is still shown. ' : ''}${error.name === 'TimeoutError' ? 'The station request timed out.' : error.message}`);
      $('errorMessage').style.display = 'block';
      if (manual) set('refreshFeedback', 'Update unavailable. Please try again shortly.');
    } finally {
      loading = false; $('spinnerContainer').style.display = 'none'; paintStatus();
    }
  }
  async function refreshStatus() {
    try {
      const response = await fetch('/ping', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      if (response.status === 401) { location.assign('/login'); return; }
      if (!response.ok) throw new Error('Status unavailable');
      statusPayload = await response.json(); statusFailed = false;
      // Read the server cache when a new completed day arrives. Never force the
      // logger automatically; collection remains the server's responsibility.
      if (statusPayload.dailyUpToDate && summary?.reportingDate !== cacheDate(statusPayload.dailySummaryDate)) await loadSummary();
    } catch { statusFailed = true; }
    paintStatus();
  }
  $('stationRefreshBtn').addEventListener('click', async () => { await loadSummary(true); await refreshStatus(); });
  loadSummary().then(refreshStatus);
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
})();
