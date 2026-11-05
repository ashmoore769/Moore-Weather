'use strict';
// Offline browser fixture: never starts server.js, contacts the station, or sends email.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const { METRICS: WEATHER, normalizeRequest } = require('../lib/weather-history');
const { METRICS: WATER } = require('../lib/water-data');
const chart = require('../public/history-chart');
const { historyHealth, expectedDaily } = require('../lib/history-alerts');
const quality = require('../public/sensor-quality');
const { expectedReportingDate } = require('../public/daily-summary');
const HOUR = 3600000, now = Date.now(), end = Math.floor(now / HOUR) * HOUR;
const screenshotRoot = path.resolve(__dirname, '../artifacts/dashboard');
const screenshotWidths = new Map([[393, 'phone'], [1440, 'desktop']]);
async function reviewScreenshot(page, engine, width, view, selector) {
  if (!screenshotWidths.has(width)) return;
  fs.mkdirSync(screenshotRoot, {recursive:true});
  const file = path.join(screenshotRoot, `${engine.name()}-${screenshotWidths.get(width)}-${view}.png`);
  if (selector) await page.locator(selector).screenshot({path:file,animations:'disabled'});
  else {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({path:file,animations:'disabled',fullPage:false});
  }
}
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
let mode = 'fresh', historyMode = 'fresh', requests = [];
let currentMode = 'fresh', weatherOffset = 0, skycamFailNewest = false, skycamAttempts = 0;
let skycamIncomingSequence = 0;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNU8Y5iYGBgYmBgYGBgAAAJYADNjl9iMQAAAABJRU5ErkJggg==', 'base64');
const cameraFrames = [
  {id:'fixture-old', url:'/skycam/fixture-old.jpg', capturedAt:new Date(now - 10 * 60000).toISOString()},
  {id:'fixture-new', url:'/skycam/fixture-new.jpg', capturedAt:new Date(now - 60000).toISOString()}
];
function currentRecord() {
  const local = new Date(now + weatherOffset + 10 * HOUR).toISOString();
  const values = quality.currentSensors.map(key => key === '7' ? 1000 : key === '6' ? 400 : key === '3' ? 50 : key === '21' ? 13.8 : key === '23' ? 10 : key === '32' ? 0 : 20);
  values[3] = currentMode === 'partial' ? 25.7 : 23.4;
  if (currentMode === 'partial') { values[28] = 'NaN'; values[20] = -100; }
  return [local.slice(0,10).replaceAll('-', '/'), local.slice(11,19), ...values].join(',');
}
function dailyRecord() {
  const local = new Date(Date.parse(expectedReportingDate(now) + 'T00:00:00Z') + 24 * HOUR).toISOString();
  const values = Array(41).fill(20); values[34] = values[35] = values[36] = 1000;
  return [local.slice(0,10).replaceAll('-', '/'), '09:00:00', ...values].join(',');
}
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
  if (mode === 'invalid-latest') { row.value=6.8; row.lastAvailable=true; row.latestValueAvailable=false; row.latestObservedAt=now; }
  const preview = series('condamine-warwick-level', 'hourly', 168);
  if (mode === 'missing') { preview.points.forEach(p => p.value = null); preview.latest = null; preview.missing = 168; }
  return { catalog: catalog.filter(m => m.water), readings, collector: { enabled: true }, imports: Object.fromEntries(
    ['leslie-daily', 'condamine-level-backfill', 'condamine-flow-backfill', 'condamine-warwick-live'].map(id => [id, { complete: true }])),
    series: [series('leslie-storage', 'daily', 720), preview, series('condamine-level', 'hourly', 168), series('connolly-storage', 'daily', 720)] };
}
const publicRoot = path.resolve(__dirname, '../public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Serve the complete production pages and scripts. Every station/provider
  // response below is local, including camera image bytes; external traffic is blocked.
  if (url.pathname === '/weather') {
    if (currentMode === 'hang') return;
    if (currentMode === 'error') { res.statusCode=503; return res.end('Fixture unavailable'); }
    return res.end(currentMode === 'malformed' ? 'broken record' : currentRecord());
  }
  if (url.pathname === '/daily') return res.end(dailyRecord());
  if (url.pathname === '/ping') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({stationObservedAt:new Date(now).toISOString(),lastWeatherPoll:new Date(now).toISOString(),dailyUpToDate:true,dailySummaryDate:expectedReportingDate(now)}));
  }
  if (url.pathname === '/skycam/history') { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({images:cameraFrames})); }
  if (url.pathname.startsWith('/skycam/')) {
    res.setHeader('Cache-Control','no-store');
    if (url.pathname.includes('fixture-new')) { skycamAttempts++; if(skycamFailNewest) {res.statusCode=503;return res.end();} }
    res.setHeader('Content-Type','image/png'); return res.end(pixel);
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/alerts/history') {
      if(historyMode==='error') { res.statusCode=503;return res.end(JSON.stringify({error:'Offline fixture'})); }
      return res.end(JSON.stringify(historyHealth({enabled:true,ready:true,streams:{
        mem3:new Date(now-(historyMode==='stale'?2*HOUR:10*60000)).toISOString(),
        mem2:new Date(now-HOUR).toISOString(),mem1:new Date(expectedDaily(now)).toISOString()
      },completeness:{checked:true,streams:{
        mem3:{checked:true,unresolvedGaps:historyMode==='gaps'?2:0,missingIntervals:historyMode==='gaps'?4:0,firstMissingAt:new Date(now-4*HOUR).toISOString(),lastMissingAt:new Date(now-3*HOUR).toISOString()},
        mem2:{checked:true},mem1:{checked:true}
      }}},now)));
    }
    if (url.pathname === '/api/system-health') return res.end(JSON.stringify({checkedAt:new Date(now).toISOString(),status:'degraded',checks:{
      storage:{status:'ok',freeBytes:4*1024**3,dbBytes:256*1024**2},
      backups:{status:'pending',lastSuccess:new Date(now-6*HOUR).toISOString(),offsiteConfigured:false,offsiteLastSuccess:null},
      retention:{status:'waiting-for-backup',days:15,lastRun:null},
      database:{status:'ok',lastWrite:new Date(now-60000).toISOString()},
      live:{status:'ok',observedAt:new Date(now).toISOString()},
      history:{status:'incomplete',completeness:{checked:true,unresolvedGaps:2}}
    }}));
    if (url.pathname === '/api/radar' || url.pathname === '/api/forecast') {res.statusCode=503;return res.end(JSON.stringify({error:'Offline fixture'}));}
    if (url.pathname === '/api/access-request') return res.end(JSON.stringify({enabled:false}));
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
      const html = fs.readFileSync(file, 'utf8');
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

async function readablePalette(page) {
  const result = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    const luminance = value => {
      ctx.clearRect(0,0,1,1); ctx.fillStyle = value; ctx.fillRect(0,0,1,1);
      const rgb = Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3).map(v => {
        const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      });
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const contrast = (a,b) => (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    const card = luminance(css.getPropertyValue('--surface'));
    const muted = luminance(css.getPropertyValue('--muted'));
    const lines = Array.from(document.querySelectorAll('.history-spark .history-series-line'));
    return {
      stylesheet: Array.from(document.styleSheets).some(s => s.href?.includes('/theme-palette.css')),
      text: contrast(card,muted),
      series: lines.map(line => contrast(card,luminance(getComputedStyle(line).stroke))),
      surfaces: ['--page','--surface-shell','--surface'].map(v => luminance(css.getPropertyValue(v)))
    };
  });
  assert.equal(result.stylesheet,true,'Shared palette must load');
  assert.ok(result.text >= 4.5,'Small labels must remain readable');
  assert.ok(result.surfaces[0] < result.surfaces[1] && result.surfaces[1] < result.surfaces[2],
    'Cards must be visibly raised above the page and shell');
  assert.ok(result.series.every(value => value >= 3),'Graph lines must remain distinct from their cards');
}

async function bounds(page, width) {
  const boxes = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const refs = [...document.querySelectorAll('.water-reference-label')].map(n => {
      const r = n.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom };
    });
    const readings = ['.water-scots','.water-warwick','.water-dam','.water-connolly'].map(selector => ({
      panel: rect(selector), label: rect(selector + ' .water-hero .water-label'),
      value: rect(selector + ' .water-hero strong')
    }));
    return { readings, bridge: rect('#warwickBridge'), warwickReading: rect('.water-warwick .water-hero'),
      referenceNote: rect('#warwickReferenceNote'),
      warwick: rect('.water-warwick'), dam: rect('.water-dam'), scots: rect('.water-scots'),
      connolly: rect('.water-connolly'), grid: rect('.water-grid'), svg: rect('.water-warwick .history-spark svg'), refs, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  for (const b of [boxes.warwick, boxes.dam, boxes.scots, boxes.connolly]) {
    assert.ok(b.x >= -1 && b.right <= width + 1, JSON.stringify({ width, boxes }));
  }
  assert.equal(boxes.overflow, false, 'Page must not scroll horizontally at ' + width);
  assert.ok(boxes.bridge.y >= boxes.warwickReading.bottom, 'Bridge clearance must follow the river graph');
  assert.ok(boxes.referenceNote.y >= boxes.bridge.bottom, 'Bridge reference must follow the clearance');
  for(let i=0;i<boxes.readings.length;i++) for(let j=i+1;j<boxes.readings.length;j++) {
    const a=boxes.readings[i], b=boxes.readings[j];
    if(Math.abs(a.panel.y-b.panel.y)<1) {
      assert.ok(Math.abs(a.label.y-b.label.y)<1, 'Neighbouring water labels must align: '+JSON.stringify(boxes.readings));
      assert.ok(Math.abs(a.value.y-b.value.y)<1 && Math.abs(a.value.height-b.value.height)<1,
        'Neighbouring water readings must align: '+JSON.stringify(boxes.readings));
    }
  }
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
  assert.equal(await page.locator('.skycam-bearing,.skycam-labels').count(), 0);
  assert.equal(await page.locator('.skycam-interval-badge').textContent(), 'UPDATES · EVERY 10 MIN');
  const geometry = await page.evaluate(() => {
    const rect = node => { const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:node.scrollWidth,client:node.clientWidth}; };
    return { container:rect(document.querySelector('.skycam-container')),
      live:rect(document.querySelector('#skycamBadge')),
      interval:rect(document.querySelector('.skycam-interval-badge')), width:innerWidth };
  });
  const {container,live,interval,width}=geometry, inset=focus ? 12 : width<=600 ? 7 : 10;
  assert.ok(Math.abs(live.x-container.x-inset)<1, 'Live label must retain its original left inset');
  assert.ok(Math.abs(container.right-interval.right-inset)<1, 'Update label must retain its original right inset');
  for(const b of [live,interval]){
    assert.ok(Math.abs(b.y-container.y-inset)<1, 'Label must retain its original top inset');
    assert.ok(b.scroll<=b.client+1, 'Label text clips');
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
  await page.evaluate(()=>{
    document.querySelector('.skycam-container').classList.add('skycam-focus-mode');
    document.body.classList.add('skycam-focus-open');
  });
  await cameraLabels(page,true);
  await page.evaluate(()=>{
    document.querySelector('.skycam-container').classList.remove('skycam-focus-mode');
    document.body.classList.remove('skycam-focus-open');
    document.querySelector('#skycamBadge').textContent='SKYCAM · LIVE';
  });
  await page.waitForTimeout(60); await cameraLabels(page);
}
async function failurePaths(page, browserName) {
  // A healthy ping must not relabel the last displayed observation after failure.
  weatherOffset = -HOUR;
  await page.evaluate(() => fetchWeather());
  const previousTime = await page.locator('#timeVal').textContent();
  const previousObservation = await page.locator('#weatherData').getAttribute('data-observed-at');
  weatherOffset = 0; currentMode = 'error';
  await page.evaluate(() => fetchWeather());
  assert.equal(await page.locator('#timeVal').textContent(), previousTime);
  assert.equal(await page.locator('#weatherData').getAttribute('data-observed-at'), previousObservation);
  assert.match(await page.locator('#statusBadge').textContent(), /STALE/);
  assert.match(await page.locator('#currentReadingStatus').textContent(), /previous observation/);
  currentMode = 'partial'; await page.evaluate(() => fetchWeather());
  assert.equal(await page.locator('#tempVal').textContent(), '25.7°C');
  assert.equal(await page.locator('#blackGlobeTempVal').textContent(), '--');
  assert.equal(await page.locator('#soilTemp10Val').textContent(), '--');
  assert.equal(await page.locator('#radiantDiffVal').textContent(), '--');
  assert.match(await page.locator('#statusBadge').textContent(), /PARTIAL/);
  currentMode = 'hang';
  await page.evaluate(async () => {
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = ms => timeout.call(AbortSignal, ms === 12000 ? 40 : ms);
    try { await fetchWeather(); } finally { AbortSignal.timeout = timeout; }
  });
  assert.match(await page.locator('#currentReadingStatus').textContent(), /timed out/);
  assert.equal(await page.locator('#fetchBtn').isDisabled(), false);
  currentMode = 'fresh'; await page.evaluate(() => fetchWeather());
  assert.match(await page.locator('#statusBadge').textContent(), /LIVE/);
  assert.equal(await page.locator('#currentReadingStatus').isVisible(), false);

  await page.evaluate(() => showSkyCamHistory(0, {manual:false,followLive:true,transitionMs:0}));
  const cameraTime = await page.locator('#skycamTime').textContent();
  // The initial newest frame has already decoded in an image layer. WebKit can
  // legitimately reuse those pixels when its origin later fails. Introduce an
  // unseen capture through the real manifest path so this tests a failed load,
  // rather than requiring every browser to re-fetch a valid cached image.
  const id = 'fixture-new-incoming-' + (++skycamIncomingSequence);
  const incoming = {id,url:'/skycam/'+id+'.jpg',capturedAt:new Date(now).toISOString()};
  const imageRequests = [];
  async function expectImageResponse(status, step) {
    console.log('SkyCam ' + browserName + ' phone: ' + step + ' for ' + id);
    let response;
    try {
      [response] = await Promise.all([
        page.waitForResponse(result => new URL(result.url()).pathname === incoming.url),
        page.evaluate(() => refreshSkyCam())
      ]);
    } catch (error) {
      const state = await page.evaluate(() => ({
        displayed:skycamDisplayedEntry?.id,historyLoading:skycamHistoryLoading,imageLoading:skycamImageLoading,error:skycamImageError,
        layers:getSkyCamImageLayers().map(image=>({src:image.getAttribute('src'),currentSrc:image.currentSrc,complete:image.complete,width:image.naturalWidth}))
      })).catch(()=>({}));
      throw new Error('SkyCam ' + browserName + ' ' + step + ' failed: ' + error.message + '; state=' + JSON.stringify(state));
    }
    assert.equal(response.status(), status, 'SkyCam ' + step + ' must reach the fixture origin');
    imageRequests.push(response.url());
  }
  cameraFrames.push(incoming);
  try {
    skycamFailNewest = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const attempts = skycamAttempts;
      await expectImageResponse(503, 'failed request ' + (attempt + 1));
      assert.ok(skycamAttempts > attempts, 'The same unseen frame must be requested on each retry');
      assert.equal(await page.locator('#skycamTime').textContent(), cameraTime);
      assert.equal(await page.evaluate(()=>skycamDisplayedEntry?.id), 'fixture-old');
      assert.match(await page.locator('#skycamImageStage .is-active').getAttribute('src'), /fixture-old/);
      assert.match(await page.locator('#skycamBadge').textContent(), /STALE/);
    }
    skycamFailNewest = false;
    await expectImageResponse(200, 'recovery request');
    assert.equal(new Set(imageRequests).size, 3, 'Every failed image retry must use a fresh request URL');
    for (const url of imageRequests.slice(1)) assert.equal(new URL(url).searchParams.getAll('_mw_retry').length, 1);
    assert.equal(await page.locator('#skycamTime').textContent(), await page.evaluate(entry => formatSkyCamTime(entry.capturedAt), incoming));
    assert.notEqual(await page.locator('#skycamTime').textContent(), cameraTime);
    assert.equal(new URL(await page.locator('#skycamImageStage .is-active').getAttribute('src'), page.url()).pathname, incoming.url);
    assert.deepEqual(await page.evaluate(()=>({id:skycamDisplayedEntry.id,url:skycamDisplayedEntry.url})), {id:incoming.id,url:incoming.url});
    await page.evaluate(fixtureNow => {Date.now=()=>fixtureNow+3600000;updateSkyCamControls();}, now);
    assert.match(await page.locator('#skycamBadge').textContent(), /STALE/);
  } finally {
    skycamFailNewest = false;
    cameraFrames.pop();
    await page.evaluate(fixtureNow => {Date.now=()=>fixtureNow;updateSkyCamControls();}, now);
  }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let checked = 0;
  try {
    const engines = (process.env.DASHBOARD_BROWSERS || 'chromium,webkit').split(',').map(name => ({chromium,webkit})[name]);
    assert.ok(engines.every(Boolean), 'DASHBOARD_BROWSERS supports chromium,webkit');
    for (const engine of engines) {
      const browser = await engine.launch(engine === chromium && process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {});
      try {
        for (const width of [320, 393, 768, 1024, 1440]) {
          const context = await browser.newContext({ viewport: { width, height: 960 } });
          await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await context.addInitScript(fixtureNow => {
            // Keep browser requests on the same clock as the fixed API fixtures, even across an hour boundary.
            Date.now = () => fixtureNow;
            window.__refreshCallbacks = [];
            window.__historyUsage = [];
            const original = window.setInterval;
            window.setInterval = (callback, interval, ...args) => {
              if (interval === 60000) window.__refreshCallbacks.push(callback);
              return original(callback, interval, ...args);
            };
          }, now);
          const page = await context.newPage(), errors = [];
          page.on('pageerror', error => errors.push(error.message));
          for (const pagePath of ['/index.html', '/daily.html']) {
            mode = 'fresh'; historyMode = 'fresh'; currentMode='fresh'; weatherOffset=0;skycamFailNewest=false;
            await page.goto(origin + pagePath); await ready(page);
            await page.evaluate(() => {
              const track = window.mooreAnalytics?.track;
              window.mooreAnalytics = {track: (name,data) => {window.__historyUsage.push({name,data});track?.(name,data);}};
            });
            if (pagePath.includes('index')) await page.waitForFunction(() => document.querySelector('[data-current-readings]').dataset.observedAt && document.querySelector('#skycamBadge').textContent.includes('LIVE'));
            else await page.waitForFunction(() => document.querySelector('#dailyStatusBadge').textContent.includes('CURRENT'));
            // Desktop uses the app's existing landscape layout class.
            if (width >= 900) await page.evaluate(() => document.body.classList.add('layout-landscape'));
            // Two representative viewports per browser, with bounded captures
            // instead of images of every long page in the responsive matrix.
            await reviewScreenshot(page, engine, width, pagePath.includes('index') ? 'current' : 'daily');
            if (pagePath.includes('index')) await reviewScreenshot(page, engine, width, 'skycam', '.layout-skycam');
            await page.locator('.local-water').scrollIntoViewIfNeeded();
            await page.waitForTimeout(80);
            await bounds(page, width);
            await navigation(page,width);
            await readablePalette(page);
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
              if (width === 393) await failurePaths(page, engine.name());
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
            await page.waitForFunction(() => document.querySelector('#systemHealthChecks').textContent.includes('off-site copy not configured'));
            assert.match(await page.locator('#systemHealthChecks').textContent(), /2 unresolved history gaps/);
            assert.match(await page.locator('#systemHealthChecks').textContent(), /Backups: Pending/);
            assert.match(await page.locator('#systemHealthChecks').textContent(), /Waiting for verified backup/);
            assert.match(await page.locator('#systemHealthChecks').textContent(), /Saved history: Older gaps remain/);
            const alertBox = await page.locator('.alert-dialog').boundingBox();
            assert.ok(alertBox.x >= -1 && alertBox.x + alertBox.width <= width + 1);
            if (pagePath.includes('index') && screenshotWidths.has(width)) {
              await page.locator('#systemHealth summary').click();
              await page.locator('#systemHealth').scrollIntoViewIfNeeded();
              await reviewScreenshot(page, engine, width, 'alerts-health', '#systemHealth');
              await page.locator('#systemHealth summary').click();
            }
            await page.locator('#alertClose').click();
            await page.waitForFunction(()=>document.getElementById('historyAlertSummary').textContent.includes('up to date'));
            assert.equal(await page.locator('#historyStatus').isVisible(),false);
            historyMode='stale';
            await page.evaluate(()=>window.__refreshCallbacks.forEach(fn=>fn()));
            await page.waitForFunction(()=>!document.getElementById('historyStatus').hidden);
            assert.match(await page.locator('#historyStatus').textContent(),/10-minute/);
            assert.equal(await page.locator('#stationAlertsBtn').evaluate(n=>n.classList.contains('history-warning')),true);
            const warningBox=await page.locator('#historyStatus').boundingBox();
            assert.ok(warningBox.x>=0 && warningBox.x+warningBox.width<=width+1);
            await page.locator('#historyStatus button').click();
            assert.match(await page.locator('#historyFeedStatus').textContent(),/needs attention/);
            assert.match(await page.locator('.alert-dialog').textContent(),/every 15 minutes/);
            await page.locator('#alertClose').click();
            historyMode='gaps';await page.evaluate(()=>window.__refreshCallbacks.forEach(fn=>fn()));
            await page.waitForFunction(()=>document.getElementById('historyFeedStatus').textContent.includes('4 missing intervals'));
            assert.equal(await page.locator('#historyStatus').isVisible(),false,'Older gaps must not leave a dashboard warning when current feeds recover');
            assert.equal(await page.locator('#stationAlertsBtn').evaluate(n=>n.classList.contains('history-warning')),true);
            await page.locator('#stationAlertsBtn').click();
            assert.equal(await page.locator('#historyFeedStatus').isVisible(),true);
            assert.match(await page.locator('#historyFeedStatus').textContent(),/2 unresolved gaps/);
            assert.match(await page.locator('#historyAlertSummary').textContent(),/Current history feeds are up to date/);
            assert.match(await page.locator('#historyAlertSummary').textContent(),/unresolved gaps/);
            await page.locator('#alertClose').click();
            if(pagePath.includes('index'))await reviewScreenshot(page,engine,width,'current-archive-gaps');
            historyMode='error';await page.evaluate(()=>window.__refreshCallbacks.forEach(fn=>fn()));
            await page.waitForFunction(()=>document.querySelector('#historyStatus p').textContent.includes('unavailable'));
            assert.equal(await page.locator('#historyStatus').isVisible(),true,'Unavailable current history status remains actionable');
            historyMode='fresh';await page.evaluate(()=>window.__refreshCallbacks.forEach(fn=>fn()));
            await page.waitForFunction(()=>document.getElementById('historyStatus').hidden);
            assert.equal(await page.locator('#stationAlertsBtn').evaluate(n=>n.classList.contains('history-warning')),false);
            assert.deepEqual(errors, []);
            checked++;
          }
          historyMode='stale';
          await page.goto(origin + '/forecast.html'); await navigation(page,width);
          await readablePalette(page);
          await page.waitForFunction(()=>document.getElementById('historyStatus') && !document.getElementById('historyStatus').hidden);
          assert.match(await page.locator('#historyStatus').textContent(),/10-minute/);
          historyMode='fresh';
          await page.locator('.dashboard-history-button').click();
          await historyReady(page,'10m',24);
          await page.locator('.history-close').click();
          if (width === 393) {
            for (const [state, text] of [['watch', '1.00m (Below Bridge)'], ['near', '0.50m (Below Bridge)'], ['above', '0.21m (Above Bridge)'], ['at', '0.00m (At Bridge)'], ['stale', '0.20m (Below Bridge)'], ['invalid-latest', '0.20m (Below Bridge)'], ['missing', 'River reading unavailable']]) {
              mode = state; await page.reload(); await ready(page);
              assert.equal(await page.locator('#warwickBridgeValue').textContent(), text);
              const warning = ['watch','near','above','at'].includes(state);
              assert.equal(await page.locator('#warwickBridge').getAttribute('data-warning'), String(warning));
              if (warning) {
                const style = await page.locator('#warwickBridge').getAttribute('style');
                assert.match(style, new RegExp('hsl\\(' + (state === 'watch' ? 42 : state === 'near' ? 21 : 0)));
              }
              if (state === 'stale' || state === 'invalid-latest') assert.match(await page.locator('#warwickBridgeContext').textContent(), /Last available/);
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
          for (const publicPage of ['/login.html','/help.html']) {
            await page.goto(origin + publicPage);
            await readablePalette(page);
          }
          await context.close();
        }
      } finally { await browser.close(); }
    }
    console.log('PASS: complete production scripts, failed-reading and failed-image recovery, truthful timestamps, partial sensor faults, bounded requests, health details; ' + checked + ' page/browser/width combinations; four water cards, Connolly history, single-line navigation, matched camera/radar, twenty-four-hour previews, persistent references, bridge states and rainfall inches/peak dates, warning colours, history outage/recovery banners without push permission, and exact 30-day rain comparisons.');
    console.log('Review screenshots: ' + screenshotRoot + ' (Current, SkyCam, Daily and Alerts health at phone and desktop widths).');
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
