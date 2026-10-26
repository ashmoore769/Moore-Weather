'use strict';
// Fetch only the public SDK. All browser requests are intercepted; no analytics,
// station, weather provider, email, or production-page requests reach a server.
const fs = require('node:fs'), path = require('node:path'), https = require('node:https');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '../public'), origin = 'https://moore-weather.onrender.com';
const sdkUrl = 'https://cloud.umami.is/script.js';
async function until(check, label) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function downloadSdk() {
  return new Promise((resolve, reject) => {
    const request = https.get(sdkUrl, response => {
      if (response.statusCode !== 200) { response.resume(); return reject(Error('SDK HTTP ' + response.statusCode)); }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 512000) request.destroy(Error('Unexpectedly large SDK'));
      });
      response.on('end', () => resolve(body));
      response.on('error', reject);
    });
    request.setTimeout(20000, () => request.destroy(Error('SDK download timed out')));
    request.on('error', reject);
  });
}
(async () => {
  const sdk = await downloadSdk();
  assert.ok(sdk.includes('umami') && sdk.length > 500, 'Official public SDK downloaded');
  let checked = 0;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      async function fixture(options = {}) {
        const context = await browser.newContext({ viewport: { width: options.width || 393, height: 852 }, serviceWorkers: 'block' });
        const requests = [], errors = [], external = [];
        if (options.excluded) await context.addInitScript(() => localStorage.setItem('umami.disabled', '1'));
        if (options.gpc) await context.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => true }));
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url());
          if (req.url() === sdkUrl) {
            external.push('sdk');
            if (options.blocked) return route.abort();
            return route.fulfill({ contentType: 'text/javascript', body: sdk });
          }
          const cors = { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': '*' };
          if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
          if (req.method() === 'POST' && (url.hostname === 'cloud.umami.is' || url.hostname.endsWith('.umami.is') || url.hostname.endsWith('.umami.dev'))) {
            const body = req.postDataJSON(); requests.push(body);
            return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({
              cache: 'offline-test-cache', sessionId: '11111111-1111-4111-8111-111111111111',
              visitId: '22222222-2222-4222-8222-222222222222'
            }) });
          }
          if (url.origin !== origin) return route.abort();
          const pathname = url.pathname === '/' ? '/index.html' : url.pathname === '/login' ? '/login.html' : url.pathname;
          const file = path.resolve(root, '.' + pathname);
          if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
          if (file.endsWith('.html')) {
            let html = fs.readFileSync(file, 'utf8')
              .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/\sonclick="[^"]*"/gi, '');
            // Retain real markup/CSS. Skip live polling and media scripts.
            html = html.replace('</head>', '<script src="/theme.js?v=4"></script><script defer src="/analytics.js?v=1"></script></head>');
            return route.fulfill({ contentType: 'text/html', body: html });
          }
          const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' :
            file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
          return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        return { context, page, requests, errors, external };
      }
      for (const [pathname, canonical] of [['/', '/'], ['/daily.html', '/daily.html'],
        ['/forecast.html', '/forecast.html'], ['/login', '/login'], ['/help.html', '/help.html']]) {
        const f = await fixture();
        await f.page.goto(origin + pathname + '?email=PRIVATE&next=SECRET#password=HIDDEN');
        await f.page.waitForFunction(() => Boolean(window.umami?.track));
        await until(() => f.requests.some(r => r.type === 'event' && !r.payload.name), 'initial pageview');
        assert.equal(f.requests.filter(r => r.type === 'event' && !r.payload.name).length, 1, 'One pageview per page');
        const pv = f.requests[0].payload;
        assert.equal(pv.website, 'cc26784e-27b2-48ef-80d6-a6da05212489');
        assert.equal(pv.url, canonical);
        assert.ok(!JSON.stringify(f.requests).includes('PRIVATE'));
        assert.ok(!JSON.stringify(f.requests).includes('SECRET'));
        assert.ok(!JSON.stringify(f.requests).includes('HIDDEN'));
        if (pathname === '/') {
          await f.page.locator('#skycamDownload').click();
          await f.page.evaluate(() => { const b = document.querySelector('#radarPlay'); b.disabled = false; b.click(); });
          await f.page.evaluate(() => window.mooreAnalytics.track('history-open', { measurement: 'rain', email: 'NEVER' }));
          await until(() => f.requests.some(r => r.payload?.name === 'history-open'), 'feature event');
          for (const name of ['skycam-download', 'radar-playback', 'history-open']) {
            assert.equal(f.requests.filter(r => r.payload?.name === name).length, 1, name);
          }
          assert.ok(!JSON.stringify(f.requests).includes('NEVER'));
        }
        if (pathname === '/login') {
          await f.page.fill('#requestName', 'Private Person');
          await f.page.fill('#requestEmail', 'private@example.org');
          await f.page.fill('#password', 'PrivatePassword');
          await f.page.waitForTimeout(100);
          assert.equal(f.requests.length, 1, 'Typing form fields sends no analytics events');
        }
        if (pathname === '/help.html') {
          await f.page.locator('#analyticsExclude').click();
          assert.match(await f.page.locator('#analyticsStatus').textContent(), /excluded/);
          const before = f.requests.length;
          await f.page.evaluate(() => window.mooreAnalytics.track('radar-refresh'));
          await f.page.reload(); await f.page.waitForTimeout(150);
          assert.equal(f.requests.length, before);
          assert.match(await f.page.locator('#analyticsStatus').textContent(), /excluded/);
          await f.page.locator('#analyticsExclude').click();
          await until(() => f.requests.length > before, 're-enabled pageview');
          assert.equal(f.requests.length, before + 1);
        }
        assert.deepEqual(f.errors, []);
        checked++; await f.context.close();
      }
      for (const options of [{ excluded: true }, { gpc: true }, { blocked: true }]) {
        const f = await fixture(options);
        await f.page.goto(origin + '/help.html');
        await f.page.waitForTimeout(150);
        assert.equal(f.requests.length, 0);
        if (!options.blocked) assert.equal(f.external.length, 0, 'No SDK request when excluded');
        assert.equal(await f.page.locator('h1').isVisible(), true);
        assert.deepEqual(f.errors, []);
        checked++; await f.context.close();
      }
      for (const width of [320, 1440]) {
        const f = await fixture({ width, excluded: true });
        await f.page.goto(origin + '/help.html#usage-statistics');
        await f.page.locator('#analyticsExclude').scrollIntoViewIfNeeded();
        const bounds = await f.page.locator('#analyticsExclude').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.height >= 44);
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(f.errors, []);
        checked++; await f.context.close();
      }
    } finally { await browser.close(); }
  }
  console.log('PASS: ' + checked + ' analytics/browser scenarios using the official Umami SDK; one clean pageview, feature events, no form capture, exclusion, blocked-provider resilience, and mobile/desktop controls. No analytics sent.');
})().catch(error => { console.error(error); process.exitCode = 1; });
