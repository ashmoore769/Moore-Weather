'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSummary, format, direction, expectedReportingDate } = require('../public/daily-summary');
const record = (date = '2026/10/11', values = Array.from({length:41}, (_,i) => i + .25)) => [date,'09:00:00',...values].join(',');

test('daily reporting period crosses years and leap days independently of visitor timezone', () => {
  assert.equal(parseSummary(record('2026/01/01')).reportingDate, '2025-12-31');
  assert.equal(parseSummary(record('2024/03/01')).reportingDate, '2024-02-29');
  assert.equal(parseSummary(record()).end - parseSummary(record()).start, 86400000);
  assert.throws(() => parseSummary(record('2026/02/30')), /invalid date/);
  assert.throws(() => parseSummary(record().replace('09:00:00','08:00:00')), /reporting time/);
  assert.throws(() => parseSummary('2026/10/11,09:00:00,1'), /incomplete/);
});
test('daily presentation preserves all soil channels, missing readings and station pressure', () => {
  const values = Array(41).fill('');
  values[15] = '-1.8'; values[37] = '1007.6'; values[34] = '1026.4';
  values[23] = '18.1'; values[26] = '19.3'; values[27] = '25.6'; values[30] = '38.5';
  values[13] = 'NaN'; values[14] = '0';
  const data = parseSummary(record('2026/10/11',values));
  assert.equal(data.values[15],0); assert.equal(data.values[37],1007.6);
  assert.equal(data.values[34],1026.4);
  assert.deepEqual([23,26,27,30].map(i=>data.values[i]), [18.1,19.3,25.6,38.5]);
  assert.equal(format(data.values[13]),'—'); assert.equal(format(data.values[14]),'0.0');
  assert.equal(data.values[0],null); assert.equal(values[15],'-1.8');
  assert.equal(direction(360),'N'); assert.equal(direction(316.8),'NW'); assert.equal(direction(null),'—');
});
test('latest completed daily record changes at 9 AM AEST, not at midnight', () => {
  for (const now of ['2026-10-11T13:59:00Z','2026-10-11T14:01:00Z','2026-10-11T22:59:59Z']) assert.equal(expectedReportingDate(Date.parse(now)),'2026-10-10');
  assert.equal(expectedReportingDate(Date.parse('2026-10-11T23:00:00Z')),'2026-10-11');
});
