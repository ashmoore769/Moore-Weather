'use strict';
// Offline browser fixture: never starts server.js, contacts the station, or sends email.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const { METRICS: WEATHER, normalizeRequest } = require('../lib/weather-history');
const { METRICS: WATER } = require('../lib/water-data');
const chart = require('../public/history-chart');
const HOUR = 3600000, now = Date.now(), end = Math.floor(now / HOUR) * HOUR;
const catalog = [...Object.values(WEATHER), ...Object.values(WATER)].map(m => ({ ...m,
  resolutions: m.resolutions || ['10m', 'hourly', 'daily'],
  coverage: Object.fromEntries((m.resolutions || ['10m', 'hourly', 'daily']).map(r => {
    const step = r === '10m' ? HOUR / 6 : r === 'hourly' ? HOUR : 24 * HOUR;
    return [r, { start: end - 90 * 24 * HOUR, first: end - 90 * 24 * HOUR + step, last: end }];
  }))
}));
function series(id, resolution, hours, finish = end) {
  const metric = catalog.find(m => m.id === id);
  const step = resolution === '10m' ? HOUR / 6 : resolution === 'hourly' ? HOUR : 24 * HOUR;
  const points = Array.from({ length: Math.round(hours * HOUR / step) }, (_, i) => {
    const value = id === 'rain' ? (resolution === '10m' ? .2 : 1.2) :
      id === 'leslie-storage' ? 78 + i / 50 : id === 'condamine-warwick-level' ? 2 + i / 50 :
      id === 'condamine-level' ? 1 + i / 500 : 20;
    return { t: finish - hours * HOUR + (i + 1) * step, value, min: null, max: null, estimated: false };
  });
  return { metric, resolution, start: finish - hours * HOUR, end: finish, intervalSeconds: step / 1000,
    points, latest: points.at(-1), missing: 0, note: 'Offline fixture', subtitle: 'Saved readings · AEST' };
}
let mode = 'fresh', requests = [];
function water() {
  const readings = Object.fromEntries(Object.keys(WATER).map(id => [id, { value: id === 'leslie-storage' ? 78.5 :
    id === 'leslie-volume' ? 83210 : id === 'condamine-flow' ? 37.2 : id === 'condamine-level' ? 1.668 : 5.34,
    t: now - 60000, capacity: id === 'leslie-volume' ? 106000 : null }]));
  const row = readings['condamine-warwick-level'];
  if (mode === 'above') row.value = 7.21;
  if (mode === 'at') row.value = 7;
  if (mode === 'stale') row.t = now - 4 * HOUR;
  if (mode === 'missing') readings['condamine-warwick-level'] = null;
  const preview = series('condamine-warwick-level', 'hourly', 168);
  if (mode === 'missing') { preview.points.forEach(p => p.value = null); preview.latest = null; preview.missing = 168; }
  return { catalog: catalog.filter(m => m.water), readings, collector: { enabled: true }, imports: Object.fromEntries(
    ['leslie-daily', 'condamine-level-backfill', 'condamine-flow-backfill', 'condamine-warwick-live'].map(id => [id, { complete: true }])),
    series: [series('leslie-storage', 'daily', 720), preview, series('condamine-level', 'hourly', 168)] };
}
const publicRoot = path.resolve(__dirname, '../public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/water') return res.end(JSON.stringify(water()));
    if (url.pathname === '/api/trends') return res.end(JSON.stringify({ catalog, series: [] }));
    if (url.pathname === '/api/history') {
      try {
        const request = normalizeRequest(Object.fromEntries(url.searchParams));
        requests.push(request);
        const metric = catalog.find(m => m.id === request.metric);
        const window = chart.navigationWindow(request.end - request.hours * HOUR, request.end, [request.resolution], now, request.resolution, metric);
        return res.end(JSON.stringify({ catalog, series: [series(metric.id, window.resolution, window.hours, window.end)] }));
      } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: e.message })); }
    }
    res.statusCode = 404; return res.end('{}');
  }
  const file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(publicRoot + path.sep)) { res.statusCode = 403; return res.end(); }
  try {
    if (file.endsWith('.html')) {
      let html = fs.readFileSync(file, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      // Keep real page markup and CSS. Only the changed history layer runs;
      // live polling, SkyCam, notifications and provider calls are excluded.
      html = html.replace('</body>', '<script src="/history-chart.js"></script><script src="/history.js"></script></body>');
      res.setHeader('Content-Type', 'text/html'); return res.end(html);
    }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.statusCode = 404; res.end(); }
});
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#warwickBridge')?.dataset.state);
  await page.waitForFunction(() => document.querySelectorAll('.water-reference-line').length === 3);
}
async function historyReady(page, resolution, hours) {
  await page.waitForFunction(({ resolution, hours }) => document.querySelector('.history-body')?.dataset.state === 'ready' &&
    document.querySelector('[data-resolution="' + resolution + '"]')?.getAttribute('aria-pressed') === 'true' &&
    (hours === undefined || document.querySelector('#historyRange').value === String(hours)), { resolution, hours });
}
async function bounds(page, width) {
  const boxes = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }; };
    const refs = [...document.querySelectorAll('.water-reference-label')].map(n => {
      const r = n.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom };
    });
    return { warwick: rect('.water-warwick'), dam: rect('.water-dam'), scots: rect('.water-scots'),
      svg: rect('.water-warwick .history-spark svg'), refs, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  for (const b of [boxes.warwick, boxes.dam, boxes.scots]) {
    assert.ok(b.x >= -1 && b.right <= width + 1, JSON.stringify({ width, boxes }));
  }
  assert.equal(boxes.overflow, false, 'Page must not scroll horizontally at ' + width);
  if (width >= 1100) {
    assert.ok(boxes.scots.x < boxes.warwick.x && boxes.warwick.x < boxes.dam.x);
    assert.ok(Math.abs(boxes.scots.y - boxes.dam.y) < 1);
  } else if (width >= 700) {
    assert.ok(boxes.warwick.x < boxes.dam.x);
    assert.ok(boxes.scots.y >= boxes.warwick.bottom - 1);
  } else assert.ok(boxes.warwick.y < boxes.dam.y && boxes.dam.y < boxes.scots.y);
  for (const r of boxes.refs) assert.ok(r.x >= boxes.svg.x - 1 && r.right <= boxes.svg.right + 1 &&
    r.y >= boxes.svg.y - 1 && r.bottom <= boxes.svg.bottom + 1, 'Reference label clipped: ' + JSON.stringify({ r, svg: boxes.svg }));
  const sorted = boxes.refs.sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].y >= sorted[i - 1].bottom, 'Reference labels overlap');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let checked = 0;
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch();
      try {
        for (const width of [320, 393, 768, 1440]) {
          const context = await browser.newContext({ viewport: { width, height: 960 } });
          await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          const page = await context.newPage(), errors = [];
          page.on('pageerror', error => errors.push(error.message));
          for (const pagePath of ['/index.html', '/daily.html']) {
            mode = 'fresh';
            await page.goto(origin + pagePath); await ready(page);
            // Desktop uses the app's existing landscape layout class.
            if (width >= 1100) await page.evaluate(() => document.body.classList.add('layout-landscape'));
            await page.locator('.local-water').scrollIntoViewIfNeeded();
            await page.waitForTimeout(80);
            await bounds(page, width);
            assert.equal(await page.locator('#warwickBridgeValue').textContent(), '1.66m (Below Bridge)');
            assert.match(await page.locator('#warwickBridgeContext').textContent(), /McCahon Bridge/);
            assert.equal(await page.locator('.water-scots .water-reference-line').count(), 0);
            await page.locator('#scotsLevel').click(); await historyReady(page, 'hourly', 168);
            assert.equal(requests.at(-1).metric, 'condamine-level');
            await page.locator('.history-close').click();
            await page.locator('#condamineFlow').click(); await historyReady(page, 'daily', 720);
            assert.equal(requests.at(-1).metric, 'condamine-flow');
            await page.locator('.history-close').click();
            await page.locator(pagePath.includes('daily') ? '#rainTotal' : '#rainSince9Val').click();
            await historyReady(page, pagePath.includes('daily') ? 'daily' : '10m');
            if (pagePath.includes('daily')) { await page.locator('[data-resolution="10m"]').click(); await historyReady(page, '10m', 24); }
            await page.selectOption('#historyRange', '720'); await historyReady(page, '10m', 720);
            const first = requests.at(-1), period = await page.locator('#historyPeriod').textContent();
            assert.equal(first.hours, 720); assert.equal(first.end % HOUR, 0);
            assert.match(await page.locator('#historyLegend').textContent(), /4320 readings · 0 missing/);
            assert.match(await page.locator('#historySummary').textContent(), /864.0/);
            await page.locator('[data-resolution="hourly"]').click(); await historyReady(page, 'hourly', 720);
            assert.equal(requests.at(-1).end, first.end);
            assert.equal(await page.locator('#historyPeriod').textContent(), period);
            assert.match(await page.locator('#historyLegend').textContent(), /720 readings · 0 missing/);
            assert.match(await page.locator('#historySummary').textContent(), /864.0/);
            await page.locator('[data-resolution="10m"]').click(); await historyReady(page, '10m', 720);
            assert.equal(requests.at(-1).end, first.end);
            await page.locator('.history-close').click();
            assert.deepEqual(errors, []);
            checked++;
          }
          if (width === 393) {
            for (const [state, text] of [['above', '0.21m (Above Bridge)'], ['at', '0.00m (At Bridge)'], ['stale', '1.66m (Below Bridge)'], ['missing', 'River reading unavailable']]) {
              mode = state; await page.reload(); await ready(page);
              assert.equal(await page.locator('#warwickBridgeValue').textContent(), text);
              if (state === 'stale') assert.match(await page.locator('#warwickBridgeContext').textContent(), /Last available/);
              await bounds(page, width);
            }
          }
          await context.close();
        }
      } finally { await browser.close(); }
    }
    console.log('PASS: ' + checked + ' page/browser/width combinations; independent water histories, persistent references, bridge states and exact 30-day rain comparisons.');
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
