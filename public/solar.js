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
  const POLL_MS = 60000, HISTORY_MS = 300000, PAINT_MS = 15000, REQUEST_TIMEOUT_MS = 10000;
  const DAY_MS = 86400000, OFFSET_MS = 36000000, EMPTY = '–';
  const statuses = new Set(['disabled', 'waiting', 'fresh', 'stale', 'unavailable']);
  const qualities = { complete: 'From midnight', partial: 'Partial day', unavailable: 'Unavailable', reset: 'Counter reset' };
  const observationTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const clockTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const shortDate = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short' });
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const number = (value, digits = 2) => value.toLocaleString('en-AU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 220) : '';
  const dayKey = now => new Date(now + OFFSET_MS).toISOString().slice(0, 10);
  const dateTime = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? Date.parse(date + 'T02:00:00Z') : NaN;
  const dateLabel = date => Number.isFinite(dateTime(date)) ? shortDate.format(dateTime(date)) : EMPTY;
  const energyText = value => numeric(value) === null || value < 0 ? EMPTY : number(value / 1000) + ' kWh';
  const recordedPercent = (value, quality) => numeric(value) === null ? '' : (quality === 'partial' && value >= 99.5 ? '>99' : number(clamp(value, 0, 100), 0)) + '%';
  const money = value => numeric(value) === null ? EMPTY : (value < -0.0049 ? '−$' : '$') + number(Math.abs(value) < .005 ? 0 : Math.abs(value));
  const hourly = value => numeric(value) === null ? EMPTY : value > 0 && value < .005 ? '<$0.01/hr' : money(value) + '/hr';
  function power(value) {
    const reading = numeric(value);
    if (reading === null) return EMPTY;
    if (reading !== 0 && Math.abs(reading) < 100) return number(reading, reading % 1 ? 1 : 0) + ' W';
    return number(reading / 1000) + ' kW';
  }
  function ageText(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  // A fresh grid meter is the authority for spare power. DC panel output is
  // deliberately excluded, and active batteries prevent attribution to solar.
  function liveView(current, rates, fresh) {
    const result = { tone: 'neutral', title: 'No data', label: 'Spare solar', value: null,
      money: EMPTY, coverage: null, homeSource: 'Unavailable' };
    if (!fresh) return { ...result, title: current ? 'Delayed' : 'Connecting', money: current ? 'Last reading retained' : EMPTY };
    const ac = numeric(current?.inverterPowerW), grid = numeric(current?.gridPowerW), load = numeric(current?.loadPowerW);
    const battery = numeric(current?.batteryPowerW);
    const bought = grid === null ? null : Math.max(0, grid), sold = grid === null ? null : Math.max(0, -grid);
    const buyRate = numeric(rates?.importPerKwh), sellRate = numeric(rates?.exportPerKwh);
    const charge = buyRate === null || bought === null ? null : bought / 1000 * buyRate;
    const credit = sellRate === null || sold === null ? null : sold / 1000 * sellRate;
    const flowMoney = bought > 0 ? (charge === null ? 'Import rate unavailable' : 'Grid cost ' + hourly(charge)) : sold > 0
      ? (credit === null ? 'Export rate unavailable' : 'Export credit ' + hourly(credit)) : grid === 0 ? 'No grid exchange' : EMPTY;
    if (ac === null || grid === null || load === null || load < 0 || current?.meterLocation !== 'grid') {
      return { ...result, title: 'Partial data', money: flowMoney };
    }
    const generation = Math.max(0, ac);
    if (battery !== null && battery !== 0) {
      return { ...result, title: 'Battery active', label: grid >= 0 ? 'Grid draw' : 'Grid export', value: Math.abs(grid),
        money: flowMoney, homeSource: 'Solar / grid / battery' };
    }
    const selfUse = Math.min(Math.max(load - bought, 0), load, generation);
    const coverage = load > 10 ? clamp(selfUse / load * 100, 0, 100) : null;
    result.coverage = coverage;
    result.money = flowMoney;
    result.homeSource = generation <= 25 ? 'Solar inactive' : coverage === null ? 'Low house load' : number(coverage, 0) + '% house solar coverage';
    if (generation <= 25) return { ...result, tone: bought > 50 ? 'import' : 'neutral', title: 'Solar inactive', label: 'Grid draw', value: bought, coverage: null };
    if (bought > 50) return { ...result, tone: 'import', title: 'Grid import', label: 'Grid draw', value: bought };
    if (sold > 75) return { ...result, tone: 'surplus', title: 'Solar surplus', label: 'Spare solar', value: sold };
    return { ...result, title: 'Balanced', label: bought > 0 ? 'Grid draw' : 'Spare solar', value: bought > 0 ? bought : sold };
  }

  function createController(options) {
    const doc = options.document, card = doc.getElementById('homeSolar');
    if (!card) return null;
    const request = options.fetch, location = options.location;
    const view = options.window || doc.defaultView;
    const now = options.now || Date.now;
    const schedule = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    const cancel = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    const timeoutSignal = options.timeoutSignal || (milliseconds => AbortSignal.timeout(milliseconds));
    const node = id => doc.getElementById(id);
    const text = (id, value) => { const element = node(id); if (element && element.textContent !== value) element.textContent = value; };
    const hide = (id, hidden) => { if (node(id)) node(id).hidden = hidden; };
    const attr = (id, name, value) => node(id)?.setAttribute?.(name, String(value));
    let started = false, inFlight = false, failed = false, enabled = null;
    let current = null, today = null, energy = null, rates = null, history = null, historyDate = null;
    let serverStatus = 'waiting', staleAfterMs = 180000, historyAt = -Infinity;
    let pollTimer = null, paintTimer = null, range = 'today', metric = 'cost', selected = null, selectionPinned = false;
    let chartItems = [], chartPositions = [], chartEmpty = true, renderedDay = null;
    let panel = 'chart', targetPending = false;
    const panels = [['chart', 'solarTabChart', 'solarPanelChart'], ['log', 'solarTabLog', 'solarPanelLog'], ['details', 'solarTabDetails', 'solarPanelDetails']];
    const bindings = [];

    function on(id, name, handler) {
      const element = node(id);
      if (element?.addEventListener) { element.addEventListener(name, handler); bindings.push([element, name, handler]); }
    }
    function clearTimers() { cancel(pollTimer); cancel(paintTimer); pollTimer = null; paintTimer = null; }
    function revealTarget() {
      if (!started || !targetPending || doc.hidden || card.hidden || enabled !== true) return;
      targetPending = false;
      if (location?.hash === '#homeSolar') {
        // The card begins hidden, so native fragment navigation may run before
        // it has a layout box. Complete that navigation once data reveals it.
        // An instant scroll respects reduced motion and never moves focus.
        card.scrollIntoView?.({ block: 'start', behavior: 'instant' });
      }
    }
    function hashChanged() {
      targetPending = location?.hash === '#homeSolar';
      revealTarget();
    }
    function showToday(time) {
      const sameDay = today && today.date === dayKey(time);
      const quality = sameDay && Object.hasOwn(qualities, today.quality) ? today.quality : 'unavailable';
      const total = sameDay ? numeric(today.energyAcWh) : null;
      const usable = ['complete', 'partial'].includes(quality) && total !== null && total >= 0;
      text('solarTodayEnergy', usable ? energyText(total) : EMPTY);
      text('solarTodayQuality', { complete: 'From 00:00', partial: 'Partial', unavailable: EMPTY, reset: 'Reset' }[quality]);
      attr('solarTodayQuality', 'title', qualities[quality]);
      const through = sameDay ? timestamp(today.through) : NaN;
      hide('solarEnergyThrough', !usable || !Number.isFinite(through));
      text('solarEnergyThrough', usable && Number.isFinite(through) ? 'Counter through ' + observationTime.format(through) + ' AEST' : '');
      text('solarTodayNote', (sameDay ? clean(today.label) : '') || (sameDay ? 'Daily AC energy is unavailable.' : "Waiting for today's readings."));
      const day = energy?.today?.date === dayKey(time) ? energy.today : null;
      const coverage = numeric(day?.coveragePercent);
      const dayQuality = ['complete', 'partial'].includes(day?.quality) ? day.quality : 'unavailable';
      const complete = dayQuality === 'complete';
      text('solarDayCoverage', dayQuality === 'unavailable' ? 'No data' : (complete ? 'From midnight' : 'Partial') +
        (coverage === null ? '' : ' · ' + recordedPercent(coverage, dayQuality) + ' recorded'));
      if (node('solarDayCoverage')) node('solarDayCoverage').dataset.quality = dayQuality;
      text('solarTodayImport', energyText(day?.gridImportWh));
      text('solarTodayExport', energyText(day?.gridExportWh));
      text('solarTodayImportCost', numeric(day?.importCost) === null ? EMPTY : money(day.importCost));
      text('solarTodayCredit', numeric(day?.exportCredit) === null ? EMPTY : money(day.exportCredit));
      text('solarTodayNet', money(day?.netCost));
      text('solarTodaySupply', numeric(day?.supplyCost) === null ? 'Full supply included' : 'incl. ' + money(day.supplyCost) + ' supply');
      attr('solarTodaySupply', 'title', 'Includes the full daily supply charge.');
      const first = timestamp(day?.since), last = timestamp(day?.through);
      let note = 'Totals will build as readings arrive.';
      if (dayQuality !== 'unavailable') {
        note = complete ? 'Estimated from recorded power readings.' : 'Partial estimate; missing usage and export are not included.';
        if (Number.isFinite(first) && Number.isFinite(last)) note += ' Recorded ' + clockTime.format(first) + '–' + clockTime.format(last) + ' AEST.';
        if (!complete) note += ' Full daily supply is included.';
        const home = numeric(day.loadWh), self = numeric(day.solarToHomeWh), homeSeconds = numeric(day.coverageSeconds?.load), selfSeconds = numeric(day.coverageSeconds?.solarToHome);
        if (home !== null && home > 0 && self !== null && homeSeconds > 0 && selfSeconds > 0 && Math.abs(homeSeconds - selfSeconds) < 1) {
          note += ' Solar covered ' + number(clamp(self / home * 100, 0, 100), 0) + '% of recorded house use.';
        }
      }
      text('solarDayDetail', note);
      let compact = dayQuality === 'unavailable' ? 'Awaiting recorded intervals.' : Number.isFinite(first) && Number.isFinite(last)
        ? 'Recorded ' + clockTime.format(first) + '–' + clockTime.format(last) : 'Recorded intervals only';
      const home = numeric(day?.loadWh), self = numeric(day?.solarToHomeWh), homeSeconds = numeric(day?.coverageSeconds?.load), selfSeconds = numeric(day?.coverageSeconds?.solarToHome);
      if (home !== null && home > 0 && self !== null && homeSeconds > 0 && selfSeconds > 0 && Math.abs(homeSeconds - selfSeconds) < 1) {
        compact += ' · solar ' + number(clamp(self / home * 100, 0, 100), 0) + '%';
      }
      text('solarDayNote', compact); attr('solarDayNote', 'title', note);
    }
    function showReadings(fresh) {
      text('solarPvPower', power(current?.pvPowerW));
      text('solarAcPower', power(current?.inverterPowerW));
      const grid = numeric(current?.gridPowerW), load = numeric(current?.loadPowerW);
      const battery = numeric(current?.batteryPowerW), rawSoc = numeric(current?.batterySocPercent);
      const soc = rawSoc !== null && rawSoc >= 0 && rawSoc <= 100 ? rawSoc : null;
      hide('solarBatteryMetric', battery === null && soc === null);
      text('solarGridLabel', grid > 0 ? 'Grid import' : grid < 0 ? 'Grid export' : 'Grid');
      text('solarGridPower', power(grid === null ? null : Math.abs(grid)));
      text('solarLoadPower', load !== null && load >= 0 ? power(load) : EMPTY);
      text('solarBatteryLabel', battery > 0 ? 'Battery discharge' : battery < 0 ? 'Battery charging' : battery === 0 ? 'Battery idle' : 'Battery charge');
      text('solarBatteryPower', battery === null ? (soc === null ? EMPTY : number(soc, 1) + '%') : power(Math.abs(battery)));
      text('solarBatterySoc', battery !== null && soc !== null ? number(soc, 1) + '% state of charge' : '');
      const view = liveView(current, rates, fresh);
      card.dataset.tone = view.tone;
      if (node('solarHero')) node('solarHero').dataset.tone = view.tone;
      text('solarHeadline', view.title);
      text('solarHeadroomLabel', view.label); text('solarHeadroom', power(view.value));
      text('solarLiveMoney', view.money); text('solarHomeSource', fresh ? view.homeSource : current ? 'Last recorded use' : 'Waiting for readings');
      hide('solarCoverageBlock', view.coverage === null);
      text('solarCoverageText', view.coverage === null ? EMPTY : number(view.coverage, 0) + '%');
      if (node('solarCoverageFill')?.style) node('solarCoverageFill').style.width = (view.coverage ?? 0) + '%';
      attr('solarCoverageTrack', 'aria-valuenow', view.coverage ?? 0);
      let gridMoney = fresh ? 'Rate unavailable' : 'Last recorded exchange';
      if (fresh && grid !== null) {
        const rate = numeric(grid > 0 ? rates?.importPerKwh : rates?.exportPerKwh);
        if (grid === 0) gridMoney = '$0.00/hr';
        else if (rate !== null) gridMoney = (grid > 0 ? 'Cost ' : 'Credit ') + hourly(Math.abs(grid) / 1000 * rate);
      }
      text('solarGridMoney', current ? gridMoney : EMPTY);
    }
    function paint() {
      card.hidden = enabled === false;
      if (card.hidden) return;
      const time = now(), observed = timestamp(current?.observedAt);
      const times = current ? [observed, timestamp(current.collectedAt), timestamp(current.receivedAt)] : [];
      const age = times.length ? time - Math.min(...times) : NaN;
      let state = enabled === null ? 'connecting' : 'waiting', label = enabled === null ? 'CONNECTING' : 'WAITING';
      let message = enabled === null ? 'Connecting to solar readings.' : 'Awaiting the first reading.';
      if (current) {
        if (times.some(value => value > time + 90000)) {
          state = 'check'; label = 'CHECK'; message = 'Source clock ahead of current time.';
        } else if (failed || serverStatus === 'stale' || serverStatus === 'waiting' || age > staleAfterMs) {
          state = 'stale'; label = 'STALE';
          message = failed ? 'Update failed; last reading retained.' : 'No recent update; last reading retained.';
        } else if (serverStatus === 'unavailable') {
          state = 'unavailable'; label = 'UNAVAILABLE'; message = 'Temporarily unavailable; last reading retained.';
        } else if (numeric(current.inverterPowerW) === null || numeric(current.gridPowerW) === null || numeric(current.loadPowerW) === null || current.loadPowerW < 0) {
          state = 'partial'; label = 'PARTIAL'; message = 'Some measurements unavailable.';
        } else { state = 'fresh'; label = 'LIVE'; message = ''; }
      } else if (failed || serverStatus === 'unavailable') {
        state = 'unavailable'; label = 'UNAVAILABLE'; message = 'Solar readings unavailable; retrying.';
      }
      card.dataset.state = state;
      text('solarStatus', label); node('solarStatus').className = 'solar-badge solar-badge-' + state;
      const fullObserved = current ? 'Observed ' + observationTime.format(observed) + ' AEST · ' + ageText(time - observed) : 'No reading received yet';
      text('solarObserved', current ? clockTime.format(observed) + ' · ' + ageText(time - observed) : 'No reading');
      attr('solarObserved', 'title', fullObserved); text('solarObservedDetail', fullObserved);
      text('solarMessage', message); hide('solarMessage', !message);
      showReadings(state === 'fresh' || state === 'partial'); showToday(time);
      // Once at midnight, expire the old chart instead of displaying yesterday
      // under Today's label. Routine age paints never redraw the history graph.
      if (renderedDay && renderedDay !== dayKey(time)) renderData();
      revealTarget();
    }
    function showRates() {
      const imported = numeric(rates?.importPerKwh), exported = numeric(rates?.exportPerKwh), supply = numeric(rates?.supplyPerDay);
      text('solarRateImport', imported === null ? EMPTY : number(imported * 100, 4) + 'c/kWh');
      text('solarRateExport', exported === null ? EMPTY : number(exported * 100, 3) + 'c/kWh');
      text('solarRateSupply', supply === null ? EMPTY : money(supply) + '/day');
      const effective = dateTime(rates?.effectiveFrom);
      text('solarRatesNote', Number.isFinite(effective)
        ? 'AUD · bill-verified rates from ' + shortDate.format(effective) + ' ' + rates.effectiveFrom.slice(0, 4) + '. Import and supply include GST; export credit as billed.'
        : 'Tariff unavailable; financial estimates paused.');
    }
    function dailyItems() {
      const date = dayKey(now());
      return (Array.isArray(energy?.days) ? energy.days : []).filter(day => day && Number.isFinite(dateTime(day.date)) && day.date <= date)
        .slice(-30).map(day => day.date === energy?.today?.date && day.date === date ? energy.today : day);
    }
    function inspect(index, pin = false) {
      if (!chartItems.length || chartEmpty) return;
      selected = clamp(Math.round(index), 0, chartItems.length - 1);
      if (pin) selectionPinned = true;
      if (node('solarChartScrubber')) node('solarChartScrubber').value = String(selected);
      const item = chartItems[selected];
      let description;
      if (range === 'today') {
        const at = timestamp(item?.observedAt), title = Number.isFinite(at) ? clockTime.format(at) + ' AEST' : 'Reading';
        description = '<strong>' + escape(title) + '</strong>' +
          (item && [item.inverterPowerW, item.loadPowerW, item.gridImportPowerW].some(value => numeric(value) !== null)
            ? '<span>Solar ' + escape(power(item.inverterPowerW)) + '</span><span>House ' + escape(power(item.loadPowerW)) + '</span><span>Bought ' + escape(power(item.gridImportPowerW)) + '</span><span>Export ' + escape(power(item.gridExportPowerW)) + '</span>'
            : '<span>No recorded reading</span>');
      } else {
        description = '<strong>' + escape(dateLabel(item.date)) + '</strong>' +
          (item.quality === 'unavailable' ? '<span>No recorded readings</span>'
            : '<span>Bought ' + escape(energyText(item.gridImportWh)) + '</span><span>Sold ' + escape(energyText(item.gridExportWh)) + '</span><span>Net ' + escape(money(item.netCost)) + '</span><span>' + escape(item.quality === 'complete' ? 'Complete' : 'Partial') +
              (numeric(item.coveragePercent) === null ? '' : ' · ' + escape(recordedPercent(item.coveragePercent, item.quality)) + ' recorded') + '</span>');
      }
      if (node('solarChartInspect')) node('solarChartInspect').innerHTML = description;
      const selectedLine = doc.getElementById('solarChartCursor');
      if (selectedLine?.setAttribute) {
        selectedLine.setAttribute('x1', chartPositions[selected]); selectedLine.setAttribute('x2', chartPositions[selected]);
        selectedLine.setAttribute('visibility', 'visible');
      }
      attr('solarChartScrubber', 'aria-valuetext', range === 'today' ? (Number.isFinite(timestamp(item?.observedAt)) ? clockTime.format(timestamp(item.observedAt)) + ' AEST' : 'No reading') : dateLabel(item.date));
    }
    function renderChart() {
      const date = dayKey(now()), dayStart = Date.parse(date + 'T00:00:00Z') - OFFSET_MS;
      const chart = node('solarChart');
      if (!chart) return;
      for (const [id, value] of [['solarRangeToday', 'today'], ['solarRange7', '7'], ['solarRange30', '30']]) attr(id, 'aria-pressed', range === value);
      hide('solarChartMetricLabel', range === 'today');
      chartItems = range === 'today' ? (historyDate === date && Array.isArray(history?.points) ? history.points.slice(0, 288).filter(p => Number.isFinite(timestamp(p?.observedAt)) && timestamp(p.observedAt) >= dayStart && timestamp(p.observedAt) < dayStart + DAY_MS) : []) : dailyItems().slice(-Number(range));
      chartPositions = chartItems.map((item, index) => range === 'today'
        ? clamp((timestamp(item.observedAt) - dayStart) / DAY_MS * 720, 0, 720) : (index + .5) / Math.max(1, chartItems.length) * 720);
      let max = 1, min = 0, content = '', available = [];
      if (range === 'today') {
        available = chartItems.flatMap(p => [numeric(p.inverterPowerW), numeric(p.loadPowerW), numeric(p.gridImportPowerW)]).filter(v => v !== null && v >= 0);
        max = Math.max(1000, Math.ceil(Math.max(0, ...available) / 1000) * 1000);
      } else if (metric === 'energy') {
        available = chartItems.flatMap(p => [numeric(p.gridImportWh), numeric(p.gridExportWh)]).filter(v => v !== null && v >= 0);
        max = Math.max(1000, Math.ceil(Math.max(0, ...available) / 10000) * 10000);
      } else {
        available = chartItems.map(p => numeric(p.netCost)).filter(v => v !== null);
        max = Math.max(1, Math.ceil(Math.max(0, ...available)));
        min = Math.min(0, Math.floor(Math.min(0, ...available)));
      }
      const y = value => 182 - (value - min) / (max - min) * 174;
      for (const value of [min, (max + min) / 2, max]) content += '<line x1="0" x2="720" y1="' + y(value) + '" y2="' + y(value) + '" class="solar-chart-grid"/>';
      if (range === 'today') {
        for (const [key, name] of [['inverterPowerW', 'generation'], ['loadPowerW', 'home'], ['gridImportPowerW', 'import']]) {
          let path = '', drawing = false, last = null;
          chartItems.forEach((item, index) => {
            const value = numeric(item[key]);
            if (value === null || value < 0) { drawing = false; return; }
            if (item.breakBefore || item.hasGap) drawing = false;
            const x = chartPositions[index], py = y(value);
            path += (drawing ? 'L' : 'M') + x.toFixed(2) + ' ' + py.toFixed(2); drawing = !item.hasGap; last = [x, py];
          });
          content += '<path d="' + path + '" class="solar-chart-series solar-chart-series-' + name + '"/>';
          if (last) content += '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.5" class="solar-chart-series solar-chart-series-' + name + '"/>';
        }
        text('solarChartSubtitle', '5-min mean');
        node('solarChartLegend').innerHTML = '<span><i class="solar-dot-generation"></i>Solar</span><span><i class="solar-dot-home"></i>House</span><span><i class="solar-dot-grid"></i>Grid bought</span>';
        text('solarChartStart', '00:00'); text('solarChartMiddle', '12:00'); text('solarChartEnd', '24:00');
        text('solarHistoryNote', 'AEST · 5-minute averages · gaps unfilled');
      } else {
        const step = 720 / Math.max(chartItems.length, 1), half = Math.min(18, step * .33);
        chartItems.forEach((item, index) => {
          const alpha = item.quality === 'complete' ? 1 : .55;
          const bar = (value, x, width, cls) => {
            if (numeric(value) === null) return;
            const top = Math.min(y(value), y(0)), height = Math.max(1, Math.abs(y(value) - y(0)));
            content += '<rect x="' + x.toFixed(2) + '" y="' + top.toFixed(2) + '" width="' + width.toFixed(2) + '" height="' + height.toFixed(2) + '" rx="2" opacity="' + alpha + '" class="solar-chart-bar ' + cls + '"/>';
          };
          if (metric === 'cost') bar(item.netCost, chartPositions[index] - half, half * 2, item.netCost < 0 ? 'solar-chart-bar-credit' : '');
          else {
            bar(item.gridImportWh, chartPositions[index] - half, half - 1, '');
            bar(item.gridExportWh, chartPositions[index] + 1, half - 1, 'solar-chart-bar-export');
          }
        });
        text('solarChartSubtitle', metric === 'cost' ? 'incl. supply' : 'kWh/day');
        node('solarChartLegend').innerHTML = metric === 'cost' ? '<span><i class="solar-dot-grid"></i>Net cost</span><span><i class="solar-dot-generation"></i>Net credit</span>' : '<span><i class="solar-dot-grid"></i>Bought</span><span><i class="solar-dot-export"></i>Sold</span>';
        text('solarChartStart', chartItems.length ? dateLabel(chartItems[0].date) : EMPTY);
        text('solarChartMiddle', chartItems.length > 2 ? dateLabel(chartItems[Math.floor(chartItems.length / 2)].date) : '');
        text('solarChartEnd', chartItems.length > 1 ? dateLabel(chartItems.at(-1).date) : EMPTY);
        text('solarHistoryNote', 'Lighter = partial · blank = no data');
      }
      const isPower = range === 'today' || metric === 'energy';
      const axis = value => isPower ? number(value / 1000, value / 1000 % 1 ? 1 : 0) : money(value);
      text('solarChartMax', axis(max) + (isPower ? range === 'today' ? ' kW' : ' kWh' : ''));
      text('solarChartMid', axis((max + min) / 2)); text('solarChartMin', axis(min));
      content += '<line id="solarChartCursor" x1="0" x2="0" y1="5" y2="185" class="solar-chart-selection" visibility="hidden"/>';
      chart.innerHTML = content;
      chartEmpty = available.length === 0;
      hide('solarChartEmpty', !chartEmpty); hide('solarChartScrubber', chartEmpty);
      text('solarChartEmpty', range === 'today' ? 'No chart readings yet.' : 'No daily readings for this period.');
      attr('solarChart', 'aria-label', range === 'today' ? "Today's solar output, house use and grid draw in kilowatts" : 'Last ' + range + ' days of ' + (metric === 'cost' ? 'net cost in Australian dollars' : 'electricity bought and sold in kilowatt-hours'));
      if (node('solarChartScrubber')) node('solarChartScrubber').max = String(Math.max(0, chartItems.length - 1));
      attr('solarChartScrubber', 'aria-label', range === 'today' ? 'Inspect a time on the solar chart' : 'Inspect a day on the solar chart');
      if (chartEmpty) text('solarChartInspect', 'No recorded readings.');
      else {
        const lastAvailable = chartItems.findLastIndex(item => range === 'today' ? numeric(item.inverterPowerW) !== null || numeric(item.loadPowerW) !== null : numeric(item.netCost) !== null || numeric(item.gridImportWh) !== null);
        inspect(!selectionPinned || selected === null ? Math.max(0, lastAvailable) : selected);
      }
    }
    function renderLog() {
      const days = dailyItems().filter(day => day.quality !== 'unavailable');
      if (node('solarDownload')) node('solarDownload').disabled = !days.length;
      if (!node('solarLogBody')) return;
      node('solarLogBody').innerHTML = days.length ? [...days].reverse().map(day => '<tr data-quality="' + (day.quality === 'complete' ? 'complete' : 'partial') + '">' +
        ['<th scope="row">' + escape(dateLabel(day.date)) + '</th>', ...[numeric(day.gridImportWh) === null ? EMPTY : number(day.gridImportWh / 1000), numeric(day.gridExportWh) === null ? EMPTY : number(day.gridExportWh / 1000), money(day.importCost), money(day.exportCredit), money(day.supplyCost), money(day.netCost), (day.quality === 'complete' ? 'Complete' : 'Partial') + (numeric(day.coveragePercent) === null ? '' : ' · ' + recordedPercent(day.coveragePercent, day.quality))].map(value => '<td>' + escape(value) + '</td>')].join('') + '</tr>').join('') : '<tr><td colspan="8">No daily readings yet.</td></tr>';
    }
    function renderData() { renderedDay = dayKey(now()); showRates(); renderChart(); renderLog(); }
    function setPanel(value, focus = false) {
      if (!panels.some(([name]) => name === value)) return;
      panel = value;
      for (const [name, tabId, panelId] of panels) {
        const active = name === panel;
        attr(tabId, 'aria-selected', active); attr(tabId, 'tabindex', active ? 0 : -1);
        hide(panelId, !active);
        if (active && focus) node(tabId)?.focus?.();
      }
    }
    function panelKey(event) {
      const index = panels.findIndex(([name]) => name === panel);
      const next = event.key === 'ArrowRight' ? (index + 1) % panels.length : event.key === 'ArrowLeft' ? (index + panels.length - 1) % panels.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); setPanel(panels[next][0], true); }
    }
    function setRange(value) { if (!['today', '7', '30'].includes(value)) return; range = value; selected = null; selectionPinned = false; renderChart(); }
    function chartPointer(event) {
      if (chartEmpty || !chartPositions.length) return;
      const rect = node('solarChartPlot')?.getBoundingClientRect?.();
      if (!rect || !rect.width) return;
      const x = clamp((event.clientX - rect.left) / rect.width, 0, 1) * 720;
      let nearest = 0;
      for (let index = 1; index < chartPositions.length; index++) if (Math.abs(chartPositions[index] - x) < Math.abs(chartPositions[nearest] - x)) nearest = index;
      if (nearest !== selected) inspect(nearest, true);
    }
    function downloadCsv() {
      const days = dailyItems().filter(day => day.quality !== 'unavailable');
      if (!days.length || !doc.createElement || !globalThis.URL?.createObjectURL) return;
      const columns = ['date', 'quality', 'coveragePercent', 'coveredSeconds', 'gridImportWh', 'gridExportWh', 'loadWh', 'solarToHomeWh', 'generatedAcWh', 'importCost', 'exportCredit', 'supplyCost', 'netCost', 'since', 'through'];
      const headers = columns.map(key => ['importCost', 'exportCredit', 'supplyCost', 'netCost'].includes(key) ? key + 'AUD' : key);
      const csv = ['currency,method,' + headers.join(','), ...days.map(day => 'AUD,power-integration,' + columns.map(key => {
        const value = day[key];
        return numeric(value) !== null ? String(value) : typeof value === 'string' && (/^\d{4}-\d{2}-\d{2}/.test(value) || ['complete', 'partial', 'unavailable'].includes(value)) ? value : '';
      }).join(','))].join('\r\n') + '\r\n';
      const url = globalThis.URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = doc.createElement('a'); link.href = url; link.download = 'moore-solar-' + dayKey(now()) + '.csv';
      doc.body.appendChild(link); link.click(); link.remove();
      schedule(() => globalThis.URL.revokeObjectURL(url), 1000);
    }
    function schedulePaint() { cancel(paintTimer); if (started && !doc.hidden) paintTimer = schedule(() => { paint(); schedulePaint(); }, PAINT_MS); }
    async function refresh() {
      if (!started || doc.hidden || inFlight) return;
      inFlight = true; cancel(pollTimer); pollTimer = null;
      const wantsHistory = now() - historyAt >= HISTORY_MS || historyDate !== dayKey(now());
      try {
        const response = await request('/api/solar' + (wantsHistory ? '?history=today' : ''), { cache: 'no-store', headers: { Accept: 'application/json' }, signal: timeoutSignal(REQUEST_TIMEOUT_MS) });
        if (!started) return;
        if (response.status === 401) {
          stop(); card.hidden = true; current = null; today = null; energy = null; history = null;
          location.assign('/login'); return;
        }
        if (!response.ok) throw new Error('Solar response unavailable');
        const body = await response.json();
        if (!started) return;
        if (!body || typeof body.enabled !== 'boolean' || !statuses.has(body.status) || !Object.hasOwn(body, 'current')) throw new Error('Invalid solar response');
        if (body.current !== null && body.current !== undefined &&
            (!body.current || ['observedAt', 'collectedAt', 'receivedAt'].some(key => !Number.isFinite(timestamp(body.current[key]))))) throw new Error('Invalid solar observation time');
        enabled = body.enabled; serverStatus = body.status; failed = false;
        staleAfterMs = typeof body.staleAfterSeconds === 'number' && body.staleAfterSeconds > 0 && body.staleAfterSeconds <= 3600 ? body.staleAfterSeconds * 1000 : 180000;
        if (!enabled) { current = null; today = null; energy = null; history = null; rates = null; }
        else {
          if (body.current) current = body.current;
          today = body.today && typeof body.today === 'object' ? body.today : null;
          rates = body.rates && typeof body.rates === 'object' ? body.rates : null;
          if (body.energy && typeof body.energy === 'object') energy = { ...body.energy, days: Array.isArray(body.energy.days) ? body.energy.days : energy?.days || [] };
          else energy = null;
          if (wantsHistory) {
            history = body.history && typeof body.history === 'object' ? body.history : null;
            historyAt = now(); historyDate = body.today?.date === dayKey(now()) ? body.today.date : dayKey(now());
          }
        }
        paint(); renderData();
      } catch { if (started) { failed = true; paint(); } }
      finally { inFlight = false; if (started && !doc.hidden) pollTimer = schedule(refresh, POLL_MS); }
    }
    function visibilityChanged() { clearTimers(); if (!doc.hidden && started) { paint(); schedulePaint(); refresh(); } }
    function start() {
      if (started) return;
      started = true; doc.addEventListener('visibilitychange', visibilityChanged);
      targetPending = location?.hash === '#homeSolar';
      view?.addEventListener?.('hashchange', hashChanged);
      for (const [name, tabId] of panels) { on(tabId, 'click', () => setPanel(name)); on(tabId, 'keydown', panelKey); }
      setPanel(panel);
      on('solarRangeToday', 'click', () => setRange('today')); on('solarRange7', 'click', () => setRange('7')); on('solarRange30', 'click', () => setRange('30'));
      on('solarChartMetric', 'change', event => { metric = event.target.value === 'energy' ? 'energy' : 'cost'; selected = null; selectionPinned = false; renderChart(); });
      on('solarChartScrubber', 'input', event => inspect(Number(event.target.value), true));
      on('solarChartPlot', 'pointerdown', chartPointer);
      on('solarChartPlot', 'pointermove', event => { if (event.pointerType === 'mouse' || event.buttons === 1) chartPointer(event); });
      on('solarDownload', 'click', downloadCsv);
      paint(); renderData(); schedulePaint(); refresh();
    }
    function stop() {
      started = false; clearTimers(); doc.removeEventListener('visibilitychange', visibilityChanged);
      targetPending = false; view?.removeEventListener?.('hashchange', hashChanged);
      for (const [element, name, handler] of bindings.splice(0)) element.removeEventListener(name, handler);
    }
    return { start, stop, refresh, paint, setRange, setPanel };
  }
  return { createController, liveView };
});
