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
  const api = { segments, domain, fittedTrend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WeatherChart = api;
})(typeof window !== 'undefined' ? window : globalThis);
