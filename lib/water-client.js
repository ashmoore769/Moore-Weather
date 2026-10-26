'use strict';
const { DAM, RIVER, hydstraStamp } = require('./water-data');
const SUNWATER = 'https://data.sunwater.com.au/api/StorageCapacity';
const WMIP = 'https://water-monitoring.information.qld.gov.au/cgi/webservice.exe?';
const { BOM_URL } = require('./water-bom');
const { CONNOLLY_URL } = require('./water-connolly');
async function textRequest(url, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(45000), headers: { Accept: 'text/html', 'User-Agent': 'Moore-Weather/1.0 (local water dashboard)' } });
  if (!response.ok) throw new Error('Water provider HTTP ' + response.status);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Water provider page exceeds response limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function jsonRequest(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(45000), headers: {
    Accept: 'application/json', 'User-Agent': 'Moore-Weather/1.0 (local water dashboard)', ...options.headers
  } });
  if (!response.ok) throw new Error('Water provider HTTP ' + response.status);
  const limit = 24 * 1024 * 1024;
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Water response exceeds batch limit'), { code: 'BATCH_SIZE' });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function createWaterClient(request = jsonRequest, requestText = textRequest) {
  const wmip = (fn, params) => request(WMIP + encodeURIComponent(JSON.stringify({ function: fn, version: '2', params })));
  return {
    warwick: () => requestText(BOM_URL),
    connolly: () => requestText(CONNOLLY_URL),
    current: () => request(`${SUNWATER}/${DAM}/current`),
    daily: (start, end, token) => request(SUNWATER + '/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stations: [DAM], startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), continuationToken: token || null }) }),
    extent: () => wmip('get_ts_blockinfo', { site_list: RIVER, datasources: ['A', 'TE'], variables: ['100.00', '140.00'], starttime: '19000101000000', endtime: '21000101000000', auditinfo: 0 }),
    trace: (metric, start, end) => {
      const level = metric === 'condamine-level', variable = level ? '100.00' : '140.00';
      return wmip('get_ts_traces', { site_list: RIVER, datasource: level ? 'AT' : 'ATQ', varfrom: variable, varto: variable,
        start_time: hydstraStamp(start), end_time: hydstraStamp(end), data_type: 'point', interval: 'day', multiplier: '1' });
    }
  };
}
module.exports = { createWaterClient, jsonRequest, textRequest };
