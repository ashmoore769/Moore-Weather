'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const parser = source.match(/^app\.use\(express\.urlencoded\(.+\)\);$/m)?.[0];

for (const production of [true, false]) {
  test(production ? 'public form parser rejects compressed requests before authentication and remains alive' :
    'patched parser survives a completed gzip body followed by trailing bytes', { timeout: 10000 }, async t => {
    assert.ok(parser, 'Use the real middleware configuration without starting the physical station');
    assert.ok(source.indexOf(parser) < source.indexOf('const payload = authenticatedPayload(req);'));
    // This regression used to exit the whole Node process, so isolate it from
    // the runner. Both cases bind only to loopback and never start server.js.
    const child = fork('-e', [`
      const express = require('express'), vm = require('node:vm');
      const app = express();
      vm.runInNewContext(${JSON.stringify(production ? parser : "app.use(express.urlencoded({ extended: false, limit: '2kb', inflate: true }));")}, { app, express });
      app.use((_req, res) => res.status(401).end('Authentication required.'));
      app.use((error, _req, res, _next) => res.status(error.status || 500).end());
      const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
      process.on('message', message => { if (message === 'close') server.close(() => process.exit(0)); });
    `], { cwd: root, env: { NODE_ENV: 'test' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
    const port = await Promise.race([
      new Promise((resolve, reject) => { child.once('message', message => resolve(message.port)); child.once('error', reject); }),
      exited.then(result => { throw Error('Parser process exited before listening: ' + JSON.stringify(result) + stderr); })
    ]);
    const base = `http://127.0.0.1:${port}`;
    // A valid frame, a gzip padding byte and another chunk reproduce the old
    // unhandled decompressor error after the authentication response is sent.
    const body = Buffer.concat([gzipSync(Buffer.from('x=1')), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
    const response = await fetch(base + '/private', { method: 'POST', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Encoding': 'gzip' },
      signal: AbortSignal.timeout(3000) });
    await response.text();
    assert.equal(response.status, production ? 415 : 401);
    const next = await fetch(base + '/private', { method: 'POST', body: new URLSearchParams({ x: '1' }), signal: AbortSignal.timeout(3000) });
    assert.equal(next.status, 401);
    await next.text();
    child.send('close');
    const result = await exited;
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    assert.doesNotMatch(stderr, /Unhandled 'error' event|Z_DATA_ERROR/);
  });
}
