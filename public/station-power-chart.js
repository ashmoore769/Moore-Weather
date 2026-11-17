/* Weather Station Power composite preview. Reuses the existing authenticated /api/trends response. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MooreStationPowerChart = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const SIZE = { width: 720, height: 134, left: 45, right: 675, top: 12, bottom: 106 };
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

  function chartModel(series, now = Date.now()) {
    const found = Array.isArray(series) ? series : [];
    const source = new Map(found.filter(s => s && METRICS.some(m => m.id === s.metric?.id))
      .map(s => [s.metric.id, s]));
    const end = Math.min(now, Math.max(...[...source.values()].map(s => valid(s.end) ? s.end : 0), 0));
    const start = end - DAY;
    const plotWidth = SIZE.right - SIZE.left;
    const seriesPoints = METRICS.map(metric => {
      const input = source.get(metric.id);
      const spacing = valid(input?.intervalSeconds) ? input.intervalSeconds * 1000 : 600000;
      const points = Array.isArray(input?.points) ? input.points : [];
      // Screened, missing and estimated samples do not turn into synthetic lines.
      return { ...metric, spacing, resolution: input?.resolution || null, points: points
        .filter(point => valid(point?.t) && point.t >= start && point.t <= end)
        .map(point => ({ t: point.t,
          value: valid(point.value) && !point.estimated ? point.value : null })) };
    });
    const volts = seriesPoints.filter(s => s.unit === 'V').flatMap(s => s.points)
      .filter(p => valid(p.value)).map(p => p.value);
    const currents = seriesPoints.filter(s => s.unit === 'mA').flatMap(s => s.points)
      .filter(p => valid(p.value)).map(p => p.value);
    const voltsMax = Math.max(15, Math.ceil(Math.max(0, ...volts) / 5) * 5);
    const voltsMin = Math.min(0, Math.floor(Math.min(0, ...volts) / 5) * 5);
    const currentMax = Math.max(50, Math.ceil(Math.max(0, ...currents) / 50) * 50);
    const currentMin = Math.min(0, Math.floor(Math.min(0, ...currents) / 50) * 50);
    const x = t => SIZE.left + Math.max(0, Math.min(1, (t - start) / DAY)) * plotWidth;
    const y = (value, min, max) => SIZE.bottom - (value - min) /
      Math.max(1, max - min) * (SIZE.bottom - SIZE.top);
    const lines = seriesPoints.map(s => {
      let d = '', previous = null, count = 0, dots = [];
      const lo = s.unit === 'V' ? voltsMin : currentMin;
      const hi = s.unit === 'V' ? voltsMax : currentMax;
      for (const point of s.points) {
        if (!valid(point.value)) { previous = null; continue; }
        const px = x(point.t).toFixed(2), py = y(point.value, lo, hi).toFixed(2);
        const continuous = previous && point.t - previous.t <= s.spacing * 1.5;
        d += (continuous ? 'L' : 'M') + px + ',' + py;
        if (!continuous) dots.push({ x: px, y: py });
        previous = point; count += 1;
      }
      return { ...s, d, count, dots };
    });
    return { lines, start, end, voltsMin, voltsMax, currentMin, currentMax,
      count: lines.reduce((n, line) => n + line.count, 0) };
  }

  function svgMarkup(model) {
    const { width, height, left, right, top, bottom } = SIZE;
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
    svg += '<text class="station-power-axis" x="1" y="18">' + model.voltsMax + ' V</text>';
    svg += '<text class="station-power-axis" x="1" y="' + (bottom + 3) + '">' + model.voltsMin + ' V</text>';
    svg += '<text class="station-power-axis" x="' + (width - 1) +
      '" y="18" text-anchor="end">' + model.currentMax + ' mA</text>';
    svg += '<text class="station-power-axis" x="' + (width - 1) +
      '" y="' + (bottom + 3) + '" text-anchor="end">' + model.currentMin + ' mA</text>';
    for (const [x, label, anchor] of [[left, '24h ago', 'start'],
      [middle, '12h', 'middle'], [right, 'Now', 'end']]) {
      svg += '<text class="station-power-axis" x="' + x + '" y="' + (height - 3) +
        '" text-anchor="' + anchor + '">' + label + '</text>';
    }
    for (const line of model.lines) {
      if (!line.count) continue;
      svg += '<path class="station-power-series ' + escapeText(line.css) +
        '" d="' + line.d + '"><title>' + escapeText(line.name) + ' (' + line.unit + ')</title></path>';
      if (line.count === 1) {
        for (const dot of line.dots) svg += '<circle class="station-power-single ' + escapeText(line.css) +
          '" cx="' + dot.x + '" cy="' + dot.y + '" r="2.5"/>';
      }
    }
    return svg;
  }

  function render(series, doc = typeof document !== 'undefined' ? document : null) {
    const card = doc?.getElementById('stationPower');
    const chart = doc?.getElementById('stationPowerChart');
    const message = doc?.getElementById('stationPowerGraphNote');
    if (!card || !chart) return null;
    const model = chartModel(series);
    chart.setAttribute('viewBox', '0 0 ' + SIZE.width + ' ' + SIZE.height);
    chart.setAttribute('aria-label', 'Weather station power 24-hour trends. Battery and panel on the voltage axis; load and charge on the current axis. Missing measurements are gaps.');
    chart.innerHTML = svgMarkup(model);
    if (message) {
      const active = model.lines.filter(line => line.count > 0).length;
      const resolutions = [...new Set(model.lines.filter(line => line.count).map(line =>
        line.resolution === 'hourly' ? 'hourly' : '10-minute'))];
      message.textContent = active
        ? active + ' of 4 traces · ' + resolutions.join(' / ') + ' history · AEST'
        : 'No recorded station power history in this window.';
    }
    return model;
  }

  if (typeof window === 'object' && window.addEventListener) {
    window.addEventListener('moore-weather-station-trends', event => render(event.detail?.series));
  }
  return { chartModel, svgMarkup, render };
});
