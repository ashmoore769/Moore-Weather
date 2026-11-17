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
