'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { HistoryReader } = require('./weather-history');
const db = new DatabaseSync(workerData.filename, { readOnly: true, timeout: 2000 });
db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192;');
const reader = new HistoryReader(db);
parentPort.on('message', ({ id, request }) => {
  try { parentPort.postMessage({ id, result: reader.query(request) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message, status: error.status }); }
});
