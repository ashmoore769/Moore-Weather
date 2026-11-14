'use strict';
// Production markup and forecast modules with synthetic data only. No station,
// inverter, real household readings or third-party APIs are contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '../public');
const artifacts = path.resolve(__dirname, '../artifacts/dashboard');
const HOUR = 3600000, NOW = Date.parse('2026-11-14T12:30:00Z'); // 22:30 AEST
const START = Math.floor(NOW / HOUR) * HOUR;
const dashboard = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi,
  (tag, attributes) => /\bsrc="\/(?:forecast-summary(?:-model)?|theme)\.js\b/.test(attributes) ? tag : '');
let mode = 'fresh', requests = 0;
function forecast() {
  const age = mode === 'stale' ? HOUR : mode === 'expired' ? 6 * HOUR : 2 * 60000;
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    time: (START + (i + 1) * HOUR) / 1000,
    precipitation: [0.2, 0, 0, 2.8, 1.4, 0, 0.1][i] || 0,
    precipitation_probability: i === 3 ? 75 : 20,
    temperature_2m: i === 15 ? 28 : i === 8 ? 16 : 21,
    weather_code: i === 4 ? 97 : 3,
    wind_gusts_10m: 20
  }));
  if (mode === 'dry') hourly.forEach(row => { row.precipitation = 0; row.precipitation_probability = 0; row.weather_code = 2; });
  if (mode === 'partial') { hourly.splice(3, 1); hourly.forEach(row => { row.weather_code = null; }); }
  return { source: 'Open-Meteo', timezone: 'Australia/Brisbane', location: { name: 'Warwick area' },
    fetchedAt: new Date(NOW - age).toISOString(), stale: mode === 'stale', hourly, daily: [] };
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/forecast') {
    requests++;
    assert.equal(url.search, '', 'the summary reuses the existing bounded forecast endpoint');
    res.writeHead(mode === 'failure' ? 503 : mode === 'unauthorized' ? 401 : 200,
      { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(['failure', 'unauthorized'].includes(mode) ? { error: 'Synthetic unavailable response' } : forecast()));
    return;
  }
  if (url.pathname === '/login') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Offline sign-in fixture</h1>'); return; }
  if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(dashboard); return; }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const content = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' :
      file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
async function checkLayout(page, width) {
  const layout = await page.evaluate(() => {
    const card = document.querySelector('#forecastSummary'), rect = card.getBoundingClientRect();
    const children = [...card.querySelectorAll('.forecast-summary-header,.forecast-summary-metrics,.forecast-summary-signal,.forecast-summary-timing,.forecast-summary-hourly,.forecast-summary-inspect,.forecast-summary-footer')]
      .filter(element => element.getBoundingClientRect().height > 0).map(element => ({
        name: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        width: element.clientWidth, scroll: element.scrollWidth
      }));
    const timeLabels = [...card.querySelectorAll('.forecast-summary-axis[y="102"]')].map(element => {
      const box = element.getBoundingClientRect();
      return { text: element.textContent, left: box.left, right: box.right };
    }).sort((a, b) => a.left - b.left);
    return { left: rect.left, right: rect.right, height: rect.height, width: document.documentElement.scrollWidth,
      aboveSolar: Boolean(card.compareDocumentPosition(document.querySelector('#homeSolar')) & Node.DOCUMENT_POSITION_FOLLOWING), children, timeLabels };
  });
  assert.equal(layout.aboveSolar, true, 'forecast appears immediately before Home solar in reading order');
  assert.ok(layout.left >= 0 && layout.right <= width + 1 && layout.width <= width + 1, JSON.stringify(layout));
  for (const child of layout.children) {
    assert.ok(child.left >= layout.left - 1 && child.right <= layout.right + 1 && child.scroll <= child.width + 1,
      'forecast content must stay within the card: ' + JSON.stringify(child));
  }
  for (let i = 1; i < layout.timeLabels.length; i++) {
    assert.ok(layout.timeLabels[i].left >= layout.timeLabels[i - 1].right + 2,
      'hour and midnight labels must remain distinct: ' + JSON.stringify(layout.timeLabels));
  }
  const limit = width >= 900 ? 290 : width >= 361 ? 390 : 420;
  assert.ok(layout.height <= limit, `Forecast summary should stay compact at ${width}px: ${layout.height}px exceeds ${limit}px`);
  return Math.round(layout.height);
}
async function waitState(page, state) {
  await page.waitForFunction(expected => document.querySelector('#forecastSummary')?.dataset.state === expected, state);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const metrics = [];
  try {
    fs.mkdirSync(artifacts, { recursive: true });
    const engines = (process.env.FORECAST_BROWSERS || process.env.DASHBOARD_BROWSERS || 'chromium,webkit').split(',').map(name => ({ chromium, webkit })[name]);
    assert.ok(engines.every(Boolean), 'FORECAST_BROWSERS supports chromium,webkit');
    for (const engine of engines) {
      const browser = await engine.launch(engine === chromium && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
      try {
        for (const width of [320, 393, 1440]) for (const theme of ['light', 'dark']) {
          mode = 'fresh'; requests = 0;
          const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, hasTouch: width < 900 });
          await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await context.addInitScript(({ now, selectedTheme }) => {
            window.__forecastNow = now;
            Date.now = () => window.__forecastNow;
            localStorage.setItem('mooreWeatherTheme', selectedTheme);
            localStorage.setItem('mooreWeatherThemeVersion', '4');
            const schedule = window.setTimeout;
            window.setTimeout = (callback, milliseconds, ...args) => {
              if (milliseconds >= 60000) window.__forecastPoll = callback;
              return schedule(callback, milliseconds, ...args);
            };
          }, { now: NOW, selectedTheme: theme });
          const page = await context.newPage(), errors = [];
          page.setDefaultTimeout(5000);
          page.on('pageerror', error => errors.push(error.message));
          try {
            await page.goto(origin + '/index.html');
            await waitState(page, 'fresh');
            await page.evaluate(({ wide, selectedTheme }) => {
              document.body.classList.add(wide ? 'layout-landscape' : 'layout-portrait');
              document.documentElement.dataset.theme = selectedTheme;
            }, { wide: width >= 900, selectedTheme: theme });
            assert.equal(await page.title(), 'Moore Weather · Dashboard');
            assert.equal((await page.locator('#fetchBtn').innerText()).trim(), 'Dashboard');
            assert.equal(await page.locator('.forecast-summary-bar').count(), 24);
            assert.match(await page.locator('#forecastSummaryRain').innerText(), /4\.5\s*mm/);
            assert.match(await page.locator('#forecastSummaryChance').innerText(), /75%/);
            assert.match(await page.locator('#forecastSummaryTemps').innerText(), /28.*16/s);
            assert.match(await page.locator('#forecastSummarySignal').innerText(), /storm/i, 'code97 must surface a thunderstorm signal');
            assert.equal(await page.locator('.forecast-summary-full').getAttribute('href'), '/forecast.html');
            assert.equal(await page.locator('.forecast-summary-footer a').last().getAttribute('href'), 'https://www.bom.gov.au/qld/warnings.shtml');
            assert.equal(await page.locator('#forecastSummary').getAttribute('aria-busy'), 'false');
            const plot = page.locator('#forecastSummaryPlot');
            await plot.focus(); await page.keyboard.press('Home');
            assert.equal(await plot.getAttribute('aria-valuenow'), '0');
            assert.match(await plot.getAttribute('aria-valuetext'), /22:00.*23:00|10\s*pm.*11\s*pm/i,
              'first rain bar belongs to the ongoing 22:00–23:00 interval, not the API end timestamp');
            await page.keyboard.press('ArrowRight');
            assert.equal(await plot.getAttribute('aria-valuenow'), '1');
            await page.keyboard.press('End');
            assert.equal(await plot.getAttribute('aria-valuenow'), '23');
            await page.keyboard.press('ArrowRight');
            assert.equal(await plot.getAttribute('aria-valuenow'), '23', 'keyboard selection remains bounded');
            await page.keyboard.press('Home');
            await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
            assert.equal(await plot.getAttribute('aria-valuenow'), '3');
            assert.match(await page.locator('#forecastSummaryInspect').innerText(), /2\.8\s*mm/);
            assert.match(await page.locator('#forecastSummaryInspect').innerText(), /75%/);
            const focus = await plot.evaluate(element => ({ focused: document.activeElement === element,
              outline: getComputedStyle(element).outlineStyle, width: parseFloat(getComputedStyle(element).outlineWidth), touch: getComputedStyle(element).touchAction }));
            assert.ok(focus.focused && focus.outline !== 'none' && focus.width > 0, 'keyboard focus is visible');
            assert.equal(focus.touch, 'pan-y', 'vertical page scrolling remains available over the chart');
            await plot.scrollIntoViewIfNeeded();
            const box = await plot.boundingBox();
            if (width < 900) await page.touchscreen.tap(box.x + box.width * .75, box.y + box.height / 2);
            else {
              await page.mouse.move(box.x + box.width * .25, box.y + box.height / 2);
              await page.mouse.down(); await page.mouse.move(box.x + box.width * .75, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
            }
            const selected = Number(await plot.getAttribute('aria-valuenow'));
            assert.ok(selected >= 16 && selected <= 19, 'touch or drag selects the corresponding hour');
            await plot.focus(); await page.keyboard.press('Home');
            const name = `forecast-${engine.name()}-${width}-${theme}`;
            metrics.push({ name, height: await checkLayout(page, width) });
            await page.locator('#forecastSummary').screenshot({ path: path.join(artifacts, name + '.png'), animations: 'disabled' });
            assert.equal(requests, 1, 'interactions reuse the existing response without refetching');

            if (width === 393 && theme === 'dark') {
              for (const [next, expected] of [['dry', 'fresh'], ['partial', 'fresh'], ['stale', 'stale'], ['expired', 'expired'], ['failure', 'unavailable']]) {
                mode = next;
                await page.reload(); await waitState(page, expected);
                const rain = await page.locator('#forecastSummaryRain').innerText();
                const signal = await page.locator('#forecastSummarySignal').innerText();
                if (next === 'dry') {
                  assert.match(rain, /0\s*mm/); assert.match(await page.locator('#forecastSummaryChance').innerText(), /0%/);
                  assert.match(await page.locator('#forecastSummaryTiming').innerText(), /no.*rain|dry/i);
                  assert.doesNotMatch(signal, /safe|all.clear|no storms/i);
                } else if (next === 'partial') {
                  assert.doesNotMatch(rain, /\d/, 'an incomplete sum must not masquerade as a full 24-hour total');
                  assert.doesNotMatch(await page.locator('#forecastSummaryChance').innerText(), /\d/);
                  assert.match(await page.locator('#forecastSummary').innerText(), /partial|incomplete|unavailable|missing/i);
                  assert.doesNotMatch(signal, /no storms|all.clear/i);
                } else if (next === 'stale') {
                  assert.match(rain, /4\.5/); assert.match(await page.locator('#forecastSummary').innerText(), /delayed|older|stale/i);
                } else {
                  assert.doesNotMatch(rain, /\d/); assert.match(await page.locator('#forecastSummary').innerText(), /unavailable|expired/i);
                }
                metrics.push({ name: name + '-' + next, height: await checkLayout(page, width) });
                if (['dry', 'partial', 'stale'].includes(next)) await page.locator('#forecastSummary').screenshot({ path: path.join(artifacts, name + '-' + next + '.png'), animations: 'disabled' });
              }
              mode = 'fresh';
              await page.reload(); await waitState(page, 'fresh');
              mode = 'failure';
              await page.evaluate(async () => {
                window.__forecastNow += 21 * 60000;
                if (!window.__forecastPoll) throw Error('Forecast refresh was not scheduled');
                await window.__forecastPoll();
              });
              await waitState(page, 'stale');
              assert.match(await page.locator('#forecastSummaryRain').innerText(), /4\.5/, 'a transient fetch error retains a clearly stale, bounded forecast');
              mode = 'unauthorized';
              await page.reload();
              await page.waitForURL(url => url.pathname === '/login');
            }
            assert.deepEqual(errors, [], 'forecast fixture should not emit browser errors');
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    fs.writeFileSync(path.join(artifacts, 'forecast-layout.json'), JSON.stringify(metrics, null, 2) + '\n');
    console.log(`Forecast summary passed ${metrics.length} layout/state checks, including touch, keyboard, midnight, storms, missing data and bounded stale recovery.`);
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
