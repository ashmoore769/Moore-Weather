/* Weather Station Power composite preview. Reuses the existing authenticated /api/trends response. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./solar-chart') : root.SolarChart);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MooreStationPowerChart = api;
})(typeof globalThis === 'object' ? globalThis : this, function (navigation) {
  'use strict';
  const DAY = 86400000;
  const SIZE = { width: 720, height: 224, left: 52, right: 668, top: 16, bottom: 194 };
  const renderStates = new WeakMap();
  const METRICS = [
    { id: 'battery', unit: 'V', name: 'Battery', css: 'station-power-line-battery' },
    { id: 'panel', unit: 'V', name: 'Panel', css: 'station-power-line-panel' },
    { id: 'load', unit: 'mA', name: 'Load', css: 'station-power-line-load' },
    { id: 'charge', unit: 'mA', name: 'Charge', css: 'station-power-line-charge' }
  ];
  const valid = x => typeof x === 'number' && Number.isFinite(x);
  const escapeText = value => String(value).replace(/[&<>"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  })[char]);

  function chartModel(series, now = Date.now(), width = SIZE.width, viewport = null) {
    const availableWidth = valid(width) && width >= 120 ? Math.round(width) : SIZE.width;
    const size = { ...SIZE, width: availableWidth, right: availableWidth - (SIZE.width - SIZE.right) };
    const found = Array.isArray(series) ? series : [];
    const source = new Map(found.filter(s => s && METRICS.some(m => m.id === s.metric?.id))
      .map(s => [s.metric.id, s]));
    const historyEnd = Math.min(now, Math.max(...[...source.values()].map(s => valid(s.end) ? s.end : 0), 0));
    const bounds = { start: historyEnd - DAY, end: historyEnd };
    const minSpan = Math.min(DAY, Math.max(3600000, ...[...source.values()].map(s => valid(s.intervalSeconds) ? s.intervalSeconds * 6000 : 3600000)));
    const { start, end } = navigation.navigationWindow(viewport?.start, viewport?.end, bounds, minSpan);
    const plotWidth = size.right - size.left;
    const seriesPoints = METRICS.map(metric => {
      const input = source.get(metric.id);
      const spacing = valid(input?.intervalSeconds) ? input.intervalSeconds * 1000 : 600000;
      const points = Array.isArray(input?.points) ? input.points : [];
      // Screened, missing and estimated samples do not turn into synthetic lines.
      return { ...metric, spacing, resolution: input?.resolution || null, points: points
        .filter(point => valid(point?.t) && point.t >= bounds.start && point.t <= bounds.end)
        .map(point => ({ t: point.t,
          value: valid(point.value) && !point.estimated ? point.value : null })).sort((a, b) => a.t - b.t) };
    });
    const volts = seriesPoints.filter(s => s.unit === 'V').flatMap(s => s.points)
      .filter(p => valid(p.value)).map(p => p.value);
    const currents = seriesPoints.filter(s => s.unit === 'mA').flatMap(s => s.points)
      .filter(p => valid(p.value)).map(p => p.value);
    const voltsMax = Math.max(15, Math.ceil(Math.max(0, ...volts) / 5) * 5);
    const voltsMin = Math.min(0, Math.floor(Math.min(0, ...volts) / 5) * 5);
    const currentMax = Math.max(50, Math.ceil(Math.max(0, ...currents) / 50) * 50);
    const currentMin = Math.min(0, Math.floor(Math.min(0, ...currents) / 50) * 50);
    const x = t => size.left + (t - start) / (end - start) * plotWidth;
    const y = (value, min, max) => size.bottom - (value - min) /
      Math.max(1, max - min) * (size.bottom - size.top);
    const lines = seriesPoints.map(s => {
      let d = '', previous = null, count = 0, dots = [];
      let segmentStart = null, segmentLength = 0;
      const finishSegment = () => {
        if (segmentLength === 1) dots.push(segmentStart);
        segmentStart = null;
        segmentLength = 0;
        previous = null;
      };
      const lo = s.unit === 'V' ? voltsMin : currentMin;
      const hi = s.unit === 'V' ? voltsMax : currentMax;
      for (const point of s.points) {
        if (!valid(point.value)) { finishSegment(); continue; }
        const px = x(point.t).toFixed(2), py = y(point.value, lo, hi).toFixed(2);
        const continuous = previous && point.t - previous.t <= s.spacing * 1.5;
        if (!continuous) {
          finishSegment();
          segmentStart = { x: px, y: py };
        }
        d += (continuous ? 'L' : 'M') + px + ',' + py;
        segmentLength += 1;
        previous = point; count += 1;
      }
      finishSegment();
      return { ...s, d, count, dots };
    });
    return { lines, size, start, end, bounds, minSpan, voltsMin, voltsMax, currentMin, currentMax,
      count: lines.reduce((n, line) => n + line.count, 0) };
  }

  function svgMarkup(model) {
    const { width, height, left, right, top, bottom } = model.size || SIZE;
    const middle = (left + right) / 2;
    let svg = '';
    for (const x of [left, middle, right]) {
      svg += '<line class="station-power-gridline" x1="' + x + '" x2="' + x +
        '" y1="' + top + '" y2="' + bottom + '"/>';
    }
    for (const fraction of [0, .5, 1]) {
      const y = top + fraction * (bottom - top);
      svg += '<line class="station-power-gridline" x1="' + left + '" x2="' + right +
        '" y1="' + y + '" y2="' + y + '"/>';
    }
    svg += '<text class="station-power-axis" x="1" y="' + (top + 6) + '">' + model.voltsMax + ' V</text>';
    svg += '<text class="station-power-axis" x="1" y="' + (bottom + 3) + '">' + model.voltsMin + ' V</text>';
    svg += '<text class="station-power-axis" x="' + (width - 1) +
      '" y="' + (top + 6) + '" text-anchor="end">' + model.currentMax + ' mA</text>';
    svg += '<text class="station-power-axis" x="' + (width - 1) +
      '" y="' + (bottom + 3) + '" text-anchor="end">' + model.currentMin + ' mA</text>';
    const fullView = model.end - model.start >= DAY - 1;
    const time = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (const [x, label, anchor] of [[left, fullView ? '24h ago' : time.format(model.start), 'start'],
      [middle, fullView ? '12h' : time.format((model.start + model.end) / 2), 'middle'], [right, fullView ? 'Now' : time.format(model.end), 'end']]) {
      svg += '<text class="station-power-axis" x="' + x + '" y="' + (height - 3) +
        '" text-anchor="' + anchor + '">' + label + '</text>';
    }
    svg += '<defs><clipPath id="stationPowerPlotClip"><rect x="' + left + '" y="' + top + '" width="' + (right - left) + '" height="' + (bottom - top) + '"/></clipPath></defs><g clip-path="url(#stationPowerPlotClip)">';
    for (const line of model.lines) {
      if (!line.count) continue;
      svg += '<path class="station-power-series ' + escapeText(line.css) +
        '" d="' + line.d + '"><title>' + escapeText(line.name) + ' (' + line.unit + ')</title></path>';
      for (const dot of line.dots) svg += '<circle class="station-power-single ' + escapeText(line.css) +
        '" cx="' + dot.x + '" cy="' + dot.y + '" r="2.5"/>';
    }
    return svg + '</g>';
  }

  function measuredWidth(chart) {
    return chart.parentElement?.clientWidth || chart.clientWidth || 0;
  }

  function watchResize(chart, state) {
    if (state.watching) return;
    state.watching = true;
    const view = state.doc.defaultView || (typeof window === 'object' ? window : null);
    const redraw = () => {
      const width = measuredWidth(chart);
      // SVG content changes can also notify the observer. Only a changed,
      // visible container width needs another draw, using the cached history.
      if (width >= 120 && Math.round(width) !== state.width) draw(state);
    };
    if (typeof view?.ResizeObserver === 'function') {
      state.observer = new view.ResizeObserver(redraw);
      state.observer.observe(chart.parentElement || chart);
    } else if (view?.addEventListener) {
      view.addEventListener('resize', redraw);
    }
  }

  function draw(state) {
    const { chart, doc } = state, message = doc.getElementById('stationPowerGraphNote');
    const model = chartModel(state.series, Date.now(), measuredWidth(chart), state.controls?.window);
    state.width = model.size.width;
    chart.setAttribute('viewBox', '0 0 ' + model.size.width + ' ' + model.size.height);
    chart.setAttribute('aria-label', 'Weather station power history. Battery and panel on the voltage axis; load and charge on the current axis. Missing measurements are gaps.');
    chart.innerHTML = svgMarkup(model);
    state.controls?.present({ svg: chart, ...model.size });
    if (message) {
      const active = model.lines.filter(line => line.count > 0).length;
      const resolutions = [...new Set(model.lines.filter(line => line.count).map(line =>
        line.resolution === 'hourly' ? 'hourly' : '10-minute'))];
      message.textContent = active
        ? active + ' of 4 traces · ' + resolutions.join(' / ') + ' history · AEST'
        : 'No recorded station power history in this window.';
    }
    watchResize(chart, state);
    return model;
  }

  function render(series, doc = typeof document !== 'undefined' ? document : null) {
    const card = doc?.getElementById('stationPower'), chart = doc?.getElementById('stationPowerChart');
    if (!card || !chart) return null;
    const state = renderStates.get(chart) || { doc, chart, watching: false };
    state.series = series;
    const controls = doc.defaultView?.MoorePowerChartControls;
    if (!state.controls && controls && chart.parentElement?.ownerDocument) {
      state.controls = controls.create({ plot: chart.parentElement, prefix: 'stationPower', label: 'Weather Station Power', redraw: () => draw(state) });
    }
    if (state.controls) {
      const model = chartModel(series, Date.now(), measuredWidth(chart)), observations = new Map();
      for (const line of model.lines) for (const point of line.points) {
        if (!observations.has(point.t)) observations.set(point.t, new Map());
        observations.get(point.t).set(line.id, point.value);
      }
      state.controls.setData({ bounds: model.bounds, minSpan: model.minSpan, domainKey: '24h',
        items: [...observations].map(([t, values]) => ({ t, values: METRICS.map(metric => ({
          name: metric.name, unit: metric.unit, precision: metric.unit === 'mA' ? 1 : 2, value: values.get(metric.id) ?? null })) })) });
    }
    renderStates.set(chart, state);
    return draw(state);
  }

  if (typeof window === 'object' && window.addEventListener) {
    window.addEventListener('moore-weather-station-trends', event => render(event.detail?.series));
  }
  return { chartModel, svgMarkup, render };
});
