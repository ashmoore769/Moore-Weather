'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchOriginBuffer } = require('../lib/skycam-client');

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
