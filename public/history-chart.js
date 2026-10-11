(function (root) {
  'use strict';
  function segments(points, direction = false) {
    const result = [];
    let segment = [];
    for (const point of points) {
      if (point.value === null || (direction && segment.length && Math.abs(point.value - segment.at(-1).value) > 180)) {
        if (segment.length) result.push(segment);
        segment = [];
      }
      if (point.value !== null) segment.push(point);
    }
    if (segment.length) result.push(segment);
    return result;
  }
  function domain(series) {
    if (series.metric.kind === 'direction') return [0, 360];
    const values = series.points.flatMap(p => p.value === null ? [] : [p.value, p.min, p.max].filter(v => v !== null));
    if (!values.length) return [0, 1];
    let min = Math.min(...values), max = Math.max(...values);
    const pad = Math.max((max - min) * .16, Math.abs(max) * .0005, 10 ** -series.metric.precision);
    min -= pad; max += pad;
    if (series.metric.kind === 'bar') { min = Math.min(0, min); max = Math.max(0, max); }
    if (['rain', 'solar', 'wind', 'gust', 'humidity'].includes(series.metric.id) || series.metric.id.startsWith('soil-moisture')) min = Math.max(0, min);
    return [min, max];
  }
  const api = { segments, domain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WeatherChart = api;
})(typeof window !== 'undefined' ? window : globalThis);
