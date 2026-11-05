'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { createStationTerminal } = require('../lib/station-terminal');

function hash(password) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('base64url') + '$' + crypto.scryptSync(password, salt, 32).toString('base64url');
}

test('the real portal login and terminal unlock form separate boundaries, and logout revokes the unlock', async t => {
  // Run the actual authentication/router block, never the production startup,
  // collectors or default station address. Any attempted socket is a failure.
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = source.indexOf('const app = express();');
  const end = source.indexOf('let cachedWeatherData = null;');
  assert.ok(start >= 0 && end > start);
  const password = 'offline-portal-pass', terminalPassword = 'offline-terminal-pass';
  const env = { MOORE_AUTH_PASSWORD_HASH: hash(password),
    MOORE_AUTH_COOKIE_SECRET: 'offline-cookie-secret-longer-than-32-characters',
    MOORE_TERMINAL_PASSWORD_HASH: hash(terminalPassword), NODE_ENV: 'test' };
  const quiet = { warn() {}, info() {}, error() {} };
  const { app, attach } = vm.runInNewContext(source.slice(start, end) +
    '\n({ app, attach(value) { stationTerminal = value; value.mount(app); } });', {
    require: createRequire(path.join(root, 'server.js')), express: require('express'), cors: require('cors'),
    path, crypto, Buffer, __dirname: root, process: { env }, logger: quiet,
    systemHealth: { snapshot: () => ({ status: 'ok' }) }
  });
  let queued = 0;
  const terminal = createStationTerminal({ env, host: '127.0.0.1', port: 1, logger: quiet,
    runTransaction() { queued++; throw new Error('Unlock must not contact a station'); } });
  attach(terminal);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await terminal.stop(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (url, cookie = '') => fetch(base + url, { headers: { Cookie: cookie }, redirect: 'manual' });
  const post = (url, body, cookie = '', csrf = '', origin = base) => fetch(base + url, {
    method: 'POST', redirect: 'manual', body: JSON.stringify(body),
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Terminal-CSRF': csrf }
  });
  for (const url of ['/terminal.html', '/terminal.js', '/terminal.css', '/api/terminal/status']) {
    assert.equal((await get(url)).status, 401, url + ' requires the portal login');
  }
  assert.equal((await post('/api/terminal/unlock', { password: terminalPassword })).status, 401);
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ password, next: '/terminal.html' }) });
  assert.equal(login.status, 303);
  const mainCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/terminal.html', mainCookie)).status, 200);
  const initial = await (await get('/api/terminal/status', mainCookie)).json();
  assert.equal(initial.enabled, true); assert.equal(initial.unlocked, false);
  assert.equal((await post('/api/terminal/connect', {}, mainCookie)).status, 401);
  assert.equal((await post('/api/terminal/unlock', { password: terminalPassword }, mainCookie, '', 'https://foreign.example')).status, 403);
  const unlock = await post('/api/terminal/unlock', { password: terminalPassword }, mainCookie);
  assert.equal(unlock.status, 200);
  const session = await unlock.json();
  assert.equal(session.unlocked, true); assert.ok(session.csrfToken);
  const extraCookie = unlock.headers.get('set-cookie');
  assert.match(extraCookie, /HttpOnly/i); assert.match(extraCookie, /SameSite=Strict/i); assert.match(extraCookie, /Path=\//);
  const bothCookies = mainCookie + '; ' + extraCookie.split(';')[0];
  assert.equal((await (await get('/api/terminal/status', bothCookies)).json()).unlocked, true);
  assert.equal((await post('/api/terminal/connect', {}, bothCookies, 'wrong-csrf')).status, 403);
  const logout = await fetch(base + '/logout', { method: 'POST', redirect: 'manual', headers: { Cookie: bothCookies } });
  assert.equal(logout.status, 303);
  assert.equal((await (await get('/api/terminal/status', bothCookies)).json()).unlocked, false,
    'Logout revokes the terminal capability even if old cookie bytes are replayed');
  assert.equal(queued, 0, 'Login, unlock, status and logout never contact hardware');
});
