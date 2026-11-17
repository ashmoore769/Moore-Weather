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
let mode = 'fresh', requests = 0;
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
const history = Array.from({ length: 144 }, (_, i) => template(now - 24 * HOUR + (i + 1) * 10 * MINUTE));
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
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/yard-power') {
    requests++;
    const current = template(now - (mode === 'stale' ? 12 : 1) * MINUTE);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ enabled: true, status: mode === 'stale' ? 'stale' : 'fresh',
      current, staleAfterSeconds: 180, timezone: 'Australia/Brisbane',
      range: url.searchParams.get('range') || null, history: url.searchParams.has('range') ? history : null }));
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
            const before = requests;
            await page.evaluate(series => window.dispatchEvent(new CustomEvent('moore-weather-station-trends',
              { detail: { series } })), station);
            assert.equal(requests, before, 'station composite reuses history rather than fetching more data');
            await page.waitForFunction(() => document.querySelectorAll('#yardPowerChart path.yard-line').length >= 4);
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
            for (const card of [visual.yard, visual.station]) {
              assert.ok(card.x >= -1 && card.right <= width + 1, 'Card must not overflow the page: ' + JSON.stringify(visual));
            }
            assert.ok(visual.yard.height < 385, 'Yard power compact card should fit within 385px: ' + JSON.stringify(visual));
            assert.deepEqual(errors, [], 'No browser exceptions');
            if (width !== 1100) {
              await page.locator('#yardPower').screenshot({ path: path.join(artifacts, 'yard-power-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
              await page.locator('#stationPower').screenshot({ path: path.join(artifacts, 'station-power-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
            }
            await page.locator('[data-yard-range="7d"]').click();
            await page.waitForFunction(() => document.getElementById('yardPowerHistoryDetail').textContent.includes('7d'));
            if (width === 393) {
              mode = 'stale'; await page.reload();
              await page.waitForFunction(() => document.querySelector('#yardPowerStatus').textContent === 'DELAYED');
              assert.equal(await page.locator('#yardPowerSummary').isVisible(), true);
              assert.doesNotMatch(await page.locator('#yardBatteryV').textContent(), /^0\.00$/, 'stale is not represented as zero battery');
              mode = 'fresh';
            }
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    console.log('Power cards passed: 6/3/2 Yard columns, 4/2 Station columns, dual-axis traces, stale states and layout checks.');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
