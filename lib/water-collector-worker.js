'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { WaterStore } = require('./water-store');
const { WaterCollector } = require('./water-collector');
const { createWaterClient } = require('./water-client');
const store = new WaterStore(workerData.filename);
const collector = new WaterCollector(store, createWaterClient());
let stopped = false, timer;
async function tick() {
  try {
    const disk = fs.statfsSync(path.dirname(workerData.filename));
    if (disk.bavail * disk.bsize < 512 * 1024 * 1024) throw new Error('Water collection paused: less than 512 MiB free on the database disk');
    const result = await collector.step();
    parentPort.postMessage({ ready: true, ...result, checkedAt: new Date().toISOString() });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  if (!stopped) timer = setTimeout(tick, 30000);
  else store.close();
}
parentPort.on('message', () => { stopped = true; clearTimeout(timer); });
tick();
