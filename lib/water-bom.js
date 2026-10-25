'use strict';
const { DAY, OFFSET, numeric, METRICS } = require('./water-data');
const STATION = '041534', METRIC = 'condamine-warwick-level';
const URL = `https://www.bom.gov.au/fwo/IDQ65396/IDQ65396.${STATION}.tbl.shtml`;
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();

// This official public table exposes a rolling 14-day window, not a historic API.
// Validate identity, units, timezone and every row before committing any records.
function bomRiver(html, now = Date.now()) {
  if (typeof html !== 'string') throw new Error('Invalid BOM response');
  const details = plain(html.match(/<p\b[^>]*class=["']stationdetails["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || '');
  if (!new RegExp(`Station Number: ${STATION}\\b`).test(details) || !details.includes('Condamine River at Warwick')) throw new Error('Unexpected BOM station');
  for (const [name, value] of [['Minor', 5], ['Moderate', 6], ['Major', 7], ['Bridge', 7]]) {
    const level = details.match(new RegExp(`${name}:\\s*([\\d.]+)\\s*m\\b`));
    if (!level || Number(level[1]) !== value) throw new Error('BOM reference levels changed; review chart thresholds');
  }
  const issued = plain(html).match(/Issued at\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+AEST\s+\w+\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (!issued) throw new Error('Missing BOM AEST issue time');
  const month = ['January','February','March','April','May','June','July','August','September','October','November','December'].findIndex(m => m.toLowerCase() === issued[5].toLowerCase());
  const issueTime = Date.UTC(+issued[6], month, +issued[4], +issued[1] % 12 + (issued[3].toUpperCase() === 'PM' ? 12 : 0), +issued[2]) - OFFSET;
  if (month < 0 || +issued[1] < 1 || +issued[1] > 12 || +issued[2] > 59 || new Date(issueTime + OFFSET).getUTCDate() !== +issued[4] || issueTime > now + 5 * 60000 || issueTime < now - 2 * DAY) throw new Error('Invalid or stale BOM issue time');
  const table = html.match(/<table\b[^>]*id=["']tableStyle1["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table || !/Water\s+Level\s*\(m\)/i.test(plain(table))) throw new Error('Missing BOM water level table');
  const records = new Map();
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => plain(m[1]));
    if (!cells.length && /<th\b/i.test(match[1])) continue;
    if (cells.length !== 2) throw new Error('Unexpected BOM observation columns');
    const date = cells[0].match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
    if (!date) throw new Error('Invalid BOM observation timestamp');
    const [, day, mon, year, hour, minute] = date;
    const wall = `${year}-${mon}-${day}T${hour}:${minute}:00`, utc = Date.parse(wall + 'Z'), t = utc - OFFSET;
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0,19) !== wall || t > issueTime + 60000 || t < issueTime - 15 * DAY) throw new Error('BOM observation outside published window');
    const value = numeric(cells[1]);
    if (value === null && !/^(?:-|--|—|N\/A|NA|Missing|Not available)?$/i.test(cells[1])) throw new Error('Invalid BOM water level');
    // BOM can repeat a minute: the last published row wins without inventing seconds.
    records.set(t, { metric: METRIC, stream: 'point', t, value, min: value, max: value,
      quality: null, qualityText: 'BOM operational observation · unverified', priority: 2,
      raw: JSON.stringify({ station: STATION, source: URL, issuedAt: issueTime, dateTime: cells[0], waterLevel: cells[1] }) });
  }
  if (!records.size) throw new Error('BOM table contains no observations');
  return { rows: [...records.values()].sort((a,b) => a.t - b.t), issueTime, referenceLines: METRICS[METRIC].referenceLines };
}
module.exports = { bomRiver, BOM_URL: URL, BOM_METRIC: METRIC };
