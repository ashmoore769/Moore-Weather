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
function readings() {
  const missing = mode === 'missing', zero = mode === 'zero', stale = mode === 'stale';
  return { enabled: mode !== 'disabled', status: mode === 'disabled' ? 'disabled' : mode === 'waiting' ? 'waiting' : stale ? 'stale' : 'fresh',
    timezone: 'Australia/Brisbane', staleAfterSeconds: 180,
    current: ['disabled', 'waiting'].includes(mode) ? null : {
      observedAt: iso(now - (stale ? 1800000 : 0)), collectedAt: iso(now), receivedAt: iso(now),
      pvPowerW: missing ? null : zero ? 0 : mode === 'recovered' ? 7200 : 6800,
      inverterPowerW: missing ? null : zero ? 0 : 6500, gridPowerW: missing ? null : zero ? 0 : -3000,
      loadPowerW: missing ? null : 3500, batteryPowerW: null, batterySocPercent: null, totalAcEnergyWh: 25000000,
      meterLocation: 'grid', mode: 'meter' },
    today: { date: '2026-11-14', energyAcWh: missing || mode === 'waiting' ? null : zero ? 0 : 13240,
      quality: mode === 'reset' ? 'reset' : missing || mode === 'waiting' ? 'unavailable' : 'partial',
      since: iso(now - 2 * 3600000), through: iso(now - 5 * 60000), sampleCount: 100, gapCount: 1, counterReset: mode === 'reset',
      label: mode === 'reset' ? 'The inverter counter reset; daily energy is unavailable.' : 'Recorded AC energy covers part of today. Earlier energy is unavailable.' }, history: null };
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/solar') {
    assert.equal(url.search, '', 'the live card should not request history');
    res.writeHead(mode === 'failure' ? 503 : mode === 'unauthorized' ? 401 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(mode === 'failure' || mode === 'unauthorized' ? { error: 'Synthetic unavailable response' } : readings())); return;
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
    const children = [...card.querySelectorAll('.solar-header,.solar-main,.solar-reading,.solar-flow,.solar-note,.solar-message')]
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
            await layout(page, width);
            await page.locator('#homeSolar').screenshot({ path: path.join(screenshotRoot, `solar-${engine.name()}-${width}-${theme}.png`), animations: 'disabled' });
            await refresh(page, 'missing');
            assert.equal(await page.locator('#homeSolar').getAttribute('data-state'), 'partial');
            assert.equal(await page.locator('#solarPvPower').textContent(), '—');
            assert.equal(await page.locator('#solarFlows').isVisible(), false);
            await refresh(page, 'zero');
            assert.equal(await page.locator('#solarPvPower').textContent(), '0.00 kW');
            assert.equal(await page.locator('#solarTodayEnergy').textContent(), '0.00 kWh');
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
            await layout(page, width);
            await refresh(page, 'reset');
            assert.equal(await page.locator('#solarTodayEnergy').textContent(), '—');
            assert.equal(await page.locator('#solarTodayQuality').textContent(), 'Counter reset');
            mode = 'waiting'; await page.reload();
            await page.waitForFunction(() => document.querySelector('#homeSolar').dataset.state === 'waiting');
            assert.equal(await page.locator('#solarPvPower').textContent(), '—');
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
    console.log(`Passed ${checked} solar browser viewport/theme combinations: responsive layout, null/zero, stale/offline/recovered, disabled and expired-auth states.`);
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
