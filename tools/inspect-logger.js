// Read-only, bounded inspection. Run manually; do not schedule beside the app.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const allowed = ['GETSERIAL', 'GETTITLE', 'VER', 'LISTALL', 'LISTSENSOR', 'LISTSTORAGE', 'r3',
  'MEM 1 LAST', 'MEM 2 LAST', 'MEM 3 LAST', 'MEM 4 LAST'];
const commands = process.argv.length > 2 ? process.argv.slice(2) : allowed;
if (commands.some(command => !allowed.includes(command))) throw new Error('Only allowlisted read commands are permitted.');
const output = path.resolve(__dirname, '../data/logger-inspection', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });

function read(command) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let raw = '', finished = false, idle;
    const deadline = setTimeout(() => finish('deadline'), command.startsWith('LIST') ? 45000 : 12000);
    function finish(status) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(idle);
      socket.destroy();
      resolve({ command, status, raw, receivedAt: new Date().toISOString() });
    }
    socket.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (raw.length > 262144) return finish('size-limit');
      clearTimeout(idle);
      if (/\\?END\s+OF\s+DATA/i.test(raw)) return finish('complete');
      idle = setTimeout(() => finish('idle'), 2000);
    });
    socket.on('error', error => finish(error.code || 'socket-error'));
    socket.on('close', () => finish('closed'));
    socket.connect(Number(process.env.WEATHER_STATION_PORT || 8899),
      process.env.WEATHER_STATION_HOST || 'myweather.ddns.net', () => socket.write(command + '\r\n'));
  });
}

(async () => {
  const results = [];
  for (const command of commands) {
    const result = await read(command);
    results.push(result);
    fs.writeFileSync(path.join(output, command.replaceAll(' ', '-').toLowerCase() + '.txt'), result.raw);
    console.log(`${command}: ${result.status}, ${result.raw.length} bytes`);
    if (!result.raw || ['deadline', 'size-limit'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fs.writeFileSync(path.join(output, 'inspection.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`Saved inspection to ${output}`);
  if (results.length !== commands.length || results.some(r => !r.raw)) process.exitCode = 1;
})();
