'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { fetchOriginBuffer, assertJpegBuffer } = require('../lib/skycam-client');
// Generated 2x2 JPEG fixture, independent of the private camera/archive.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBaKKK+kPAP/9k=', 'base64');

async function origin(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return new URL('http://127.0.0.1:' + server.address().port + '/image');
}

test('an interrupted successful SkyCam response rejects promptly and the next request recovers', async t => {
  let calls = 0;
  const url = await origin(t, (_req, res) => {
    if (++calls === 1) {
      res.writeHead(200, { 'Content-Length': '100' }); res.write('partial');
      setTimeout(() => res.destroy(), 10);
    } else { res.end('complete'); }
  });
  await assert.rejects(fetchOriginBuffer(url, { timeoutMs: 300, maxBytes: 1024 }), /interrupted|closed|aborted|failed/i);
  assert.equal((await fetchOriginBuffer(url, { timeoutMs: 300, maxBytes: 1024 })).buffer.toString(), 'complete');
});

test('SkyCam enforces a whole-response deadline even when an origin trickles bytes', async t => {
  const url = await origin(t, (_req, res) => {
    res.writeHead(200); res.write('x');
    const timer = setInterval(() => res.write('x'), 10);
    res.on('close', () => clearInterval(timer));
  });
  await assert.rejects(fetchOriginBuffer(url, { timeoutMs: 100, maxBytes: 1024 }), /timed out|deadline|time limit/i);
});

test('SkyCam rejects oversized content and non-success responses', async t => {
  let calls = 0;
  const url = await origin(t, (_req, res) => {
    if (++calls === 1) res.end('x'.repeat(100));
    else { res.writeHead(503); res.end('unavailable'); }
  });
  await assert.rejects(fetchOriginBuffer(url, { timeoutMs: 300, maxBytes: 50 }), /size|large|limit/i);
  await assert.rejects(fetchOriginBuffer(url, { timeoutMs: 300, maxBytes: 1024 }), /503/);
});

test('JPEG guard rejects empty, non-JPEG, and structurally incomplete HTTP-success bodies', () => {
  assert.doesNotThrow(() => assertJpegBuffer(jpeg));
  const invalid = [Buffer.alloc(0), Buffer.from('<html>not a JPEG</html>'), jpeg.subarray(0, -2),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.concat([jpeg.subarray(0, 12), Buffer.from([0xff, 0xd9])])];
  for (const body of invalid) assert.throws(() => assertJpegBuffer(body), /empty|invalid|incomplete/i);
});

test('all production camera image routes reject invalid bodies without immutable caching and recover', async t => {
  const root = path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const helperStart = source.indexOf('async function fetchSkyCamOriginImage(');
  const helperEnd = source.indexOf('function skyCamArchivePathFromId(', helperStart);
  const routesStart = source.indexOf('app.get("/skycam/latest.jpg"');
  const routesEnd = source.indexOf('app.get("/ping"', routesStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && routesStart >= 0 && routesEnd > routesStart);
  const app = require('express')(), errors = [];
  const id = 'SkyCam_00_20261114161010';
  let body = Buffer.alloc(0);
  vm.runInNewContext(source.slice(helperStart, helperEnd) + source.slice(routesStart, routesEnd), {
    app, require: createRequire(path.join(root, 'server.js')), SKYCAM_MAX_IMAGE_BYTES: 10 * 1024 * 1024,
    fetchSkyCamOriginBuffer: async () => ({ buffer: body, headers: { 'content-type': 'image/jpeg' } }),
    getSkyCamManifest: async () => ({ images: [{ id }], count: 1, maxImages: 1000 }),
    skyCamArchivePathFromId: value => value === id ? '/archive/2026/11/14/' + id + '.jpg' : null,
    logger: { error: value => errors.push(value) }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const endpoint of ['/skycam/latest.jpg', '/skycam/history/' + id, '/skycam/download/' + id]) {
    for (const invalid of [Buffer.alloc(0), Buffer.from('wrong content'), jpeg.subarray(0, -2)]) {
      body = invalid;
      const response = await fetch(base + endpoint);
      assert.equal(response.status, 502, endpoint);
      assert.equal(response.headers.get('cache-control'), 'no-store', endpoint);
      assert.doesNotMatch(response.headers.get('content-type'), /image\/jpeg/);
      await response.text();
    }
    body = jpeg;
    const response = await fetch(base + endpoint);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
    if (endpoint.includes('/history/')) assert.match(response.headers.get('cache-control'), /immutable/);
    else assert.match(response.headers.get('cache-control'), /no-store/);
  }
  assert.equal(errors.length, 9);
});
