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
