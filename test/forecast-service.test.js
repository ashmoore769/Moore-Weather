'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createForecastService, normalizeForecast, normalizeRadar, forecastUrl, DAILY, HOURLY } = require('../lib/forecast-service');
const NOW = Date.parse('2026-10-25T02:00:00Z'), midnight = Date.parse('2026-10-24T14:00:00Z')/1000;
function forecast() {
  const daily = { time:Array.from({length:7},(_,i)=>midnight+i*86400) }, hourly = { time:Array.from({length:168},(_,i)=>midnight+i*3600) };
  DAILY.forEach(key=>daily[key]=daily.time.map(()=>key==='weather_code'?0:20));
  HOURLY.forEach(key=>hourly[key]=hourly.time.map(()=>key==='weather_code'?0:20));
  daily.precipitation_sum[0]=0; daily.temperature_2m_min[1]=null; hourly.precipitation[0]=null;
  return {timezone:'Australia/Brisbane',utc_offset_seconds:36000,daily_units:{temperature_2m_max:'°C',precipitation_sum:'mm'},hourly_units:{wind_speed_10m:'km/h'},daily,hourly};
}
function radar() { return { host:'https://tilecache.rainviewer.com',radar:{past:Array.from({length:13},(_,i)=>({time:NOW/1000-7200+i*600,path:'/v2/radar/frame_'+i}))} }; }
const quiet={warn(){}};
test('forecast requests metric data for Warwick in Brisbane time and preserves missing values',()=>{
  const url=new URL(forecastUrl()); assert.equal(url.origin,'https://api.open-meteo.com');
  assert.equal(url.searchParams.get('timezone'),'Australia/Brisbane'); assert.equal(url.searchParams.get('timeformat'),'unixtime');
  assert.equal(url.searchParams.get('wind_speed_unit'),'kmh'); assert.equal(url.searchParams.get('forecast_days'),'7');
  const d=normalizeForecast(forecast(),NOW); assert.equal(d.daily.length,7); assert.equal(d.hourly.length,168);
  assert.equal(d.daily[0].precipitation_sum,0); assert.equal(d.daily[1].temperature_2m_min,null); assert.equal(d.hourly[0].precipitation,null);
});
test('invalid forecast units, incomplete arrays and expired/empty forecasts are rejected',()=>{
  for(const alter of [d=>d.timezone='UTC',d=>d.hourly_units.wind_speed_10m='mph',d=>d.hourly.precipitation.pop(),d=>d.daily.time[1]=d.daily.time[0],d=>d.daily.temperature_2m_max.fill(null),d=>d.daily.time=d.daily.time.map(t=>t-86400*3)]) {
    const d=forecast(); alter(d); assert.throws(()=>normalizeForecast(d,NOW));
  }
});
test('many visitors share one forecast request, including a concurrent refresh',async()=>{
  let clock=NOW, calls=0, finish;
  const service=createForecastService({now:()=>clock,logger:quiet,read:()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  const visitors=Array.from({length:12},()=>service.getForecast()); assert.equal(calls,1); finish(forecast());
  const values=await Promise.all(visitors); assert.ok(values.every(d=>!d.stale));
  await service.getForecast(); assert.equal(calls,1);
  clock+=20*60000; const refresh=[service.getForecast(),service.getForecast()]; assert.equal(calls,2); finish(forecast()); await Promise.all(refresh);
});
test('forecast outages retain bounded stale data and back off between retries',async()=>{
  let clock=NOW, calls=0, fail=false;
  const s=createForecastService({now:()=>clock,logger:quiet,read:async()=>{calls++;if(fail)throw Error('outage');return forecast();}});
  const initial=await s.getForecast(); fail=true; clock+=20*60000;
  const cached=await s.getForecast(); assert.equal(cached.stale,true); assert.equal(cached.fetchedAt,initial.fetchedAt);
  await s.getForecast(); assert.equal(calls,2); clock+=60000; await s.getForecast(); assert.equal(calls,3);
  clock=NOW+6*3600000; await assert.rejects(s.getForecast(),/unavailable/);
});
test('cold failures are throttled and a later successful request recovers',async()=>{
  let clock=NOW,calls=0,fail=true;
  const s=createForecastService({now:()=>clock,logger:quiet,read:async()=>{calls++;if(fail)throw Error('offline');return forecast();}});
  await assert.rejects(s.getForecast()); await assert.rejects(s.getForecast()); assert.equal(calls,1);
  clock+=60000;fail=false;assert.equal((await s.getForecast()).daily.length,7); assert.equal(calls,2);
});
test('radar normalization uses the provider path, rejects foreign hosts and discards invalid frames',()=>{
  const d=radar(); d.radar.past.push({time:NOW/1000-60,path:'https://evil.test/tile'},{time:NOW/1000+3600,path:'/v2/radar/future'},{time:NOW/1000-86400,path:'/v2/radar/old'});
  const valid=normalizeRadar(d,NOW); assert.equal(valid.frames.length,13); assert.equal(valid.frames.at(-1).path,'/v2/radar/frame_12');
  d.host='https://evil.test';assert.throws(()=>normalizeRadar(d,NOW));
  assert.throws(()=>normalizeRadar({host:'https://tilecache.rainviewer.com',radar:{past:[]}},NOW));
});
test('radar old timestamps are marked delayed even after a successful fetch and never shown indefinitely',async()=>{
  let clock=NOW;
  const s=createForecastService({now:()=>clock,logger:quiet,read:async()=>radar()});
  assert.equal((await s.getRadar()).stale,false); clock+=25*60000; assert.equal((await s.getRadar()).stale,true);
  clock=NOW+121*60000; await assert.rejects(s.getRadar(),/out of date/);
});
test('radar availability is independent of a failed forecast feed',async()=>{
  const s=createForecastService({now:()=>NOW,logger:quiet,read:async url=>{if(url.includes('open-meteo'))throw Error('forecast down'); return radar();}});
  const values=await Promise.allSettled([s.getForecast(),s.getRadar()]); assert.equal(values[0].status,'rejected'); assert.equal(values[1].status,'fulfilled');
});
