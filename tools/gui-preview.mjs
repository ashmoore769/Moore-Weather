#!/usr/bin/env node
/**
 * Local GUI preview only. Serves the real public files with representative
 * fixtures. No credentials, network clients, production database or writes.
 * Start with the managed Sites preview command after setting scripts.dev to
 * `node tools/gui-preview.mjs`. PORT is supplied by that preview service.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import * as fixture from './preview/fixtures.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const previewNotice = '<aside aria-label="Preview sample data" style="position:fixed;bottom:10px;left:10px;z-index:9000;max-width:calc(100vw - 40px);padding:7px 11px;border:1px solid #668b86;border-radius:7px;background:#122329ee;color:#c3d7d4;font:11px/1.4 system-ui,sans-serif;box-shadow:0 3px 15px #0004">DESIGN PREVIEW · Sample data <a href="?preview=healthy" style="color:#8addc7;margin-left:8px">Fresh</a> <a href="?preview=day" style="color:#8addc7;margin-left:8px">Day</a> <a href="?preview=night" style="color:#8addc7;margin-left:8px">Night</a> <a href="?preview=stale" style="color:#eed098;margin-left:8px">Stale</a> <a href="?preview=partial" style="color:#eed098;margin-left:8px">Partial</a> <a href="?preview=long" style="color:#eed098;margin-left:8px">Long</a></aside>';

export async function handlePreview(req, res) {
  const url = new URL(req.url, 'http://preview.local'), path = url.pathname;
  const cookieMode = req.headers.cookie?.match(/(?:^|;\s*)moore_preview=([^;]*)/)?.[1];
  const selected = url.searchParams.get('preview') || cookieMode || 'healthy';
  const mode = fixture.modes.includes(selected) ? selected : 'healthy';
  const now = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Moore-Preview', 'sample-data-only');
  if (url.searchParams.has('preview')) res.setHeader('Set-Cookie', `moore_preview=${mode}; Path=/; SameSite=Lax`);
  const send = (body, type = 'application/json; charset=utf-8', status = 200) => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(req.method === 'HEAD' ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  if (!['GET', 'HEAD'].includes(req.method)) return send({ error: 'This design preview is read-only. Alert subscriptions and production writes are disabled.' }, undefined, 405);
  if (path === '/__preview/status') return send({ preview: true, mode, generatedAt: new Date(now).toISOString(), liveConnections: false });
  if (path === '/weather') return mode === 'unavailable' ? send('Preview station unavailable', 'text/plain', 503) : send(fixture.currentCsv(now, mode), 'text/plain; charset=utf-8');
  if (path === '/daily') return mode === 'unavailable' ? send('Preview summary unavailable', 'text/plain', 503) : send(fixture.dailyCsv(now, mode), 'text/plain; charset=utf-8');
  if (path === '/ping') return send({ status: 'ok', stationObservedAt: new Date(now - (mode === 'stale' ? 38 * fixture.HOUR : 12000)).toISOString(), lastWeatherPoll: new Date(now - 1000).toISOString() });
  if (path === '/api/trends' || path === '/api/history') return send(fixture.historyPayload(now, mode, url.searchParams, path === '/api/trends'));
  if (path === '/api/water') return send(fixture.water(now, mode));
  if (path === '/api/forecast') return mode === 'unavailable' ? send({ error: 'Preview forecast unavailable' }, undefined, 503) : send(fixture.forecast(now, mode));
  if (path === '/api/solar') return send(fixture.solar(now, mode));
  if (path === '/api/yard-power') return send(fixture.yard(now, mode, url.searchParams.get('range')));
  if (path === '/api/alerts/history') return send(fixture.historyHealth(now, mode));
  if (path === '/api/system-health') return send(fixture.systemHealth(now, mode));
  if (path === '/api/alerts/config') return send({ enabled: false, preview: true,
    solar: { enabled: true, marginW: 100, morningDwellMinutes: 5, eveningDwellMinutes: 5, eveningStart: '15:00' },
    maintenance: { enabled: false } });
  if (path === '/skycam/history') return send(fixture.skyManifest(now, mode));
  if (path === '/skycam/latest.jpg' || path.startsWith('/skycam/download/') || path === '/__preview/skycam.svg') {
    const latest = fixture.skyManifest(now, mode).images.at(-1);
    if (!latest) return send('Preview camera unavailable', 'text/plain', 503);
    const downloadTime = path.startsWith('/skycam/download/preview-') ? Number(path.split('preview-').at(-1)) : null;
    const time = Math.min(now, Number(url.searchParams.get('time')) || downloadTime || Date.parse(latest.capturedAt));
    return send(fixture.cameraSvg(time), 'image/svg+xml');
  }
  if (path === '/api/radar') return send({ host: '/__preview', stale: false, location: { latitude: -28.213713, longitude: 151.9893045 },
    frames: Array.from({ length: 6 }, (_, i) => ({ time: Math.floor(now / 600000) * 600 - (5 - i) * 600, path: '/radar/' + i })) });
  if (path.startsWith('/__preview/radar/')) return send(fixture.radarSvg(), 'image/svg+xml');
  if (path.startsWith('/api/') || path.startsWith('/internal/')) return send({ error: 'No fixture for this endpoint. No live service was contacted.' }, undefined, 404);
  try {
    const pathname = decodeURIComponent(path === '/' ? '/index.html' : path);
    const file = resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot.endsWith(sep) ? publicRoot : publicRoot + sep)) return send('Forbidden', 'text/plain', 403);
    if (!(await stat(file)).isFile()) return send('Not found', 'text/plain', 404);
    let body = await readFile(file);
    if (extname(file) === '.html') body = body.toString().replace('</body>', previewNotice + '</body>');
    // Route just the radar overlay through fixtures. Production radar.js is
    // untouched; public OSM base tiles continue to use their normal browser URL.
    if (path === '/radar.js') body = body.toString().replaceAll('https://tilecache.rainviewer.com', '/__preview');
    return send(body, contentTypes[extname(file)] || 'application/octet-stream');
  } catch (error) { return send(error.code === 'ENOENT' ? 'Not found' : 'Preview asset unavailable', 'text/plain', error.code === 'ENOENT' ? 404 : 500); }
}

export function previewAddress(argv = process.argv.slice(2), env = process.env) {
  const arg = name => {
    const assignment = argv.find(value => value.startsWith(name + '='));
    if (assignment) return assignment.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = Number(env.PORT || arg('--port') || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Preview PORT must be an integer between 1 and 65535.');
  return { port, host: arg('--host') || env.HOST || '0.0.0.0' };
}

export function startPreview() {
  const address = previewAddress();
  const server = createServer((req, res) => handlePreview(req, res).catch(error => {
    console.error('Preview request failed:', error.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Preview fixture failed' }));
  }));
  // Node fails on a busy port, which provides --strictPort behaviour without
  // silently selecting another port behind the managed preview service.
  server.listen(address.port, address.host, () => console.log('Moore Weather GUI preview · sample data only · ' + address.host + ':' + server.address().port));
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startPreview();
