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

  // Least squares uses elapsed time, not array position. Estimated/missing
  // observations never influence the fit. No extrapolation beyond observations.
  function fittedTrend(series) {
    const points = series.points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.value) && !p.estimated).sort((a,b)=>a.t-b.t);
    if (points.length < 3 || points[0].t === points.at(-1).t) return [];
    const start=points[0].t, span=points.at(-1).t-start;
    const xs=points.map(p=>(p.t-start)/span), meanX=xs.reduce((a,b)=>a+b,0)/xs.length;
    const variance=xs.reduce((sum,x)=>sum+(x-meanX)**2,0);
    function fit(values) {
      const mean=values.reduce((a,b)=>a+b,0)/values.length;
      const slope=xs.reduce((sum,x,i)=>sum+(x-meanX)*(values[i]-mean),0)/variance;
      return x=>mean+slope*(x-meanX);
    }
    if(series.metric.kind !== 'direction') {
      const line=fit(points.map(p=>p.value));
      return [{t:start,value:line(0)},{t:start+span,value:line(1)}];
    }
    // Regress unit vectors so 359° and 1° remain neighbours. Where opposing
    // winds cancel, the direction is undefined and the fitted curve has a gap.
    const east=fit(points.map(p=>Math.sin(p.value*Math.PI/180)));
    const north=fit(points.map(p=>Math.cos(p.value*Math.PI/180)));
    return Array.from({length:129},(_,i)=>{
      const x=i/128, e=east(x), n=north(x);
      return {t:start+span*x,value:Math.hypot(e,n)<.1 ? null : (Math.atan2(e,n)*180/Math.PI+360)%360};
    });
  }
  const HOUR = 3600000;
  const resolutions = {
    '10m': { step: HOUR / 6, maxHours: 168 },
    hourly: { step: HOUR, maxHours: 744 },
    daily: { step: 24 * HOUR, maxHours: 17520 }
  };
  // Keep navigation within the existing API limits. Whole native periods are
  // essential for totals: daily rain cannot be split into invented hourly rain.
  function navigationWindow(start, end, supported, now = Date.now(), preferred) {
    const available = Object.keys(resolutions).filter(r => supported.includes(r));
    const requestedHours = Math.max(1, (end - start) / HOUR);
    const resolution = available.includes(preferred) && requestedHours <= resolutions[preferred].maxHours ? preferred :
      available.find(r => requestedHours <= resolutions[r].maxHours) || available.at(-1);
    const spec = resolutions[resolution];
    const quantum = resolution === 'daily' ? 24 : 1;
    const hours = Math.min(spec.maxHours, Math.max(quantum, Math.round(requestedHours / quantum) * quantum));
    const offset = resolution === 'daily' ? 23 * HOUR : 0;
    const latest = Math.floor((now - offset) / spec.step) * spec.step + offset;
    const earliest = Date.UTC(2000, 0, 1) + hours * HOUR;
    const finish = Math.max(earliest, Math.min(latest, Math.round((end - offset) / spec.step) * spec.step + offset));
    return { resolution, hours, start: finish - hours * HOUR, end: finish };
  }
  function visibleSeries(series, start, end) {
    const points = series.points.filter(p => p.t > start && p.t <= end);
    const valid = points.filter(p => Number.isFinite(p.value));
    return { ...series, start, end, points, latest: valid.at(-1) || null,
      missing: Math.max(0, Math.round((end - start) / (series.intervalSeconds * 1000)) - valid.length) };
  }
  function summary(series) {
    const m = series.metric, valid = series.points.filter(p => Number.isFinite(p.value));
    const period = { '10m': '10-minute', hourly: 'hourly', daily: 'daily' }[series.resolution];
    const noun = ({ air: 'temperature', globe: 'temperature', ground: 'temperature', dew: 'dew point',
      humidity: 'humidity', pressure: 'pressure', wind: 'wind speed', gust: 'wind gust', solar: 'solar radiation',
      rain: 'rainfall', battery: 'voltage', panel: 'voltage', load: 'load', charge: 'current', evaporation: 'evaporation rate',
      'evaporation-total': 'evaporation' })[m.id] || (m.id.startsWith('soil-temp') ? 'temperature' : 'soil moisture');
    if (m.kind === 'direction') return [['Latest wind direction', series.latest?.value], ['Available readings', valid.length, ''], ['Missing readings', series.missing, '']];
    const extreme = (stat, label) => {
      const recorded = valid.some(p => Number.isFinite(p[stat]));
      const values = valid.map(p => recorded ? p[stat] : p.value).filter(Number.isFinite);
      const detail = m.aggregation === 'TOTAL' ? `${period} ${noun}` : recorded ? noun :
        m.aggregation === 'AVERAGE' ? `${period} average` : m.aggregation === 'MINIMUM' ? `${period} minimum voltage` :
          m.aggregation === 'MAXIMUM' ? `${period} peak gust` : noun;
      return [`${label} ${detail}`, values.length ? Math[stat](...values) : null];
    };
    const items = [[`Latest ${noun}`, series.latest?.value], extreme('min', 'Lowest'), extreme('max', 'Highest')];
    if (m.id === 'rain') {
      const measured = valid.filter(p => !p.estimated);
      const incomplete = series.missing > 0 || measured.length !== valid.length;
      items.unshift([incomplete ? 'Recorded rainfall (incomplete)' : 'Total rainfall', measured.length ? measured.reduce((sum, p) => sum + p.value, 0) : null]);
    }
    return items;
  }
  const api = { segments, domain, fittedTrend, navigationWindow, visibleSeries, summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WeatherChart = api;
})(typeof window !== 'undefined' ? window : globalThis);
