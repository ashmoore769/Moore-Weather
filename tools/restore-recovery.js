'use strict';
const { restoreRecoveryBundle } = require('../lib/recovery-backup');
const [filename, directory] = process.argv.slice(2);
if (!filename || !directory) {
  console.error('Usage: node tools/restore-recovery.js BUNDLE.mwb NEW_OUTPUT_DIRECTORY (key from WEATHER_BACKUP_ENCRYPTION_KEY or MOORE_AUTH_COOKIE_SECRET)');
  process.exitCode = 1;
} else {
  restoreRecoveryBundle(filename, directory).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
