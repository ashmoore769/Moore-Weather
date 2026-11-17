'use strict';
// Offline browser fixture. It runs the production solar module in the actual
// dashboard markup/styles, with other collectors removed and synthetic data only.
// Production route privacy is verified separately by test/solar-http.test.js.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const publicRoot = path.resolve(__dirname, '../public');
const screenshotRoot = path.resolve(__dirname, '../artifacts/dashboard');
const heightMetrics = [];
const failures = [];
const now = Date.parse('2026-11-14T02:00:00.000Z');
const partialHouseBin = 108, emptyBin = 120;
const iso = value => new Date(value).toISOString();
const dashboard = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8').replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi,
  (tag, attributes) => /\bsrc="\/(?:solar(?:-chart)?|theme)\.js\b/.test(attributes) ? tag : '');
let mode = 'fresh', apiRequests = 0;
function readings(includeHistory = true) {
  const missing = mode === 'missing', zero = mode === 'zero', stale = mode === 'stale', buying = mode === 'buying';
  const livePower = {
    'heavy-import': { inverterPowerW: 1500, gridPowerW: 2000, loadPowerW: 3500 },
    balanced: { inverterPowerW: 3500, gridPowerW: 0, loadPowerW: 3500 },
    night: { pvPowerW: 0, inverterPowerW: 0, gridPowerW: 600, loadPowerW: 600 },
    'battery-active': { inverterPowerW: 2000, gridPowerW: 500, loadPowerW: 3000, batteryPowerW: 500 },
    'battery-unknown': { batteryPowerW: null, batterySocPercent: 50 }
  }[mode] || {};
  const day = { date: '2026-11-14', since: iso(now - 4 * 3600000), through: iso(now), quality: 'partial', sampleCount: 240,
    coveredSeconds: 14340, expectedSeconds: 43200, coveragePercent: 33.2, coverageSeconds: { load: 14340, solarToHome: 14340, grid: 14340, generation: 14340 },
    gridImportWh: 1200, gridExportWh: 9200, loadWh: 8000, solarToHomeWh: 6800, generatedAcWh: 16000,
    importCost: .3467376, exportCredit: .552552, supplyCost: 1.805078, netCost: 1.5992636 };
  const days = Array.from({ length: 30 }, (_, index) => {
    if (index === 29) return day;
    const offset = 29 - index, date = new Date(now - offset * 86400000 + 36000000).toISOString().slice(0, 10);
    const imported = 5 + index % 4, exported = 22 + index % 7;
    const start = Date.parse(date + 'T00:00:00+10:00');
    return { ...day, date, since: iso(start), through: iso(start + 86400000),
      quality: 'complete', coveragePercent: 100, coveredSeconds: 86400, expectedSeconds: 86400,
      gridImportWh: imported * 1000, gridExportWh: exported * 1000, importCost: imported * .288948,
      exportCredit: exported * .06006, netCost: imported * .288948 - exported * .06006 + 1.805078 };
  });
  const points = Array.from({ length: 145 }, (_, index) => {
    const recorded = index >= 72 && index !== emptyBin;
    const ac = Math.max(0, Math.sin((index - 72) / 144 * Math.PI) * 6500), load = 1600 + Math.pow(Math.sin(index / 13), 2) * 2000;
    return { observedAt: iso(now - (144 - index) * 300000), inverterPowerW: recorded ? ac : null,
      loadPowerW: recorded ? load : null, gridImportPowerW: recorded ? Math.max(0, load - ac) : null,
      gridExportPowerW: recorded ? Math.max(0, ac - load) : null, breakBefore: index === emptyBin + 1,
      hasGap: index === partialHouseBin, samples: recorded ? 5 : 0,
      // At 09:00 one house measurement is absent; the measured average remains
      // valid, while solar and grid have uninterrupted coverage. The separate
      // 10:00 empty bin continues to exercise a genuine gap in every series.
      seriesGaps: recorded ? { inverterPowerW: false, loadPowerW: index === partialHouseBin, gridImportPowerW: false } : null };
  });
  return { enabled: mode !== 'disabled', status: mode === 'disabled' ? 'disabled' : mode === 'waiting' ? 'waiting' : stale ? 'stale' : 'fresh',
    timezone: 'Australia/Brisbane', staleAfterSeconds: 180,
    current: ['disabled', 'waiting'].includes(mode) ? null : {
      observedAt: iso(now - (stale ? 1800000 : 0)), collectedAt: iso(now), receivedAt: iso(now),
      pvPowerW: missing ? null : zero ? 0 : mode === 'recovered' ? 7200 : 6800,
      inverterPowerW: missing ? null : zero ? 0 : buying ? 2300 : 6500, gridPowerW: missing ? null : zero ? 0 : buying ? 1200 : -3000,
      loadPowerW: missing ? null : zero ? 0 : 3500, batteryPowerW: null, batterySocPercent: null, totalAcEnergyWh: 25000000,
      meterLocation: 'grid', mode: 'meter', ...livePower },
    today: { date: '2026-11-14', energyAcWh: missing || mode === 'waiting' ? null : zero ? 0 : 13240,
      quality: mode === 'reset' ? 'reset' : missing || mode === 'waiting' ? 'unavailable' : 'partial',
      since: iso(now - 2 * 3600000), through: iso(now - 5 * 60000), sampleCount: 100, gapCount: 1, counterReset: mode === 'reset',
      label: mode === 'reset' ? 'The inverter counter reset; daily energy is unavailable.' : 'Recorded AC energy covers part of today. Earlier energy is unavailable.' },
    rates: { currency: 'AUD', effectiveFrom: '2026-07-01', importPerKwh: .288948, exportPerKwh: .06006, supplyPerDay: 1.805078 },
    energy: { method: 'power-integration', maxGapSeconds: 180, today: day, days: includeHistory ? days : null }, history: includeHistory ? { points, resolutionSeconds: 300 } : null };
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/solar') {
    apiRequests++;
    assert.ok(['', '?history=today'].includes(url.search), 'only bounded today history is requested');
    res.writeHead(mode === 'failure' ? 503 : mode === 'unauthorized' ? 401 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(mode === 'failure' || mode === 'unauthorized' ? { error: 'Synthetic unavailable response' } : readings(url.searchParams.get('history') === 'today'))); return;
  }
  if (url.pathname === '/login') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Offline sign-in fixture</h1>'); return; }
  if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(dashboard); return; }
  const file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(publicRoot + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const content = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
async function refresh(page, next) {
  mode = next;
  await page.evaluate(async () => { if (!window.__solarPoll) throw Error('Solar polling callback missing'); await window.__solarPoll(); });
}
async function liveReadingColours(page, expected) {
  const actual = await page.evaluate(() => {
    const card = document.querySelector('#homeSolar');
    const palette = Object.fromEntries(Object.entries({ neutral: '--muted', good: '--green', cool: '--solar-home', caution: '--amber', high: '--red' }).map(([tone, token]) => {
      const probe = document.createElement('span'); probe.style.color = 'var(' + token + ')'; card.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return [tone, color];
    }));
    return { palette,
      readings: ['solarAcPower', 'solarLoadPower', 'solarGridPower'].map(id => {
        const element = document.getElementById(id);
        return { tone: element.dataset.readingTone, color: getComputedStyle(element).color };
      }),
      series: ['generation', 'home', 'import'].map(name => getComputedStyle(card.querySelector('.solar-chart-series-' + name)).stroke),
      legend: ['generation', 'home', 'grid'].map(name => getComputedStyle(card.querySelector('#solarChartLegend .solar-dot-' + name)).backgroundColor)
    };
  });
  assert.deepEqual(actual.readings, expected.map(tone => ({ tone, color: actual.palette[tone] })),
    'Solar AC, House and Grid use their current reading conditions');
  assert.equal(new Set(Object.values(actual.palette)).size, 5, 'live states use five distinguishable palette colours');
  const fixed = ['good', 'cool', 'caution'].map(tone => actual.palette[tone]);
  assert.deepEqual(actual.series, fixed, 'live numeric conditions must not recolour the recorded chart series');
  assert.deepEqual(actual.legend, fixed, 'chart legend colours remain aligned with their fixed series');
}
async function layout(page, width, context, { notice = false } = {}) {
  const result = await page.evaluate(() => {
    const card = document.querySelector('#homeSolar'), rect = card.getBoundingClientRect();
    const children = [...card.querySelectorAll('.solar-header,.solar-main,.solar-reading,.solar-flow,.solar-note,.solar-message,.solar-hero,.solar-day-grid,.solar-history,.solar-history-header,.solar-chart-toolbar,.solar-chart-inspect,[role="tablist"],[role="tabpanel"]')]
      // Visually clipped accessibility hints are deliberately 1px wide; only
      // rendered content can create visible layout overflow.
      .filter(element => element.getBoundingClientRect().height > 0 && getComputedStyle(element).clipPath === 'none')
      .map(element => ({ name: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        width: element.clientWidth, scroll: element.scrollWidth }));
    const panels = [...card.querySelectorAll('[role="tabpanel"]')].map(element => ({ id: element.id,
      hidden: element.hidden, height: element.getBoundingClientRect().height, contentHeight: element.scrollHeight }));
    const chart = card.querySelector('#solarChart').getBoundingClientRect();
    const plot = card.querySelector('#solarChartPlot').getBoundingClientRect();
    const axis = card.querySelector('.solar-chart-xaxis').getBoundingClientRect();
    return { left: rect.left, right: rect.right, height: rect.height, documentWidth: document.documentElement.scrollWidth, children, panels,
      chart: { height: chart.height, bottom: chart.bottom, plotBottom: plot.bottom, axisTop: axis.top } };
  });
  // These generous maximums guard the intended reduction from the previous
  // 1,200–1,500px card without tying the tests to individual CSS pixel values.
  const limit = (width >= 900 ? 600 : width >= 361 ? 850 : 920) + (notice ? 100 : 0);
  heightMetrics.push({ context, width, height: Math.round(result.height * 10) / 10, limit,
    panels: result.panels.filter(panel => !panel.hidden).map(panel => ({ id: panel.id, height: Math.round(panel.height * 10) / 10 })) });
  assert.ok(result.left >= 0 && result.right <= width + 1, JSON.stringify(result));
  assert.ok(result.documentWidth <= width + 1, 'dashboard must not create horizontal scrolling at ' + width);
  for (const child of result.children) {
    assert.ok(child.left >= result.left - 1 && child.right <= result.right + 1, JSON.stringify(child));
    assert.ok(child.scroll <= child.width + 1, 'solar content overflows: ' + JSON.stringify(child));
  }
  assert.ok(result.height <= limit, `Solar card is not compact at ${context}: ${result.height.toFixed(1)}px exceeds ${limit}px`);
  if (result.chart.height > 0) {
    assert.ok(result.chart.bottom <= result.chart.plotBottom + 1, 'SVG must stay within its allocated plot: ' + JSON.stringify(result.chart));
    assert.ok(result.chart.plotBottom <= result.chart.axisTop + 1, 'time labels must remain below the plot: ' + JSON.stringify(result.chart));
  }
  return result;
}

const panelIds = { chart: ['solarTabChart', 'solarPanelChart'], log: ['solarTabLog', 'solarPanelLog'], details: ['solarTabDetails', 'solarPanelDetails'] };
async function panelState(page, selected, keyboard = false) {
  for (const [name, [tabId, panelId]] of Object.entries(panelIds)) {
    const tab = page.locator('#' + tabId), panel = page.locator('#' + panelId), active = name === selected;
    assert.equal(await tab.getAttribute('role'), 'tab');
    assert.equal(await tab.getAttribute('aria-controls'), panelId);
    assert.equal(await tab.getAttribute('aria-selected'), String(active));
    assert.equal(await tab.getAttribute('tabindex'), active ? '0' : '-1');
    assert.equal(await panel.getAttribute('role'), 'tabpanel');
    assert.equal(await panel.getAttribute('aria-labelledby'), tabId);
    assert.equal(await panel.isVisible(), active, 'only the selected work area should be visible');
  }
  if (keyboard) {
    const focus = await page.evaluate(() => {
      const element = document.activeElement, style = getComputedStyle(element);
      return { id: element.id, outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
    });
    assert.equal(focus.id, panelIds[selected][0]);
    assert.ok(focus.outline !== 'none' && focus.outlineWidth > 0, 'keyboard focus must remain visible');
  }
}

async function boundedLog(page) {
  assert.equal(await page.locator('#solarLogBody tr').count(), 30, 'all 30 days remain accessible');
  const region = page.locator('#solarPanelLog .solar-table-wrap');
  assert.equal(await region.getAttribute('tabindex'), '0', 'the scrolling log must be keyboard focusable');
  const bounds = await region.evaluate(element => {
    const style = getComputedStyle(element);
    element.scrollTop = element.scrollHeight;
    const last = element.querySelector('tbody tr:last-child').getBoundingClientRect(), rect = element.getBoundingClientRect();
    return { viewport: element.clientHeight, content: element.scrollHeight, overflow: style.overflowY,
      top: element.scrollTop, lastTop: last.top, lastBottom: last.bottom, regionTop: rect.top, regionBottom: rect.bottom };
  });
  assert.ok(bounds.content > bounds.viewport, '30 rows should scroll within the log rather than grow the card');
  assert.ok(['auto', 'scroll'].includes(bounds.overflow));
  assert.ok(bounds.top > 0 && bounds.lastTop >= bounds.regionTop && bounds.lastBottom <= bounds.regionBottom + 1,
    'the last daily row must be reachable in the bounded log: ' + JSON.stringify(bounds));
  await region.evaluate(element => { element.scrollTop = 0; });
}

async function chartWindow(page) {
  return page.locator('#solarChartPlot').evaluate(element => ({
    start: Number(element.dataset.windowStart), end: Number(element.dataset.windowEnd),
    span: Number(element.dataset.windowSpan), zoomed: element.dataset.zoomed
  }));
}
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 2, message + ': ' + actual + ' vs ' + expected);

async function chartSeriesQuality(page) {
  const points = readings().history.points;
  const observed = await page.locator('#solarChart').evaluate((svg, timestamps) => {
    const plot = document.querySelector('#solarChartPlot'), span = Number(plot.dataset.windowSpan);
    const x = time => (time - Number(plot.dataset.windowStart)) / span * 720;
    const partialX = x(timestamps.partial), nextX = x(timestamps.partial + 300000);
    const emptyX = x(timestamps.empty), recoveredX = x(timestamps.empty + 300000);
    const bounds = svg.getBoundingClientRect();
    return ['generation', 'home', 'import'].map(name => {
      const path = svg.querySelector('path.solar-chart-series-' + name);
      const commands = [...path.getAttribute('d').matchAll(/([ML])(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
        .map(match => ({ command: match[1], x: Number(match[2]), y: Number(match[3]) }));
      const at = position => commands.find(point => Math.abs(point.x - position) < .02);
      const partial = at(partialX);
      const markers = [...svg.querySelectorAll('circle.solar-chart-series-' + name)]
        .filter(circle => partial && Math.abs(Number(circle.getAttribute('cx')) - partial.x) < .02 &&
          Math.abs(Number(circle.getAttribute('cy')) - partial.y) < .02)
        .map(circle => {
          const rect = circle.getBoundingClientRect(), style = getComputedStyle(circle);
          return { visible: rect.width > 0 && rect.height > 0 && style.visibility === 'visible' &&
            style.display !== 'none' && Number(style.opacity) > 0 && style.stroke !== 'none' &&
            rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom };
        });
      return { name, partial: partial?.command, afterPartial: at(nextX)?.command,
        emptyDrawn: Boolean(at(emptyX)), recovered: at(recoveredX)?.command, markers };
    });
  }, { partial: Date.parse(points[partialHouseBin].observedAt), empty: Date.parse(points[emptyBin].observedAt) });
  for (const series of observed) {
    assert.equal(series.partial, series.name === 'home' ? 'M' : 'L', series.name + ' must use its own field quality');
    assert.equal(series.afterPartial, series.name === 'home' ? 'M' : 'L', series.name + ' must preserve its known continuity after the partial bin');
    if (series.name === 'home') assert.deepEqual(series.markers, [{ visible: true }], 'the partial house average needs a visible isolated point at the correct time and power');
    assert.equal(series.emptyDrawn, false, series.name + ' must not invent a value for the empty bin');
    assert.equal(series.recovered, 'M', series.name + ' must not connect across the genuine data gap');
  }
}

async function chartNavigation(page, width, reviewName) {
  const plot = page.locator('#solarChartPlot');
  const original = await chartWindow(page), requestsBefore = apiRequests;
  near(original.span, 86400000, 'Today starts with the full AEST day');
  assert.equal(await page.locator('#solarZoomReset').isDisabled(), true);
  const maximum = await page.locator('#solarChartMax').textContent();
  const originalPath = await page.locator('.solar-chart-series-generation').first().getAttribute('d');
  assert.ok((originalPath.match(/M/g) || []).length >= 2, 'the known missing reading must split the line');
  await chartSeriesQuality(page);
  await page.locator('#solarZoomIn').click();
  const zoomed = await chartWindow(page);
  assert.ok(zoomed.span < original.span && zoomed.span >= 3600000, 'zoom changes the visible time domain');
  assert.equal(await page.locator('#solarChartMax').textContent(), maximum, 'the y scale stays stable while zooming');
  assert.notEqual(await page.locator('#solarChartStart').textContent(), '00:00');
  assert.equal(await plot.getAttribute('data-zoomed'), 'true');
  await chartSeriesQuality(page);
  await layout(page, width, reviewName + '-zoomed');
  await page.locator('#homeSolar').screenshot({ path: path.join(screenshotRoot, reviewName + '-zoomed.png'), animations: 'disabled' });

  await plot.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  const earlier = await chartWindow(page);
  assert.ok(earlier.start < zoomed.start, 'keyboard pans to earlier readings');
  near(earlier.span, zoomed.span, 'panning preserves scale');
  await page.locator('#solarPanLater').click();
  const later = await chartWindow(page);
  assert.ok(later.start > earlier.start, 'button pans to later readings');

  await plot.scrollIntoViewIfNeeded();
  const rect = await plot.boundingBox();
  await page.mouse.move(rect.x + rect.width * .6, rect.y + rect.height * .5);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * .8, rect.y + rect.height * .5, { steps: 5 });
  await page.mouse.up();
  const dragged = await chartWindow(page);
  assert.ok(dragged.start < later.start, 'dragging the graph right reveals earlier readings');
  near(dragged.span, later.span, 'dragging preserves scale');

  await plot.focus();
  await page.keyboard.press('+');
  assert.ok((await chartWindow(page)).span < dragged.span, 'keyboard zoom is available without a gesture');
  for (let attempt = 0; attempt < 12 && !await page.locator('#solarZoomIn').isDisabled(); attempt++) await page.locator('#solarZoomIn').click();
  near((await chartWindow(page)).span, 3600000, 'today zoom stops at one hour');
  assert.equal(await page.locator('#solarZoomIn').isDisabled(), true);
  assert.equal(apiRequests, requestsBefore, 'navigation must use cached readings without extra requests');
  const beforeRefresh = await chartWindow(page);
  await refresh(page, 'fresh');
  const afterRefresh = await chartWindow(page);
  near(afterRefresh.start, beforeRefresh.start, 'a routine update retains the chosen start');
  near(afterRefresh.end, beforeRefresh.end, 'a routine update retains the chosen end');

  await plot.focus(); await page.keyboard.press('0');
  near((await chartWindow(page)).span, original.span, 'zero resets the full view');
  assert.equal(await page.locator('#solarZoomReset').isDisabled(), true);
  assert.equal(await page.locator('#solarChartStart').textContent(), '00:00');
  assert.equal(await page.locator('#solarChartEnd').textContent(), '24:00');
  assert.equal(await page.locator('.solar-chart-series-generation').first().getAttribute('d'), originalPath,
    'reset restores the same samples and genuine gaps');
  if (width >= 900) {
    await plot.scrollIntoViewIfNeeded();
    const box = await plot.boundingBox();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
    await page.mouse.wheel(0, -160);
    await page.waitForFunction(() => Number(document.querySelector('#solarChartPlot').dataset.windowSpan) < 86400000);
    await page.locator('#solarZoomReset').click();
  }
}

async function dailyNavigation(page) {
  const before = await chartWindow(page), requestsBefore = apiRequests;
  near(before.span, 30 * 86400000, 'month chart starts with thirty calendar days');
  await page.locator('#solarZoomIn').click();
  assert.ok((await chartWindow(page)).span < before.span, 'daily chart supports zoom');
  for (let attempt = 0; attempt < 12 && !await page.locator('#solarZoomIn').isDisabled(); attempt++) await page.locator('#solarZoomIn').click();
  near((await chartWindow(page)).span, 3 * 86400000, 'daily zoom stops at a readable three-day window');
  await page.locator('#solarZoomReset').click();
  near((await chartWindow(page)).span, before.span, 'daily reset restores thirty days');
  assert.equal(await page.locator('#solarChart .solar-chart-bar').count(), 60, 'reset preserves every daily bought/sold bar');
  assert.equal(apiRequests, requestsBefore, 'daily navigation remains local');
}

async function touchNavigation(page, context, engine) {
  const plot = page.locator('#solarChartPlot');
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const initial = await chartWindow(page), requestsBefore = apiRequests;
  if (engine === chromium) {
    const session = await context.newCDPSession(page);
    const points = distance => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(box.width * .12) });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(box.width * (.12 + .02 * step)) });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok((await chartWindow(page)).span < initial.span * .8, 'native two-finger touch must zoom the time window');
    await page.locator('#solarZoomReset').click();

    await plot.scrollIntoViewIfNeeded();
    const verticalBox = await plot.boundingBox();
    const verticalPoints = distance => [{ x: verticalBox.x + verticalBox.width / 2, y: verticalBox.y + verticalBox.height / 2 - distance, id: 4 },
      { x: verticalBox.x + verticalBox.width / 2, y: verticalBox.y + verticalBox.height / 2 + distance, id: 5 }];
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: verticalPoints(verticalBox.height * .12) });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: verticalPoints(verticalBox.height * (.12 + .02 * step)) });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok((await chartWindow(page)).span < initial.span * .8, 'a vertical two-finger spread must also zoom the time window');
    await page.locator('#solarZoomReset').click();

    // Native single-finger vertical scrolling still belongs to the page.
    await plot.scrollIntoViewIfNeeded();
    const next = await plot.boundingBox(), oldScroll = await page.evaluate(() => window.scrollY);
    const touch = [{ x: next.x + next.width / 2, y: next.y + next.height * .75, id: 3 }];
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch[0], y: touch[0].y - step * 12 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(previous => window.scrollY > previous + 10, oldScroll);
    near((await chartWindow(page)).span, initial.span, 'vertical page scrolling does not zoom the chart');
    await session.detach();
  } else {
    // WebKit automation exposes no native multi-touch input. Exercise its actual
    // pointer handlers and DOM rendering; native browser gesture arbitration is
    // verified by the Chromium sequence above.
    await plot.evaluate((element, geometry) => {
      const fire = (name, pointerId, distance) => element.dispatchEvent(new PointerEvent(name, {
        bubbles: true, cancelable: true, pointerType: 'touch', pointerId, button: 0, buttons: name === 'pointerup' ? 0 : 1,
        clientX: geometry.x + (pointerId === 1 ? -distance : distance), clientY: geometry.y
      }));
      fire('pointerdown', 1, geometry.width * .12); fire('pointerdown', 2, geometry.width * .12);
      for (let step = 1; step <= 8; step++) {
        fire('pointermove', 1, geometry.width * (.12 + .02 * step));
        fire('pointermove', 2, geometry.width * (.12 + .02 * step));
      }
      fire('pointerup', 1, geometry.width * .28); fire('pointerup', 2, geometry.width * .28);
    }, { x, y, width: box.width });
    assert.ok((await chartWindow(page)).span < initial.span * .8, 'WebKit two-finger events must zoom the time window');
    await page.locator('#solarZoomReset').click();
  }
  assert.equal(apiRequests, requestsBefore, 'touch navigation adds no data requests');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let checked = 0;
  try {
    fs.mkdirSync(screenshotRoot, { recursive: true });
    const engines = (process.env.SOLAR_BROWSERS || process.env.DASHBOARD_BROWSERS || 'chromium,webkit').split(',').map(name => ({ chromium, webkit })[name]);
    assert.ok(engines.every(Boolean), 'SOLAR_BROWSERS supports chromium,webkit');
    for (const engine of engines) {
      const browser = await engine.launch(engine === chromium && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
      try {
        for (const width of [320, 393, 1440]) for (const theme of ['light', 'dark']) {
          mode = 'fresh';
          const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, hasTouch: width < 900 });
          await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await context.addInitScript(({ fixtureNow, dark }) => {
            Date.now = () => fixtureNow;
            localStorage.setItem('mooreWeatherTheme', dark ? 'dark' : 'light');
            localStorage.setItem('mooreWeatherThemeVersion', '4');
            const schedule = window.setTimeout;
            window.setTimeout = (callback, milliseconds, ...args) => {
              if (milliseconds === 60000) window.__solarPoll = callback;
              return schedule(callback, milliseconds, ...args);
            };
          }, { fixtureNow: now, dark: theme === 'dark' });
          const page = await context.newPage(), errors = [];
          page.setDefaultTimeout(5000);
          page.on('pageerror', error => errors.push(error.message));
          try {
            await page.goto(origin + '/index.html');
            await page.waitForFunction(() => document.querySelector('#homeSolar').dataset.state === 'fresh');
            await page.evaluate(({ wide }) => {
              document.body.classList.add(wide ? 'layout-landscape' : 'layout-portrait');
            }, { wide: width >= 900 });
            assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'saved and system light must render dark');
            assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).colorScheme), 'dark');
            assert.equal(await page.locator('#themeToggleBtn').count(), 0);
            assert.equal(await page.locator('#solarPvPower').textContent(), '6.80 kW');
            assert.equal(await page.locator('#solarAcPower').textContent(), '6.50 kW');
            assert.match(await page.locator('#solarEnergyThrough').textContent(), /11:55:00 AEST/);
            assert.equal(await page.locator('#solarHero').getAttribute('data-tone'), 'surplus');
            assert.equal(await page.locator('#solarHeadroom').textContent(), '3.00 kW');
            assert.match(await page.locator('#solarLiveMoney').textContent(), /\$0.18\/hr/);
            assert.match(await page.locator('#solarDayNote').textContent(), /85%/);
            assert.equal(await page.locator('#solarChartEmpty').isVisible(), false);
            await liveReadingColours(page, ['good', 'cool', 'good']);
            const reviewName = `solar-${engine.name()}-${width}-dark-system-${theme}`;
            await panelState(page, 'chart');
            await layout(page, width, reviewName + '-chart');
            await page.locator('#homeSolar').screenshot({ path: path.join(screenshotRoot, reviewName + '.png'), animations: 'disabled' });
            await chartNavigation(page, width, reviewName);
            if (width === 393 && theme === 'dark') await touchNavigation(page, context, engine);
            await page.locator('#solarRange7').click();
            assert.equal(await page.locator('#solarRange7').getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#solarChart .solar-chart-bar').count(), 7);
            await page.locator('#solarChartMetric').selectOption('energy');
            assert.equal(await page.locator('#solarChart .solar-chart-bar').count(), 14);
            await page.locator('#solarChartScrubber').focus(); await page.keyboard.press('ArrowLeft');
            assert.match(await page.locator('#solarChartInspect').textContent(), /13 Nov/);
            await page.locator('#solarRange30').click();
            assert.equal(await page.locator('#solarChart .solar-chart-bar').count(), 60, 'all thirty recorded days remain in the energy chart');
            await dailyNavigation(page);
            await layout(page, width, reviewName + '-chart-30days');

            // Keyboard switching replaces the shared work area. A full month of
            // log rows must not turn a compact card back into a long page.
            await page.locator('#solarTabChart').focus(); await page.keyboard.press('ArrowRight');
            await panelState(page, 'log', true);
            await boundedLog(page);
            await layout(page, width, reviewName + '-log');
            await page.locator('#homeSolar').screenshot({ path: path.join(screenshotRoot, reviewName + '-log.png'), animations: 'disabled' });
            const downloadPromise = page.waitForEvent('download');
            await page.locator('#solarDownload').click();
            const download = await downloadPromise;
            const csv = fs.readFileSync(await download.path(), 'utf8').trim().split(/\r?\n/);
            assert.equal(csv.length, 31, 'CSV preserves the header and all thirty recorded days');
            assert.match(csv[0], /gridImportWh,gridExportWh/);

            await page.locator('#solarTabLog').focus(); await page.keyboard.press('ArrowRight');
            await panelState(page, 'details', true);
            await layout(page, width, reviewName + '-details');
            for (const id of ['solarPvPower', 'solarRatesNote', 'solarDayDetail', 'solarTodayNote', 'solarEnergyThrough', 'solarObservedDetail']) {
              assert.equal(await page.locator('#' + id).isVisible(), true, id + ' must remain available in Details');
            }
            assert.match(await page.locator('#solarDayDetail').textContent(), /missing usage.*not included.*Full daily supply/);
            const details = await page.locator('#solarPanelDetails').evaluate(element => ({
              viewport: element.clientHeight, content: element.scrollHeight, overflow: getComputedStyle(element).overflowY
            }));
            if (details.content > details.viewport + 1) assert.ok(['auto', 'scroll'].includes(details.overflow), 'long details must be reachable by scrolling');
            await page.locator('#homeSolar').screenshot({ path: path.join(screenshotRoot, reviewName + '-details.png'), animations: 'disabled' });
            await page.keyboard.press('Home'); await panelState(page, 'chart', true);
            await page.keyboard.press('End'); await panelState(page, 'details', true);
            await page.keyboard.press('ArrowRight'); await panelState(page, 'chart', true);
            await page.keyboard.press('ArrowLeft'); await panelState(page, 'details', true);
            await page.keyboard.press('Home'); await panelState(page, 'chart', true);
            await page.locator('#solarRangeToday').click();
            await refresh(page, 'buying');
            assert.equal(await page.locator('#solarHero').getAttribute('data-tone'), 'import');
            assert.equal(await page.locator('#solarHeadroom').textContent(), '1.20 kW');
            assert.match(await page.locator('#solarLiveMoney').textContent(), /\$0.35\/hr/);
            await liveReadingColours(page, ['caution', 'caution', 'caution']);
            if (width === 393 && theme === 'dark') {
              await refresh(page, 'heavy-import');
              await liveReadingColours(page, ['caution', 'high', 'high']);
              assert.equal(await page.locator('#solarGridPower').textContent(), '2.00 kW');
              await page.locator('#homeSolar').screenshot({ path: path.join(screenshotRoot, reviewName + '-heavy-import.png'), animations: 'disabled' });
              await refresh(page, 'balanced');
              await liveReadingColours(page, ['good', 'cool', 'cool']);
              await refresh(page, 'night');
              await liveReadingColours(page, ['neutral', 'caution', 'caution']);
              await refresh(page, 'battery-active');
              await liveReadingColours(page, ['neutral', 'neutral', 'caution']);
              await refresh(page, 'battery-unknown');
              await liveReadingColours(page, ['neutral', 'neutral', 'good']);
              assert.equal(await page.locator('#solarHeadline').textContent(), 'Partial data');
            }
            await refresh(page, 'missing');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'partial');
            assert.equal(await page.locator('#solarPvPower').textContent(), '–');
            assert.equal(await page.locator('#solarLoadPower').textContent(), '–');
            assert.equal(await page.locator('#solarHeadroom').textContent(), '–');
            await liveReadingColours(page, ['neutral', 'neutral', 'neutral']);
            await refresh(page, 'zero');
            assert.equal(await page.locator('#solarPvPower').textContent(), '0.00 kW');
            assert.equal(await page.locator('#solarTodayEnergy').textContent(), '0.00 kWh');
            assert.equal(await page.locator('#solarHero').getAttribute('data-tone'), 'neutral');
            assert.equal(await page.locator('#solarCoverageBlock').isVisible(), false);
            await liveReadingColours(page, ['neutral', 'neutral', 'cool']);
            const observed = await page.locator('#solarObserved').textContent();
            await refresh(page, 'failure');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'stale');
            assert.equal(await page.locator('#solarPvPower').textContent(), '0.00 kW');
            assert.equal(await page.locator('#solarObserved').textContent(), observed);
            await liveReadingColours(page, ['neutral', 'neutral', 'neutral']);
            await refresh(page, 'recovered');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'fresh');
            assert.equal(await page.locator('#solarPvPower').textContent(), '7.20 kW');
            await liveReadingColours(page, ['good', 'cool', 'good']);
            await refresh(page, 'stale');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'stale');
            assert.equal(await page.locator('#solarHeadroom').textContent(), '–');
            assert.equal(await page.locator('#solarCoverageBlock').isVisible(), false);
            await liveReadingColours(page, ['neutral', 'neutral', 'neutral']);
            await layout(page, width, reviewName + '-stale', { notice: true });
            await refresh(page, 'reset');
            assert.equal(await page.locator('#solarTodayEnergy').textContent(), '–');
            assert.equal(await page.locator('#solarTodayQuality').textContent(), 'Reset');
            assert.equal(await page.locator('#solarTodayQuality').getAttribute('title'), 'Counter reset');
            mode = 'waiting'; await page.reload();
            await page.waitForFunction(() => document.querySelector('#homeSolar').dataset.state === 'waiting');
            assert.equal(await page.locator('#solarPvPower').textContent(), '–');
            await refresh(page, 'disabled');
            assert.equal(await page.locator('#homeSolar').isVisible(), false);
            mode = 'unauthorized';
            await page.evaluate(() => { void window.__solarPoll(); });
            await page.waitForURL(origin + '/login');
            assert.deepEqual(errors, []);
            checked++;
          } catch (error) {
            try {
              await page.locator('#homeSolar').screenshot({ path: path.join(screenshotRoot, `solar-${engine.name()}-${width}-${theme}-failure.png`), animations: 'disabled' });
            } catch {}
            failures.push({ engine: engine.name(), width, systemAppearance: theme, message: error.message });
            console.error('Solar browser case failed: ' + JSON.stringify(failures.at(-1)));
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(failures, [], 'Every solar browser case must pass: ' + JSON.stringify(failures));
    console.log(`Passed ${checked} solar browser viewport/system-appearance combinations: permanent dark, compact chart/log/details, bounded zoom/pan/reset, keyboard and touch navigation, thirty-row log/CSV, solar/import states, null/zero, stale/offline/recovered, disabled and expired-auth states.`);
  } finally {
    fs.writeFileSync(path.join(screenshotRoot, 'solar-height-metrics.json'), JSON.stringify(heightMetrics, null, 2) + '\n');
    console.log('Solar card heights (CSS px): ' + JSON.stringify(heightMetrics.map(({ context, height, limit }) => ({ context, height, limit }))));
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
