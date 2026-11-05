'use strict';
const { setTimeout: delay } = require('node:timers/promises');

async function monitor() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://moore-weather.onrender.com/health/monitor', {
        signal: AbortSignal.timeout(15000), redirect: 'error', headers: { 'Cache-Control': 'no-cache' }
      });
      if (!response.ok || (await response.json()).status !== 'ok') throw new Error('App or collection health is degraded (HTTP ' + response.status + ')');
      console.log('Moore Weather is reachable and current collection, storage and recovery checks are healthy.');
      return;
    } catch (error) {
      console.log('Health attempt ' + attempt + ': ' + error.message);
      if (attempt === 3) throw new Error('Moore Weather failed its independent health check. Inspect Render and the authenticated app status.');
      await delay(30000);
    }
  }
}
if (require.main === module) monitor().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { monitor };
