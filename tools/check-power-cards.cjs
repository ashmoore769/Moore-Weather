'use strict';
// Offline browser review of the real dashboard markup with synthetic readings.
// No Render, EPEVER, Pi, logger or outside websites are contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '../public');
const artifacts = path.resolve(__dirname, '../artifacts/dashboard');
const now = Date.now(), HOUR = 3600000, MINUTE = 60000;
let mode = 'fresh', historyMode = 'continuous', requests = 0, dataRequests = 0;
const dashboard = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (tag, attributes) =>
    /\bsrc="\/(?:station-power-chart|yard-power|theme)\.js\b/.test(attributes) ? tag : '');

const template = timestamp => ({
  observedAt: new Date(timestamp).toISOString(),
  collectedAt: new Date(timestamp).toISOString(),
  receivedAt: new Date(timestamp + 1000).toISOString(),
  batteryVoltageV: 13.2 + Math.sin(timestamp / HOUR) * .4,
  pvVoltageV: Math.max(.4, Math.sin(timestamp / (12 * HOUR)) * 21),
  pvPowerW: Math.max(0, Math.sin(timestamp / (12 * HOUR)) * 180),
  chargeCurrentA: .2, controllerLoadPowerW: 1.6,
  controllerTempC: 32, pvCurrentA: 3.3, controllerLoadCurrentA: .12, chargingPowerW: 80
});
// Match the collector's one-minute observations. Ten-minute fixture points all
// exceed the 24-hour chart's gap threshold and cannot verify connected traces.
const history = Array.from({ length: 1440 }, (_, i) => template(now - 24 * HOUR + (i + 1) * MINUTE));
const sparseYardHistory = [-60, -50, -40, -39, -30, -29, -28].map(offset => ({
  ...template(now + offset * MINUTE),
  // Only the PV series breaks inside the final group; other series stay joined.
  ...(offset === -29 ? { pvVoltageV: null } : {})
}));
const station = ['battery', 'panel', 'load', 'charge'].map((id, index) => ({
  metric: { id }, resolution: '10m', intervalSeconds: 600, start: now - 24 * HOUR, end: now,
  points: Array.from({ length: 144 }, (_, i) => ({
    t: now - 24 * HOUR + (i + 1) * 10 * MINUTE,
    value: i === 49 ? null : index === 0 ? 13.2 + i / 500 :
      index === 1 ? 10 + Math.sin(i / 13) * 9 :
        index === 2 ? 45 + i % 9 : Math.max(0, Math.sin(i / 18) * 260),
    estimated: false
  }))
}));
const sparseStation = station.map((series, index) => ({
  ...series,
  points: [-120, -90, -60, -50, -30, -20, -10].map((offset, i) => ({
    t: now + offset * MINUTE,
    value: index === 1 && offset === -20 ? null : index < 2 ? 12 + i / 10 : 30 + i,
    estimated: false
  }))
}));

// A path element alone is not evidence of a visible line. Inspect real SVG
// geometry and the final CSS cascade so a zero-length or filled trace fails CI.
async function chartGeometry(page) {
  return page.evaluate(() => {
    const inspect = selector => {
      const style = element => {
        const css = getComputedStyle(element), box = element.getBoundingClientRect();
        return { fill: css.fill, stroke: css.stroke, strokeWidth: parseFloat(css.strokeWidth),
          fillOpacity: parseFloat(css.fillOpacity), strokeOpacity: parseFloat(css.strokeOpacity),
          opacity: parseFloat(css.opacity), visibility: css.visibility, display: css.display,
          width: box.width, height: box.height };
      };
      const chart = document.querySelector(selector);
      const svg = chart instanceof SVGSVGElement ? chart : chart.querySelector('svg');
      const viewport = svg.getBoundingClientRect();
      return {
        svg: { viewportWidth: viewport.width, viewportHeight: viewport.height,
          hostWidth: svg.parentElement.getBoundingClientRect().width,
          viewBoxWidth: svg.viewBox.baseVal.width, viewBoxHeight: svg.viewBox.baseVal.height },
        labels: [...chart.querySelectorAll('text')].map(element => {
          const matrix = element.getScreenCTM(), fontSize = parseFloat(getComputedStyle(element).fontSize);
          const scale = matrix ? Math.min(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)) : 0;
          return { text: element.textContent, renderedFontSize: fontSize * scale };
        }),
        paths: [...chart.querySelectorAll('path')].map(element => {
          const d = element.getAttribute('d') || '';
          return { ...style(element), classes: [...element.classList],
            moves: (d.match(/M/g) || []).length, joins: (d.match(/L/g) || []).length,
            length: element.getTotalLength() };
        }),
        dots: [...chart.querySelectorAll('circle')].map(element => ({
          ...style(element), classes: [...element.classList], radius: Number(element.getAttribute('r'))
        }))
      };
    };
    return { station: inspect('#stationPowerChart'), yard: inspect('#yardPowerChart') };
  });
}

async function waitForFittedCharts(page) {
  await page.waitForFunction(() => ['#stationPowerChart', '#yardPowerChart svg'].every(selector => {
    const svg = document.querySelector(selector);
    return svg && svg.querySelector('path') &&
      Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) <= 1 &&
      Math.abs(svg.viewBox.baseVal.width - svg.parentElement.getBoundingClientRect().width) <= 1;
  }), null, { timeout: 5000 });
}

function assertResponsiveChart(chart, description) {
  assert.ok(Math.abs(chart.svg.viewBoxWidth - chart.svg.viewportWidth) <= 1 &&
    Math.abs(chart.svg.viewBoxWidth - chart.svg.hostWidth) <= 1,
    description + ': viewBox must fit the actual chart/container width: ' + JSON.stringify(chart.svg));
  assert.ok(Math.abs(chart.svg.viewportHeight - 134) <= 1 && chart.svg.viewBoxHeight === 134,
    description + ': the compact graph height must remain 134px');
  assert.ok(chart.labels.length >= 6, description + ': both scales and time labels are present');
  for (const label of chart.labels) {
    assert.ok(label.renderedFontSize >= 9,
      description + ': axis text must remain at least 9px on screen: ' + JSON.stringify(label));
  }
  assert.ok(Math.max(...chart.paths.map(trace => trace.width)) >= chart.svg.viewportWidth - 120,
    description + ': the plot must use the available chart width');
}

function assertVisibleLines(chart, description) {
  assert.equal(chart.paths.length, 4, description + ': all four series are present');
  for (const trace of chart.paths) {
    assert.ok(trace.joins > 0 && trace.length > 0 && trace.width > 0,
      description + ': each trace must contain a visible connected segment: ' + JSON.stringify(trace));
    assert.equal(trace.fill, 'none', description + ': line paths must not become filled polygons');
    assert.notEqual(trace.stroke, 'none', description + ': each trace needs a visible stroke');
    assert.ok(trace.strokeWidth > 0 && trace.strokeOpacity > 0 && trace.opacity > 0,
      description + ': trace stroke must be painted');
    assert.equal(trace.visibility, 'visible');
    assert.notEqual(trace.display, 'none');
  }
}

function assertSparseGeometry(chart, description, panelClass) {
  assertVisibleLines(chart, description);
  for (const trace of chart.paths) {
    const isPanel = trace.classes.includes(panelClass);
    assert.equal(trace.moves, isPanel ? 5 : 4,
      description + ': time gaps and per-series missing values must start new segments');
    assert.equal(trace.joins, isPanel ? 1 : 3,
      description + ': only neighbouring valid measurements may be connected');
  }
  assert.equal(chart.dots.length, 10, description + ': every singleton segment remains visible');
  const seriesClasses = panelClass === 'yard-line-panel'
    ? [null, 'yard-line-panel', 'yard-line-power', 'yard-line-load']
    : ['station-power-line-battery', 'station-power-line-panel', 'station-power-line-load', 'station-power-line-charge'];
  for (const seriesClass of seriesClasses) {
    const count = chart.dots.filter(dot => seriesClass ? dot.classes.includes(seriesClass)
      : !seriesClasses.filter(Boolean).some(css => dot.classes.includes(css))).length;
    assert.equal(count, seriesClass === panelClass ? 4 : 2,
      description + ': correct isolated-point count for ' + (seriesClass || 'battery'));
  }
  for (const dot of chart.dots) {
    assert.ok(dot.radius > 0 && dot.width > 0 && dot.height > 0,
      description + ': isolated readings have nonzero rendered circles');
    assert.ok((dot.fill !== 'none' && dot.fillOpacity > 0) ||
      (dot.stroke !== 'none' && dot.strokeWidth > 0 && dot.strokeOpacity > 0),
      description + ': isolated readings have a painted fill or stroke');
    assert.ok(dot.opacity > 0);
    assert.equal(dot.visibility, 'visible');
    assert.notEqual(dot.display, 'none');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) dataRequests++;
  if (url.pathname === '/api/yard-power') {
    requests++;
    const current = template(now - (mode === 'stale' ? 12 : 1) * MINUTE);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ enabled: true, status: mode === 'stale' ? 'stale' : 'fresh',
      current, staleAfterSeconds: 180, timezone: 'Australia/Brisbane',
      range: url.searchParams.get('range') || null,
      history: url.searchParams.has('range') ? (historyMode === 'sparse' ? sparseYardHistory : history) : null }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(dashboard); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const { width, layout, yardColumns, stationColumns } of [
          { width: 393, layout: 'portrait', yardColumns: 2, stationColumns: 2 },
          { width: 1100, layout: 'portrait', yardColumns: 3, stationColumns: 2 },
          { width: 1440, layout: 'landscape', yardColumns: 6, stationColumns: 4 }
        ]) {
          const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          try {
            await page.goto(origin + '/index.html');
            await page.waitForFunction(() => !document.getElementById('yardPower').hidden);
            await page.evaluate(layout => {
              document.body.classList.add('layout-' + layout);
              document.documentElement.dataset.theme = 'dark';
            }, layout);
            await page.waitForFunction(() => document.getElementById('yardPowerHistoryDetail').textContent.includes('recorded intervals'));
            const before = requests;
            await page.evaluate(series => window.dispatchEvent(new CustomEvent('moore-weather-station-trends',
              { detail: { series } })), station);
            assert.equal(requests, before, 'station composite reuses history rather than fetching more data');
            await page.waitForFunction(() => document.querySelectorAll('#yardPowerChart path.yard-line').length >= 4);
            await waitForFittedCharts(page);
            const visual = await page.evaluate(() => {
              const yard = document.getElementById('yardPower');
              const station = document.getElementById('stationPower');
              const gridCount = selector => getComputedStyle(document.querySelector(selector)).gridTemplateColumns.trim().split(/\s+/).length;
              const bbox = el => { const b = el.getBoundingClientRect(); return { x: b.x, right: b.right, width: b.width, height: b.height }; };
              return {
                yardColumns: gridCount('#yardPower .yard-power-grid'),
                stationColumns: gridCount('#stationPower .metric-list'),
                yardMetrics: document.querySelectorAll('#yardPower .yard-power-metric').length,
                stationMetrics: document.querySelectorAll('#stationPower .metric-row').length,
                stationTraces: document.querySelectorAll('#stationPowerChart path.station-power-series').length,
                yardTraces: document.querySelectorAll('#yardPowerChart path.yard-line').length,
                station: bbox(station), yard: bbox(yard),
                viewportWidth: document.documentElement.clientWidth
              };
            });
            assert.equal(visual.yardColumns, yardColumns, JSON.stringify(visual));
            assert.equal(visual.stationColumns, stationColumns, JSON.stringify(visual));
            assert.equal(visual.yardMetrics, 6);
            assert.equal(visual.stationMetrics, 4);
            assert.equal(visual.stationTraces, 4);
            assert.equal(visual.yardTraces, 4);
            const connected = await chartGeometry(page);
            assertVisibleLines(connected.station, 'Station Power continuous history');
            assertVisibleLines(connected.yard, 'Yard Power one-minute history');
            assertResponsiveChart(connected.station, 'Station Power at ' + width + 'px');
            assertResponsiveChart(connected.yard, 'Yard Power at ' + width + 'px');
            for (const card of [visual.yard, visual.station]) {
              assert.ok(card.x >= -1 && card.right <= width + 1, 'Card must not overflow the page: ' + JSON.stringify(visual));
            }
            assert.ok(visual.yard.height < (width === 1440 ? 410 : width === 1100 ? 495 : 600),
              'Yard Power should remain compact for the available column width: ' + JSON.stringify(visual));
            assert.deepEqual(errors, [], 'No browser exceptions');
            if (width === 1440) {
              const beforeResize = dataRequests;
              await page.setViewportSize({ width: 393, height: 900 });
              await page.evaluate(() => document.body.classList.replace('layout-landscape', 'layout-portrait'));
              await waitForFittedCharts(page);
              const narrow = await chartGeometry(page);
              for (const key of ['station', 'yard']) {
                assertVisibleLines(narrow[key], key + ' after narrowing');
                assertResponsiveChart(narrow[key], key + ' after narrowing');
                assert.ok(narrow[key].svg.viewportWidth < connected[key].svg.viewportWidth / 2,
                  key + ': resize must exercise a substantially narrower chart');
              }
              assert.equal(dataRequests, beforeResize, 'Narrowing charts must reuse cached readings without a data request');
              await page.setViewportSize({ width: 1440, height: 900 });
              await page.evaluate(() => document.body.classList.replace('layout-portrait', 'layout-landscape'));
              await waitForFittedCharts(page);
              const restored = await chartGeometry(page);
              for (const key of ['station', 'yard']) {
                assertVisibleLines(restored[key], key + ' after widening');
                assertResponsiveChart(restored[key], key + ' after widening');
                assert.ok(Math.abs(restored[key].svg.viewportWidth - connected[key].svg.viewportWidth) <= 1,
                  key + ': widening must restore the original chart width');
              }
              assert.equal(dataRequests, beforeResize, 'Widening charts must reuse cached readings without a data request');
            }
            if (width !== 1100) {
              await page.locator('#yardPower').screenshot({ path: path.join(artifacts, 'yard-power-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
              await page.locator('#stationPower').screenshot({ path: path.join(artifacts, 'station-power-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
            }
            await page.locator('[data-yard-range="7d"]').click();
            await page.waitForFunction(() => document.getElementById('yardPowerHistoryDetail').textContent.includes('7d'));
            // Exercise two isolated observations, a connected pair and a final
            // group with a missing PV/panel value. This catches invisible M-only
            // subpaths even when a series also has valid connected segments.
            historyMode = 'sparse';
            await page.locator('[data-yard-range="24h"]').click();
            await page.waitForFunction(() => document.getElementById('yardPowerHistoryDetail').textContent.startsWith('7 recorded intervals'));
            await page.evaluate(series => window.dispatchEvent(new CustomEvent('moore-weather-station-trends',
              { detail: { series } })), sparseStation);
            const sparse = await chartGeometry(page);
            assertSparseGeometry(sparse.station, 'Station Power sparse history', 'station-power-line-panel');
            assertSparseGeometry(sparse.yard, 'Yard Power sparse history', 'yard-line-panel');
            if (width !== 1100) {
              await page.locator('#yardPower').screenshot({ path: path.join(artifacts, 'yard-power-sparse-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
              await page.locator('#stationPower').screenshot({ path: path.join(artifacts, 'station-power-sparse-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
            }
            historyMode = 'continuous';
            if (width === 393) {
              mode = 'stale'; await page.reload();
              await page.waitForFunction(() => document.querySelector('#yardPowerStatus').textContent === 'DELAYED');
              assert.equal(await page.locator('#yardPowerSummary').isVisible(), true);
              assert.doesNotMatch(await page.locator('#yardBatteryV').textContent(), /^0\.00$/, 'stale is not represented as zero battery');
              mode = 'fresh';
            }
          } finally { mode = 'fresh'; historyMode = 'continuous'; await context.close(); }
        }
      } finally { await browser.close(); }
    }
    console.log('Power cards passed: 6/3/2 Yard columns, 4/2 Station columns, visible unfilled traces, readable adaptive axes and cached resize, per-series gaps and singleton points, stale states and layout checks.');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
