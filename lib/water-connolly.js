'use strict';
const { DAY, OFFSET } = require('./water-data');
const CONNOLLY_URL = 'https://www.sdrc.qld.gov.au/living-here/environment-water-waste/dam-levels';
function plain(value) {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }).replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, name) => ({ nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name.toLowerCase()])
    .replace(/\s+/g, ' ').trim();
}
function tableGrid(html) {
  const grid = [], rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rows.length > 100) throw new Error('Council table has too many rows');
  rows.forEach((row, r) => {
    grid[r] ||= [];
    let c = 0;
    for (const cell of row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      while (grid[r][c] !== undefined) c++;
      const span = name => Number(cell[1].match(new RegExp(name + '\\s*=\\s*["\\x27]?(\\d+)', 'i'))?.[1] || 1);
      const across = span('colspan'), down = span('rowspan');
      if (across < 1 || down < 1 || across > 10 || down > 10 || c + across > 20) throw new Error('Unexpected council table layout');
      const value = plain(cell[2]);
      for (let i = r; i < r + down; i++) {
        grid[i] ||= [];
        for (let j = c; j < c + across; j++) grid[i][j] = value;
      }
      c += across;
    }
  });
  return grid;
}
function number(text, percent = false) {
  const value = String(text ?? '').trim();
  const pattern = percent ? /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?\s*%?$/ : /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
  if (!pattern.test(value)) throw new Error('Missing or invalid Connolly storage figure');
  return Number(value.replace(/[,%\s]/g, ''));
}
function connollyReport(html, now = Date.now()) {
  if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) throw new Error('Invalid council page');
  const candidates = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].filter(m => /Connolly/i.test(m[0]) && /Capacity\s*Full/i.test(plain(m[0])));
  if (candidates.length !== 1) throw new Error('Council storage table is missing or ambiguous');
  const match = candidates[0], grid = tableGrid(match[0]);
  const header = grid.find(row => row.some(cell => /^Connolly Dam$/i.test(cell)));
  const column = header?.findIndex(cell => /^Connolly Dam$/i.test(cell));
  if (column === undefined || column < 1) throw new Error('Connolly Dam column not found');
  const field = label => {
    const rows = grid.filter(row => label.test(row[0]));
    if (rows.length !== 1 || rows[0][column] === undefined) throw new Error('Council storage row is missing or ambiguous');
    return rows[0][column];
  };
  const percentageFull = number(field(/^Capacity Full\s*\(%\)$/i), true);
  const megaLitres = number(field(/^Current Volume\s*\(ML\)$/i));
  const totalCapacityMegaLitres = number(field(/^Maximum Capacity\s*\(ML\)$/i));
  if (percentageFull < 0 || percentageFull > 200 || megaLitres < 0 || totalCapacityMegaLitres <= 0 ||
      Math.abs(megaLitres / totalCapacityMegaLitres * 100 - percentageFull) > .25) throw new Error('Inconsistent Connolly storage figures');
  // Use the table's publication date, never the time this page was fetched.
  const date = plain(html.slice(match.index + match[0].length, match.index + match[0].length + 6000))
    .match(/Last Updated\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!date) throw new Error('Council report date not found');
  const reportDate = date[3] + '-' + date[2].padStart(2, '0') + '-' + date[1].padStart(2, '0');
  const calendar = Date.parse(reportDate + 'T00:00:00Z'), t = calendar - OFFSET;
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== reportDate ||
      calendar < Date.UTC(2000, 0, 1) || t > Math.floor((now + OFFSET) / DAY) * DAY - OFFSET) throw new Error('Invalid council report date');
  const raw = JSON.stringify({ source: CONNOLLY_URL, reportDate, percentageFull, megaLitres, totalCapacityMegaLitres, table: match[0] });
  return { reportDate, rows: [['connolly-storage', percentageFull], ['connolly-volume', megaLitres]].map(([metric, value]) => ({
    metric, t, value, min: value, max: value, stream: 'point', quality: null,
    qualityText: 'Council-published storage report; date only', priority: 1, raw
  })) };
}
module.exports = { CONNOLLY_URL, connollyReport };
