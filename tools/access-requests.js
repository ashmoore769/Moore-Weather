'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

// Owner-only Render Shell utility. No HTTP endpoint, network calls, pruning,
// sending, schema changes or imports of server.js.
function readRequests(env = process.env, summary = false) {
  const filename = env.ACCESS_REQUEST_DB_PATH || (env.WEATHER_DB_PATH
    ? path.join(path.dirname(env.WEATHER_DB_PATH), 'access-requests.sqlite') : '');
  if (!filename) throw Error('No access-request database path is configured.');
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 1000 });
  try {
    if (summary) return db.prepare("SELECT state,last_failure,COUNT(*) AS count FROM access_request_queue GROUP BY state,last_failure").all();
    return db.prepare(`SELECT id,name,email,created_at,expires_at,state,attempts,last_failure
      FROM access_request_queue WHERE state!='sent' ORDER BY created_at`).all().map(row => ({
        ...row, created_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString()
      }));
  } finally { db.close(); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['list', 'summary'].includes(args[0])) {
    console.error('Usage: node tools/access-requests.js summary|list'); process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(readRequests(process.env, args[0] === 'summary'), null, 2)); }
    catch { console.error('Could not read the access-request queue. Check its configured path and file permissions. Nothing was changed.'); process.exitCode = 1; }
  }
}
module.exports = { readRequests };
