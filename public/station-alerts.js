(() => {
  const button=document.getElementById('stationAlertsBtn'); if(!button || document.getElementById('alertTitle'))return;
  button.setAttribute('aria-label','Weather, solar and river alerts');
  button.setAttribute('aria-haspopup','dialog');
  button.title='Weather, solar and river alerts';
  const dialog=document.createElement('dialog'); dialog.className='alert-dialog'; dialog.setAttribute('aria-labelledby','alertTitle');
  dialog.innerHTML=`
    <div class="alert-dialog-header">
      <div><p class="alert-eyebrow">Weather · solar · river</p><h2 id="alertTitle">Alerts &amp; status</h2></div>
      <button type="button" id="alertClose" aria-label="Close alerts and status" autofocus>Close <span aria-hidden="true">×</span></button>
    </div>
    <div class="alert-dialog-body">
      <section class="alert-current" id="alertCurrent" data-state="checking" aria-labelledby="alertCurrentTitle">
        <div class="alert-section-heading"><h3 id="alertCurrentTitle">Current collection</h3><span class="alert-state-badge" id="alertCollectionState">Checking</span></div>
        <p id="alertCollectionSummary" role="status">Checking saved station readings…</p>
      </section>
      <section class="alert-device" aria-labelledby="alertDeviceTitle">
        <div class="alert-section-heading"><h3 id="alertDeviceTitle">Notifications on this device</h3><span class="alert-state-badge" id="alertDeviceState" data-state="checking">Checking</span></div>
        <p id="alertState" role="status">Checking this device…</p>
        <div class="alert-actions"><button type="button" class="alert-primary" id="alertEnable" hidden>Enable notifications</button><button type="button" class="alert-primary" id="alertTest" hidden>Send test notification</button><button type="button" id="alertDisable" hidden>Turn off</button></div>
        <p class="alert-note">On iPhone, add Moore Weather to your Home Screen and open it from that icon. Allow notifications in your device settings.</p>
      </section>
      <details class="alert-details history-alert-detail" id="historyArchive">
        <summary><span id="historyAlertTitle">Saved history &amp; archive gaps</span><span class="alert-detail-status" id="historyArchiveState">Checking</span></summary>
        <p id="historyAlertSummary" role="status">Checking saved readings…</p><ul id="historyFeedStatus"></ul>
      </details>
      <details class="alert-details system-health" id="systemHealth"><summary>System health &amp; diagnostics</summary><p id="systemHealthSummary" role="status">Open alerts to check station storage and backups.</p><ul id="systemHealthChecks"></ul><p class="health-time" id="systemHealthTime"></p></details>
      <details class="alert-details alert-rules" id="alertRules">
        <summary>When alerts are sent</summary>
        <p><strong>Station.</strong> More than 15 minutes without a fresh reading, followed by one recovery notice.</p>
        <p id="maintenanceAlertPolicy" class="alert-note" hidden></p><p id="solarAlertPolicy" hidden></p>
        <p><strong>Saved history.</strong> A warning follows <strong>30 minutes</strong> without ten-minute readings, <strong>2 hours</strong> without hourly readings, or <strong>9:30 am AEST</strong> if the daily record has not arrived. Reminders repeat <strong>every 15 minutes</strong> until the current feeds recover, followed by a recovery notice. Older archive gaps stay visible here without repeated notifications.</p>
        <p><strong>Warwick river.</strong> Alerts warn at <strong>0.50m below McCahon Bridge’s 7.00m gauge reference</strong>, then again if the river reaches it. Each warning is sent once until the river falls more than 1m below.</p>
        <p class="alert-note">River alerts use recent BOM readings and are a guide, not a road-open or road-closed notice. Delivery depends on our server, your connection and notification settings.</p>
      </details>
    </div>`;
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
    if(response.status===401)throw Error('Sign in again to manage alerts.');
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
      const delayed=health.enabled && health.delayed;
      const olderGaps=health.enabled && health.incomplete;
      button.classList.toggle('history-warning',delayed);
      button.classList.toggle('history-archive-note',!delayed && olderGaps);
      const buttonDetail=delayed?'Current saved readings need attention':olderGaps?'Current saved readings are up to date; older archive gaps remain':'Weather, solar and river alerts';
      button.title=buttonDetail;
      button.setAttribute('aria-label',delayed || olderGaps?'Alerts: '+buttonDetail:buttonDetail);
      $('alertCurrent').dataset.state=!health.enabled?'disabled':delayed?'warning':'healthy';
      $('alertCollectionState').textContent=!health.enabled?'Not monitored':delayed?'Needs attention':'Up to date';
      $('alertCollectionSummary').textContent=!health.enabled?health.summary:delayed?health.summary:'Saved station readings are arriving on schedule.';
      $('historyArchiveState').textContent=!health.enabled?'Off':olderGaps?'Older gaps remain':health.checking?'Checking coverage':delayed?'Current delay':'No known gaps';
      $('historyAlertSummary').textContent=health.summary;
      $('historyFeedStatus').replaceChildren(...health.feeds.map(feed=>{
        const item=document.createElement('li');
        item.dataset.state=feed.delayed?'warning':feed.incomplete?'archive':'healthy';
        const heading=document.createElement('div'), label=document.createElement('strong'), state=document.createElement('span');
        heading.className='alert-feed-heading';label.textContent=feed.label+' readings';state.className='alert-feed-state';
        state.textContent=feed.delayed?'Needs attention':'Up to date';heading.append(label,state);
        const time=Date.parse(feed.lastObservedAt);
        const parts=[Number.isFinite(time)?'last saved '+stamp.format(time)+' AEST':'no saved record'];
        if(feed.delayed)parts.push('needs attention');
        if(Number.isFinite(feed.missingIntervals) && feed.missingIntervals>0)parts.push(feed.missingIntervals+' missing interval'+(feed.missingIntervals===1?'':'s'));
        if(Number.isFinite(feed.unresolvedGaps) && feed.unresolvedGaps>0)parts.push(feed.unresolvedGaps+' unresolved gap'+(feed.unresolvedGaps===1?'':'s'));
        const first=Date.parse(feed.firstMissingAt),last=Date.parse(feed.lastMissingAt);
        if(Number.isFinite(first))parts.push('missing '+stamp.format(first)+(Number.isFinite(last)&&last!==first?' to '+stamp.format(last):'')+' AEST');
        if(feed.coverageChecked===false)parts.push('coverage check in progress');
        const detail=document.createElement('p');detail.textContent=parts.join(' · ');item.append(heading,detail);
        return item;
      }));
    } catch(error) {
      banner.hidden=false;banner.querySelector('p').textContent=error.message;
      button.classList.add('history-warning');
      button.classList.remove('history-archive-note');
      button.title='Current saved history status is unavailable';
      button.setAttribute('aria-label','Alerts: current saved history status is unavailable');
      $('alertCurrent').dataset.state='warning';
      $('alertCollectionState').textContent='Unavailable';
      $('alertCollectionSummary').textContent=error.message;
      $('historyArchiveState').textContent='Unavailable';
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
  const clockMinutes=value=>typeof value==='string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? Number(value.slice(0,2))*60+Number(value.slice(3)) : null;
  const clockLabel=minutes=>String(Math.floor(minutes/60)%24).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
  function updateAlertPolicies() {
    const solar=config?.solar, maintenance=config?.maintenance;
    const solarReady=solar?.enabled===true && Number.isFinite(solar.marginW) && solar.marginW>0 &&
      Number.isFinite(solar.morningDwellMinutes) && solar.morningDwellMinutes>0 &&
      Number.isFinite(solar.eveningDwellMinutes) && solar.eveningDwellMinutes>0 && clockMinutes(solar.eveningStart)!==null;
    $('solarAlertPolicy').hidden=!solarReady;
    $('solarAlertPolicy').textContent=solarReady ? 'Solar: one morning alert after generation covers the house for '+solar.morningDwellMinutes+
      ' min. After '+solar.eveningStart+' AEST, one grid alert follows '+solar.eveningDwellMinutes+
      ' min of imports on a solar-covered day. Both use a '+solar.marginW+' W margin.' : '';
    const end=clockMinutes(maintenance?.end), grace=maintenance?.graceMinutes;
    const maintenanceReady=maintenance?.enabled===true && clockMinutes(maintenance.start)!==null && end!==null &&
      Number.isInteger(grace) && grace>=0 && grace<=60;
    $('maintenanceAlertPolicy').hidden=!maintenanceReady;
    $('maintenanceAlertPolicy').textContent=maintenanceReady ? 'Planned modem pause: '+maintenance.start+'–'+maintenance.end+
      ' AEST, with reconnection grace until '+clockLabel(end+grace)+'. Genuine outages still alert.' : '';
  }
  function controls() {
    $('alertEnable').hidden=!!subscription || !config?.enabled || !supported() || Notification.permission==='denied';
    $('alertTest').hidden=$('alertDisable').hidden=!subscription;
    for(const id of ['alertEnable','alertTest','alertDisable'])$(id).disabled=busy;
  }
  function deviceState(message,state) {
    $('alertState').textContent=message;
    $('alertDeviceState').dataset.state=state;
    $('alertDeviceState').textContent=({checking:'Checking',enabled:'Enabled',off:'Off',blocked:'Blocked',unavailable:'Unavailable'})[state];
  }
  async function check() {
    deviceState('Checking this device…','checking');
    config=null; subscription=null; controls();updateAlertPolicies();
    try {
      const response=await fetch('/api/alerts/config',{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('Sign in again or try again shortly.');
      config=await response.json();updateAlertPolicies();
      if(!config.enabled)throw Error('Alerts are temporarily unavailable.');
      if(!supported()) { deviceState('This browser cannot receive push notifications. On iPhone, open the installed Home Screen app on iOS 16.4 or later.','unavailable');controls();return; }
      registration=await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});
      subscription=await registration.pushManager.getSubscription();
      if(subscription)await post('subscribe',subscription.toJSON());
      deviceState(subscription ? 'Alerts are enabled on this device. Send a test to check delivery.' : Notification.permission==='denied' ? 'Notifications are blocked. Allow Moore Weather notifications in your device settings, then reopen this panel.' : 'Enable notifications for station, saved history, solar and river alerts.',subscription?'enabled':Notification.permission==='denied'?'blocked':'off');
    } catch(error) {deviceState(error.message,'unavailable');}
    controls();
  }
  function openAlerts() {
    if(!dialog.open) {dialog.showModal();dialog.querySelector('.alert-dialog-body').scrollTop=0;}
    refreshHistory();refreshSystemHealth();check();
  }
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
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;
    const box=dialog.getBoundingClientRect();
    if(event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom)dialog.close();
  });
  async function action(task) {
    if(busy)return;busy=true;controls();
    try {await task();} catch(error) {deviceState(error.message,subscription?'enabled':Notification.permission==='denied'?'blocked':'off');} finally {busy=false;controls();}
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
      deviceState('Alerts are enabled. Send a test to check delivery on this device.','enabled');
    });
  });
  $('alertTest').addEventListener('click',()=>action(async()=>{await post('test',subscription.toJSON());deviceState('Test accepted for delivery. Check your notifications.','enabled');}));
  $('alertDisable').addEventListener('click',()=>action(async()=>{
    const current=subscription;
    await post('unsubscribe',current.toJSON());
    await current.unsubscribe();subscription=null;deviceState('Alerts are off on this device.','off');
  }));
})();
