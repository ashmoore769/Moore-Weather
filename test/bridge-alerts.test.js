'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StationAlerts,STALE_MS}=require('../lib/station-alerts');
const {MAX_AGE_MS,RETRY_MS}=require('../lib/bridge-alerts');
const {WaterReader}=require('../lib/water-history');
const {WaterStore}=require('../lib/water-store');
const {WeatherStore}=require('../lib/weather-store');
const {createHistoryApi}=require('../lib/weather-history-api');
const sub=(id='one')=>({endpoint:'https://web.push.apple.com/'+id,keys:{auth:Buffer.alloc(16,1).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,2)]).toString('base64url')}});
function setup(t,send) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moore-bridge-'));let now=Date.parse('2026-10-26T00:00:00Z');
  const sent=[],options={filename:path.join(dir,'alerts.sqlite'),now:()=>now,startupGraceMs:0,logger:{warn(){}},
    send:async(s,p,o)=>{const data=JSON.parse(p);if(send)await send(s,data,o);sent.push({endpoint:s.endpoint,payload:data,options:o});}};
  let alerts=new StationAlerts(options);
  t.after(()=>{alerts.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {get alerts(){return alerts;},sent,now:()=>now,advance:ms=>now+=ms,
    row:(value,overrides={})=>({metric:'condamine-warwick-level',value,t:now,checkedAt:now,...overrides}),
    restart(){alerts.close();alerts=new StationAlerts(options);}};
}
test('warning at exactly 0.50m below then a distinct bridge-crossing push; repeated observations and restarts stay quiet',async t=>{
  const f=setup(t);f.alerts.subscribe(sub());const key=f.alerts.vapid.publicKey;
  await f.alerts.bridge.tick(f.row(6.49));assert.equal(f.sent.length,0);
  f.advance(60000);await f.alerts.bridge.tick(f.row(6.5));assert.equal(f.sent.length,1);
  assert.match(f.sent[0].payload.body,/0.50m below the 7.00m McCahon Bridge reference/);
  assert.match(f.sent[0].payload.body,/AEST/);assert.equal(f.sent[0].options.urgency,'high');
  assert.equal(f.sent[0].payload.url,'/#localWater');
  f.restart();assert.equal(f.alerts.vapid.publicKey,key);
  await f.alerts.bridge.tick(f.row(6.5));assert.equal(f.sent.length,1);
  f.advance(60000);await f.alerts.bridge.tick(f.row(7));assert.equal(f.sent.length,2);
  assert.match(f.sent[1].payload.body,/7.00m — at the 7.00m/);
  assert.notEqual(f.sent[0].payload.tag,f.sent[1].payload.tag);
  assert.notEqual(f.sent[0].options.topic,f.sent[1].options.topic);
  f.restart();f.advance(60000);await f.alerts.bridge.tick(f.row(7.1));assert.equal(f.sent.length,2);
});
test('a direct jump above the bridge or a new device receives the stronger message only',async t=>{
  const f=setup(t);f.alerts.subscribe(sub());
  await f.alerts.bridge.tick(f.row(7.2));assert.equal(f.sent.length,1);
  assert.match(f.sent[0].payload.body,/0.20m above/);
  f.alerts.subscribe(sub('two'));await f.alerts.bridge.tick(f.row(7.2));
  assert.equal(f.sent.length,2);assert.ok(f.sent.every(s=>s.payload.title.includes('reached')));
});
test('fluctuations do not rearm until water is more than a metre below the reference',async t=>{
  const f=setup(t);f.alerts.subscribe(sub());await f.alerts.bridge.tick(f.row(6.6));
  for(const value of [6.4,6.51,7,6.9,7.1,6,6.5]){f.advance(60000);await f.alerts.bridge.tick(f.row(value));}
  assert.equal(f.sent.length,2);
  f.advance(60000);await f.alerts.bridge.tick(f.row(5.99));
  f.restart();f.advance(60000);await f.alerts.bridge.tick(f.row(6.5));assert.equal(f.sent.length,3);
  assert.notEqual(f.sent[0].payload.tag,f.sent[2].payload.tag);
});
test('stale, missing, future, wrong-gauge and failed-source observations do not alert or rearm',async t=>{
  const f=setup(t);f.alerts.subscribe(sub());
  for(const row of [null,f.row(null),f.row(NaN),f.row(8,{metric:'condamine-level'}),f.row(8,{t:f.now()+120000}),
    f.row(8,{t:f.now()-MAX_AGE_MS-1}),f.row(8,{checkedAt:f.now()-MAX_AGE_MS-1}),f.row(8,{checkedAt:NaN})]) {
    await f.alerts.bridge.tick(row);
  }
  assert.equal(f.sent.length,0);
  await f.alerts.bridge.tick(f.row(6.5));
  await f.alerts.bridge.tick(f.row(5.5)); // revised same timestamp cannot rearm
  await f.alerts.bridge.tick(f.row(5.5,{t:f.now()-60000})); // old table row
  f.advance(60000);await f.alerts.bridge.tick(f.row(6.6));assert.equal(f.sent.length,1);
});
test('failed warning retries persist across restart and do not postpone a more urgent crossing',async t=>{
  let fail=true,attempts=0;
  const f=setup(t,async()=>{attempts++;if(fail)throw Object.assign(Error('temporary'),{statusCode:503});});
  f.alerts.subscribe(sub());await f.alerts.bridge.tick(f.row(6.5));assert.equal(attempts,1);
  f.restart();await f.alerts.bridge.tick(f.row(6.5));assert.equal(attempts,1);
  fail=false;f.advance(60000);await f.alerts.bridge.tick(f.row(7.01));
  assert.equal(attempts,2);assert.equal(f.sent.length,1);assert.match(f.sent[0].payload.title,/reached/);
  f.advance(RETRY_MS);await f.alerts.bridge.tick(f.row(6.8));assert.equal(attempts,2);
});
test('retry uses current fresh level, stops after recession or stale data, and removes expired devices',async t=>{
  let fail=503,attempts=0;
  const f=setup(t,async()=>{attempts++;if(fail)throw Object.assign(Error('provider'),{statusCode:fail});});
  f.alerts.subscribe(sub());await f.alerts.bridge.tick(f.row(6.5));
  f.advance(RETRY_MS);await f.alerts.bridge.tick(f.row(6.2));assert.equal(attempts,1);
  f.advance(RETRY_MS);await f.alerts.bridge.tick(f.row(6.7,{t:f.now()-MAX_AGE_MS-1}));assert.equal(attempts,1);
  fail=0;f.advance(60000);await f.alerts.bridge.tick(f.row(6.7));assert.equal(attempts,2);
  assert.match(f.sent[0].payload.body,/0.30m below/);
  f.alerts.subscribe(sub('expired'));fail=410;await f.alerts.bridge.tick(f.row(6.7));
  assert.equal(f.alerts.db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n,1);
  f.alerts.unsubscribe(sub());f.advance(60000);await f.alerts.bridge.tick(f.row(7));assert.equal(attempts,3);
});
test('concurrent checks and station alerts have independent saved delivery state and topics',async t=>{
  const f=setup(t,async()=>new Promise(resolve=>setTimeout(resolve,5)));f.alerts.subscribe(sub());
  await Promise.all([f.alerts.bridge.tick(f.row(6.5)),f.alerts.bridge.tick(f.row(6.5))]);
  assert.equal(f.sent.length,1);
  f.advance(STALE_MS+1);await f.alerts.tick(null);assert.equal(f.sent.length,2);
  assert.notEqual(f.sent[0].options.topic,f.sent[1].options.topic);
  f.advance(60000);await f.alerts.bridge.tick(f.row(7));assert.equal(f.sent.length,3);
});
test('bridge query selects latest native Warwick row, never an earlier usable value, bucket or Scots record',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-source-')),file=path.join(dir,'weather.sqlite');
  const weather=new WeatherStore(file),water=new WaterStore(file),reader=new WaterReader(water.db);
  const api=createHistoryApi({filename:file,isReady:()=>true,logger:{warn(){}}});
  t.after(async()=>{api.close();water.close();weather.close();await new Promise(r=>setTimeout(r,100));fs.rmSync(dir,{recursive:true,force:true});});
  const now=Date.now(),make=(metric,value,time)=>({metric,value,t:time,min:value,max:value,stream:'point',quality:null,qualityText:'Unverified',priority:1,raw:'{}'});
  water.save([make('condamine-level',8,now),make('condamine-warwick-level',6.5,now-60000)],
    'condamine-warwick-live',{lastSuccess:new Date(now).toISOString(),error:null});
  assert.deepEqual(reader.bridgeObservation(),{metric:'condamine-warwick-level',value:6.5,t:now-60000,checkedAt:now});
  assert.equal((await api.query({bridgeStatus:true,minute:1})).value,6.5);
  water.save([make('condamine-warwick-level',null,now)]);
  assert.equal(reader.bridgeObservation().value,null);
  assert.equal((await api.query({bridgeStatus:true,minute:2})).value,null);
  water.setState('condamine-warwick-live',{lastSuccess:new Date(now).toISOString(),error:'Source unavailable'});
  assert.equal(reader.bridgeObservation(),null);
});
