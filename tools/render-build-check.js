'use strict';
// Render's automatic Git deploys must pass the same offline checks as CI before
// a new build can replace the running release. Local installs remain quick.
if (process.env.RENDER === 'true') {
  const { spawnSync } = require('node:child_process');
  const { readdirSync } = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const tests = readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js')).sort().map(name => path.join('test', name));
  for (const args of [['tools/check.js'], ['--test', ...tests]]) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.error) { console.error(result.error.message); process.exit(1); }
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
