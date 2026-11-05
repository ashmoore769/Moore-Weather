'use strict';
const { createRecoveryBundle, cleanupRecoveryWork } = require('../lib/recovery-backup');
process.on('exit', () => {
  if (process.env.WEATHER_BACKUP_DIR) {
    try { cleanupRecoveryWork(process.env.WEATHER_BACKUP_DIR, { pid: process.pid, ownerExiting: true }); }
    catch (error) { console.error('Recovery scratch cleanup: ' + error.message); }
  }
});
process.once('SIGTERM', () => process.exit(143));
process.once('SIGINT', () => process.exit(130));
createRecoveryBundle({ checkpoint: process.argv.includes('--checkpoint') }).then(result => {
  console.log(JSON.stringify(result));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
