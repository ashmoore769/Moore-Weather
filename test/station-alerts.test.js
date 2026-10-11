'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StationAlerts,validateSubscription,observationTime,STALE_MS}=require('../lib/station-alerts');
const sub=(id='one')=>({endpoint:'https://web.push.apple.com/'+id,keys:{auth:Buffer.alloc(16,1).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,2)]).toString('base64url')}});
function setup(t,send) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moore-alerts-'));let now=1800000000000;
 const sent=[], filename=path.join(dir,'alerts.sqlite');
 const options={filename,now:()=>now,send:send || (async(s,p)=>sent.push(JSON.parse(p))),startupGraceMs:0,logger:{warn(){}}};
 let alerts=new StationAlerts(options);t.after(()=>{alerts.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {get alerts(){return alerts;},sent,advance:ms=>now+=ms,now:()=>now,restart(){alerts.close();alerts=new StationAlerts(options);}};
}
test('one outage and recovery alert per device; state and VAPID survive restart',async t=>{
 const f=setup(t);f.alerts.subscribe(sub());const key=f.alerts.vapid.publicKey;
 f.advance(STALE_MS);await f.alerts.tick(null);assert.equal(f.sent.length,0);
 f.advance(1);await f.alerts.tick(null);assert.equal(f.sent.length,1);
 f.restart();assert.equal(f.alerts.vapid.publicKey,key);
 await f.alerts.tick(null);assert.equal(f.sent.length,1);
 await f.alerts.tick(f.now());assert.equal(f.sent.length,2);assert.match(f.sent[1].title,/back online/);
 await f.alerts.tick(f.now());assert.equal(f.sent.length,2);
 f.advance(STALE_MS+1);await f.alerts.tick(null);assert.equal(f.sent.length,3);
});
test('repeated stale replies and future clocks cannot disguise an outage',async t=>{
 const f=setup(t);f.alerts.subscribe(sub());f.advance(STALE_MS+1);
 await f.alerts.tick(f.now()-10*60000);assert.equal(f.sent.length,1);
 await f.alerts.tick(f.now()+120000);assert.equal(f.sent.length,1);
});
test('fresh data keeps alerts quiet and startup grace avoids restart false alarms',async t=>{
 const f=setup(t);f.alerts.subscribe(sub());
 for(let i=0;i<20;i++){f.advance(60000);await f.alerts.tick(f.now());}assert.equal(f.sent.length,0);
 f.alerts.startupGraceMs=3600000;f.advance(STALE_MS+1);await f.alerts.tick(null);assert.equal(f.sent.length,0);
});
test('expired endpoints are removed and temporary failures are retried with a delay',async t=>{
 let attempts=0;
 const f=setup(t,async()=>{attempts++;const e=Error('unavailable');e.statusCode=attempts===1?503:410;throw e;});
 f.alerts.subscribe(sub());f.advance(STALE_MS+1);await f.alerts.tick(null);assert.equal(attempts,1);
 await f.alerts.tick(null);assert.equal(attempts,1);
 f.advance(300000);await f.alerts.tick(null);assert.equal(attempts,2);
 f.advance(300000);await f.alerts.tick(null);assert.equal(attempts,2);
});
test('test notifications are explicit and rate limited; unsubscribe removes delivery',async t=>{
 const f=setup(t);f.alerts.subscribe(sub());await f.alerts.test(sub());assert.equal(f.sent.length,1);
 await assert.rejects(f.alerts.test(sub()),/wait one minute/);
 f.alerts.unsubscribe(sub());f.advance(STALE_MS+1);await f.alerts.tick(null);assert.equal(f.sent.length,1);
});
test('only secure known push gateways and well-formed keys are accepted',()=>{
 for(const endpoint of ['http://web.push.apple.com/x','https://localhost/x','https://fcm.googleapis.com.evil.test/x','https://web.push.apple.com@127.0.0.1/x','https://web.push.apple.com:444/x'])assert.throws(()=>validateSubscription({...sub(),endpoint}));
 assert.throws(()=>validateSubscription({...sub(),keys:{auth:'x',p256dh:'x'}}));
 assert.equal(validateSubscription(sub()).endpoint,sub().endpoint);
});
test('station time is parsed in AEST and impossible calendar dates rejected',()=>{
 assert.equal(observationTime('2026/10/12,00:30:00,1'),Date.parse('2026-10-11T14:30:00Z'));
 assert.equal(observationTime('2026/02/30,00:30:00,1'),null);
 assert.equal(observationTime('junk'),null);
});
