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
const historyRequests = [];
const dashboard = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (tag, attributes) =>
    /\bsrc="\/(?:solar-chart|power-chart-controls|station-power-chart|yard-power|theme)\.js\b/.test(attributes) ? tag : '');

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
        return { fill: css.fill, stroke: css.stroke, strokeWidth: parseFloat(css.strokeWidth), dash: css.strokeDasharray,
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
  assert.ok(Math.abs(chart.svg.viewportHeight - 224) <= 1 && chart.svg.viewBoxHeight === 224,
    description + ': the enlarged graph has a matching 224px canvas and viewBox');
  assert.ok(chart.labels.length >= 6, description + ': both scales and time labels are present');
  for (const label of chart.labels) {
    assert.ok(label.renderedFontSize >= 11.9,
      description + ': 12px axis text must not be shrunk by SVG scaling: ' + JSON.stringify(label));
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

async function powerWindow(page, prefix) {
  return page.locator('#' + prefix + ' .power-chart-plot').evaluate(element => ({
    start: Number(element.dataset.windowStart), end: Number(element.dataset.windowEnd),
    span: Number(element.dataset.windowSpan), zoomed: element.dataset.zoomed
  }));
}
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 2, label + ': ' + a + ' vs ' + b);

async function chartNavigation(page, prefix, width) {
  const plot = page.locator('#' + prefix + ' .power-chart-plot'), initial = await powerWindow(page, prefix);
  const before = dataRequests, originalPaths = await plot.locator('svg path').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
  const axes = await plot.locator('svg text').allTextContents();
  near(initial.span, (prefix === 'yardPower' ? 12 : 24) * HOUR, prefix + ' initially shows its selected period');
  assert.equal(await page.locator('#' + prefix + 'ZoomReset').isDisabled(), true);
  await page.locator('#' + prefix + 'ZoomIn').click();
  const zoomed = await powerWindow(page, prefix);
  near(zoomed.span, initial.span / 2, prefix + ' button zoom halves the time window');
  assert.deepEqual((await plot.locator('svg text').allTextContents()).slice(0, 4), axes.slice(0, 4),
    prefix + ' preserves both unit scales while zooming');
  await plot.press('Shift+ArrowLeft');
  const earlier = await powerWindow(page, prefix);
  assert.ok(earlier.start < zoomed.start, prefix + ' keyboard pans earlier');
  near(earlier.span, zoomed.span, prefix + ' pan retains scale');
  await page.locator('#' + prefix + 'PanLater').click();
  const later = await powerWindow(page, prefix);
  assert.ok(later.start > earlier.start, prefix + ' button pans later');
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  const dragged = await powerWindow(page, prefix);
  assert.ok(dragged.start < later.start, prefix + ' dragging right reveals earlier readings');
  near(dragged.span, later.span, prefix + ' drag retains scale');
  await plot.press('+');
  assert.ok((await powerWindow(page, prefix)).span < dragged.span, prefix + ' keyboard zoom works');
  await plot.press('Home');
  assert.equal(await page.locator('#' + prefix + 'Scrubber').inputValue(), '0');
  const first = await page.locator('#' + prefix + 'Inspect').textContent();
  await plot.press('End');
  assert.notEqual(await page.locator('#' + prefix + 'Inspect').textContent(), first, prefix + ' keyboard inspects recorded times');
  await page.locator('#' + prefix + 'Scrubber').evaluate(element => { element.value = '0'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.locator('#' + prefix + 'Inspect').textContent(), first, prefix + ' slider scrubs the same recorded measurements');
  assert.equal(await plot.locator('.power-chart-selection').getAttribute('visibility'), 'visible');
  assert.match(first, /AEST/); assert.match(first, / V/); assert.match(first, prefix === 'stationPower' ? / mA/ : / W/);
  if (prefix === 'stationPower') {
    const beforeUpdate = await powerWindow(page, prefix);
    await page.evaluate(series => window.dispatchEvent(new CustomEvent('moore-weather-station-trends', { detail: { series } })), station);
    assert.deepEqual(await powerWindow(page, prefix), beforeUpdate, 'routine station history update preserves the chosen view');
  }
  for (let attempt = 0; attempt < 8 && !await page.locator('#' + prefix + 'ZoomIn').isDisabled(); attempt++) await page.locator('#' + prefix + 'ZoomIn').click();
  near((await powerWindow(page, prefix)).span, HOUR, prefix + ' zoom stops at one hour');
  await page.locator('#' + prefix + 'ZoomOut').click();
  near((await powerWindow(page, prefix)).span, 2 * HOUR, prefix + ' zoom-out button expands the view');
  await plot.press('0');
  assert.deepEqual(await powerWindow(page, prefix), initial, prefix + ' keyboard reset restores the full domain');
  assert.deepEqual(await plot.locator('svg path').evaluateAll(paths => paths.map(path => path.getAttribute('d'))), originalPaths,
    prefix + ' reset restores the exact samples and gaps');
  if (width >= 900) {
    await plot.scrollIntoViewIfNeeded(); const target = await plot.boundingBox();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2); await page.mouse.wheel(0, -160);
    await page.waitForFunction(({ prefix, span }) => Number(document.querySelector('#' + prefix + ' .power-chart-plot').dataset.windowSpan) < span,
      { prefix, span: initial.span });
    await page.locator('#' + prefix + 'ZoomReset').click();
  }
  assert.equal(dataRequests, before, prefix + ' navigation, inspection and rendering never request more readings');
}

async function touchNavigation(page, context, engine, prefix) {
  const plot = page.locator('#' + prefix + ' .power-chart-plot'), initial = await powerWindow(page, prefix), before = dataRequests;
  await plot.scrollIntoViewIfNeeded(); const box = await plot.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (engine === chromium) {
    const session = await context.newCDPSession(page);
    const points = distance => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(box.width * .12) });
    for (let step = 1; step <= 8; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(box.width * (.12 + .02 * step)) });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok((await powerWindow(page, prefix)).span < initial.span * .8, prefix + ' native pinch zooms the time window');
    await page.locator('#' + prefix + 'ZoomReset').click();
    // Leave enough page below the chart to test native vertical scrolling even
    // for Yard Power near the footer; the graph remains within the viewport.
    await plot.evaluate(element => scrollTo(0, Math.max(0, Math.min(element.getBoundingClientRect().top + scrollY - 200,
      document.documentElement.scrollHeight - innerHeight - 150))));
    const next = await plot.boundingBox(), oldScroll = await page.evaluate(() => scrollY);
    const touch = { x: next.x + next.width / 2, y: next.y + next.height * .75, id: 3 };
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
    for (let step = 1; step <= 8; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, y: touch.y - step * 12 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(previous => scrollY > previous + 10, oldScroll);
    near((await powerWindow(page, prefix)).span, initial.span, prefix + ' single-finger page scroll does not zoom');
    await session.detach();
  } else {
    // WebKit exposes no native multitouch automation; use its real pointer
    // handlers while Chromium above checks native browser gesture arbitration.
    await plot.evaluate((element, box) => {
      const fire = (type, id, distance) => element.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: box.x + (id === 1 ? -distance : distance), clientY: box.y
      }));
      fire('pointerdown', 1, box.width * .12); fire('pointerdown', 2, box.width * .12);
      for (let step = 1; step <= 8; step++) { fire('pointermove', 1, box.width * (.12 + .02 * step)); fire('pointermove', 2, box.width * (.12 + .02 * step)); }
      fire('pointerup', 1, box.width * .28); fire('pointerup', 2, box.width * .28);
    }, { x, y, width: box.width });
    assert.ok((await powerWindow(page, prefix)).span < initial.span * .8, prefix + ' WebKit pinch handlers zoom the time window');
    await page.locator('#' + prefix + 'ZoomReset').click();
  }
  assert.equal(await plot.getAttribute('data-dragging'), 'false', prefix + ' gestures release cleanly');
  assert.equal(dataRequests, before, prefix + ' touch navigation uses cached history');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) dataRequests++;
  if (url.pathname === '/api/yard-power') {
    requests++;
    const range = url.searchParams.get('range'), duration = { '12h': 12 * HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR }[range];
    if (range) historyRequests.push(range);
    const current = template(now - (mode === 'stale' ? 12 : 1) * MINUTE);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ enabled: true, status: mode === 'stale' ? 'stale' : 'fresh',
      current, staleAfterSeconds: 180, timezone: 'Australia/Brisbane',
      range: range || null,
      history: range ? (historyMode === 'sparse' ? sparseYardHistory : history)
        .filter(point => Date.parse(point.observedAt) >= now - duration) : null }));
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
          { width: 1279, layout: 'landscape', yardColumns: 6, stationColumns: 4 },
          { width: 1280, layout: 'landscape', yardColumns: 3, stationColumns: 2 },
          { width: 1366, layout: 'landscape', yardColumns: 3, stationColumns: 2 }
        ]) {
          const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark', hasTouch: true });
          await context.addInitScript(fixtureNow => { Date.now = () => fixtureNow; }, now);
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          try {
            const initialHistoryRequest = historyRequests.length;
            await page.goto(origin + '/index.html');
            await page.waitForFunction(() => !document.getElementById('yardPower').hidden);
            await page.evaluate(layout => {
              document.body.classList.remove('layout-portrait', 'layout-landscape');
              document.body.classList.add('layout-' + layout);
              document.documentElement.dataset.theme = 'dark';
              // Display the static Home Solar card too, so this fixture checks the whole power group.
              document.getElementById('homeSolar').hidden = false;
            }, layout);
            await page.waitForFunction(() => document.getElementById('yardPowerHistoryDetail').textContent.includes('recorded intervals'));
            assert.deepEqual(historyRequests.slice(initialHistoryRequest), ['12h'], 'Yard initially requests exactly its real 12-hour history period');
            assert.deepEqual(await page.locator('[data-yard-range]').evaluateAll(buttons => buttons.map(button =>
              [button.dataset.yardRange, button.getAttribute('aria-pressed')])),
            [['12h', 'true'], ['24h', 'false'], ['7d', 'false'], ['30d', 'false']], 'the initial range control agrees with the history request');
            assert.ok((await page.locator('#yardPowerChart text').allTextContents()).includes('12h ago'), 'the initial time axis labels the selected half-day');
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
              const bbox = el => { const b = el.getBoundingClientRect(); return { x: b.x, right: b.right, y: b.y, bottom: b.bottom, width: b.width, height: b.height }; };
              const powerCards = ['homeSolar', 'stationPower', 'yardPower'].map(id => document.getElementById(id));
              return {
                yardColumns: gridCount('#yardPower .yard-power-grid'),
                stationColumns: gridCount('#stationPower .metric-list'),
                yardMetrics: document.querySelectorAll('#yardPower .yard-power-metric').length,
                stationMetrics: document.querySelectorAll('#stationPower .metric-row').length,
                stationTraces: document.querySelectorAll('#stationPowerChart path.station-power-series').length,
                yardTraces: document.querySelectorAll('#yardPowerChart path.yard-line').length,
                station: bbox(station), yard: bbox(yard),
                equipmentOrder: [...document.querySelector('.dashboard-power').children].map(card => card.id),
                solarBeforeEquipment: Boolean(document.getElementById('homeSolar').compareDocumentPosition(station) & Node.DOCUMENT_POSITION_FOLLOWING),
                powerTitles: powerCards.map(card => card.querySelector('.section-title').textContent.trim()),
                powerBounds: powerCards.map(bbox),
                content: [station, yard].map(card => ({ id:card.id, clientHeight:card.clientHeight, scrollHeight:card.scrollHeight })),
                labels: [...document.querySelectorAll('#stationPower .metric-label,#yardPower .yard-power-label,.station-power-legend,.yard-power-legend,.power-chart-inspect')]
                  .map(element => ({ text:element.textContent, size:parseFloat(getComputedStyle(element).fontSize) })),
                controls: [station, yard].map(card => ({ card: bbox(card),
                  buttons: [...card.querySelectorAll('.power-chart-navigation button,.yard-power-range button')].map(bbox),
                  parts: [...card.querySelectorAll('.power-chart-navigation > *, .power-chart-scrubber, .power-chart-inspect, .yard-power-range button')].map(bbox) })),
                stationKeys: ['battery', 'panel', 'load', 'charge'].map(id => {
                  const key = document.querySelector('.station-power-key-' + id);
                  return { id, colour: getComputedStyle(key).color, pattern: getComputedStyle(key, '::before').backgroundImage };
                }),
                yardCues: [['battery', 'battery', 'battery'], ['panel', 'panel', 'panel'], ['solar', 'power', 'solar'], ['load', 'load', 'load']]
                  .map(([metric, line, key]) => ({ metric,
                    icon: getComputedStyle(yard.querySelector('[data-yard-metric="' + metric + '"] .yard-power-label svg')).stroke,
                    line: getComputedStyle(yard.querySelector('path.yard-line-' + line)).stroke,
                    label: getComputedStyle(yard.querySelector('.yard-legend-' + key)).color,
                    legend: getComputedStyle(yard.querySelector('.yard-legend-' + key), '::before').backgroundColor,
                    pattern: getComputedStyle(yard.querySelector('.yard-legend-' + key), '::before').backgroundImage })),
                yardIcons: [...yard.querySelectorAll('.yard-power-label svg')].map(icon => getComputedStyle(icon).stroke),
                viewportWidth: document.documentElement.clientWidth,
                documentWidth: document.documentElement.scrollWidth
              };
            });
            assert.equal(visual.yardColumns, yardColumns, JSON.stringify(visual));
            assert.equal(visual.stationColumns, stationColumns, JSON.stringify(visual));
            assert.equal(visual.yardMetrics, 6);
            assert.equal(visual.stationMetrics, 4);
            assert.equal(visual.stationTraces, 4);
            assert.equal(visual.yardTraces, 4);
            assert.deepEqual(visual.equipmentOrder, ['stationPower', 'yardPower'], 'the two equipment feeds share their own power group');
            assert.equal(visual.solarBeforeEquipment, true, 'the full-width Home Solar module appears before equipment diagnostics');
            assert.deepEqual(visual.powerTitles, ['Home Solar', 'Weather Station Power', 'Yard Power']);
            assert.ok(visual.powerBounds.every(card => card.height > 0), 'all power modules are visible');
            assert.ok(visual.powerBounds[0].bottom <= Math.min(visual.station.y, visual.yard.y) + 1,
              'Home Solar has its own earlier row without overlapping equipment cards');
            if (layout === 'landscape' && width >= 1280) {
              assert.ok(Math.abs(visual.station.y - visual.yard.y) <= 1,
                'wide equipment cards share the same top edge');
              assert.ok(Math.abs(visual.station.bottom - visual.yard.bottom) <= 1,
                'wide equipment cards share the same bottom edge');
              assert.ok(visual.station.right <= visual.yard.x - 12,
                'paired equipment cards have a clear gutter and never overlap');
              assert.ok(Math.abs(visual.station.width - visual.yard.width) <= 1,
                'paired equipment cards use equal column widths');
            } else {
              assert.ok(visual.yard.y >= visual.station.bottom + 12,
                'compact and Portrait layouts stack equipment cards with a clear gap');
            }
            const connected = await chartGeometry(page);
            assertVisibleLines(connected.station, 'Station Power continuous history');
            assertVisibleLines(connected.yard, 'Yard Power one-minute history');
            assert.equal(new Set(connected.station.paths.map(trace => trace.stroke)).size, 4, 'station series have four distinct colours');
            assert.equal(visual.stationKeys.find(key => key.id === 'battery').colour, 'rgb(55, 211, 163)', 'station battery is green');
            assert.equal(visual.stationKeys.find(key => key.id === 'panel').colour, 'rgb(242, 168, 78)', 'station panel is orange');
            for (const trace of connected.station.paths) {
              const dashed = trace.classes.some(css => ['station-power-line-panel', 'station-power-line-charge'].includes(css));
              assert.equal(trace.dash !== 'none' && trace.dash.split(/[ ,]+/).some(value => parseFloat(value) > 0), dashed,
                'panel/charge are dashed; battery/load remain solid');
              const key = visual.stationKeys.find(key => trace.classes.includes('station-power-line-' + key.id));
              assert.equal(key.colour, trace.stroke, 'legend colours match their station traces');
              assert.equal(key.pattern !== 'none', dashed, 'legend swatches distinguish dashed and solid traces');
            }
            const yardLoad = connected.yard.paths.find(trace => trace.classes.includes('yard-line-load'));
            assert.equal(new Set(connected.yard.paths.map(trace => trace.stroke)).size, 4, 'Yard traces remain four distinct measurements');
            for (const cue of visual.yardCues) {
              assert.equal(cue.icon, cue.line, cue.metric + ' icon matches its Yard graph line');
              assert.equal(cue.label, cue.line, cue.metric + ' legend text matches its Yard graph line');
              if (cue.metric === 'panel') {
                assert.notEqual(cue.pattern, 'none', 'the PV legend uses the same dashed cue as its trace');
              } else {
                assert.equal(cue.legend, cue.line, cue.metric + ' legend matches its Yard graph line');
              }
            }
            assert.equal(visual.yardCues.find(cue => cue.metric === 'battery').line, visual.stationKeys.find(key => key.id === 'battery').colour,
              'battery uses the same green in both power modules');
            assert.equal(new Set(visual.yardIcons).size, 6, 'all six Yard metric icons have deliberate distinct colour cues');
            assert.ok(Math.abs(yardLoad.strokeWidth - 1.6) < .01, 'Yard load retains a finer, readable stroke');
            assert.ok(connected.yard.paths.filter(trace => trace !== yardLoad).every(trace => Math.abs(trace.strokeWidth - 2.2) < .01),
              'other Yard series use the coordinated 2.2px line weight');
            for (const trace of connected.yard.paths) {
              const dashed = trace.dash !== 'none' && trace.dash.split(/[ ,]+/).some(value => parseFloat(value) > 0);
              assert.equal(dashed, trace.classes.includes('yard-line-panel'), 'PV voltage has a dashed cue; other Yard traces are solid');
            }
            assertResponsiveChart(connected.station, 'Station Power at ' + width + 'px');
            assertResponsiveChart(connected.yard, 'Yard Power at ' + width + 'px');
            for (const card of [visual.yard, visual.station]) {
              assert.ok(card.x >= -1 && card.right <= width + 1, 'Card must not overflow the page: ' + JSON.stringify(visual));
            }
            for (const { card, parts, buttons } of visual.controls) {
              for (const part of parts) assert.ok(part.x >= card.x - 1 && part.right <= card.right + 1,
                'chart controls and inspected readings stay within the card: ' + JSON.stringify({ card, part }));
              for (const button of buttons) assert.ok(button.width >= 43.9 && button.height >= 43.9,
                'range and chart buttons retain 44px touch targets: ' + JSON.stringify(button));
            }
            for (const label of visual.labels) assert.ok(label.size >= 12,
              'reading labels, legends and inspectors remain readable: ' + JSON.stringify(label));
            for (const card of visual.content) assert.ok(card.scrollHeight <= card.clientHeight + 1,
              'card height grows with its content instead of clipping labels or controls: ' + JSON.stringify(card));
            assert.ok(visual.documentWidth <= visual.viewportWidth + 1, 'power modules do not create horizontal page overflow');
            assert.deepEqual(errors, [], 'No browser exceptions');
            for (const prefix of ['stationPower', 'yardPower']) {
              await chartNavigation(page, prefix, width);
              if (width === 393) await touchNavigation(page, context, engine, prefix);
            }
            if (width === 1366) {
              for (const prefix of ['stationPower', 'yardPower']) await page.locator('#' + prefix + 'ZoomIn').click();
              const views = await Promise.all(['stationPower', 'yardPower'].map(prefix => powerWindow(page, prefix)));
              const beforeResize = dataRequests;
              await page.setViewportSize({ width: 393, height: 900 });
              await page.evaluate(() => document.body.classList.replace('layout-landscape', 'layout-portrait'));
              await waitForFittedCharts(page);
              const narrow = await chartGeometry(page);
              for (const key of ['station', 'yard']) {
                assertVisibleLines(narrow[key], key + ' after narrowing');
                assertResponsiveChart(narrow[key], key + ' after narrowing');
                assert.ok(narrow[key].svg.viewportWidth < connected[key].svg.viewportWidth * .75,
                  key + ': resize must exercise a substantially narrower chart');
              }
              assert.equal(dataRequests, beforeResize, 'Narrowing charts must reuse cached readings without a data request');
              assert.deepEqual(await Promise.all(['stationPower', 'yardPower'].map(prefix => powerWindow(page, prefix))), views,
                'narrowing preserves the selected time windows');
              await page.setViewportSize({ width, height: 900 });
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
              assert.deepEqual(await Promise.all(['stationPower', 'yardPower'].map(prefix => powerWindow(page, prefix))), views,
                'widening preserves the selected time windows');
              for (const prefix of ['stationPower', 'yardPower']) await page.locator('#' + prefix + 'ZoomReset').click();
            }
            if (width !== 1100) {
              await page.locator('#yardPower').screenshot({ path: path.join(artifacts, 'yard-power-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
              await page.locator('#stationPower').screenshot({ path: path.join(artifacts, 'station-power-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
            }
            await page.locator('[data-yard-range="7d"]').click();
            await page.waitForFunction(() => document.getElementById('yardPowerHistoryDetail').textContent.includes('7d'));
            near((await powerWindow(page, 'yardPower')).span, 7 * 24 * HOUR, 'range change resets to the newly fetched seven-day domain');
            const beforeRangeZoom = dataRequests;
            await page.locator('#yardPowerZoomIn').click();
            near((await powerWindow(page, 'yardPower')).span, 3.5 * 24 * HOUR, 'seven-day Yard history supports the same zoom controls');
            await page.locator('#yardPowerZoomReset').click();
            near((await powerWindow(page, 'yardPower')).span, 7 * 24 * HOUR, 'reset restores the selected seven-day period');
            assert.equal(dataRequests, beforeRangeZoom, 'seven-day zoom remains local');
            // Exercise two isolated observations, a connected pair and a final
            // group with a missing PV/panel value. This catches invisible M-only
            // subpaths even when a series also has valid connected segments.
            historyMode = 'sparse';
            await page.locator('[data-yard-range="24h"]').click();
            await page.waitForFunction(() => document.getElementById('yardPowerHistoryDetail').textContent.startsWith('7 recorded intervals'));
            near((await powerWindow(page, 'yardPower')).span, 24 * HOUR, 'switching back resets the Yard time domain');
            await page.evaluate(series => window.dispatchEvent(new CustomEvent('moore-weather-station-trends',
              { detail: { series } })), sparseStation);
            const sparse = await chartGeometry(page);
            assertSparseGeometry(sparse.station, 'Station Power sparse history', 'station-power-line-panel');
            assertSparseGeometry(sparse.yard, 'Yard Power sparse history', 'yard-line-panel');
            assert.ok(sparse.yard.dots.every(dot => Math.abs(dot.strokeWidth - 2.2) < .01), 'thinner Yard load styling does not weaken isolated-point markers');
            const beforeDayZoom = dataRequests;
            await page.locator('#yardPowerZoomIn').click(); await page.locator('#yardPowerZoomReset').click();
            near((await powerWindow(page, 'yardPower')).span, 24 * HOUR, 'reset restores 24h when that period is selected');
            assert.equal(dataRequests, beforeDayZoom, '24h zoom and reset remain local');
            if (width !== 1100) {
              await page.locator('#yardPower').screenshot({ path: path.join(artifacts, 'yard-power-sparse-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
              await page.locator('#stationPower').screenshot({ path: path.join(artifacts, 'station-power-sparse-' + engine.name() + '-' + width + '.png'), animations: 'disabled' });
            }
            historyMode = 'continuous';
            assert.deepEqual(errors, [], 'interactions do not cause browser errors');
            if (width === 393) {
              for (const [range, hours] of [['30d', 30 * 24], ['12h', 12]]) {
                await page.locator('[data-yard-range="' + range + '"]').click();
                await page.waitForFunction(range => document.getElementById('yardPowerHistoryDetail').textContent.includes(' · ' + range + ' · '), range);
                near((await powerWindow(page, 'yardPower')).span, hours * HOUR, 'selecting ' + range + ' restores its full domain');
                const beforeZoom = dataRequests;
                await page.locator('#yardPowerZoomIn').click();
                near((await powerWindow(page, 'yardPower')).span, hours * HOUR / 2, range + ' remains zoomable');
                await page.locator('#yardPowerZoomReset').click();
                near((await powerWindow(page, 'yardPower')).span, hours * HOUR, 'reset restores selected ' + range);
                assert.equal(dataRequests, beforeZoom, range + ' zoom/reset uses already fetched readings');
              }
              mode = 'stale'; await page.reload();
              await page.waitForFunction(() => document.querySelector('#yardPowerStatus').textContent === 'STALE');
              assert.equal(await page.locator('#yardPowerSummary').isVisible(), true);
              assert.doesNotMatch(await page.locator('#yardBatteryV').textContent(), /^0\.00$/, 'stale is not represented as zero battery');
              mode = 'fresh';
            }
          } finally { mode = 'fresh'; historyMode = 'continuous'; await context.close(); }
        }
      } finally { await browser.close(); }
    }
    console.log('Power cards passed: responsive layouts, distinct units/styles, cached button/wheel/keyboard zoom, pan/drag, native and WebKit pinch, scrub inspection, bounded reset/range changes, persistent resize, per-series gaps and singleton points, stale states and no additional navigation requests.');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
