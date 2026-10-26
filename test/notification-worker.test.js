'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(windows=[]) {
  const events={},shown=[],opened=[];
  const self={location:{origin:'https://moore-weather.onrender.com'},addEventListener:(event,handler)=>events[event]=handler,
    registration:{showNotification:async(title,options)=>shown.push({title,options})},
    clients:{matchAll:async()=>windows,openWindow:async url=>opened.push(url),claim:async()=>{}},skipWaiting:async()=>{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/sw.js'),'utf8'),{self,URL,Number});
  return {events,shown,opened};
}
test('bridge notifications retain observation timestamp and stable tag; only the local water destination is allowed',async()=>{
  const f=fixture();let pending;
  f.events.push({data:{json:()=>({title:'River warning',body:'Recorded reading',tag:'moore-river-near-1',url:'/#localWater',timestamp:123456})},waitUntil:p=>pending=p});
  await pending;assert.equal(f.shown[0].options.data.url,'/#localWater');
  assert.equal(f.shown[0].options.timestamp,123456);assert.equal(f.shown[0].options.renotify,false);
  f.events.push({data:{json:()=>({url:'https://other.example/'})},waitUntil:p=>pending=p});await pending;
  assert.equal(f.shown[1].options.data.url,'/');
  assert.equal(f.events.fetch,undefined);
});
test('a river alert opens the water section in an existing app window or a new window',async()=>{
  const navigated=[],client={url:'https://moore-weather.onrender.com/daily.html',focus:async()=>{},navigate:async url=>{navigated.push(url);return client;}};
  const f=fixture([client]);let pending;
  const event={notification:{data:{url:'/#localWater'},close(){}},waitUntil:p=>pending=p};
  f.events.notificationclick(event);await pending;assert.deepEqual(navigated,['/#localWater']);assert.equal(f.opened.length,0);
  const empty=fixture();empty.events.notificationclick(event);await pending;assert.deepEqual(empty.opened,['/#localWater']);
});
