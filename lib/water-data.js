'use strict';
const HOUR = 3600000, DAY = 24 * HOUR, OFFSET = 10 * HOUR;
const DAM = '422315B', RIVER = '422310C';
const METRICS = Object.fromEntries([
  ['leslie-storage', 'Leslie Dam — storage', '%', 2, 'storage', ['hourly', 'daily'], '1986-01-01'],
  ['connolly-storage', 'Connolly Dam - storage', '%', 1, 'storage', ['daily'], '2000-01-01'],
  ['connolly-volume', 'Connolly Dam - stored water', 'ML', 0, 'stored water', ['daily'], '2000-01-01'],
  ['leslie-volume', 'Leslie Dam — stored water', 'ML', 0, 'stored water', ['hourly', 'daily'], '1986-01-01'],
  ['condamine-warwick-level', 'Condamine River at Warwick — town gauge', 'm', 2, 'river level', ['hourly', 'daily'], '2026-10-12'],
  ['condamine-level', 'Condamine River at Scots College — level', 'm', 3, 'river level', ['hourly', 'daily'], '1960-10-01'],
  ['condamine-flow', 'Condamine River at Scots College — flow', 'm³/s', 3, 'river flow', ['hourly', 'daily'], '1960-10-01']
].map(([id, label, unit, precision, noun, resolutions, earliest]) => [id, {
  id, label, unit, precision, noun, resolutions, earliest, kind: 'line', aggregation: 'CURRENT', water: true,
  maxHours: 24 * 366 * 150, dailyOffset: 14 * HOUR
}]));
for (const id of ['connolly-storage', 'connolly-volume']) Object.assign(METRICS[id], { reporting: 'published', dateOnly: true });
// Published Warwick gauge reference. This is not an O. O. Madsen threshold.
METRICS['condamine-warwick-level'].bridge = { name: 'McCahon Bridge', level: 7 };
METRICS['condamine-warwick-level'].referenceLines = [
  { value: 5, label: 'Minor flood', color: '#50a68c' },
  { value: 6, label: 'Moderate flood', color: '#dba64e' },
  { value: 7, label: 'Major / McCahon Bridge', color: '#df808b' }
];
function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function hydstraTime(value) {
  const s = String(value);
  if (!/^\d{14}$/.test(s)) throw new Error('Invalid WMIP timestamp');
  const wall = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  const t = Date.parse(wall + 'Z');
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 19) !== wall) throw new Error('Invalid WMIP calendar date');
  return t - OFFSET;
}
const hydstraStamp = t => new Date(t + OFFSET).toISOString().slice(0, 19).replace(/[-:T]/g, '');
function sunTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('Missing Sunwater timezone');
  const wall = value.slice(0, 19), calendar = Date.parse(wall + 'Z');
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== wall) throw new Error('Invalid Sunwater calendar date');
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error('Invalid Sunwater timestamp');
  return t;
}
function sample(metric, t, value, raw, extra = {}) {
  if (!Number.isFinite(t) || t < Date.UTC(1900, 0, 1) || t > Date.now() + DAY * 2) throw new Error('Water timestamp out of range');
  return { metric, t, value, min: value, max: value, stream: 'point', quality: null, qualityText: 'Unverified automated data',
    priority: 1, raw: JSON.stringify(raw), ...extra };
}
function damCurrent(data) {
  if (data.station !== DAM) throw new Error('Unexpected Sunwater station');
  const t = sunTime(data.date);
  return [['leslie-storage', data.percentageFull], ['leslie-volume', data.megaLitres]].map(([id, value]) =>
    sample(id, t, numeric(value), data));
}
function damDaily(data) {
  if (!Array.isArray(data.value) || data.value.length > 10000) throw new Error('Invalid Sunwater daily page');
  return data.value.map(row => {
    if (row.station !== DAM) throw new Error('Unexpected Sunwater daily station');
    const min = numeric(row.minPercentageFull), max = numeric(row.maxPercentageFull);
    if (min !== null && max !== null && min > max) throw new Error('Inverted Sunwater daily range');
    // The provider's average field is a zero placeholder, not a measured mean.
    return sample('leslie-storage', sunTime(row.date) + DAY, max, row, { stream: 'daily', min, max });
  });
}
function riverTrace(data, metric) {
  if (data.error_num !== 0 || !Array.isArray(data.return?.traces)) throw new Error('WMIP: ' + (data.error_msg || 'Invalid trace response'));
  const variable = metric === 'condamine-level' ? '100.00' : '140.00';
  if (data.return.traces.length !== 1) throw new Error('Unexpected WMIP trace count');
  const trace = data.return.traces[0];
  if (trace.error_num !== 0 || trace.site !== RIVER || trace.varto_details?.variable !== variable ||
      Number(trace.site_details?.timezone) !== 10 || !Array.isArray(trace.trace) || Number(trace.compressed) !== 0) throw new Error('Unexpected WMIP trace identity or format');
  return trace.trace.map(row => {
    const q = numeric(row.q), original = numeric(row.v);
    // Retain excluded values in raw JSON. Missing, unreported or unusable QC
    // codes must never turn into a plausible level or a zero-flow observation.
    const value = q === null || q === 39 || q >= 151 ? null : original;
    return sample(metric, hydstraTime(row.t), value, row, { quality: q,
      qualityText: trace.quality_codes?.[q] || (q === 130 ? 'Unvalidated' : 'Source quality ' + q), priority: 2 });
  });
}
function riverExtent(data) {
  if (data.error_num !== 0 || !Array.isArray(data.return?.blocks)) throw new Error('Invalid WMIP availability response');
  const blocks = data.return.blocks.filter(b => b.site === RIVER && b.variable === '100.00');
  if (!blocks.length) throw new Error('WMIP did not publish the river archive extent');
  return Math.min(...blocks.map(b => hydstraTime(b.starttime)));
}
module.exports = { HOUR, DAY, OFFSET, DAM, RIVER, METRICS, numeric, hydstraTime, hydstraStamp, damCurrent, damDaily, riverTrace, riverExtent };
