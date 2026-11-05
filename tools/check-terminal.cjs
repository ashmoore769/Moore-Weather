'use strict';
// Serve the production UI against a local, synthetic terminal. No real station,
// application password, socket bridge, or deployed server is used by this check.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const publicRoot = path.resolve(__dirname, '../public');
const screenshotRoot = path.resolve(__dirname, '../artifacts/dashboard');
const PASSWORD = 'offline-terminal-fixture-password', CSRF = 'offline-terminal-fixture-csrf';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const greeting = 'Moore Weather fixture · 23.4°C\r\n<img src=x onerror="window.terminalInjected=true">\r\n';
let fixture, origin, sequence = 0;
function reset() {
  fixture = { unlocked:false, enabled:true, portalExpired:false, active:null, connectMode:'connected',
    connections:0, inputs:[], interrupts:0, disconnects:0, locks:0, requests:[], violations:[] };
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
  res.end(JSON.stringify(data));
}
function status(state) {
  return { enabled:state.enabled, unlocked:state.unlocked, ...(state.unlocked ? {csrfToken:CSRF,expiresAt:new Date(Date.now()+15*60000).toISOString()} : {}),
    connected:Boolean(state.active?.connected), busy:Boolean(state.active), limits:{idleSeconds:60,maxSeconds:300} };
}
function emit(lease, event) {
  if (!lease || lease.res.destroyed || lease.res.writableEnded) return;
  lease.res.write(JSON.stringify(event) + '\n');
}
function finish(lease, message = 'Disconnected. Weather collection resumes automatically.') {
  if (!lease) return;
  emit(lease, {type:'state',state:'closing'});
  emit(lease, {type:'state',state:'closed',message});
  lease.res.end();
}
async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin || 'http://localhost'), state = fixture;
  if (url.pathname.startsWith('/api/terminal/')) {
    state.requests.push({method:req.method,path:url.pathname});
    if (state.portalExpired) { res.writeHead(401, {'Content-Type':'text/plain'}); res.end('Authentication required.'); return; }
    if (url.pathname === '/api/terminal/status') { json(res,200,status(state)); return; }
    if (req.method !== 'POST' || req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json')) {
      state.violations.push('Mutation missing its browser origin or JSON body.'); json(res,403,{error:'Request not accepted.'}); return;
    }
    let data;
    try { data = await body(req); } catch { json(res,400,{error:'Invalid request.'}); return; }
    if (url.pathname === '/api/terminal/unlock') {
      if (data.password !== PASSWORD) { json(res,401,{error:'Incorrect terminal password.'}); return; }
      state.unlocked = true; json(res,200,status(state)); return;
    }
    if (!state.unlocked) { json(res,401,{error:'Terminal unlock expired. Unlock again to continue.'}); return; }
    if (req.headers['x-terminal-csrf'] !== CSRF) {
      state.violations.push('Missing terminal CSRF token.'); json(res,403,{error:'Invalid terminal token.'}); return;
    }
    if (url.pathname === '/api/terminal/connect') {
      if (state.active) { json(res,409,{error:'The terminal is already in use.'}); return; }
      const lease = {id:'fixture-connection-' + (++sequence),res,connected:false};
      state.active = lease; state.connections++;
      res.writeHead(200, {'Content-Type':'application/x-ndjson','Cache-Control':'no-store'}); res.flushHeaders();
      emit(lease,{type:'state',state:'queued',connectionId:lease.id});
      const heartbeat = setInterval(() => emit(lease,{type:'heartbeat'}),1000);
      res.on('close',() => { clearInterval(heartbeat); if(state.active===lease) state.active=null; });
      if (state.connectMode === 'queued') return;
      lease.connected = true;
      emit(lease,{type:'state',state:'connecting'});
      emit(lease,{type:'state',state:'connected',connectionId:lease.id});
      // Split both an NDJSON event and a multibyte UTF-8 character across chunks.
      const bytes = Buffer.from(JSON.stringify({type:'data',text:greeting})+'\n');
      const split = bytes.indexOf(Buffer.from('°')) + 1;
      res.write(bytes.subarray(0,split));
      setTimeout(() => { if(!res.destroyed && !res.writableEnded) res.write(bytes.subarray(split)); },10);
      return;
    }
    if (url.pathname === '/api/terminal/lock') {
      state.unlocked=false; state.locks++; finish(state.active,'Terminal locked.'); json(res,200,{ok:true}); return;
    }
    const lease = state.active;
    if (!lease || data.connectionId !== lease.id) {
      state.violations.push('A control did not carry its own connection capability.'); json(res,409,{error:'This connection is no longer active.'}); return;
    }
    if (url.pathname === '/api/terminal/input') {
      assert.equal(typeof data.commandId,'string');
      assert.match(data.commandId,/^[0-9a-f-]{36}$/i);
      assert.match(data.command,/^[\x20-\x7e]{1,512}$/);
      state.inputs.push({...data});
      emit(lease,{type:'data',text:data.command === 'TIME' ? '2026/11/05 16:30:00\r\n> ' : data.command+' reply\r\n> '});
      json(res,200,{ok:true}); return;
    }
    if (url.pathname === '/api/terminal/interrupt') { state.interrupts++; emit(lease,{type:'data',text:'^C^C^C^C^C\r\n> '}); json(res,200,{ok:true}); return; }
    if (url.pathname === '/api/terminal/disconnect') { state.disconnects++; finish(lease); json(res,200,{ok:true}); return; }
    json(res,404,{error:'Unknown fixture route.'}); return;
  }
  if (url.pathname === '/login') { res.writeHead(200,{'Content-Type':'text/html'}); res.end('<h1>Fixture portal sign-in</h1>'); return; }
  const file = path.resolve(publicRoot,'.'+decodeURIComponent(url.pathname));
  if(!file.startsWith(publicRoot+path.sep)) {res.writeHead(403);res.end();return;}
  try {
    res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});
    res.end(fs.readFileSync(file));
  } catch {res.writeHead(404);res.end();}
});
async function connected(page) {
  await page.waitForFunction(() => document.querySelector('#terminalPanel').dataset.state === 'connected');
}
async function readyToConnect(page) {
  await page.waitForFunction(() => !document.querySelector('#terminalConnect').disabled);
}
async function unlock(page) {
  await page.locator('#terminalPassword').fill(PASSWORD);
  await page.locator('#terminalUnlock').click();
  await page.waitForFunction(() => !document.querySelector('#terminalPanel').hidden);
}
async function bounds(page,width) {
  const violations = await page.evaluate(() => {
    const nodes=[document.querySelector('main'),...document.querySelectorAll('button,input,.terminal-output,.connection-actions,.command-tools')];
    return nodes.filter(node=>node && node.getClientRects().length).flatMap(node=>{
      const r=node.getBoundingClientRect();
      return r.left< -1 || r.right>innerWidth+1 ? [node.id||node.className||node.tagName] : [];
    });
  });
  assert.deepEqual(violations,[],'Terminal overflow at '+width);
}
async function check(context,engine,width) {
  const page=await context.newPage(), errors=[], external=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{
    if(route.request().url().startsWith(origin)) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__terminalCopied=String(value);}}});
  });
  await page.goto(origin+'/terminal.html');
  await page.waitForFunction(()=>!document.querySelector('#terminalPassword').disabled);
  assert.equal(await page.locator('#terminalPassword').getAttribute('autocomplete'),'current-password');
  assert.equal(fixture.connections,0,'opening the page must not contact the station');
  await page.locator('#terminalPassword').fill('incorrect-fixture-password');
  await page.locator('#terminalUnlock').click();
  await page.waitForFunction(()=>document.querySelector('#terminalStatus').textContent.includes('Incorrect terminal password'));
  assert.equal(new URL(page.url()).pathname,'/terminal.html','terminal password errors must stay inline');
  assert.equal(await page.locator('#terminalPanel').isVisible(),false);
  await unlock(page);
  assert.equal(await page.locator('#terminalPassword').inputValue(),'');
  assert.equal(fixture.connections,0,'unlocking must not open the station connection');
  await page.locator('[data-command="TIME"]').click();
  assert.equal(await page.locator('#terminalCommand').inputValue(),'TIME');
  assert.equal(fixture.inputs.length,0,'a quick command only fills the input');
  assert.equal(await page.locator('#terminalSend').isDisabled(),true);

  await page.locator('#terminalConnect').click(); await connected(page);
  await page.waitForFunction(()=>document.querySelector('#terminalOutput').textContent.includes('23.4°C'));
  assert.equal(await page.locator('#terminalOutput img').count(),0,'station output must be rendered as text');
  assert.equal(await page.evaluate(()=>window.terminalInjected),undefined);
  assert.equal(await page.locator('#terminalLeaseNotice').isVisible(),true);
  assert.match(await page.locator('#terminalLimits').textContent(),/60 seconds.*5 minutes/);
  assert.match(await page.locator('#terminalCommandHelp').textContent(),/Storage schedule changes need a matching app update/);
  await page.locator('#terminalCommand').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#terminalCommand').value==='' && document.querySelector('#terminalStatus').textContent.includes('Command sent'));
  assert.equal(fixture.inputs.length,1); assert.equal(fixture.inputs[0].command,'TIME');
  await page.locator('#terminalCommand').fill('draft command');
  await page.locator('#terminalCommand').press('ArrowUp');
  assert.equal(await page.locator('#terminalCommand').inputValue(),'TIME');
  await page.locator('#terminalCommand').press('ArrowDown');
  assert.equal(await page.locator('#terminalCommand').inputValue(),'draft command');
  await page.locator('[data-command="LISTALL"]').click();
  assert.equal(fixture.inputs.length,1);

  const other=await context.newPage();
  await other.goto(origin+'/terminal.html');
  await other.waitForFunction(()=>document.querySelector('#terminalPanel').dataset.state==='busy');
  for(const id of ['terminalConnect','terminalSend','terminalInterrupt','terminalDisconnect']) assert.equal(await other.locator('#'+id).isDisabled(),true,id+' must not adopt another tab\'s connection');
  assert.equal(fixture.connections,1);
  await other.close(); await page.bringToFront();
  assert.equal(fixture.disconnects,0,'closing an observer tab must not disconnect the owner');
  const stored=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
  for(const secret of [PASSWORD,CSRF,fixture.active.id,'LISTALL']) assert.ok(!stored.includes(secret),'terminal state must not be persisted');
  await bounds(page,width);
  fs.mkdirSync(screenshotRoot,{recursive:true});
  await page.screenshot({path:path.join(screenshotRoot,`${engine.name()}-${width<600?'phone':'desktop'}-terminal.png`),fullPage:true,animations:'disabled'});

  await page.locator('#terminalCopy').click();
  assert.equal(await page.evaluate(()=>window.__terminalCopied),await page.locator('#terminalOutput').textContent());
  const downloadEvent=page.waitForEvent('download'); await page.locator('#terminalSave').click();
  const download=await downloadEvent;
  assert.match(download.suggestedFilename(),/^moore-weather-terminal-.*\.txt$/);
  const saved=fs.readFileSync(await download.path(),'utf8');
  assert.match(saved,/23\.4°C/); assert.ok(!saved.includes(PASSWORD));
  await page.locator('#terminalInterrupt').click();
  await page.waitForFunction(()=>document.querySelector('#terminalStatus').textContent.includes('Ctrl+C sent'));
  assert.equal(fixture.interrupts,1);

  // Complete one real HTTP POST, then hide its successful acknowledgement from
  // the application. Destroying a reused socket can instead make Chromium retry
  // below fetch(), which tests transport recovery rather than our no-resend rule.
  await page.evaluate(() => {
    const original = window.fetch;
    let dropped = false;
    window.__terminalDroppedAck = null;
    window.__terminalRestoreFetch = () => { window.fetch = original; delete window.__terminalRestoreFetch; };
    window.fetch = async (input, options) => {
      const response = await original.call(window, input, options);
      const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (!dropped && pathname === '/api/terminal/input' && options?.method === 'POST') {
        dropped = true;
        const ack = await response.json();
        window.__terminalDroppedAck = { status:response.status, ok:ack.ok, commandId:JSON.parse(options.body).commandId };
        throw new TypeError('Fixture acknowledgement lost after the server accepted the command.');
      }
      return response;
    };
  });
  try {
    await page.locator('#terminalSend').click();
    await page.waitForFunction(()=>document.querySelector('#terminalStatus').textContent.includes('Send could not be confirmed'));
    await page.waitForTimeout(1200);
    assert.equal(fixture.inputs.length,2,'an ambiguously acknowledged command must not be automatically resent');
    assert.deepEqual(await page.evaluate(()=>window.__terminalDroppedAck),{status:200,ok:true,commandId:fixture.inputs[1].commandId});
    assert.match(await page.locator('#terminalOutput').textContent(),/LISTALL reply/);
    assert.equal(await page.locator('#terminalCommand').inputValue(),'LISTALL');
  } finally {
    await page.evaluate(()=>window.__terminalRestoreFetch?.());
  }

  if(width===393) {
    for(let i=0;i<3;i++) emit(fixture.active,{type:'data',text:'°'.repeat(400000)});
    await page.waitForFunction(()=>!document.querySelector('#terminalOutputLimit').hidden);
    const text=await page.locator('#terminalOutput').textContent();
    assert.ok(Buffer.byteLength(text,'utf8')<=MAX_OUTPUT_BYTES,'output stays within its byte cap');
    assert.ok(!text.includes('\ufffd'),'output truncation must keep complete UTF-8 characters');
  }
  await page.locator('#terminalClear').click();
  assert.equal(await page.locator('#terminalOutput').textContent(),'');
  assert.equal(await page.locator('#terminalOutputLimit').isVisible(),false);

  // JSON 401 means the extra terminal unlock expired, not the portal login.
  fixture.unlocked=false;
  await page.locator('[data-command="VER"]').click();
  await page.locator('#terminalSend').click();
  await page.waitForFunction(()=>!document.querySelector('#terminalUnlockPanel').hidden && document.querySelector('#terminalStatus').textContent.includes('expired'));
  assert.equal(new URL(page.url()).pathname,'/terminal.html');
  assert.equal(await page.locator('#terminalOutput').textContent(),'');
  await unlock(page); await readyToConnect(page);

  fixture.connectMode='queued'; const before=fixture.inputs.length;
  await page.locator('#terminalConnect').click();
  await page.waitForFunction(()=>document.querySelector('#terminalPanel').dataset.state==='queued');
  assert.equal(await page.locator('#terminalDisconnect').textContent(),'Cancel connection');
  const queuedResponse=fixture.active.res;
  const released=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('The cancelled connection stream was not closed.')),5000);
    queuedResponse.once('close',()=>{clearTimeout(timer);resolve();});
  });
  await page.locator('#terminalDisconnect').click(); await released; await readyToConnect(page);
  assert.equal(fixture.active,null,'cancelling a queued stream releases only that connection');
  assert.equal(fixture.inputs.length,before);

  fixture.connectMode='connected';
  await page.locator('#terminalConnect').click(); await connected(page);
  await page.locator('#terminalDisconnect').click(); await readyToConnect(page);
  assert.equal(fixture.disconnects,1);
  await page.locator('#terminalConnect').click(); await connected(page);
  const connects=fixture.connections;
  finish(fixture.active,'Disconnected after the idle limit. Weather collection resumes.');
  await readyToConnect(page);
  assert.equal(fixture.connections,connects,'automatic expiry must not trigger reconnection');

  await page.locator('#terminalLock').click();
  await page.waitForFunction(()=>!document.querySelector('#terminalUnlockPanel').hidden);
  assert.equal(fixture.locks,1); assert.equal(fixture.unlocked,false);
  assert.equal(await page.locator('#terminalOutput').textContent(),'');
  await unlock(page);
  await page.locator('#terminalCommand').fill('new draft');
  await page.locator('#terminalCommand').press('ArrowUp');
  assert.equal(await page.locator('#terminalCommand').inputValue(),'new draft','locking clears command history');
  assert.equal(fixture.connections,connects,'unlocking again must not reconnect');

  fixture.portalExpired=true;
  await page.locator('#terminalConnect').click();
  await page.waitForURL(url=>url.pathname==='/login');
  assert.equal(new URL(page.url()).searchParams.get('next'),'/terminal.html');
  assert.deepEqual(errors,[]); assert.deepEqual(external,[],'the terminal must load no external analytics or providers');
  assert.deepEqual(fixture.violations,[]);
  await page.close();
}
(async()=>{
  reset();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin='http://127.0.0.1:'+server.address().port;
  try {
    const engines=(process.env.TERMINAL_BROWSERS||'chromium,webkit').split(',').map(name=>({chromium,webkit})[name]);
    assert.ok(engines.every(Boolean),'TERMINAL_BROWSERS supports chromium,webkit');
    for(const engine of engines) {
      const browser=await engine.launch(engine===chromium && process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{});
      try {
        for(const width of [393,1280]) {
          reset();
          const context=await browser.newContext({viewport:{width,height:960},acceptDownloads:true});
          try {await check(context,engine,width);console.log('Passed terminal '+engine.name()+' '+width);}
          finally {await context.close();}
        }
      } finally {await browser.close();}
    }
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
