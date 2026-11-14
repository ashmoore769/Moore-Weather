'use strict';
// Real Leaflet and production radar markup/CSS/JS, with synthetic frames and
// local replacement image bytes. No station or weather provider is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const publicRoot = path.resolve(__dirname, '../public');
const screenshotRoot = path.resolve(__dirname, '../artifacts/dashboard');
const centre = [-28.22, 152.03], station = [-28.213713, 151.9893045];
const centreTolerancePx = 1;
function pixelDistance(first, second) { return Math.hypot(first.x - second.x, first.y - second.y); }
function readMapStateInPage(target) {
  const m = window.__radarReviewMap, p = m.getCenter(), element = document.getElementById('radarMap');
  const projected = m.project(p, m.getZoom()), destination = m.project(target, m.getZoom());
  const size = m.getSize();
  return { lat: p.lat, lng: p.lng, zoom: m.getZoom(), minimum: m.getMinZoom(),
    projectedCentre: { x: projected.x, y: projected.y }, targetCentreErrorPx: pixelDistance(projected, destination),
    mapSize: { x: size.x, y: size.y }, containerSize: { x: element.clientWidth, y: element.clientHeight },
    enabled: Object.fromEntries(['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard'].map(name => [name, m[name].enabled()])),
    active: document.querySelector('.radar-map-stage').dataset.interactive,
    touch: getComputedStyle(element).touchAction };
}
const now = Math.floor(Date.now() / 600000) * 600;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNU8Y5iYGBgYmBgYGBgAAAJYADNjl9iMQAAAABJRU5ErkJggg==', 'base64');
const radarImage = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><path d="M0 180Q180 40 512 220L512 280Q180 100 0 250Z" fill="#13964f" opacity=".42"/><path d="M50 100Q220 150 420 60" fill="none" stroke="#6ed7f3" stroke-width="15" opacity=".7"/></svg>';
const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8')
  .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (tag, attributes) =>
    /\bsrc="\/(?:radar\.js|theme\.js|vendor\/leaflet\/leaflet\.js)/.test(attributes) ? tag : '')
  .replace(/(<script\b[^>]*src="\/radar\.js[^>]*>)/, '<script defer src="/radar-review-hook.js"></script>$1');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/radar') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ host: 'https://tilecache.rainviewer.com',
      location: { latitude: centre[0], longitude: centre[1] },
      frames: [now - 600, now].map(time => ({ time, path: '/fixture/' + time })) }));
  }
  if (url.pathname === '/radar-review-hook.js') {
    res.setHeader('Content-Type', 'application/javascript');
    // The unrelated dashboard initializer is excluded from this fixture. Apply
    // its responsive layout before radar.js constructs Leaflet so the desktop
    // case exercises the real wide map and its native-image coverage limits.
    return res.end(`${pixelDistance.toString()}; ${readMapStateInPage.toString()};
      window.__radarReviewReadState=readMapStateInPage;
      document.body.classList.add(innerWidth>=900?"layout-landscape":"layout-portrait");
      const originalRadarMapFactory=L.map;
      L.map=(...args)=>{const map=originalRadarMapFactory(...args); window.__radarReviewMap=map; return map;};`);
  }
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(publicRoot + path.sep)) { res.statusCode = 403; return res.end(); }
  try {
    const content = fs.readFileSync(file);
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
    return res.end(content);
  } catch { res.statusCode = 404; return res.end(); }
});
async function mapState(page) {
  return page.evaluate(target => window.__radarReviewReadState(target), centre);
}
function sameView(actual, expected, label) {
  const displacementPx = pixelDistance(actual.projectedCentre, expected.projectedCentre);
  assert.ok(actual.zoom === expected.zoom && displacementPx <= centreTolerancePx, label + ': ' + JSON.stringify({ displacementPx, actual, expected }));
}
async function locked(page, label) {
  const s = await mapState(page);
  assert.equal(s.active, 'false', label);
  assert.ok(Object.values(s.enabled).every(value => value === false), label + ' movement handlers');
  assert.match(s.touch, /pan-y/, label + ' permits vertical page scrolling');
  assert.equal(await page.locator('#radarInteraction').getAttribute('aria-pressed'), 'false');
  return s;
}
async function unlocked(page, label) {
  const s = await mapState(page);
  assert.equal(s.active, 'true', label);
  assert.ok(Object.values(s.enabled).every(Boolean), label + ' movement handlers');
  assert.equal(s.touch, 'none', label + ' gestures belong to map');
  assert.equal(await page.locator('#radarInteraction').getAttribute('aria-pressed'), 'true');
  return s;
}
async function clearOverlayControls(page) {
  const { stage, controls } = await page.evaluate(() => {
    const bounds = element => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const selectors = ['.radar-title-badge', '.radar-frame-badge', '#radarReset', '#refreshRadar', '#radarInteraction', '.leaflet-control-zoom-in', '.leaflet-control-zoom-out'];
    return { stage: bounds(document.querySelector('.radar-map-stage')),
      controls: selectors.map(selector => ({ selector, ...bounds(document.querySelector(selector)) })) };
  });
  for (const [index, control] of controls.entries()) {
    assert.ok(control.left >= stage.left - 1 && control.right <= stage.right + 1 && control.top >= stage.top - 1 && control.bottom <= stage.bottom + 1, control.selector + ' stays within the radar');
    for (const other of controls.slice(index + 1)) {
      const overlap = Math.min(control.right, other.right) - Math.max(control.left, other.left) > 1 && Math.min(control.bottom, other.bottom) - Math.max(control.top, other.top) > 1;
      assert.equal(overlap, false, control.selector + ' does not obstruct ' + other.selector);
    }
  }
}
async function point(page) {
  await page.locator('#radarMap').scrollIntoViewIfNeeded();
  const box = await page.locator('#radarMap').boundingBox();
  return { x: box.x + box.width * .45, y: box.y + box.height * .55 };
}
async function drag(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(250);
}
async function touchPinch(page, context, engine) {
  if (engine === chromium) {
    const box = await page.locator('#radarMap').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    const session = await context.newCDPSession(page);
    const points = distance => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(25) });
    for (let distance = 30; distance <= 65; distance += 5) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(distance) });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach(); await page.waitForTimeout(400); return;
  }
  // WebKit automation exposes no native multitouch channel. Exercise its real
  // Leaflet DOM touch handlers; Chromium above verifies native arbitration.
  await page.locator('#radarMap').evaluate(element => {
    const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const touch = (id, clientX) => ({ identifier: id, target: element, clientX, clientY: y, screenX: clientX, screenY: y, pageX: clientX + scrollX, pageY: y + scrollY });
    const fire = (type, distance) => {
      const touches = type === 'touchend' ? [] : [touch(1, x - distance), touch(2, x + distance)];
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: touches }, targetTouches: { value: touches }, changedTouches: { value: touches } });
      element.dispatchEvent(event);
    };
    fire('touchstart', 25);
    for (let distance = 30; distance <= 65; distance += 5) fire('touchmove', distance);
    fire('touchend', 65);
  });
  await page.waitForTimeout(400);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const failures = []; let checked = 0;
  fs.mkdirSync(screenshotRoot, { recursive: true });
  try {
    const engines = (process.env.RADAR_BROWSERS || 'chromium,webkit').split(',').map(name => ({ chromium, webkit })[name]);
    assert.ok(engines.every(Boolean), 'RADAR_BROWSERS supports chromium,webkit');
    for (const engine of engines) {
      const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
      try {
        for (const width of [320, 393, 1440]) {
          const context = await browser.newContext({ viewport: { width, height: width < 900 ? 844 : 1000 }, hasTouch: true, isMobile: width < 900, colorScheme: 'light' });
          const page = await context.newPage(), errors = [], outsideRequests = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin === origin) return route.continue();
            if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ contentType: 'image/png', body: pixel });
            if (url.hostname === 'tilecache.rainviewer.com') return route.fulfill({ contentType: 'image/svg+xml', body: radarImage });
            outsideRequests.push(url.origin); return route.abort();
          });
          const name = `radar-${engine.name()}-${width}`;
          let checkpoint = 'navigation and map initialization';
          try {
            await page.goto(origin); await page.waitForFunction(() => window.__radarReviewMap && !document.getElementById('radarInteraction').disabled);
            checkpoint = 'synthetic radar image ready';
            await page.waitForFunction(() => /AEST/.test(document.getElementById('radarFrameTime').textContent) && !/—/.test(document.getElementById('radarFrameTime').textContent));
            checkpoint = 'responsive map size and Warwick centring';
            // Leaflet rounds its pixel origin and reconstructs the geographic
            // centre after invalidateSize. A subpixel difference is expected;
            // compare at the displayed zoom rather than requiring metre-level
            // geographic equality on a regional map.
            await page.waitForFunction(({ target, tolerance }) => {
              const state = window.__radarReviewReadState(target);
              return state.mapSize.x === state.containerSize.x && state.mapSize.y === state.containerSize.y && state.targetCentreErrorPx <= tolerance;
            }, { target: centre, tolerance: centreTolerancePx });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            if (width >= 900) {
              assert.equal(await page.locator('body').evaluate(element => element.classList.contains('layout-landscape')), true, 'desktop uses the production landscape layout');
              assert.ok((await page.locator('.main-container').boundingBox()).width > 1000 && (await page.locator('#radarMap').boundingBox()).width > 500, 'desktop checks a genuinely wide radar, not the portrait fallback');
            }
            const initial = await locked(page, 'Initial view');
            assert.ok(initial.targetCentreErrorPx <= centreTolerancePx, 'Warwick is centred within one displayed pixel: ' + initial.targetCentreErrorPx);
            if (width < 900) assert.equal((await page.locator('.leaflet-control-scale-line').innerText()).trim(), '100 km', 'phone default scale');
            const markers = await page.evaluate(() => { const found = []; window.__radarReviewMap.eachLayer(layer => { if (layer instanceof L.CircleMarker) { const p = layer.getLatLng(); found.push([p.lat, p.lng]); } }); return found; });
            assert.deepEqual(markers, [station], 'station dot is west of town at verified point');
            assert.equal(await page.locator('.leaflet-tooltip').count(), 0, 'no forced Warwick label');
            checkpoint = 'initial locked screenshot';
            await page.locator('#radar').screenshot({ path: path.join(screenshotRoot, name + '-locked.png'), animations: 'disabled' });

            checkpoint = 'locked mouse drag';
            let p = await point(page);
            await drag(page, p, 50, -70); sameView(await locked(page, 'A swipe does not unlock'), initial, 'Locked drag does not move map');
            checkpoint = 'locked wheel page scrolling';
            await page.mouse.move(p.x, p.y); const beforeScroll = await page.evaluate(() => scrollY);
            await page.mouse.wheel(0, 180); await page.waitForFunction(previous => scrollY !== previous, beforeScroll);
            sameView(await locked(page, 'Scroll stays locked'), initial, 'Wheel scroll belongs to page');
            if (engine === chromium && width < 900) {
              checkpoint = 'locked native finger page scrolling';
              p = await point(page); const scrollBeforeTouch = await page.evaluate(() => scrollY), session = await context.newCDPSession(page);
              await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y + 45, id: 3 }] });
              for (let step = 1; step <= 8; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y + 45 - step * 10, id: 3 }] });
              await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
              await page.waitForFunction(previous => scrollY > previous + 10, scrollBeforeTouch);
              sameView(await locked(page, 'Native finger scroll stays locked'), initial, 'Single finger belongs to page');
              await session.detach();
            }
            checkpoint = 'deliberate map tap and overlay geometry';
            p = await point(page); await page.mouse.click(p.x, p.y); await unlocked(page, 'A short map tap enables exploration');
            await clearOverlayControls(page);
            checkpoint = 'active zoom control';
            await page.locator('.leaflet-control-zoom-in').click(); await page.waitForFunction(z => window.__radarReviewMap.getZoom() > z, initial.zoom);
            await page.waitForTimeout(300); const zoomed = await mapState(page);
            checkpoint = 'active map drag';
            p = await point(page); await drag(page, p, 35, 15);
            const moved = await mapState(page);
            assert.ok(pixelDistance(moved.projectedCentre, zoomed.projectedCentre) > centreTolerancePx, 'Active map drags by more than one displayed pixel');
            checkpoint = 'active reset';
            await page.locator('#radarReset').click(); await page.waitForTimeout(300);
            sameView(await unlocked(page, 'Reset preserves active state'), initial, 'Reset recentres default view');
            checkpoint = 'active pinch';
            await touchPinch(page, context, engine); assert.ok((await mapState(page)).zoom > initial.zoom, 'Active pinch zooms the map');
            checkpoint = 'active screenshot';
            await page.locator('#radar').screenshot({ path: path.join(screenshotRoot, name + '-active.png'), animations: 'disabled' });
            checkpoint = 'Done and keyboard activation';
            await page.locator('#radarInteraction').click(); await locked(page, 'Done locks');
            await page.locator('#radarInteraction').focus(); await page.keyboard.press('Enter'); await unlocked(page, 'Keyboard Enter activates');
            await page.keyboard.press('Escape'); await locked(page, 'Escape locks');
            assert.equal(await page.locator('#radarInteraction').evaluate(el => el === document.activeElement), true, 'Escape returns focus to activation control');
            await page.keyboard.press('Space'); await unlocked(page, 'Keyboard Space activates');
            checkpoint = 'outside click and locked reset';
            await page.getByRole('heading', { name: 'Moore Weather', exact: true }).click(); await locked(page, 'Outside click locks');
            await page.locator('#radarReset').click(); await page.waitForTimeout(300);
            sameView(await locked(page, 'Reset remains locked'), initial, 'Locked reset recentres default view');
            checkpoint = 'playback and browser errors';
            await page.locator('#radarLatest').click(); await locked(page, 'Playback controls do not unlock');
            assert.deepEqual(errors, [], 'No browser errors'); assert.deepEqual(outsideRequests, [], 'Every external image is replaced locally');
            checked++;
          } catch (error) {
            const state = await mapState(page).catch(stateError => ({ unavailable: stateError.message }));
            try { await page.locator('#radar').screenshot({ path: path.join(screenshotRoot, name + '-failure.png'), animations: 'disabled' }); } catch {}
            failures.push({ engine: engine.name(), width, checkpoint, message: error.message, state, browserErrors: errors, stack: error.stack }); console.error(JSON.stringify(failures.at(-1)));
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(failures, [], 'Radar interaction checks must all pass');
    console.log(`Passed ${checked} real-Leaflet radar cases: locked scrolling, deliberate activation, pan/zoom/pinch, keyboard controls, relocking, default centre and station marker.`);
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
