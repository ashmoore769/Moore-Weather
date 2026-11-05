'use strict';
const http = require('node:http');
const https = require('node:https');

// A socket inactivity timer alone cannot finish an already-aborted response.
// Settle every stream termination path and also impose a whole-request deadline.
function fetchOriginBuffer(target, { token = '', agent, timeoutMs = 10000, maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const chunks = []; let bytes = 0;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) { response?.destroy(); request?.destroy(); reject(error); }
      else resolve(result);
    };
    const deadline = setTimeout(() => finish(Error('SkyCam origin request exceeded its time limit')), timeoutMs);
    const headers = { Accept: '*/*', 'User-Agent': 'Moore-Weather-Render/3' };
    if (token) headers['X-SkyCam-Origin-Token'] = token;
    try {
      request = (target.protocol === 'https:' ? https : http).request(target, { method: 'GET', headers, agent }, upstream => {
        response = upstream;
        upstream.on('error', () => finish(Error('SkyCam origin response interrupted')));
        upstream.on('aborted', () => finish(Error('SkyCam origin response interrupted')));
        upstream.on('close', () => { if (!upstream.complete) finish(Error('SkyCam origin response ended early')); });
        if (upstream.statusCode !== 200) return finish(Error('SkyCam origin returned HTTP ' + upstream.statusCode));
        const declared = Number(upstream.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) return finish(Error('SkyCam origin response exceeded its byte limit'));
        upstream.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(Error('SkyCam origin response exceeded its byte limit'));
          chunks.push(chunk);
        });
        upstream.on('end', () => {
          if (!upstream.complete) return finish(Error('SkyCam origin response ended early'));
          finish(null, { buffer: Buffer.concat(chunks), headers: upstream.headers });
        });
      });
      request.on('error', () => finish(Error('SkyCam origin connection failed')));
      request.setTimeout(timeoutMs, () => finish(Error('SkyCam origin socket timed out')));
      request.end();
    } catch (error) { finish(error); }
  });
}
module.exports = { fetchOriginBuffer };
