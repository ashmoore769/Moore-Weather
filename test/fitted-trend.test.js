'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {fittedTrend,segments}=require('../public/history-chart');
const series=(points,kind='line')=>({points,metric:{kind}});
test('fits elapsed time and excludes gaps, nonfinite and estimated observations',()=>{
 const start=1700000000000;
 const result=fittedTrend(series([{t:start,value:2},{t:start+1000,value:4},{t:start+4000,value:10},{t:start+2000,value:null},{t:start+3000,value:99,estimated:true},{t:start+5000,value:NaN}]));
 assert.deepEqual(result.map(p=>p.t),[start,start+4000]); assert(Math.abs(result[0].value-2)<1e-10); assert(Math.abs(result[1].value-10)<1e-10);
});
test('fit needs three usable observations with distinct times',()=>{
 assert.deepEqual(fittedTrend(series([{t:0,value:2},{t:1,value:3}])),[]);
 assert.deepEqual(fittedTrend(series([{t:1,value:2},{t:1,value:3},{t:1,value:4}])),[]);
 assert.deepEqual(fittedTrend(series([{t:0,value:4},{t:1,value:4},{t:2,value:4}])),[{t:0,value:4},{t:2,value:4}]);
});
test('compass fit crosses north without falsely travelling through south',()=>{
 const fitted=fittedTrend(series([{t:0,value:359},{t:1,value:0},{t:2,value:1}],'direction'));
 assert(fitted.every(p=>p.value<2 || p.value>358));
 assert.equal(segments(fitted,true).length,2);
});
test('opposing compass readings do not invent a direction at cancellation',()=>{
 const fitted=fittedTrend(series([{t:0,value:0},{t:1,value:180},{t:2,value:0},{t:3,value:180}],'direction'));
 assert(fitted.some(p=>p.value===null));
});
