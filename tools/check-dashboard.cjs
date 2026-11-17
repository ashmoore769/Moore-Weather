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
  if (!screenshotWidths.has(width) && !(width === 320 && view === 'current-readings-long')) return;
  fs.mkdirSync(screenshotRoot, {recursive:true});
  const file = path.join(screenshotRoot, `${engine.name()}-${screenshotWidths.get(width) || '320'}-${view}.png`);
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
let skycamEmptyNewest = false;
let skycamIncomingSequence = 0;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNU8Y5iYGBgYmBgYGBgAAAJYADNjl9iMQAAAABJRU5ErkJggg==', 'base64');
const cameraFrames = [
  {id:'fixture-old', url:'/skycam/fixture-old.jpg', capturedAt:new Date(now - 10 * 60000).toISOString()},
  {id:'fixture-new', url:'/skycam/fixture-new.jpg', capturedAt:new Date(now - 60000).toISOString()}
];
function currentRecord(overrides = {}) {
  const local = new Date(now + weatherOffset + 10 * HOUR).toISOString();
  const values = quality.currentSensors.map(key => key === '7' ? 1000 : key === '6' ? 400 : key === '3' ? 50 : key === '21' ? 13.8 : key === '23' ? 10 : key === '32' ? 0 : 20);
  values[3] = currentMode === 'partial' ? 25.7 : 23.4;
  if (currentMode === 'partial') { values[28] = 'NaN'; values[20] = -100; }
  for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
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
    ['leslie-daily', 'condamine-level-backfill', 'condamine-flow-backfill', 'condamine-warwick-live', 'connolly-current'].map(id => [id, { complete: true, lastSuccess:new Date(now).toISOString() }])),
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
    return res.end(JSON.stringify({stationObservedAt:new Date(Math.floor((now + weatherOffset) / 1000) * 1000).toISOString(),lastWeatherPoll:new Date(now).toISOString(),dailyUpToDate:true,dailySummaryDate:expectedReportingDate(now)}));
  }
  if (url.pathname === '/skycam/history') { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({images:cameraFrames})); }
  if (url.pathname.startsWith('/skycam/')) {
    res.setHeader('Cache-Control','no-store');
    if (url.pathname.includes('fixture-new')) {
      skycamAttempts++;
      if (skycamEmptyNewest) { res.setHeader('Content-Type','image/jpeg'); return res.end(); }
      if (skycamFailNewest) {res.statusCode=503;return res.end();}
    }
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
async function assertDark(page) {
  assert.deepEqual(await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    toggle: Boolean(document.querySelector('#themeToggleBtn')),
    chrome: document.querySelector('meta[name="theme-color"]').content
  })), { theme:'dark', scheme:'dark', toggle:false, chrome:'#0d1722' });
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
      connolly: rect('.water-connolly'), groups:rect('.water-groups'), dams:rect('#damLevels'), rivers:rect('#riverLevels'),
      damGrid:rect('#damLevels .water-grid'), riverGrid:rect('#riverLevels .water-grid'),
      groupLabels:[...document.querySelectorAll('.water-group h2')].map(n=>n.textContent),
      order:[...document.querySelectorAll('.water-panel h3')].map(n=>n.textContent),
      svg: rect('.water-warwick .history-spark > svg'), refs, overflow: document.documentElement.scrollWidth > innerWidth };
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
  assert.deepEqual(boxes.groupLabels, ['Dam Levels','River Levels']);
  assert.deepEqual(boxes.order, ['Leslie Dam','Connolly Dam','Scots College','Warwick']);
  for (const [first,second,grid,group] of [[boxes.dam,boxes.connolly,boxes.damGrid,boxes.dams],[boxes.scots,boxes.warwick,boxes.riverGrid,boxes.rivers]]) {
    for(const panel of [first,second]) assert.ok(panel.x >= group.x && panel.right <= group.right && panel.bottom <= group.bottom,
      'Water panels stay inside their named group: '+JSON.stringify({panel,group}));
    if(grid.width >= 500) assert.ok(first.x < second.x && Math.abs(first.y-second.y)<1, 'Paired water cards keep their reading order');
    else assert.ok(first.bottom <= second.y, 'Stacked water cards keep their reading order');
  }
  if(boxes.groups.width >= 1100) assert.ok(boxes.dams.x < boxes.rivers.x && Math.abs(boxes.dams.y-boxes.rivers.y)<1);
  else assert.ok(boxes.dams.bottom <= boxes.rivers.y, 'Dam Levels precedes River Levels');
  for (const r of boxes.refs) assert.ok(r.x >= boxes.svg.x - 1 && r.right <= boxes.svg.right + 1 &&
    r.y >= boxes.svg.y - 1 && r.bottom <= boxes.svg.bottom + 1, 'Reference label clipped: ' + JSON.stringify({ r, svg: boxes.svg }));
  const sorted = boxes.refs.sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].y >= sorted[i - 1].bottom, 'Reference labels overlap');
}
async function currentReadingsLayout(page, state = 'fresh') {
  try { await assertCurrentReadingsLayout(page, state); }
  catch (error) {
    // Geometry failures must retain the whole ten-card review image, including
    // widths and failure states outside the normal screenshot selection.
    try {
      fs.mkdirSync(screenshotRoot, {recursive:true});
      const engine = page.context().browser().browserType().name(), width = page.viewportSize().width;
      const file = `${engine}-${width}-current-readings-${state.replace(/[^a-z0-9]+/gi, '-')}-failure.png`;
      await page.locator('.layout-primary').screenshot({path:path.join(screenshotRoot, file), animations:'disabled', timeout:5000});
      console.error('Current-reading geometry failure screenshot: ' + file);
    } catch (captureError) { console.error('Could not capture current-reading geometry: ' + captureError.message); }
    throw error;
  }
}
async function assertCurrentReadingsLayout(page, state) {
  await page.waitForFunction(() => document.querySelectorAll('.layout-primary .current-reading-card .history-spark > svg').length === 10);
  const cards = await page.evaluate(() => {
    const valueIds = ['tempVal', 'blackGlobeTempVal', 'humidityVal', 'rainSince9Val', 'windSpeedVal',
      'windDirDegVal', 'solarRadVal', 'pressureVal', 'dewPointVal', 'evapRateVal'];
    const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
    return [...document.querySelectorAll('.layout-primary .current-reading-card')].map(card => {
      const heading = card.querySelector('.current-reading-heading'), label = card.querySelector('.current-reading-label');
      const iconRoot = card.querySelector('.current-reading-icon');
      const icon = iconRoot?.matches('svg') ? iconRoot : iconRoot?.querySelector('svg');
      const value = card.querySelector('.current-reading-value'), detail = card.querySelector('.current-reading-detail');
      const spark = card.querySelector('.history-spark'), css = getComputedStyle(card), titleCss = getComputedStyle(label);
      const text = document.createRange(); text.selectNodeContents(label);
      const valueText = document.createRange(); valueText.selectNodeContents(value);
      const id = valueIds.find(id => card.contains(document.getElementById(id)));
      return { id, title:label.textContent.trim(), box:rect(card), heading:rect(heading), label:rect(label), titleText:rect(text), icon:rect(icon),
        value:rect(value), valueText:rect(valueText), detail:detail && detail.getBoundingClientRect().height > 0 ? rect(detail) : null,
        plot:rect(spark.querySelector(':scope > svg')), caption:rect(spark.querySelector('.history-spark-caption')),
        padding:[css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft],
        titleStyle:[titleCss.fontSize, titleCss.fontWeight, titleCss.lineHeight, titleCss.letterSpacing],
        headingGap:getComputedStyle(heading).columnGap,
        titleLineHeight:parseFloat(titleCss.lineHeight) || parseFloat(titleCss.fontSize) * 1.5,
        sparks:card.querySelectorAll('.history-spark').length, icons:card.querySelectorAll('.current-reading-icon').length,
        role:card.getAttribute('role'), tabIndex:card.tabIndex, popup:card.getAttribute('aria-haspopup'),
        describedBy:(card.getAttribute('aria-describedby') || '').split(/\s+/), unitId:document.getElementById(id + 'Unit')?.id,
        parts:[heading, value, detail, spark].filter(node => node && node.getBoundingClientRect().height > 0)
          .map(node => ({...rect(node), scroll:node.scrollWidth, client:node.clientWidth})) };
    });
  });
  assert.equal(cards.length, 10, 'all current readings retain their cards');
  for (const card of cards) {
    const context = state + ' ' + card.id;
    assert.deepEqual(card.padding, cards[0].padding, context + ': consistent card padding');
    assert.deepEqual(card.titleStyle, cards[0].titleStyle, context + ': consistent title typography');
    assert.equal(card.icons, 1); assert.equal(card.sparks, 1);
    assert.ok(Math.abs(card.icon.width - 16) <= 1 && Math.abs(card.icon.height - 16) <= 1, context + ': consistent visible icons');
    assert.ok(card.label.height <= card.titleLineHeight + 1 && card.titleText.right <= card.heading.right + 1,
      context + ': title stays on one line without clipping: ' + JSON.stringify({title:card.title, box:card.box,
        heading:card.heading, label:card.label, text:card.titleText, icon:card.icon, gap:card.headingGap,
        style:card.titleStyle, lineHeight:card.titleLineHeight}));
    assert.ok(card.titleText.x >= card.icon.right + 1, context + ': icon and title do not overlap');
    for (const part of [...card.parts, card.valueText, card.icon, card.plot, card.caption]) {
      assert.ok(part.x >= card.box.x - 1 && part.right <= card.box.right + 1 && part.y >= card.box.y - 1 && part.bottom <= card.box.bottom + 1,
        context + ': content remains inside its card: ' + JSON.stringify({box:card.box, part}));
      if (part.client) assert.ok(part.scroll <= part.client + 1, context + ': content must not overflow horizontally');
    }
    assert.ok(card.value.y >= card.heading.bottom - 1 && card.plot.y >= Math.max(card.value.bottom, card.detail?.bottom ?? card.value.bottom) - 1,
      context + ': header, value/detail and graph do not overlap');
    assert.ok(Math.abs(card.plot.height - 42) <= 1 && card.caption.y >= card.plot.bottom - 1, context + ': graph and caption keep consistent spacing');
    assert.equal(card.role, 'button'); assert.equal(card.tabIndex, 0); assert.equal(card.popup, 'dialog');
    assert.ok(card.describedBy.includes(card.id), context + ': history description retains its reading');
    if (card.unitId) assert.ok(card.describedBy.includes(card.unitId), context + ': history description retains the separate unit');
  }
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    if (Math.abs(a.box.y - b.box.y) > 1) continue;
    for (const part of ['heading', 'value', 'plot', 'caption']) {
      assert.ok(Math.abs(a[part].y - b[part].y) <= 1, state + ': neighbouring ' + part + ' rows align: ' + a.id + '/' + b.id);
    }
    assert.ok(Math.abs(a.plot.bottom - b.plot.bottom) <= 1 && Math.abs(a.box.bottom - b.box.bottom) <= 1,
      state + ': neighbouring cards and graphs finish together');
  }
}
async function navigation(page, width) {
  const nav = page.locator('.dashboard-tabs');
  const labels = await nav.locator('.dashboard-tab').allInnerTexts();
  assert.deepEqual(labels.map(s => s.replace(/\s+/g, ' ').trim()), ['Dashboard', 'Forecast', 'Daily Summary', 'Trends']);
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
async function soilProfileLayout(page) {
  const geometry = await page.evaluate(() => {
    const rect = node => { const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width}; };
    const soil=document.querySelector('#soilProfile');
    return { landscape:innerWidth>=900 && document.body.classList.contains('layout-landscape'),
      nested:document.querySelector('#weatherData').contains(soil),
      count:document.querySelectorAll('#soilProfile').length,
      soil:rect(soil), weather:rect(document.querySelector('#weatherData')),
      primary:rect(document.querySelector('.layout-primary')),
      forecast:rect(document.querySelector('#forecastSummary')),
      rows:[...soil.querySelectorAll('.soil-reading')].map(row => ({box:rect(row),
        metrics:[...row.querySelectorAll('.soil-reading-value')].map(metric => ({box:rect(metric),
          contents:[...metric.querySelectorAll('.soil-reading-value-label,.soil-reading-value-number,.history-spark')].map(rect)}))})) };
  });
  const {soil,weather,primary,forecast,rows}=geometry;
  assert.equal(geometry.count,1,'One soil card serves every layout');
  if(geometry.landscape) {
    assert.equal(geometry.nested,true,'Desktop soil sits within the current readings section');
    assert.ok(Math.abs(soil.x-primary.x)<1 && Math.abs(soil.width-primary.width)<1,'Desktop soil aligns with the readings column');
    assert.ok(Math.abs(soil.y-primary.bottom-20)<1,'Desktop soil follows the readings with the normal grid gap');
    assert.ok(soil.bottom<=weather.bottom,'Desktop soil stays inside the current readings section');
    assert.ok(forecast.y>=weather.bottom+12 && forecast.y<=weather.bottom+40,'Forecast follows the main section without a vacated soil-card gap');
  } else {
    assert.equal(geometry.nested,false,'Mobile and portrait soil remain an independent dashboard card');
    assert.ok(Math.abs(soil.x-forecast.x)<1 && Math.abs(soil.width-forecast.width)<1,'Soil spans the same width as the standalone cards');
    assert.ok(soil.y>=weather.bottom+12 && forecast.y>=soil.bottom+12,'Soil has clear separation from adjacent sections');
  }
  for(const {box,metrics} of rows) {
    assert.ok(box.x>=soil.x && box.right<=soil.right,'Soil depth row stays inside its card');
    for(const {box:metric,contents} of metrics) {
      assert.ok(metric.x>=box.x && metric.right<=box.right,'Soil metrics stay inside their depth row');
      for(const child of contents) assert.ok(child.x>=metric.x-1 && child.right<=metric.right+1 && child.y>=box.y-1 && child.bottom<=box.bottom+1,'Soil reading or trend clips: '+JSON.stringify({metric,child,box}));
    }
  }
}
async function cameraControlLayout(page, engine, width) {
  for(const state of ['live','history']) {
    await page.evaluate(state=>showSkyCamHistory(state==='live'?skycamHistory.length-1:0,{manual:true,followLive:state==='live',transitionMs:0}),state);
    const boxes=await page.evaluate(()=>{
      const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scroll:node.scrollWidth,client:node.clientWidth};};
      return {stage:rect(document.querySelector('.skycam-container')),
        parts:[...document.querySelectorAll('.skycam-caption > span,.skycam-actions')].map(rect),
        buttons:[...document.querySelectorAll('.skycam-action')].filter(n=>getComputedStyle(n).display!=='none').map(rect)};
    });
    for(const item of boxes.parts) assert.ok(item.x>=boxes.stage.x && item.right<=boxes.stage.right && item.y>=boxes.stage.y && item.bottom<=boxes.stage.bottom && item.scroll<=item.client+1,'SkyCam caption clips in '+state+': '+JSON.stringify(boxes));
    for(let i=0;i<boxes.parts.length;i++)for(let j=i+1;j<boxes.parts.length;j++){
      const a=boxes.parts[i],b=boxes.parts[j];
      assert.ok(a.right<=b.x+1 || b.right<=a.x+1 || a.bottom<=b.y+1 || b.bottom<=a.y+1,'SkyCam caption overlaps in '+state);
    }
    for(const button of boxes.buttons) assert.ok(button.width>=40 && button.height>=40,'SkyCam controls retain usable touch targets');
    if([320,393,1440].includes(width)) {
      fs.mkdirSync(screenshotRoot,{recursive:true});
      await page.locator('.layout-skycam').screenshot({path:path.join(screenshotRoot,`${engine.name()}-${width}-skycam-${state}.png`),animations:'disabled'});
    }
  }
  await page.evaluate(()=>showSkyCamHistory(skycamHistory.length-1,{manual:true,followLive:true,transitionMs:0}));
}
async function initialCameraRecovery(page) {
  // A separate context avoids reusing pixels already decoded by the main page,
  // especially WebKit's in-memory resource cache for the exact image URL.
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  const origin = new URL(page.url()).origin;
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(fixtureNow => { Date.now = () => fixtureNow; }, now);
  const startup = await context.newPage(), errors = [], imageRequests = [];
  startup.on('pageerror', error => errors.push(error.message));
  startup.on('request', request => {
    if (new URL(request.url()).pathname === '/skycam/fixture-new.jpg') imageRequests.push(request.url());
  });
  try {
    skycamEmptyNewest = true;
    const emptyResponse = startup.waitForResponse(response => new URL(response.url()).pathname === '/skycam/fixture-new.jpg');
    await startup.goto(page.url());
    const response = await emptyResponse;
    assert.equal(response.status(), 200);
    assert.equal((await response.body()).length, 0, 'Reproduce the HTTP200 zero-byte archive incident');
    await startup.waitForFunction(() => skycamDisplayedEntry?.id === 'fixture-old' && !skycamImageLoading);
    const oldTimestamp = await startup.locator('#skycamTime').textContent();
    assert.equal(oldTimestamp, await startup.evaluate(entry => formatSkyCamTime(entry.capturedAt), cameraFrames[0]));
    assert.equal(await startup.evaluate(() => skycamFollowLive), true);
    assert.equal(await startup.locator('#skycamBadge').getAttribute('data-state'), 'stale');
    assert.equal(await startup.locator('#skycamBadge').evaluate(node => getComputedStyle(node, '::before').backgroundColor), 'rgb(255, 205, 95)');
    assert.match(await startup.locator('#skycamPosition').textContent(), /latest image unavailable; retrying/);
    await startup.evaluate(() => refreshSkyCam());
    assert.equal(await startup.locator('#skycamTime').textContent(), oldTimestamp);
    assert.equal(imageRequests.length, 2);
    assert.equal(new Set(imageRequests).size, 2, 'A failed newest image must be retried at a fresh URL');
    skycamEmptyNewest = false;
    await startup.evaluate(() => refreshSkyCam());
    assert.equal(await startup.evaluate(() => skycamDisplayedEntry.id), 'fixture-new');
    assert.equal(await startup.locator('#skycamTime').textContent(), await startup.evaluate(entry => formatSkyCamTime(entry.capturedAt), cameraFrames[1]));
    assert.equal(await startup.locator('#skycamBadge').getAttribute('data-state'), 'live');
    assert.equal(await startup.locator('#skycamBadge').evaluate(node => getComputedStyle(node, '::before').backgroundColor), 'rgb(70, 212, 126)');
    assert.deepEqual(errors, []);
  } finally {
    skycamEmptyNewest = false;
    await context.close();
  }
}

async function failurePaths(page, browserName) {
  await initialCameraRecovery(page);
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
  await currentReadingsLayout(page, 'stale');
  currentMode = 'partial'; await page.evaluate(() => fetchWeather());
  assert.equal(await page.locator('#tempVal').textContent(), '25.7°C');
  assert.equal(await page.locator('#blackGlobeTempVal').textContent(), '--');
  assert.equal(await page.locator('#soilTemp10Val').textContent(), '--');
  assert.equal(await page.locator('#radiantDiffVal').textContent(), '--');
  assert.match(await page.locator('#statusBadge').textContent(), /PARTIAL/);
  await currentReadingsLayout(page, 'partial');
  currentMode = 'hang';
  await page.evaluate(async () => {
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = ms => timeout.call(AbortSignal, ms === 12000 ? 40 : ms);
    try { await fetchWeather(); } finally { AbortSignal.timeout = timeout; }
  });
  assert.match(await page.locator('#currentReadingStatus').textContent(), /timed out/);
  assert.equal(await page.locator('#fetchBtn').isDisabled(), false);
  await currentReadingsLayout(page, 'timeout');
  currentMode = 'fresh'; await page.evaluate(() => fetchWeather());
  assert.match(await page.locator('#statusBadge').textContent(), /LIVE/);
  assert.equal(await page.locator('#currentReadingStatus').isVisible(), false);
  await currentReadingsLayout(page, 'recovered');

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
        for (const width of process.env.DASHBOARD_SKYCAM_ONLY ? [393] : [320, 393, 768, 1024, 1440]) {
          const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: 'dark' });
          await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await context.addInitScript(fixtureNow => {
            // Keep browser requests on the same clock as the fixed API fixtures, even across an hour boundary.
            Date.now = () => fixtureNow;
            localStorage.setItem('mooreWeatherTheme', 'light');
            localStorage.setItem('mooreWeatherThemeVersion', '4');
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
          for (const pagePath of process.env.DASHBOARD_SKYCAM_ONLY ? ['/index.html'] : ['/index.html', '/daily.html']) {
            mode = 'fresh'; historyMode = 'fresh'; currentMode='fresh'; weatherOffset=0;skycamFailNewest=false;
            await page.goto(origin + pagePath); await ready(page);
            await assertDark(page);
            await page.evaluate(() => {
              const track = window.mooreAnalytics?.track;
              window.mooreAnalytics = {track: (name,data) => {window.__historyUsage.push({name,data});track?.(name,data);}};
            });
            if (pagePath.includes('index')) await page.waitForFunction(() => document.querySelector('[data-current-readings]').dataset.observedAt && document.querySelector('#skycamBadge').textContent.includes('LIVE'));
            else await page.waitForFunction(() => document.querySelector('#dailyStatusBadge').textContent.includes('CURRENT'));
            if (process.env.DASHBOARD_SKYCAM_ONLY) {
              await failurePaths(page, engine.name());
              await reviewScreenshot(page, engine, width, 'skycam-recovery', '.layout-skycam');
              assert.deepEqual(errors, []);
              checked++;
              continue;
            }
            // Current uses the real layout control so responsive card placement runs too.
            if (width >= 900) {
              if (pagePath.includes('index')) await page.evaluate(() => setDesktopLayout('landscape'));
              else await page.evaluate(() => document.body.classList.add('layout-landscape'));
            }
            if (pagePath.includes('index')) {
              await currentReadingsLayout(page);
              await reviewScreenshot(page, engine, width, 'current-readings', '.layout-primary');
              if (width === 320) {
                try {
                  await page.evaluate(csv => updateWeatherData(csv), currentRecord({0:199.9, 1:359.9, 2:100,
                    3:-12.3, 4:9.9, 5:1399.9, 6:1099.9, 12:199.9, 15:225, 16:9.99, 19:-24.5, 28:49.9}));
                  await page.waitForFunction(() => document.getElementById('rainSince9Inches').textContent === '(8.86 in)');
                  await currentReadingsLayout(page, 'long values');
                  await reviewScreenshot(page, engine, width, 'current-readings-long', '.layout-primary');
                } finally { await page.evaluate(csv => updateWeatherData(csv), currentRecord()); }
              }
              if (width === 393) {
                await page.locator('#tempVal').locator('xpath=ancestor::*[contains(@class,"temp-hero")]').press('Enter');
                await historyReady(page, '10m', 24); assert.equal(requests.at(-1).metric, 'air');
                await page.locator('.history-close').click();
                await page.locator('#dewPointVal').locator('xpath=ancestor::*[contains(@class,"quick-stat")]').locator('.current-reading-heading').click();
                await historyReady(page, '10m', 24); assert.equal(requests.at(-1).metric, 'dew');
                await page.locator('.history-close').click();
              }
            }
            // Two representative viewports per browser, with bounded captures
            // instead of images of every long page in the responsive matrix.
            await reviewScreenshot(page, engine, width, pagePath.includes('index') ? 'current' : 'daily');
            if (pagePath.includes('index')) {
              await reviewScreenshot(page, engine, width, 'skycam', '.layout-skycam');
              await reviewScreenshot(page, engine, width, 'soil', '#soilProfile');
            }
            await page.locator('.local-water').scrollIntoViewIfNeeded();
            await page.waitForTimeout(80);
            await bounds(page, width);
            if(pagePath.includes('index')) await reviewScreenshot(page,engine,width,'water-levels','#localWater');
            await navigation(page,width);
            await readablePalette(page);
            assert.equal(await page.locator('#waterImportStatus').isVisible(), false);
            assert.match(await page.locator('#connollyStorageTime').textContent(), /Council report/);
            assert.match(await page.locator('#connollySourceCheck').textContent(), /Source checked/);
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
              await cameraControlLayout(page,engine,width);
              await soilProfileLayout(page);
              if(width===1440) {
                await page.evaluate(()=>{
                  window.__soilBeforeLayout={card:document.querySelector('#soilProfile'),spark:document.querySelector('#soilProfile .history-spark')};
                  setDesktopLayout('portrait');
                });
                await soilProfileLayout(page);
                await page.evaluate(()=>setDesktopLayout('landscape'));
                await soilProfileLayout(page);
                await page.setViewportSize({width:393,height:960});
                await page.waitForFunction(()=>document.body.classList.contains('layout-portrait') && !document.querySelector('#weatherData').contains(document.querySelector('#soilProfile')));
                await soilProfileLayout(page);
                await page.setViewportSize({width,height:960});
                await page.waitForFunction(()=>document.body.classList.contains('layout-landscape') && document.querySelector('#weatherData').contains(document.querySelector('#soilProfile')));
                await soilProfileLayout(page);
                assert.equal(await page.evaluate(()=>window.__soilBeforeLayout.card===document.querySelector('#soilProfile') && window.__soilBeforeLayout.spark===document.querySelector('#soilProfile .history-spark')),true,'Layout changes retain the soil card and its existing sparkline nodes');
              }
              await page.locator('#soilTemp10Val').click(); await historyReady(page,'10m',24);
              assert.equal(requests.at(-1).metric,'soil-temp-10','Soil card retains history navigation in every layout');
              await page.locator('.history-close').click();
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
              const readingSizes = await page.evaluate(() => Object.fromEntries([
                'tempVal', 'blackGlobeTempVal', 'humidityVal', 'rainSince9Val',
                'windSpeedVal', 'windDirDegVal', 'solarRadVal', 'pressureVal', 'dewPointVal', 'evapRateVal'
              ].map(id => [id, parseFloat(getComputedStyle(document.getElementById(id)).fontSize)])));
              const lowerSizes = ['windSpeedVal', 'windDirDegVal', 'solarRadVal', 'pressureVal', 'dewPointVal', 'evapRateVal']
                .map(id => readingSizes[id]);
              assert.equal(readingSizes.humidityVal, readingSizes.rainSince9Val, 'humidity and rainfall share the same emphasis');
              assert.equal(new Set(lowerSizes).size, 1, 'the six lower readings use uniform numerical type');
              assert.equal(readingSizes.tempVal, readingSizes.blackGlobeTempVal, 'both temperature readings have equal prominence');
              assert.ok(readingSizes.tempVal > readingSizes.humidityVal && readingSizes.humidityVal > lowerSizes[0],
                'temperature, humidity/rainfall, and lower readings retain their visual hierarchy: ' + JSON.stringify(readingSizes));
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
              if (pagePath.includes('index')) await page.evaluate(() => setDesktopLayout('portrait'));
              else await page.evaluate(() => { document.body.classList.remove('layout-landscape'); document.body.classList.add('layout-portrait'); });
              await page.waitForTimeout(80); await bounds(page, width);
              await page.emulateMedia({ colorScheme: 'light' });
              await page.evaluate(() => {
                // An older open tab can still write its obsolete preference.
                localStorage.setItem('mooreWeatherTheme', 'light');
                window.dispatchEvent(new StorageEvent('storage', {
                  key:'mooreWeatherTheme', oldValue:'dark', newValue:'light', storageArea:localStorage
                }));
              });
              await assertDark(page);
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
    console.log(process.env.DASHBOARD_SKYCAM_ONLY
      ? 'PASS: zero-byte newest camera fallback, truthful older timestamps, automatic newest recovery, status colours, and existing failure recovery; ' + checked + ' browser/phone combinations.'
      : 'PASS: complete production scripts, failed-reading and failed-image recovery, truthful timestamps, partial sensor faults, bounded requests, health details; ' + checked + ' page/browser/width combinations; four water cards, Connolly history, single-line navigation, matched camera/radar, twenty-four-hour previews, persistent references, bridge states and rainfall inches/peak dates, warning colours, history outage/recovery banners without push permission, and exact 30-day rain comparisons.');
    console.log('Review screenshots: ' + screenshotRoot + ' (Current, SkyCam, Daily and Alerts health at phone and desktop widths).');
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
