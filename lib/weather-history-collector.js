'use strict';
const net = require('node:net');

// LAST b is documented in the DL3000 memory command: b is kilobytes,
// rounded to complete records. Never issue ALL or an unbounded date search.
const FEEDS = [
  { stream: 'mem3', minutes: 10, kilobytes: 8 },
  { stream: 'mem2', minutes: 60, kilobytes: 8 },
  { stream: 'mem4', minutes: 5, kilobytes: 8 },
  { stream: 'mem1', minutes: 360, kilobytes: 4 },
];

function readRecent({ host, port, stream, kilobytes, timeoutMs = 20000, maxBytes = 32768 }) {
  if (!/^mem[1-4]$/.test(stream) || ![4, 8].includes(kilobytes)) throw new Error('Invalid bounded memory command');
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let response = '';
    let bytes = 0;
    let ended = false;
    const finish = error => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve(response);
    };
    const deadline = setTimeout(() => finish(new Error('Bounded memory read exceeded time limit')), timeoutMs);
    socket.setTimeout(Math.min(timeoutMs, 10000));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) return finish(new Error('Bounded memory reply exceeded byte limit'));
      response += chunk.toString('utf8');
      if (/(?:^|\r?\n)\s*\\?END OF DATA(?:\r?\n|$)/i.test(response)) finish();
    });
    socket.on('error', finish);
    socket.on('timeout', () => finish(new Error('Incomplete memory reply: no completion marker')));
    socket.on('close', () => { if (!ended) finish(new Error('Memory connection closed before completion')); });
    socket.connect(port, host, () => socket.write(`MEM ${stream.slice(3)} LAST ${kilobytes}\r\n`));
  });
}

function createHistoryCollector({ enabled, persistence, runTransaction, host, port, logger, read = readRecent, now = Date.now }) {
  let running = false;
  let stopped = false;
  const nextDue = new Map();
  const state = { enabled: Boolean(enabled), active: null, feeds: {} };
  for (const feed of FEEDS) state.feeds[feed.stream] = { lastSuccess: null, error: null, warning: null };
  return {
    status: () => structuredClone(state),
    stop() { stopped = true; },
    async tick() {
      if (!state.enabled || stopped || running || !persistence.status().ready) return;
      const feed = FEEDS.find(f => (nextDue.get(f.stream) || 0) <= now());
      if (!feed) return;
      running = true;
      state.active = feed.stream;
      // One request per scheduler tick. No tight-loop retries on EW10 failures.
      nextDue.set(feed.stream, now() + feed.minutes * 60000);
      try {
        const response = await runTransaction(`HISTORY ${feed.stream} LAST ${feed.kilobytes}`, () => read({ host, port, ...feed }));
        if (stopped) return;
        const result = persistence.recordHistory(feed.stream, response);
        const s = state.feeds[feed.stream];
        s.lastSuccess = new Date(now()).toISOString();
        s.error = null;
        s.warning = result.warning;
        logger.info(`[HISTORY] ${feed.stream}: ${result.inserted} new records, ${result.linked} received${result.warning ? '; ' + result.warning : ''}`);
      } catch (error) {
        state.feeds[feed.stream].error = error.message;
        logger.error(`[HISTORY] ${feed.stream}: ${error.message}`);
      } finally { running = false; state.active = null; }
    }
  };
}

module.exports = { FEEDS, readRecent, createHistoryCollector };
