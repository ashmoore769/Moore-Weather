'use strict';
const http = require('node:http');
const https = require('node:https');

// Check the JPEG envelope and bounded header structure before an image can be
// cached as immutable. This rejects empty/wrong/truncated uploads; it is not a
// full decoder and cannot certify every entropy-coded pixel in the scan.
function assertJpegBuffer(buffer) {
  const invalid = () => Error('SkyCam origin returned an invalid or incomplete JPEG image');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw Error('SkyCam origin returned an empty image');
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8 ||
      buffer.readUInt16BE(buffer.length - 2) !== 0xffd9) throw invalid();
  let offset = 2, hasFrame = false;
  for (let segments = 0; segments < 1024 && offset < buffer.length - 2; segments++) {
    if (buffer[offset++] !== 0xff) throw invalid();
    while (offset < buffer.length - 2 && buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (!marker || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) throw invalid();
    if (marker === 0x01) continue; // Standalone TEM marker.
    if (offset + 2 > buffer.length - 2) throw invalid();
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length - 2) throw invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || !buffer.readUInt16BE(offset + 3) || !buffer.readUInt16BE(offset + 5)) throw invalid();
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (!hasFrame || length < 6 || offset + length >= buffer.length - 2) throw invalid();
      return;
    }
    offset += length;
  }
  throw invalid();
}

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
module.exports = { fetchOriginBuffer, assertJpegBuffer };
