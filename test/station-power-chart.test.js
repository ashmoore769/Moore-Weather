'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const chart = require('../public/station-power-chart');

const NOW = Date.parse('2026-11-17T09:00:00.000Z');
function readings(id, values, resolution = '10m') {
  const step = resolution === '10m' ? 600000 : 3600000;
  return {
    metric: { id }, resolution, intervalSeconds: step / 1000, end: NOW, start: NOW - values.length * step,
    points: values.map((value, i) => ({
      t: NOW - (values.length - i - 1) * step,
      value, estimated: false
    }))
  };
}
function four() {
  return [
    readings('battery', [13.1, 13.2, null, 13.4, 13.6]),
    readings('panel', [0.2, 12, 18, 20, 17]),
    readings('load', [40, 42, 45, 44, 46]),
    readings('charge', [0, 10, 210, 360, 140])
  ];
}

test('renders four weather station power traces with honest voltage/current axes', () => {
  const result = chart.chartModel(four(), NOW);
  assert.equal(result.lines.length, 4);
  assert.ok(result.voltsMax >= 20);
  assert.ok(result.currentMax >= 360);
  assert.equal(result.lines.find(s => s.id === 'battery').count, 4);
  const svg = chart.svgMarkup(result);
  for (const id of ['battery', 'panel', 'load', 'charge'])
    assert.match(svg, new RegExp('station-power-line-' + id));
  assert.match(svg, /mA/);
  assert.match(svg, / V/);
  assert.equal(result.lines.find(s => s.id === 'battery').d.match(/M/g).length, 2,
    'missing time intervals split the line instead of being interpolated');
});

test('estimated and invalid values are not turned into station power graph measurements', () => {
  const invalid = four();
  invalid[0].points[1].estimated = true;
  invalid[0].points[3].value = Infinity;
  const result = chart.chartModel(invalid, NOW);
  assert.equal(result.lines[0].count, 2);
  assert.equal(result.lines[0].d.match(/M/g).length, 2);
  assert.equal(chart.chartModel([], NOW).count, 0);
});

test('isolated station measurements remain visible around gaps without connecting them', () => {
  const result = chart.chartModel([
    readings('battery', [13.1, null, 13.2, 13.3, null, 13.4]),
    readings('panel', [11, 12, 13, 14, 15, 16])
  ], NOW);
  const battery = result.lines.find(line => line.id === 'battery');
  const panel = result.lines.find(line => line.id === 'panel');
  assert.equal(battery.count, 4);
  assert.equal(battery.d.match(/M/g).length, 3, 'two singletons and one connected pair');
  assert.equal(battery.d.match(/L/g).length, 1, 'only the adjacent measurements are connected');
  assert.equal(battery.dots.length, 2, 'each isolated segment receives its own marker');
  assert.equal(panel.dots.length, 0, 'another complete series stays a continuous trace');
  const svg = chart.svgMarkup(result);
  assert.equal((svg.match(/<circle class="station-power-single station-power-line-battery"/g) || []).length, 2);
  assert.doesNotMatch(svg, /<circle class="station-power-single station-power-line-panel"/);
});

test('sparse station observations appear as dots even when missing timestamps have no rows', () => {
  const sparse = readings('battery', [12.9, 13.1, 13.3]);
  sparse.points.forEach((point, i) => { point.t = NOW - (2 - i) * 3 * 600000; });
  const result = chart.chartModel([sparse], NOW);
  assert.equal(result.lines[0].dots.length, 3);
  assert.doesNotMatch(result.lines[0].d, /L/, 'outage gaps must not be bridged');
  assert.equal((chart.svgMarkup(result).match(/<circle /g) || []).length, 3);

  const one = chart.chartModel([readings('battery', [13.1])], NOW);
  assert.equal((chart.svgMarkup(one).match(/<circle /g) || []).length, 1);
  const missing = readings('battery', [null, 13.1, Infinity]);
  missing.points[1].estimated = true;
  assert.equal(chart.chartModel([missing], NOW).count, 0);
  assert.doesNotMatch(chart.svgMarkup(chart.chartModel([missing], NOW)), /<circle /);
});

test('station plots use the available width while preserving pixel-sized axes and height', () => {
  const source = readings('battery', [10, 12, 14]);
  source.intervalSeconds = 12 * 3600;
  source.points.forEach((point, i) => { point.t = NOW - (2 - i) * 12 * 3600000; });
  const phone = chart.chartModel([source], NOW, 350);
  const wide = chart.chartModel([source], NOW, 1320);
  const coordinates = model => [...model.lines[0].d.matchAll(/[ML]([\d.]+),([\d.]+)/g)]
    .map(match => [Number(match[1]), Number(match[2])]);
  assert.deepEqual(coordinates(phone).map(point => point[0]), [45, 175, 305]);
  assert.deepEqual(coordinates(wide).map(point => point[0]), [45, 660, 1275]);
  assert.deepEqual(coordinates(phone).map(point => point[1]), coordinates(wide).map(point => point[1]),
    'resizing changes only the time-axis width, not the vertical scale');
  for (const model of [phone, wide]) {
    assert.equal(model.size.height, 134);
    assert.equal(model.size.left, 45);
    assert.equal(model.size.width - model.size.right, 45);
    assert.match(chart.svgMarkup(model), new RegExp('x="' + (model.size.width - 1) + '" y="18" text-anchor="end"'));
    assert.equal(model.count, 3);
  }
  assert.equal(chart.chartModel([source], NOW).size.width, 720);
  assert.equal(chart.chartModel([source], NOW, NaN).size.width, 720);
});

test('station zoom changes only the viewport and clips unchanged readings and gaps to the plot', () => {
  const input = four().map(series => ({ ...series, points: Array.from({ length: 144 }, (_, i) => ({
    t: NOW - (143 - i) * 600000, value: i === 72 ? null : series.points.at(-1).value, estimated: i === 80
  })) }));
  const original = structuredClone(input), full = chart.chartModel(input, NOW, 393);
  const zoomed = chart.chartModel(input, NOW, 393, { start: NOW - 12 * 3600000, end: NOW - 6 * 3600000 });
  assert.equal(zoomed.end - zoomed.start, 6 * 3600000);
  assert.deepEqual(zoomed.bounds, full.bounds, 'navigation cannot extend the fetched history');
  assert.deepEqual([zoomed.voltsMin, zoomed.voltsMax, zoomed.currentMin, zoomed.currentMax],
    [full.voltsMin, full.voltsMax, full.currentMin, full.currentMax], 'both units keep stable scales');
  for (let i = 0; i < full.lines.length; i++) {
    assert.equal(zoomed.lines[i].count, full.lines[i].count, 'zoom never resamples or invents observations');
    assert.equal((zoomed.lines[i].d.match(/M/g) || []).length, (full.lines[i].d.match(/M/g) || []).length,
      'missing and estimated values remain independent gaps');
    assert.match(zoomed.lines[i].d, /M-/, 'real samples outside the window remain available at the clipped edges');
  }
  assert.match(chart.svgMarkup(zoomed), /clip-path="url\(#stationPowerPlotClip\)"/);
  assert.match(chart.svgMarkup(zoomed), /<rect x="45" y="12" width="303" height="94"/);
  const smallest = chart.chartModel(input, NOW, 393, { start: NOW - 1000, end: NOW });
  assert.equal(smallest.end - smallest.start, 3600000, 'ten-minute observations stop at a one-hour view');
  assert.ok(smallest.start >= full.bounds.start && smallest.end <= full.bounds.end);
  assert.deepEqual(input, original, 'navigation leaves the fetched data unchanged');
});

test('station resize redraws the latest history once per changed visible width', () => {
  let writes = 0, markup = '';
  const attributes = {}, callbacks = [], observed = [];
  const container = { clientWidth: 350 };
  const drawing = {
    parentElement: container,
    setAttribute(name, value) { attributes[name] = value; },
    set innerHTML(value) { markup = value; writes += 1; }
  };
  const note = { textContent: '' };
  const doc = {
    defaultView: { ResizeObserver: class {
      constructor(callback) { callbacks.push(callback); }
      observe(target) { observed.push(target); }
    } },
    getElementById(id) {
      return { stationPower: {}, stationPowerChart: drawing, stationPowerGraphNote: note }[id];
    }
  };
  const liveNow = Date.now() - 1000;
  const live = four().map(series => ({ ...series, end: liveNow,
    points: series.points.map(point => ({ ...point, t: liveNow + point.t - NOW })) }));
  chart.render(live, doc);
  assert.equal(attributes.viewBox, '0 0 350 134');
  assert.deepEqual(observed, [container]);
  callbacks[0]();
  assert.equal(writes, 1, 'initial and content-only observer notifications do not loop');
  container.clientWidth = 1320;
  callbacks[0]();
  assert.equal(attributes.viewBox, '0 0 1320 134');
  assert.equal(writes, 2);
  container.clientWidth = 0;
  callbacks[0]();
  assert.equal(writes, 2, 'hidden containers wait until a visible width is available');

  container.clientWidth = 1320;
  chart.render([live[0]], doc);
  container.clientWidth = 393;
  callbacks[0]();
  assert.equal(attributes.viewBox, '0 0 393 134');
  assert.equal((markup.match(/<path class="station-power-series /g) || []).length, 1,
    'resizing uses the most recent series, without reviving old measurements');
  assert.match(note.textContent, /^1 of 4 traces/);
  assert.equal(callbacks.length, 1, 'regular updates do not add resize observers');
  assert.equal(writes, 4);
});

test('composite chart uses the existing station history signal, not extra polling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'history.js'), 'utf8');
  const module = fs.readFileSync(path.join(__dirname, '..', 'public', 'station-power-chart.js'), 'utf8');
  assert.match(source, /moore-weather-station-trends/);
  assert.doesNotMatch(module, /fetch\s*\(|XMLHttpRequest|WebSocket/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const root = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal(html, root);
  assert.match(html, /Weather Station Power/);
  assert.ok(html.indexOf('id="stationPower"') < html.indexOf('id="yardPower"'));
  assert.match(html, /power-cards\.css/);
  assert.match(html, /station-power-chart\.js/);
});
