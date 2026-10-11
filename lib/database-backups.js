'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

function createBackupScheduler(env, persistence, logger) {
  const state = { enabled: Boolean(env.WEATHER_DB_PATH && env.WEATHER_BACKUP_DIR), running: false, lastSuccess: null, file: null, error: null };
  return {
    status: () => ({ ...state }),
    run() {
      if (!state.enabled || state.running || !persistence.status().ready) return;
      if (env.RENDER === 'true' && !path.resolve(env.WEATHER_BACKUP_DIR).startsWith('/var/data/')) {
        state.error = 'Backup directory must be on the persistent disk';
        return;
      }
      state.running = true;
      const child = spawn(process.execPath, [path.join(__dirname, '../tools/backup-weather-database.js'), env.WEATHER_DB_PATH, env.WEATHER_BACKUP_DIR], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '', errors = '';
      child.stdout.on('data', b => { output = (output + b).slice(-4096); });
      child.stderr.on('data', b => { errors = (errors + b).slice(-4096); });
      child.on('error', error => { state.error = error.message; state.running = false; });
      child.on('close', code => {
        state.running = false;
        try {
          if (code !== 0) throw new Error(errors || 'Backup process failed');
          const result = JSON.parse(output);
          state.file = result.file;
          state.lastSuccess = new Date().toISOString();
          state.error = null;
          logger.info('[DATABASE] Verified backup available: ' + result.file);
        } catch (error) { state.error = error.message; logger.error('[DATABASE] Backup: ' + error.message); }
      });
    }
  };
}
module.exports = { createBackupScheduler };
