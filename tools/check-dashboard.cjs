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
      ['leslie-storage', 'connolly-storage'].includes(id) ? 78 + i / 50 : id === 'condamine-warwick-level' ? 2 + i / 50 :
      id === 'condamine-level' ? 1 + i / 500 : 20;
    return { t: finish - hours * HOUR + (i + 1) * step, value, min: null, max: null, estimated: false };
  });
  return { metric, resolution, start: finish - hours * HOUR, end: finish, intervalSeconds: step / 1000,
    points, latest: points.at(-1), missing: 0, note: 'Offline fixture', subtitle: 'Saved readings · AEST' };
}
let mode = 'fresh', requests = [];
function water() {
  const readings = Object.fromEntries(Object.keys(WATER).map(id => [id, { value: id === 'leslie-storage' ? 78.5 :
    id === 'connolly-storage' ? 100 : id === 'connolly-volume' ? 2166 : id === 'leslie-volume' ? 83210 : id === 'condamine-flow' ? 37.2 : id === 'condamine-level' ? 1.668 : 5.34,
    t: now - 60000, capacity: id === 'leslie-volume' ? 106000 : id === 'connolly-volume' ? 2166 : null }]));
  const row = readings['condamine-warwick-level'];
  if (mode === 'watch') row.value = 6;
  if (mode === 'near') row.value = 6.5;
  if (mode === 'above') row.value = 7.21;
  if (mode === 'at') row.value = 7;
  if (mode === 'stale') { row.t = now - HOUR; row.value = 6.8; }
  if (mode === 'missing') readings['condamine-warwick-level'] = null;
  const preview = series('condamine-warwick-level', 'hourly', 168);
  if (mode === 'missing') { preview.points.forEach(p => p.value = null); preview.latest = null; preview.missing = 168; }
  return { catalog: catalog.filter(m => m.water), readings, collector: { enabled: true }, imports: Object.fromEntries(
    ['leslie-daily', 'condamine-level-backfill', 'condamine-flow-backfill', 'condamine-warwick-live'].map(id => [id, { complete: true }])),
    series: [series('leslie-storage', 'daily', 720), preview, series('condamine-level', 'hourly', 168), series('connolly-storage', 'daily', 720)] };
}
const publicRoot = path.resolve(__dirname, '../public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/alerts/config') return res.end(JSON.stringify({ enabled: false }));
    if (url.pathname === '/api/water') return res.end(JSON.stringify(water()));
    if (url.pathname === '/api/trends') {
      const daily = url.searchParams.get('view') === 'daily';
      return res.end(JSON.stringify({ catalog, series: catalog.filter(m => !m.water).map(m => series(m.id, daily ? 'daily' : '10m', daily ? 720 : 24)) }));
    }
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
      if (!file.endsWith('forecast.html')) html = html.replace('</body>', '<script src="/history-chart.js"></script><script src="/history.js"></script><script src="/station-alerts.js"></script><script src="/skycam-labels.js"></script></body>');
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
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const refs = [...document.querySelectorAll('.water-reference-label')].map(n => {
      const r = n.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom };
    });
    return { warwick: rect('.water-warwick'), dam: rect('.water-dam'), scots: rect('.water-scots'),
      connolly: rect('.water-connolly'), grid: rect('.water-grid'), svg: rect('.water-warwick .history-spark svg'), refs, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  for (const b of [boxes.warwick, boxes.dam, boxes.scots, boxes.connolly]) {
    assert.ok(b.x >= -1 && b.right <= width + 1, JSON.stringify({ width, boxes }));
  }
  assert.equal(boxes.overflow, false, 'Page must not scroll horizontally at ' + width);
  if (boxes.grid.width >= 1200) {
    assert.ok(boxes.scots.x < boxes.warwick.x && boxes.warwick.x < boxes.dam.x && boxes.dam.x < boxes.connolly.x);
    assert.ok(Math.abs(boxes.scots.y - boxes.connolly.y) < 1);
  } else if (boxes.grid.width >= 680) {
    assert.ok(boxes.warwick.x < boxes.scots.x && Math.abs(boxes.warwick.y - boxes.scots.y) < 1);
    assert.ok(boxes.dam.x < boxes.connolly.x && Math.abs(boxes.dam.y - boxes.connolly.y) < 1);
    assert.ok(boxes.dam.y >= boxes.warwick.bottom - 1);
  } else assert.ok(boxes.warwick.y < boxes.dam.y && boxes.dam.y < boxes.connolly.y && boxes.connolly.y < boxes.scots.y);
  for (const r of boxes.refs) assert.ok(r.x >= boxes.svg.x - 1 && r.right <= boxes.svg.right + 1 &&
    r.y >= boxes.svg.y - 1 && r.bottom <= boxes.svg.bottom + 1, 'Reference label clipped: ' + JSON.stringify({ r, svg: boxes.svg }));
  const sorted = boxes.refs.sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].y >= sorted[i - 1].bottom, 'Reference labels overlap');
}
async function navigation(page, width) {
  const nav = page.locator('.dashboard-tabs');
  const labels = await nav.locator('.dashboard-tab').allInnerTexts();
  assert.deepEqual(labels.map(s => s.replace(/\s+/g, ' ').trim()), [width <= 600 ? 'Current' : 'Current Readings', 'Forecast', 'Daily Summary', 'Trends']);
  const boxes = await nav.locator('.dashboard-tab').evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, scroll:n.scrollWidth, client:n.clientWidth };
  }));
  for (let i=0;i<boxes.length;i++) {
    const b=boxes[i]; assert.ok(b.x >= 0 && b.right <= width && b.scroll <= b.client + 1, 'Navigation clips: '+JSON.stringify(boxes));
    assert.ok(Math.abs(b.y-boxes[0].y)<1, 'Navigation must stay on one line');
    if(i) assert.ok(boxes[i-1].right <= b.x, 'Navigation overlaps');
  }
  assert.equal(await page.locator('.footer-analytics').getAttribute('href'), 'https://cloud.umami.is/');
}
async function cameraLabels(page, focus = false) {
  const geometry = await page.evaluate(() => {
    const rect = node => { const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,scroll:node.scrollWidth,client:node.clientWidth}; };
    const stage=document.querySelector('.skycam-image-stage'), frame=document.querySelector('#skycamImage');
    return { stage:rect(stage), labels:[...document.querySelector('.skycam-labels').children].map(rect), ratio:frame.naturalWidth/frame.naturalHeight || 4/3 };
  });
  const {stage,labels,ratio}=geometry;
  const height=focus ? Math.min(stage.height,stage.width/ratio) : stage.height;
  const width=focus ? height*ratio : stage.width;
  const imageX=stage.x+(stage.width-width)/2, imageY=stage.y+(stage.height-height)/2;
  for(let i=0;i<labels.length;i++){
    const b=labels[i];
    assert.ok(b.y>=imageY+Math.max(32,height*.14)-1, 'Label covers reserved watermark area: '+JSON.stringify(geometry));
    assert.ok(b.x>=imageX-1 && b.right<=imageX+width+1 && b.bottom<=imageY+height, 'Label lies outside camera image');
    assert.ok(b.scroll<=b.client+1, 'Label text clips');
    assert.ok(Math.abs(b.y-labels[0].y)<1 && Math.abs(b.width-labels[0].width)<1 && Math.abs(b.height-labels[0].height)<1, 'Labels must align and have equal space');
    if(i)assert.ok(labels[i-1].right<b.x, 'Labels overlap');
  }
}
async function visualWindows(page) {
  const boxes = await page.evaluate(() => ['.skycam-image-stage','.radar-map-stage'].map(selector => {
    const r=document.querySelector(selector).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
  }));
  const [camera,radar]=boxes;
  assert.ok(Math.abs(camera.width-radar.width)<2 && Math.abs(camera.height-radar.height)<2, 'Camera/radar dimensions: '+JSON.stringify(boxes));
  assert.ok(Math.abs(camera.width/camera.height-4/3)<.01);
  await cameraLabels(page);
  // Exercise the longest status and both common camera ratios in the enlarged viewer.
  for(const ratio of [4/3,16/9]){
    await page.evaluate(ratio=>{
      const frame=document.querySelector('#skycamImage');
      frame.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+(ratio*900)+'" height="900"></svg>');
      document.querySelector('#skycamBadge').textContent='SKYCAM · TIMELAPSE';
      document.querySelector('.skycam-container').classList.add('skycam-focus-mode');
      document.body.classList.add('skycam-focus-open');
    },ratio);
    await page.waitForFunction(ratio=>Math.abs(document.querySelector('#skycamImage').naturalWidth/900-ratio)<.01,ratio);
    await page.waitForTimeout(60);
    await cameraLabels(page,true);
  }
  await page.evaluate(()=>{
    document.querySelector('.skycam-container').classList.remove('skycam-focus-mode');
    document.body.classList.remove('skycam-focus-open');
    document.querySelector('#skycamBadge').textContent='SKYCAM · LIVE';
  });
  await page.waitForTimeout(60); await cameraLabels(page);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let checked = 0;
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch();
      try {
        for (const width of [320, 393, 768, 1024, 1440]) {
          const context = await browser.newContext({ viewport: { width, height: 960 } });
          await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await context.addInitScript(() => {
            window.__refreshCallbacks = [];
            window.__historyUsage = [];
            window.mooreAnalytics = { track: (name, data) => window.__historyUsage.push({ name, data }) };
            const original = window.setInterval;
            window.setInterval = (callback, interval, ...args) => {
              if (interval === 60000) window.__refreshCallbacks.push(callback);
              return original(callback, interval, ...args);
            };
          });
          const page = await context.newPage(), errors = [];
          page.on('pageerror', error => errors.push(error.message));
          for (const pagePath of ['/index.html', '/daily.html']) {
            mode = 'fresh';
            await page.goto(origin + pagePath); await ready(page);
            await page.evaluate(() => document.body.classList.add('weather-loaded'));
            // Desktop uses the app's existing landscape layout class.
            if (width >= 900) await page.evaluate(() => document.body.classList.add('layout-landscape'));
            await page.locator('.local-water').scrollIntoViewIfNeeded();
            await page.waitForTimeout(80);
            await bounds(page, width);
            await navigation(page,width);
            assert.equal(await page.locator('#waterImportStatus').isVisible(), false);
            assert.match(await page.locator('#connollyStorageTime').textContent(), /Council report/);
            assert.equal(await page.locator('#connollyVolume').textContent(), '2,166');
            await page.locator('#connollyStorage').click(); await historyReady(page, 'daily', 720);
            assert.equal(requests.at(-1).metric, 'connolly-storage');
            assert.equal(await page.locator('[data-resolution="hourly"]').isDisabled(), true);
            await page.locator('.history-close').click();
            assert.equal(await page.locator('#warwickBridgeValue').textContent(), '1.66m (Below Bridge)');
            assert.equal(await page.locator('#warwickBridge').getAttribute('data-warning'), 'false');
            if (pagePath.includes('index')) {
              await visualWindows(page);
              assert.match(await page.locator('#powerTrendLabel').textContent(), /24-hour/);
              assert.match(await page.locator('#tempVal').locator('xpath=ancestor::*[contains(@class,"temp-hero")]').locator('.history-spark-caption').textContent(), /24 hours/);
              for (const [mm, inches] of [['25.4', '(1.00 in)'], ['0.0', '(0.00 in)'], ['--', ''], ['225.0', '(8.86 in)']]) {
                await page.evaluate(mm => document.querySelector('#rainSince9Val').textContent = mm, mm);
                await page.waitForFunction(inches => document.querySelector('#rainSince9Inches').textContent === inches, inches);
                assert.equal(await page.locator('#rainSince9Inches').isVisible(), Boolean(inches));
              }
              assert.equal(await page.locator('.rain-primary .unit-suffix').isVisible(), true);
              const sizes = await page.locator('#rainSince9Inches').evaluate(n => ({
                secondary: parseFloat(getComputedStyle(n).fontSize),
                primary: parseFloat(getComputedStyle(document.querySelector('#rainSince9Val')).fontSize)
              }));
              assert.ok(sizes.secondary < sizes.primary);
            }
            assert.match(await page.locator('#warwickBridgeContext').textContent(), /McCahon Bridge/);
            assert.equal(await page.locator('.water-scots .water-reference-line').count(), 0);
            await page.locator('#scotsLevel').click(); await historyReady(page, 'hourly', 168);
            assert.equal(requests.at(-1).metric, 'condamine-level');
            assert.deepEqual(await page.evaluate(() => window.__historyUsage.at(-1)), { name: 'history-open', data: { measurement: 'condamine-level' } });
            await page.locator('.history-close').click();
            await page.locator('#condamineFlow').click(); await historyReady(page, 'daily', 720);
            assert.equal(requests.at(-1).metric, 'condamine-flow');
            await page.locator('.history-close').click();
            await page.locator(pagePath.includes('daily') ? '#rainTotal' : '#rainSince9Val').click();
            await historyReady(page, pagePath.includes('daily') ? 'daily' : '10m');
            if (pagePath.includes('daily')) { await page.locator('[data-resolution="10m"]').click(); await historyReady(page, '10m', 24); }
            assert.deepEqual(await page.evaluate(() => window.__historyUsage.at(-1)), { name: 'history-open', data: { measurement: 'rain' } });
            await page.selectOption('#historyRange', '720'); await historyReady(page, '10m', 720);
            const first = requests.at(-1), period = await page.locator('#historyPeriod').textContent();
            assert.equal(first.hours, 720); assert.equal(first.end % HOUR, 0);
            assert.match(await page.locator('#historyLegend').textContent(), /4320 readings · 0 missing/);
            assert.match(await page.locator('#historySummary').textContent(), /864.0/);
            assert.equal(await page.locator('.history-rain-total .rain-inches').textContent(), '(34.02 in)');
            assert.equal(await page.locator('#historySummary > div:last-child time').getAttribute('datetime'),
              new Date(first.end - 720 * HOUR + HOUR / 6).toISOString());
            assert.match(await page.locator('#historySummary > div:last-child').textContent(), /10 min ending/);
            await page.locator('[data-resolution="hourly"]').click(); await historyReady(page, 'hourly', 720);
            assert.equal(requests.at(-1).end, first.end);
            assert.equal(await page.locator('#historyPeriod').textContent(), period);
            assert.match(await page.locator('#historyLegend').textContent(), /720 readings · 0 missing/);
            assert.match(await page.locator('#historySummary').textContent(), /864.0/);
            await page.locator('[data-resolution="10m"]').click(); await historyReady(page, '10m', 720);
            assert.equal(requests.at(-1).end, first.end);
            await page.locator('.history-close').click();
            if (width === 1440) {
              await page.evaluate(() => { document.body.classList.remove('layout-landscape'); document.body.classList.add('layout-portrait'); });
              await page.waitForTimeout(80); await bounds(page, width);
              await page.evaluate(() => document.documentElement.dataset.theme = 'light');
              await bounds(page, width);
            }
            await page.locator('#stationAlertsBtn').click();
            assert.match(await page.locator('#alertTitle').textContent(), /river alerts/);
            assert.match(await page.locator('.alert-dialog').textContent(), /0.50m below McCahon/);
            const alertBox = await page.locator('.alert-dialog').boundingBox();
            assert.ok(alertBox.x >= -1 && alertBox.x + alertBox.width <= width + 1);
            await page.locator('#alertClose').click();
            assert.deepEqual(errors, []);
            checked++;
          }
          await page.goto(origin + '/forecast.html'); await navigation(page,width);
          await page.locator('.dashboard-history-button').click();
          await historyReady(page,'10m',24);
          await page.locator('.history-close').click();
          if (width === 393) {
            for (const [state, text] of [['watch', '1.00m (Below Bridge)'], ['near', '0.50m (Below Bridge)'], ['above', '0.21m (Above Bridge)'], ['at', '0.00m (At Bridge)'], ['stale', '0.20m (Below Bridge)'], ['missing', 'River reading unavailable']]) {
              mode = state; await page.reload(); await ready(page);
              assert.equal(await page.locator('#warwickBridgeValue').textContent(), text);
              const warning = ['watch','near','above','at'].includes(state);
              assert.equal(await page.locator('#warwickBridge').getAttribute('data-warning'), String(warning));
              if (warning) {
                const style = await page.locator('#warwickBridge').getAttribute('style');
                assert.match(style, new RegExp('hsl\\(' + (state === 'watch' ? 42 : state === 'near' ? 21 : 0)));
              }
              if (state === 'stale') assert.match(await page.locator('#warwickBridgeContext').textContent(), /Last available/);
              await bounds(page, width);
            }
            // A failed/stale update must remove warning styling on the existing card.
            mode = 'near'; await page.evaluate(() => window.__refreshCallbacks.forEach(fn => fn()));
            await page.waitForFunction(() => document.querySelector('#warwickBridge').dataset.warning === 'true');
            mode = 'stale'; await page.evaluate(() => window.__refreshCallbacks.forEach(fn => fn()));
            await page.waitForFunction(() => document.querySelector('#warwickBridge').dataset.state === 'stale');
            assert.equal(await page.locator('#warwickBridge').getAttribute('data-warning'), 'false');
            assert.equal(await page.locator('#warwickBridge').evaluate(n => n.style.getPropertyValue('--bridge-warning-colour')), '');
          }
          await context.close();
        }
      } finally { await browser.close(); }
    }
    console.log('PASS: ' + checked + ' page/browser/width combinations; four water cards, Connolly history, single-line navigation, matched camera/radar, twenty-four-hour previews, persistent references, bridge states and rainfall inches/peak dates, warning colours and exact 30-day rain comparisons.');
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
