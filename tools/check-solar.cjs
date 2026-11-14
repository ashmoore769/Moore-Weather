'use strict';
// Offline browser fixture. It runs the production solar module in the actual
// dashboard markup/styles, with other collectors removed and synthetic data only.
// Production route privacy is verified separately by test/solar-http.test.js.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const publicRoot = path.resolve(__dirname, '../public');
const screenshotRoot = path.resolve(__dirname, '../artifacts/dashboard');
const now = Date.parse('2026-11-14T02:00:00.000Z');
const iso = value => new Date(value).toISOString();
const dashboard = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8').replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi,
  (tag, attributes) => /\bsrc="\/(?:solar|theme)\.js\b/.test(attributes) ? tag : '');
let mode = 'fresh';
function readings(includeHistory = true) {
  const missing = mode === 'missing', zero = mode === 'zero', stale = mode === 'stale', buying = mode === 'buying';
  const day = { date: '2026-11-14', since: iso(now - 4 * 3600000), through: iso(now), quality: 'partial', sampleCount: 240,
    coveredSeconds: 14340, expectedSeconds: 43200, coveragePercent: 33.2, coverageSeconds: { load: 14340, solarToHome: 14340, grid: 14340, generation: 14340 },
    gridImportWh: 1200, gridExportWh: 9200, loadWh: 8000, solarToHomeWh: 6800, generatedAcWh: 16000,
    importCost: .3467376, exportCredit: .552552, supplyCost: 1.805078, netCost: 1.5992636 };
  const days = Array.from({ length: 30 }, (_, index) => {
    if (index === 29) return day;
    const offset = 29 - index, date = new Date(now - offset * 86400000 + 36000000).toISOString().slice(0, 10);
    if (index < 23) return { date, quality: 'unavailable', coveragePercent: 0 };
    const imported = 5 + index % 4, exported = 22 + index % 7;
    return { ...day, date, quality: 'complete', coveragePercent: 100, coveredSeconds: 86400, expectedSeconds: 86400,
      gridImportWh: imported * 1000, gridExportWh: exported * 1000, importCost: imported * .288948,
      exportCredit: exported * .06006, netCost: imported * .288948 - exported * .06006 + 1.805078 };
  });
  const points = Array.from({ length: 145 }, (_, index) => {
    const recorded = index >= 72 && index !== 120;
    const ac = Math.max(0, Math.sin((index - 72) / 144 * Math.PI) * 6500), load = 1600 + Math.pow(Math.sin(index / 13), 2) * 2000;
    return { observedAt: iso(now - (144 - index) * 300000), inverterPowerW: recorded ? ac : null,
      loadPowerW: recorded ? load : null, gridImportPowerW: recorded ? Math.max(0, load - ac) : null,
      gridExportPowerW: recorded ? Math.max(0, ac - load) : null, breakBefore: index === 121, hasGap: false, samples: recorded ? 5 : 0 };
  });
  return { enabled: mode !== 'disabled', status: mode === 'disabled' ? 'disabled' : mode === 'waiting' ? 'waiting' : stale ? 'stale' : 'fresh',
    timezone: 'Australia/Brisbane', staleAfterSeconds: 180,
    current: ['disabled', 'waiting'].includes(mode) ? null : {
      observedAt: iso(now - (stale ? 1800000 : 0)), collectedAt: iso(now), receivedAt: iso(now),
      pvPowerW: missing ? null : zero ? 0 : mode === 'recovered' ? 7200 : 6800,
      inverterPowerW: missing ? null : zero ? 0 : buying ? 2300 : 6500, gridPowerW: missing ? null : zero ? 0 : buying ? 1200 : -3000,
      loadPowerW: missing ? null : zero ? 0 : 3500, batteryPowerW: null, batterySocPercent: null, totalAcEnergyWh: 25000000,
      meterLocation: 'grid', mode: 'meter' },
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
async function layout(page, width) {
  const result = await page.evaluate(() => {
    const card = document.querySelector('#homeSolar'), rect = card.getBoundingClientRect();
    const children = [...card.querySelectorAll('.solar-header,.solar-main,.solar-reading,.solar-flow,.solar-note,.solar-message,.solar-hero,.solar-day-grid,.solar-history,.solar-history-header,.solar-chart-toolbar,.solar-chart-inspect')]
      .filter(element => element.getBoundingClientRect().height > 0)
      .map(element => ({ name: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        width: element.clientWidth, scroll: element.scrollWidth }));
    return { left: rect.left, right: rect.right, documentWidth: document.documentElement.scrollWidth, children };
  });
  assert.ok(result.left >= 0 && result.right <= width + 1, JSON.stringify(result));
  assert.ok(result.documentWidth <= width + 1, 'dashboard must not create horizontal scrolling at ' + width);
  for (const child of result.children) {
    assert.ok(child.left >= result.left - 1 && child.right <= result.right + 1, JSON.stringify(child));
    assert.ok(child.scroll <= child.width + 1, 'solar content overflows: ' + JSON.stringify(child));
  }
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
          const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme });
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
            await page.evaluate(({ wide, selectedTheme }) => {
              document.body.classList.add(wide ? 'layout-landscape' : 'layout-portrait');
              document.documentElement.dataset.theme = selectedTheme;
            }, { wide: width >= 900, selectedTheme: theme });
            assert.equal(await page.locator('#solarPvPower').textContent(), '6.80 kW');
            assert.equal(await page.locator('#solarAcPower').textContent(), '6.50 kW');
            assert.match(await page.locator('#solarEnergyThrough').textContent(), /11:55:00 AEST/);
            assert.equal(await page.locator('#solarHero').getAttribute('data-tone'), 'surplus');
            assert.equal(await page.locator('#solarHeadroom').textContent(), '3.00 kW');
            assert.equal(await page.locator('#solarLiveMoney').textContent(), 'Export earning $0.18/hr');
            assert.match(await page.locator('#solarDayNote').textContent(), /Solar covered 85% of recorded house use/);
            assert.equal(await page.locator('#solarChartEmpty').isVisible(), false);
            await layout(page, width);
            await page.locator('#homeSolar').screenshot({ path: path.join(screenshotRoot, `solar-${engine.name()}-${width}-${theme}.png`), animations: 'disabled' });
            await page.locator('#solarRange7').click();
            assert.equal(await page.locator('#solarRange7').getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#solarChart .solar-chart-bar').count(), 7);
            await page.locator('#solarChartMetric').selectOption('energy');
            assert.equal(await page.locator('#solarChart .solar-chart-bar').count(), 14);
            await page.locator('#solarChartScrubber').focus(); await page.keyboard.press('ArrowLeft');
            assert.match(await page.locator('#solarChartInspect').textContent(), /13 Nov/);
            await page.locator('#solarRange30').click();
            await page.locator('#solarLogDetails summary').click();
            assert.equal(await page.locator('#solarLogBody tr').count(), 7);
            await layout(page, width);
            await page.locator('#solarLogDetails summary').click();
            await page.locator('#solarRangeToday').click();
            await refresh(page, 'buying');
            assert.equal(await page.locator('#solarHero').getAttribute('data-tone'), 'import');
            assert.equal(await page.locator('#solarHeadroom').textContent(), '1.20 kW');
            assert.match(await page.locator('#solarLiveMoney').textContent(), /\$0.35\/hr/);
            await refresh(page, 'missing');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'partial');
            assert.equal(await page.locator('#solarPvPower').textContent(), '–');
            assert.equal(await page.locator('#solarLoadPower').textContent(), '–');
            assert.equal(await page.locator('#solarHeadroom').textContent(), '–');
            await refresh(page, 'zero');
            assert.equal(await page.locator('#solarPvPower').textContent(), '0.00 kW');
            assert.equal(await page.locator('#solarTodayEnergy').textContent(), '0.00 kWh');
            assert.equal(await page.locator('#solarHero').getAttribute('data-tone'), 'neutral');
            assert.equal(await page.locator('#solarCoverageBlock').isVisible(), false);
            const observed = await page.locator('#solarObserved').textContent();
            await refresh(page, 'failure');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'stale');
            assert.equal(await page.locator('#solarPvPower').textContent(), '0.00 kW');
            assert.equal(await page.locator('#solarObserved').textContent(), observed);
            await refresh(page, 'recovered');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'fresh');
            assert.equal(await page.locator('#solarPvPower').textContent(), '7.20 kW');
            await refresh(page, 'stale');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'stale');
            assert.equal(await page.locator('#solarHeadroom').textContent(), '–');
            assert.equal(await page.locator('#solarCoverageBlock').isVisible(), false);
            await layout(page, width);
            await refresh(page, 'reset');
            assert.equal(await page.locator('#solarTodayEnergy').textContent(), '–');
            assert.equal(await page.locator('#solarTodayQuality').textContent(), 'Counter reset');
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
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    console.log(`Passed ${checked} solar browser viewport/theme combinations: responsive layout, solar/import guidance, history controls, keyboard inspector, daily log, null/zero, stale/offline/recovered, disabled and expired-auth states.`);
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
