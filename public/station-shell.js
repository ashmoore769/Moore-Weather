(() => {
  const badge = document.getElementById('statusBadge'), detail = document.getElementById('freshnessText');
  if (!badge) return;
  let observed = NaN, polled = NaN, failed = false, busy = false;
  const date = new Intl.DateTimeFormat('en-AU', {timeZone:'Australia/Brisbane', weekday:'short', day:'numeric', month:'short',year:'numeric'});
  const time = new Intl.DateTimeFormat('en-AU', {timeZone:'Australia/Brisbane',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function paint() {
    const age = Date.now() - Math.min(observed,polled);
    let label = 'CONNECTING', cls = 'fetching', text = 'Waiting for station';
    if (failed) { label = 'OFFLINE'; cls = 'error'; text = 'Status unavailable'; }
    else if (observed > Date.now()+90000) { label = 'CHECK'; text = 'Check station clock'; }
    else if (Number.isFinite(age)) {
      label = age <= 90000 ? 'LIVE' : age <= 180000 ? 'DELAYED' : 'STALE';
      cls = age <= 90000 ? 'connected' : age <= 180000 ? 'fetching' : 'error';
      const seconds = Math.max(0,Math.floor(age/1000));
      text = 'Observed ' + (seconds<5 ? 'just now' : seconds<60 ? seconds+'s ago' : seconds<3600 ? Math.floor(seconds/60)+'m ago' : Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m ago');
    }
    if (badge.textContent !== '● '+label) badge.textContent = '● '+label;
    badge.className = 'status-badge '+cls; detail.textContent = text;
    if (Number.isFinite(observed)) { document.getElementById('dateVal').textContent=date.format(observed); document.getElementById('timeVal').textContent=time.format(observed)+' AEST'; }
  }
  async function refresh() {
    if (busy) return; busy = true;
    try {
      const response = await fetch('/ping', {cache:'no-store', signal:AbortSignal.timeout(10000)});
      if(response.status===401) { location.assign('/login'); return; }
      if(!response.ok) throw Error('Status unavailable');
      const data = await response.json(); observed = Date.parse(data.stationObservedAt); polled = Date.parse(data.lastWeatherPoll); failed=false;
    } catch { failed=true; }
    finally { busy=false; paint(); }
  }
  refresh(); setInterval(()=>{if(!document.hidden) refresh();},30000);
  setInterval(()=>{if(!document.hidden) paint();},1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
})();