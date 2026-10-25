'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { bomRiver, BOM_URL, BOM_METRIC } = require('../lib/water-bom');
const { WaterStore } = require('../lib/water-store');
const { WaterCollector } = require('../lib/water-collector');
const { WaterReader } = require('../lib/water-history');
const { createWaterClient, textRequest } = require('../lib/water-client');
const { METRICS, DAY, HOUR } = require('../lib/water-data');
const { normalizeRequest } = require('../lib/weather-history');
const chart = require('../public/history-chart');
const html = fs.readFileSync(__dirname + '/fixtures/bom-warwick.html', 'utf8');
const now = Date.parse('2026-10-26T08:00:00+10:00');

test('official BOM table imports all native minute observations with explicit AEST and station provenance', () => {
  const {rows, issueTime} = bomRiver(html, now);
  assert.ok(rows.length > 200);
  assert.equal(issueTime, Date.parse('2026-10-26T07:38:00+10:00'));
  assert.equal(rows[0].t, Date.parse('2026-10-12T08:03:00+10:00'));
  assert.equal(rows[0].value, .19);
  assert.equal(new Set(rows.map(r=>r.t)).size, rows.length);
  assert.ok(rows.every(r=>r.metric===BOM_METRIC&&r.min===r.value&&r.max===r.value));
  assert.equal(JSON.parse(rows[0].raw).station, '041534');
  assert.equal(JSON.parse(rows[0].raw).source, BOM_URL);
});

test('BOM identity, units, dates, threshold changes and error pages fail without importing misleading data', () => {
  for (const bad of [html.replace('Station Number:</b> 041534','Station Number:</b> 041503'),
    html.replace('Level\u00a0(m)', 'Level\u00a0(ft)'), html.replace('Minor:</b> 5.00', 'Minor:</b> 4.00'),
    html.replace('12/10/2026 08:03', '31/02/2026 08:03'), html.replace('12/10/2026 08:03','27/10/2026 08:03'),
    html.replace('AEST','UTC'), html.replace('>0.19</td>','>error</td>'), '<html>Service unavailable</html>']) {
    assert.throws(()=>bomRiver(bad,now));
  }
  assert.throws(()=>bomRiver(html,now+3*DAY),/stale/);
});

test('missing BOM values remain null; source corrections replace the same timestamp only', t => {
  const store = new WaterStore(':memory:'); t.after(()=>store.close());
  const rows=bomRiver(html,now).rows, first=rows[0];
  store.save(rows); store.save(rows);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM water_samples').get().n,rows.length);
  const missing=bomRiver(html.replace('>0.19</td>','>--</td>'),now).rows;
  store.save(missing);
  assert.equal(store.db.prepare('SELECT value FROM water_samples WHERE observed_at=?').get(first.t).value,null);
  store.save(bomRiver(html.replace('>0.19</td>','>0.21</td>'),now).rows);
  assert.equal(store.db.prepare('SELECT value FROM water_samples WHERE observed_at=?').get(first.t).value,.21);
});

test('new gauge checkpoints restart safely, retry failed fetches, retain old Scots College history and accumulate past rolling window', async t => {
  const store = new WaterStore(':memory:');t.after(()=>store.close());
  const row=bomRiver(html,now).rows[0];
  store.save([{...row,metric:'condamine-level',value:1.668,min:1.668,max:1.668},
    {...row,metric:'condamine-flow',value:37,min:37,max:37}, {...row,t:row.t-30*DAY}]);
  let fail=false,calls=0;
  const client={warwick:async()=>{calls++;if(fail)throw new Error('BOM HTTP 503');return html;}};
  let collector=new WaterCollector(store,client);
  for(const job of collector.jobs())if(job!=='condamine-warwick-live')store.setState(job,{complete:true});
  assert.equal((await collector.step(now)).error,null);
  assert.equal(store.state('condamine-warwick-live').due,now+600000);
  assert.equal(store.state('condamine-warwick-live').archiveComplete,true);
  assert.equal(await collector.step(now+30000),null);
  fail=true;await collector.step(now+600000);
  assert.match(store.state('condamine-warwick-live').error,/503/);
  assert.equal(new WaterReader(store.db).snapshot().readings[BOM_METRIC].value,bomRiver(html,now).rows.at(-1).value);
  fail=false;collector=new WaterCollector(store,client);await collector.step(now+HOUR);
  assert.equal(store.state('condamine-warwick-live').error,null);assert.equal(calls,3);
  assert.equal(store.db.prepare("SELECT value FROM water_samples WHERE metric='condamine-level'").get().value,1.668);
  assert.equal(store.db.prepare("SELECT value FROM water_samples WHERE metric='condamine-flow'").get().value,37);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM water_samples WHERE metric=? AND observed_at=?').get(BOM_METRIC,row.t-30*DAY).n,1);
  const reader=new WaterReader(store.db),cat=reader.catalog(now);
  assert.ok(cat.find(m=>m.id===BOM_METRIC).coverage.hourly);
  assert.equal(cat.find(m=>m.id==='condamine-level').referenceLines,undefined);
  assert.match(cat.find(m=>m.id==='condamine-flow').label,/Scots College/);
  const result=reader.series(normalizeRequest({metric:BOM_METRIC,resolution:'hourly',hours:'168',end:new Date(now).toISOString()},false,now));
  assert.deepEqual(result.metric.referenceLines.map(r=>r.value),[5,6,7]);
  assert.ok(result.extrema.max.t);assert.match(result.note,/not O. O. Madsen/);
  assert.equal(reader.snapshot().series[1].metric.id,BOM_METRIC);
});

test('flood chart always includes fixed thresholds; flow and sparklines retain their natural scale', () => {
  const series={metric:METRICS[BOM_METRIC],points:[{value:1.2,min:1,max:1.3}]};
  assert.equal(chart.domain(series)[0],0);assert.ok(chart.domain(series)[1]>7);
  assert.ok(chart.domain(series,false)[1]<2);
  assert.ok(chart.domain({...series,metric:METRICS['condamine-flow']})[1]<2);
  assert.ok(chart.domain({...series,points:[{value:9,min:8,max:10}]})[1]>10);
  assert.ok(chart.domain({...series,points:[]})[1]>7);
});

test('BOM is fetched centrally from its fixed public table; errors and oversized responses are rejected', async()=>{
  let url;
  const client=createWaterClient(undefined,async u=>{url=u;return html;});
  assert.equal(await client.warwick(),html);assert.equal(url,BOM_URL);
  await assert.rejects(textRequest(BOM_URL,async()=>({ok:false,status:503})),/503/);
  await assert.rejects(textRequest(BOM_URL,async()=>({ok:true,body:[Buffer.alloc(2*1024*1024+1)]})),/limit/);
});
