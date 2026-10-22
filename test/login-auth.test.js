'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

test('new public login assets and request form keep weather, archive and SkyCam behind the password', async t => {
  // Execute the actual server authentication/router block, stopping before any
  // weather collector, database worker or physical station connection starts.
  const root = path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = source.indexOf('const app = express();'), stop = source.indexOf('let cachedWeatherData = null;');
  assert.ok(start >= 0 && stop > start);
  const password = 'offline-test-password', salt = crypto.randomBytes(16);
  const hash = 'scrypt$' + salt.toString('base64url') + '$' + crypto.scryptSync(password, salt, 32).toString('base64url');
  const app = vm.runInNewContext(source.slice(start, stop) + '\napp;', {
    require: createRequire(path.join(root, 'server.js')), express: require('express'), cors: require('cors'),
    path, crypto, Buffer, __dirname: root, process: { env: { MOORE_AUTH_PASSWORD_HASH: hash, MOORE_AUTH_COOKIE_SECRET: 'offline-cookie-secret-longer-than-32-characters', NODE_ENV: 'production' } },
    logger: { warn() {}, info() {} }
  });
  app.get('/api/history', (_req, res) => res.json({ authenticated: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (url, headers = {}) => fetch(base + url, { headers, redirect: 'manual' });
  for (const url of ['/login', '/login.css', '/login.js', '/theme.js', '/dashboard.css', '/moore-weather-favicon-v3.svg', '/api/access-request']) assert.equal((await get(url)).status, 200, url);
  assert.equal((await (await get('/api/access-request')).json()).enabled, false);
  const login = await (await get('/login')).text(); assert.match(login, /accessRequestForm/); assert.doesNotMatch(login, /mailto:/);
  for (const url of ['/', '/index.html', '/daily.html', '/api/history', '/api/water', '/weather', '/skycam/latest.jpg']) assert.equal((await get(url)).status, 401, url);
  const navigation = await get('/daily.html', { Accept: 'text/html' });
  assert.equal(navigation.status, 302); assert.match(navigation.headers.get('location'), /^\/login\?next=/);
  const post = body => fetch(base + '/login', { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
  const invalid = await post({ password: 'wrong' }); assert.match(invalid.headers.get('location'), /error=invalid/);
  const valid = await post({ password, next: '/daily.html' });
  assert.equal(valid.status, 303); assert.equal(valid.headers.get('location'), '/daily.html');
  const cookie = valid.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await get('/daily.html', headers)).status, 200);
  assert.deepEqual(await (await get('/api/history', headers)).json(), { authenticated: true });
  const malicious = await post({ password, next: '//foreign.example' }); assert.equal(malicious.headers.get('location'), '/');
});
