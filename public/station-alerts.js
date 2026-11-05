(() => {
  const button=document.getElementById('stationAlertsBtn'); if(!button || document.getElementById('alertTitle'))return;
  const dialog=document.createElement('dialog'); dialog.className='alert-dialog'; dialog.setAttribute('aria-labelledby','alertTitle');
  dialog.innerHTML='<div class="alert-dialog-header"><h2 id="alertTitle">Weather & river alerts</h2><button type="button" id="alertClose" aria-label="Close weather and river alerts">Close</button></div><p>Get a notification if the station goes 15 minutes without a fresh reading, and another when it comes back online.</p><p>Missing saved history also triggers a warning: after <strong>30 minutes</strong> for ten-minute readings, <strong>2 hours</strong> for hourly readings, or <strong>9:30 am AEST</strong> if the daily record has not arrived. Reminders repeat <strong>every 15 minutes</strong> until the current feeds recover, followed by a recovery notice. Older archive gaps stay visible here without repeated notifications.</p><section class="history-alert-detail" aria-labelledby="historyAlertTitle"><h3 id="historyAlertTitle">Saved history</h3><p id="historyAlertSummary" role="status">Checking saved readings…</p><ul id="historyFeedStatus"></ul></section><details class="system-health" id="systemHealth"><summary>System health</summary><p id="systemHealthSummary" role="status">Open alerts to check station storage and backups.</p><ul id="systemHealthChecks"></ul><p class="health-time" id="systemHealthTime"></p></details><p>Warwick river alerts warn at <strong>0.50m below McCahon Bridge’s 7.00m gauge reference</strong>, then again if the river reaches it. Each warning is sent once until the river falls more than 1m below.</p><p id="alertState" role="status">Checking this device…</p><div class="alert-actions"><button type="button" class="alert-primary" id="alertEnable" hidden>Enable on this device</button><button type="button" id="alertTest" hidden>Send test</button><button type="button" id="alertDisable" hidden>Turn off</button></div><p class="alert-note">On iPhone, first add Moore Weather to your Home Screen, then open it from that icon. Notifications must be allowed in your device settings.</p><p class="alert-note">River alerts use recent BOM readings and are a guide, not a road-open or road-closed notice. Delivery depends on our server, your connection and notification settings.</p>';
  document.body.append(dialog);
  const banner=document.createElement('aside');
  banner.id='historyStatus';banner.className='history-status';banner.hidden=true;
  banner.setAttribute('aria-label','Saved weather history status');
  banner.innerHTML='<p role="status"></p><button type="button">View alerts</button>';
  const header=document.querySelector('.dashboard-header');
  if(header)header.insertAdjacentElement('afterend',banner);
  const $=id=>document.getElementById(id);
  let registration,subscription,config,busy=false,historyBusy=false,systemBusy=false;
  const supported=()=>window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const post=async(action,body)=>{
    const response=await fetch('/api/alerts/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    if(response.status===401)throw Error('Sign in again to manage weather and river alerts.');
    const data=await response.json(); if(!response.ok)throw Error(data.error || 'Alerts are temporarily unavailable.'); return data;
  };
  const stamp=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  async function refreshHistory() {
    if(historyBusy)return;historyBusy=true;
    try {
      const response=await fetch('/api/alerts/history',{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('History status unavailable. Open alerts or try again shortly.');
      const health=await response.json();
      if(typeof health.enabled!=='boolean' || typeof health.delayed!=='boolean' || !Array.isArray(health.feeds))throw Error('History status unavailable. Try again shortly.');
      // Keep historical gaps and coverage checks in Alerts. The dashboard
      // banner is for a current collection problem that needs attention.
      banner.hidden=!health.enabled || !health.delayed;
      banner.querySelector('p').textContent=health.summary;
      button.classList.toggle('history-warning',health.enabled && Boolean(health.delayed || health.incomplete));
      $('historyAlertSummary').textContent=health.summary;
      $('historyFeedStatus').replaceChildren(...health.feeds.map(feed=>{
        const item=document.createElement('li');
        const time=Date.parse(feed.lastObservedAt);
        const parts=[Number.isFinite(time)?'last saved '+stamp.format(time)+' AEST':'no saved record'];
        if(feed.delayed)parts.push('needs attention');
        if(Number.isFinite(feed.missingIntervals) && feed.missingIntervals>0)parts.push(feed.missingIntervals+' missing interval'+(feed.missingIntervals===1?'':'s'));
        if(Number.isFinite(feed.unresolvedGaps) && feed.unresolvedGaps>0)parts.push(feed.unresolvedGaps+' unresolved gap'+(feed.unresolvedGaps===1?'':'s'));
        const first=Date.parse(feed.firstMissingAt),last=Date.parse(feed.lastMissingAt);
        if(Number.isFinite(first))parts.push('missing '+stamp.format(first)+(Number.isFinite(last)&&last!==first?' to '+stamp.format(last):'')+' AEST');
        if(feed.coverageChecked===false)parts.push('coverage check in progress');
        item.textContent=feed.label+': '+parts.join(' · ');
        return item;
      }));
    } catch(error) {
      banner.hidden=false;banner.querySelector('p').textContent=error.message;
      button.classList.add('history-warning');
      $('historyAlertSummary').textContent=error.message;
      $('historyFeedStatus').replaceChildren();
    } finally {historyBusy=false;}
  }
  const bytes = value => Number.isFinite(value) ? (value / (value >= 1073741824 ? 1073741824 : 1048576)).toFixed(1) + (value >= 1073741824 ? ' GB' : ' MB') : 'unknown';
  const when = value => Number.isFinite(Date.parse(value)) ? stamp.format(Date.parse(value)) + ' AEST' : 'not recorded';
  const healthStatus = value => ({ok:'Healthy',healthy:'Healthy',warning:'Needs attention',degraded:'Needs attention',error:'Unavailable',failed:'Failed',disabled:'Disabled',unknown:'Unknown',pending:'Pending',unavailable:'Unavailable',low:'Low free space',stale:'Stale',delayed:'Delayed',incomplete:'Older gaps remain',checking:'Checking coverage',starting:'Starting up','waiting-for-backup':'Waiting for verified backup','catching-up':'Clearing older readings'})[value] || 'Unknown';
  async function refreshSystemHealth() {
    if (systemBusy) return; systemBusy = true;
    try {
      const response = await fetch('/api/system-health', {cache:'no-store',signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw Error('System health is unavailable. Try opening alerts again shortly.');
      const health = await response.json();
      if (!health.checks || typeof health.checks !== 'object') throw Error('System health could not be read.');
      $('systemHealthSummary').textContent = healthStatus(health.status);
      const labels = {clock:'Station clock',storage:'Storage',backups:'Backups',retention:'Raw weather retention',history:'Saved history',historyGaps:'Saved history',database:'Weather database',live:'Station feed'};
      $('systemHealthChecks').replaceChildren(...Object.entries(health.checks).map(([name,check]) => {
        const item = document.createElement('li');
        if (!check || typeof check !== 'object') { item.textContent = (labels[name] || name) + ': Unknown'; return item; }
        const parts = [healthStatus(check.status)];
        if (check.summary) parts.push(String(check.summary));
        if (name === 'storage') parts.push(bytes(check.freeBytes) + ' free', 'database ' + bytes(check.dbBytes));
        if (name === 'backups') {
          parts.push('last local copy ' + when(check.lastSuccess));
          parts.push(check.offsiteConfigured === true ? 'off-site copy ' + when(check.offsiteLastSuccess) : check.offsiteConfigured === false ? 'off-site copy not configured' : 'off-site status unknown');
        }
        if (name === 'retention') {
          if (Number.isFinite(check.days)) parts.push(check.days + '-day raw capture window');
          parts.push('last run ' + when(check.lastRun));
          if (Number.isFinite(check.deletedRecords) && check.deletedRecords > 0) parts.push(check.deletedRecords.toLocaleString('en-AU') + ' old raw records cleared');
        }
        if (name === 'database') parts.push('last saved ' + when(check.lastWrite));
        if (name === 'live') parts.push('observed ' + when(check.observedAt));
        if (name === 'clock') {
          if (check.status === 'ok' && Number.isFinite(check.accuracySeconds)) parts.push('within ' + check.accuracySeconds + 's of server time');
          else if (Number.isFinite(check.driftMinimumSeconds) && Number.isFinite(check.driftMaximumSeconds)) {
            parts.push('possible clock difference ' + check.driftMinimumSeconds.toFixed(1) + ' to ' + check.driftMaximumSeconds.toFixed(1) + 's');
          }
          if (check.lastVerifiedAt) parts.push('verified ' + when(check.lastVerifiedAt));
        }
        if (name === 'backups' && check.running) parts.push('backup in progress');
        const gaps = check.completeness || check;
        if (Number.isFinite(gaps.unresolvedGaps)) parts.push(gaps.unresolvedGaps + ' unresolved history gap' + (gaps.unresolvedGaps === 1 ? '' : 's'));
        if (gaps.checked === false) parts.push('history audit in progress');
        item.textContent = (labels[name] || name) + ': ' + parts.join(' · ');
        return item;
      }));
      $('systemHealthTime').textContent = 'Checked ' + when(health.checkedAt) + (health.version ? ' · ' + String(health.version).slice(0,12) : '');
    } catch (error) {
      $('systemHealthSummary').textContent = error.message;
      $('systemHealthChecks').replaceChildren();
      $('systemHealthTime').textContent = '';
    } finally { systemBusy = false; }
  }
  function controls() {
    $('alertEnable').hidden=!!subscription || !config?.enabled || !supported() || Notification.permission==='denied';
    $('alertTest').hidden=$('alertDisable').hidden=!subscription;
    for(const id of ['alertEnable','alertTest','alertDisable'])$(id).disabled=busy;
  }
  async function check() {
    $('alertState').textContent='Checking this device…';
    config=null; subscription=null; controls();
    if(!supported()) { $('alertState').textContent='This browser cannot receive push notifications. On iPhone, open the installed Home Screen app on iOS 16.4 or later.';return; }
    try {
      const response=await fetch('/api/alerts/config',{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('Sign in again or try again shortly.');
      config=await response.json();
      if(!config.enabled)throw Error('Weather & river alerts are temporarily unavailable.');
      registration=await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});
      subscription=await registration.pushManager.getSubscription();
      if(subscription)await post('subscribe',subscription.toJSON());
      $('alertState').textContent=subscription ? 'Alerts are enabled on this device.' : Notification.permission==='denied' ? 'Notifications are blocked. Allow Moore Weather notifications in your device settings, then reopen this panel.' : 'Alerts are off on this device.';
    } catch(error) {$('alertState').textContent=error.message;}
    controls();
  }
  function openAlerts() {if(!dialog.open)dialog.showModal();refreshHistory();refreshSystemHealth();check();}
  button.addEventListener('click',openAlerts);
  banner.querySelector('button').addEventListener('click',openAlerts);
  function fromNotification() {if(location.hash==='#historyStatus')openAlerts();}
  window.addEventListener('hashchange',fromNotification);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshHistory();});
  setInterval(()=>{if(!document.hidden)refreshHistory();},60000);
  refreshHistory();fromNotification();
  // Refresh an existing notification worker on a normal page visit. Never ask
  // permission or subscribe a device without an explicit tap.
  if(supported() && Notification.permission==='granted') {
    navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>{});
  }
  $('alertClose').addEventListener('click',()=>dialog.close());
  async function action(task) {
    if(busy)return;busy=true;controls();
    try {await task();} catch(error) {$('alertState').textContent=error.message;} finally {busy=false;controls();}
  }
  $('alertEnable').addEventListener('click',()=>{
    // Request permission directly in the tap handler (required on iPhone).
    const permission=Notification.requestPermission();
    action(async()=>{
      if(await permission!=='granted')throw Error('Notifications were not allowed. You can change this in device settings.');
      registration=await navigator.serviceWorker.ready;
      subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(config.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))});
      try {await post('subscribe',subscription.toJSON());}
      catch(error) {await subscription.unsubscribe();subscription=null;throw error;}
      $('alertState').textContent='Alerts are enabled. Send a test to check delivery on this device.';
    });
  });
  $('alertTest').addEventListener('click',()=>action(async()=>{await post('test',subscription.toJSON());$('alertState').textContent='Test accepted for delivery. Check your notifications.';}));
  $('alertDisable').addEventListener('click',()=>action(async()=>{
    const current=subscription;
    await post('unsubscribe',current.toJSON());
    await current.unsubscribe();subscription=null;$('alertState').textContent='Alerts are off on this device.';
  }));
})();
