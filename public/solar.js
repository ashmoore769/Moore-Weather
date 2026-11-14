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
    const result = { tone: 'neutral', title: 'Waiting for live solar', action: 'Fresh readings will show how much solar is available.',
      label: 'Spare solar', value: null, money: 'Waiting for a fresh reading', coverage: null, homeSource: 'Waiting for readings' };
    if (!fresh) return { ...result, title: current ? 'Waiting for a fresh reading' : result.title,
      action: current ? 'Last readings are shown below. Live guidance resumes when the connection returns.' : result.action };
    const ac = numeric(current?.inverterPowerW), grid = numeric(current?.gridPowerW), load = numeric(current?.loadPowerW);
    const battery = numeric(current?.batteryPowerW);
    if (ac === null || grid === null || load === null || load < 0 || current?.meterLocation !== 'grid') {
      return { ...result, title: 'Some readings are unavailable', action: 'Solar coverage needs a fresh house and grid meter reading.' };
    }
    const bought = Math.max(0, grid), sold = Math.max(0, -grid), generation = Math.max(0, ac);
    const buyRate = numeric(rates?.importPerKwh), sellRate = numeric(rates?.exportPerKwh);
    const charge = buyRate === null ? null : bought / 1000 * buyRate;
    const credit = sellRate === null ? null : sold / 1000 * sellRate;
    const flowMoney = bought > 0 ? (charge === null ? 'Import rate unavailable' : 'Grid costing ' + hourly(charge)) : sold > 0
      ? (credit === null ? 'Export rate unavailable' : 'Export earning ' + hourly(credit)) : 'No grid exchange right now';
    if (battery !== null && battery !== 0) {
      return { ...result, title: 'Battery is part of the flow', action: 'Solar coverage is unavailable while battery power is contributing to the balance.',
        label: grid >= 0 ? 'Grid draw' : 'Grid export', value: Math.abs(grid), money: flowMoney, homeSource: 'Solar / grid / battery' };
    }
    const selfUse = Math.min(Math.max(load - bought, 0), load, generation);
    const coverage = load > 10 ? clamp(selfUse / load * 100, 0, 100) : null;
    result.coverage = coverage;
    result.money = flowMoney;
    result.homeSource = generation <= 25 ? 'Solar is resting' : coverage === null ? 'Very low house use' : number(coverage, 0) + '% covered by solar';
    if (generation <= 25) {
      return { ...result, title: 'Solar is resting', action: 'Grid power is covering any house use. Solar will pick up when generation returns.',
        label: 'Grid draw', value: bought, coverage: null };
    }
    if (bought > 50) {
      return { ...result, tone: 'import', title: 'The grid is helping out', label: 'Grid draw', value: bought,
        action: 'Reduce house use by about ' + power(bought) + ' to get back within solar.' };
    }
    if (sold > 75) {
      return { ...result, tone: 'surplus', title: load > 10 ? 'Solar covers the house' : 'Solar is ready to use', label: 'Spare solar', value: sold,
        action: 'This is your headroom for extra use right now. It changes with clouds and appliances.' };
    }
    return { ...result, title: 'Close to solar balance', label: bought > 0 ? 'Small grid draw' : 'Spare solar', value: bought > 0 ? bought : sold,
      action: 'House use is close to solar output, with very little spare headroom.' };
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
    const text = (id, value) => { const element = node(id); if (element && element.textContent !== value) element.textContent = value; };
    const hide = (id, hidden) => { if (node(id)) node(id).hidden = hidden; };
    const attr = (id, name, value) => node(id)?.setAttribute?.(name, String(value));
    let started = false, inFlight = false, failed = false, enabled = null;
    let current = null, today = null, energy = null, rates = null, history = null, historyDate = null;
    let serverStatus = 'waiting', staleAfterMs = 180000, historyAt = -Infinity;
    let pollTimer = null, paintTimer = null, range = 'today', metric = 'cost', selected = null, selectionPinned = false;
    let chartItems = [], chartPositions = [], chartEmpty = true, renderedDay = null;
    const bindings = [];

    function on(id, name, handler) {
      const element = node(id);
      if (element?.addEventListener) { element.addEventListener(name, handler); bindings.push([element, name, handler]); }
    }
    function clearTimers() { cancel(pollTimer); cancel(paintTimer); pollTimer = null; paintTimer = null; }
    function showToday(time) {
      const sameDay = today && today.date === dayKey(time);
      const quality = sameDay && Object.hasOwn(qualities, today.quality) ? today.quality : 'unavailable';
      const total = sameDay ? numeric(today.energyAcWh) : null;
      const usable = ['complete', 'partial'].includes(quality) && total !== null && total >= 0;
      text('solarTodayEnergy', usable ? energyText(total) : EMPTY);
      text('solarTodayQuality', qualities[quality]);
      const through = sameDay ? timestamp(today.through) : NaN;
      hide('solarEnergyThrough', !usable || !Number.isFinite(through));
      text('solarEnergyThrough', usable && Number.isFinite(through) ? 'Counter through ' + observationTime.format(through) + ' AEST' : '');
      text('solarTodayNote', (sameDay ? clean(today.label) : '') || (sameDay ? 'Daily AC energy is unavailable.' : "Waiting for today's readings."));
      const day = energy?.today?.date === dayKey(time) ? energy.today : null;
      const coverage = numeric(day?.coveragePercent);
      const dayQuality = ['complete', 'partial'].includes(day?.quality) ? day.quality : 'unavailable';
      const complete = dayQuality === 'complete';
      text('solarDayCoverage', dayQuality === 'unavailable' ? 'Waiting for readings' : (complete ? 'From midnight' : 'Partial day') +
        (coverage === null ? '' : ' · ' + recordedPercent(coverage, dayQuality) + ' recorded'));
      if (node('solarDayCoverage')) node('solarDayCoverage').dataset.quality = dayQuality;
      text('solarTodayImport', energyText(day?.gridImportWh));
      text('solarTodayExport', energyText(day?.gridExportWh));
      text('solarTodayImportCost', numeric(day?.importCost) === null ? EMPTY : money(day.importCost) + ' grid cost');
      text('solarTodayCredit', numeric(day?.exportCredit) === null ? EMPTY : money(day.exportCredit) + ' credit');
      text('solarTodayNet', money(day?.netCost));
      text('solarTodaySupply', numeric(day?.supplyCost) === null ? 'Includes full daily supply' : 'Includes ' + money(day.supplyCost) + ' daily supply');
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
      text('solarDayNote', note);
    }
    function showReadings(fresh) {
      text('solarPvPower', power(current?.pvPowerW));
      text('solarAcPower', power(current?.inverterPowerW));
      const grid = numeric(current?.gridPowerW), load = numeric(current?.loadPowerW);
      const battery = numeric(current?.batteryPowerW), rawSoc = numeric(current?.batterySocPercent);
      const soc = rawSoc !== null && rawSoc >= 0 && rawSoc <= 100 ? rawSoc : null;
      hide('solarBatteryMetric', battery === null && soc === null);
      text('solarGridLabel', grid > 0 ? 'Grid buying' : grid < 0 ? 'Grid exporting' : 'Grid exchange');
      text('solarGridPower', power(grid === null ? null : Math.abs(grid)));
      text('solarLoadPower', load !== null && load >= 0 ? power(load) : EMPTY);
      text('solarBatteryLabel', battery > 0 ? 'Battery discharge' : battery < 0 ? 'Battery charging' : battery === 0 ? 'Battery idle' : 'Battery charge');
      text('solarBatteryPower', battery === null ? (soc === null ? EMPTY : number(soc, 1) + '%') : power(Math.abs(battery)));
      text('solarBatterySoc', battery !== null && soc !== null ? number(soc, 1) + '% state of charge' : '');
      const view = liveView(current, rates, fresh);
      if (node('solarHero')) node('solarHero').dataset.tone = view.tone;
      text('solarHeroKicker', fresh ? 'RIGHT NOW' : current ? 'LAST READING' : 'RIGHT NOW');
      text('solarHeadline', view.title); text('solarAction', view.action);
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
      let message = enabled === null ? 'Connecting to saved solar readings.' : 'Waiting for the first reading from the home collector.';
      if (current) {
        if (times.some(value => value > time + 90000)) {
          state = 'check'; label = 'CHECK'; message = 'The inverter or collector clock is ahead of the current time.';
        } else if (failed || serverStatus === 'stale' || serverStatus === 'waiting' || age > staleAfterMs) {
          state = 'stale'; label = 'STALE';
          message = failed ? 'Latest solar update failed. Last reading retained; retrying automatically.' : 'No recent solar reading. Last reading retained.';
        } else if (serverStatus === 'unavailable') {
          state = 'unavailable'; label = 'UNAVAILABLE'; message = 'Solar readings are temporarily unavailable. Last reading retained.';
        } else if (numeric(current.inverterPowerW) === null || numeric(current.gridPowerW) === null || numeric(current.loadPowerW) === null || current.loadPowerW < 0) {
          state = 'partial'; label = 'PARTIAL'; message = 'Some solar measurements are unavailable.';
        } else { state = 'fresh'; label = 'LIVE'; message = ''; }
      } else if (failed || serverStatus === 'unavailable') {
        state = 'unavailable'; label = 'UNAVAILABLE'; message = 'Solar readings could not be loaded. Retrying automatically.';
      }
      card.dataset.state = state;
      text('solarStatus', label); node('solarStatus').className = 'solar-badge solar-badge-' + state;
      text('solarObserved', current ? 'Observed ' + observationTime.format(observed) + ' AEST · ' + ageText(time - observed) : 'No reading received yet');
      text('solarMessage', message); hide('solarMessage', !message);
      showReadings(state === 'fresh' || state === 'partial'); showToday(time);
      // Once at midnight, expire the old chart instead of displaying yesterday
      // under Today's label. Routine age paints never redraw the history graph.
      if (renderedDay && renderedDay !== dayKey(time)) renderData();
    }
    function showRates() {
      const imported = numeric(rates?.importPerKwh), exported = numeric(rates?.exportPerKwh), supply = numeric(rates?.supplyPerDay);
      text('solarRateImport', imported === null ? EMPTY : number(imported * 100, 4) + 'c/kWh');
      text('solarRateExport', exported === null ? EMPTY : number(exported * 100, 3) + 'c/kWh');
      text('solarRateSupply', supply === null ? EMPTY : money(supply) + '/day');
      const effective = dateTime(rates?.effectiveFrom);
      text('solarRatesNote', Number.isFinite(effective)
        ? 'AUD · rates verified from electricity bills, effective ' + shortDate.format(effective) + ' ' + rates.effectiveFrom.slice(0, 4) + '. Import and supply include GST. Feed-in credit is used as billed.'
        : 'Tariff rates are unavailable. Financial estimates will resume when they are loaded.');
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
        text('solarChartSubtitle', '5-minute averages · solar, house and grid draw');
        node('solarChartLegend').innerHTML = '<span><i class="solar-dot-generation"></i>Solar</span><span><i class="solar-dot-home"></i>House</span><span><i class="solar-dot-grid"></i>Grid bought</span>';
        text('solarChartStart', '00:00'); text('solarChartMiddle', '12:00'); text('solarChartEnd', '24:00');
        text('solarHistoryNote', 'Times are AEST. Chart refreshes every 5 minutes; live readings every minute. Gaps are left unfilled.');
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
        text('solarChartSubtitle', metric === 'cost' ? 'Daily net cost · full supply charge included' : 'Daily electricity bought and sold');
        node('solarChartLegend').innerHTML = metric === 'cost' ? '<span><i class="solar-dot-grid"></i>Net cost</span><span><i class="solar-dot-generation"></i>Net credit</span>' : '<span><i class="solar-dot-grid"></i>Bought</span><span><i class="solar-dot-export"></i>Sold</span>';
        text('solarChartStart', chartItems.length ? dateLabel(chartItems[0].date) : EMPTY);
        text('solarChartMiddle', chartItems.length > 2 ? dateLabel(chartItems[Math.floor(chartItems.length / 2)].date) : '');
        text('solarChartEnd', chartItems.length > 1 ? dateLabel(chartItems.at(-1).date) : EMPTY);
        text('solarHistoryNote', 'Lighter bars are partial days. Blank days have no recorded data. Use the daily log for coverage and the full cost breakdown.');
      }
      const isPower = range === 'today' || metric === 'energy';
      const axis = value => isPower ? number(value / 1000, value / 1000 % 1 ? 1 : 0) : money(value);
      text('solarChartMax', axis(max) + (isPower ? range === 'today' ? ' kW' : ' kWh' : ''));
      text('solarChartMid', axis((max + min) / 2)); text('solarChartMin', axis(min));
      content += '<line id="solarChartCursor" x1="0" x2="0" y1="5" y2="185" class="solar-chart-selection" visibility="hidden"/>';
      chart.innerHTML = content;
      chartEmpty = available.length === 0;
      hide('solarChartEmpty', !chartEmpty); hide('solarChartScrubber', chartEmpty);
      text('solarChartEmpty', range === 'today' ? 'Your graph will grow as readings arrive.' : 'Daily history will build from your recorded readings.');
      attr('solarChart', 'aria-label', range === 'today' ? "Today's solar output, house use and grid draw in kilowatts" : 'Last ' + range + ' days of ' + (metric === 'cost' ? 'net cost in Australian dollars' : 'electricity bought and sold in kilowatt-hours'));
      if (node('solarChartScrubber')) node('solarChartScrubber').max = String(Math.max(0, chartItems.length - 1));
      attr('solarChartScrubber', 'aria-label', range === 'today' ? 'Inspect a time on the solar chart' : 'Inspect a day on the solar chart');
      if (chartEmpty) text('solarChartInspect', 'No readings available for this period yet.');
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
      for (const [element, name, handler] of bindings.splice(0)) element.removeEventListener(name, handler);
    }
    return { start, stop, refresh, paint, setRange };
  }
  return { createController, liveView };
});
