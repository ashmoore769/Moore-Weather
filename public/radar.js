/* Regional images use one RainViewer request per frame, rather than a tile grid.
   This keeps a two-hour animation comfortably within the free feed's limits. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id), minute=60000;
  const time=seconds=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(seconds*1000);
  let map, bounds, overlay, baseLayer, baseError=false, data, selected=-1, sequence=0, playing=false, playTimer, inputTimer, busy=false, lastAttempt=0, lastImageRequest=0;
  const imageCache=new Map();
  function status(message,kind='') { $('radarStatus').textContent=message; $('radarStatus').dataset.kind=kind; }
  function pause() { playing=false; clearTimeout(playTimer); $('radarPlay').textContent='▶ Play'; $('radarPlay').setAttribute('aria-pressed','false'); }
  function freshness() {
    if(!data) return;
    if(baseError) { status('Some background map tiles couldn’t load. Radar imagery is still shown; try Refresh.','error'); return; }
    const age=Math.max(0,Math.round((Date.now()/1000-data.frames.at(-1).time)/60));
    status((data.stale || age>20 ? 'Radar is delayed · ' : '')+'Latest · '+age+' min ago',data.stale||age>20?'stale':'');
  }
  function initMap(location) {
    if(map) return;
    if(!window.L) throw Error('Map library unavailable');
    const centre=[location.latitude,location.longitude];
    map=L.map('radarMap',{center:centre,zoom:7,minZoom:7,maxZoom:10,zoomSnap:.5,scrollWheelZoom:false,zoomControl:false,attributionControl:true});
    // A centred 512px image at native zoom 7 spans these exact Web Mercator pixels.
    const p=map.project(centre,7);
    bounds=L.latLngBounds(map.unproject([p.x-256,p.y+256],7),map.unproject([p.x+256,p.y-256],7));
    map.setMaxBounds(bounds); map.options.maxBoundsViscosity=1;
    function fitRegion(reset=false) {
      const minimum=Math.max(7,map.getBoundsZoom(bounds,true));
      map.setMinZoom(minimum); if(reset || map.getZoom()<minimum) map.setView(centre,minimum,{animate:false});
    }
    fitRegion(true);
    baseLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:10, minZoom:7, noWrap:true, bounds, keepBuffer:0, className:'radar-base-tiles',
      referrerPolicy:'strict-origin-when-cross-origin',
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).on('tileerror',()=>{baseError=true;status('The background map couldn’t load. Radar may still be available; try refreshing shortly.','error');}).addTo(map);
    map.attributionControl.setPrefix(false);
    L.control.zoom({position:'bottomright'}).addTo(map);
    L.circleMarker(centre,{radius:5,weight:2,color:'#fff',fillColor:'#178a84',fillOpacity:1}).addTo(map).bindTooltip('Warwick',{permanent:true,direction:'right',offset:[8,0]});
    L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
    map.on('movestart',pause);
    const resize=new ResizeObserver(()=>{map.invalidateSize({pan:false});fitRegion();}); resize.observe($('radarMap'));
  }
  function imageUrl(frame) {
    return `${data.host}${frame.path}/512/7/${data.location.latitude.toFixed(4)}/${data.location.longitude.toFixed(4)}/2/1_0.png`;
  }
  function preload(url) {
    if(imageCache.has(url)) return imageCache.get(url);
    const promise=new Promise((resolve,reject)=>{
      const img=new Image(); let timer;
      img.onload=()=>{clearTimeout(timer);resolve(url);};
      img.onerror=()=>{clearTimeout(timer);reject(Error('Radar image unavailable'));};
      timer=setTimeout(()=>{img.onload=null;img.onerror=null;img.src='';reject(Error('Radar image timed out'));},12000);
      img.referrerPolicy='strict-origin-when-cross-origin'; img.src=url;
    }).catch(error=>{imageCache.delete(url);throw error;});
    imageCache.set(url,promise); return promise;
  }
  async function show(index) {
    if(!data?.frames.length) return false;
    const token=++sequence, frame=data.frames[Math.max(0,Math.min(index,data.frames.length-1))], url=imageUrl(frame);
    // Scrubbing is debounced and uncached frames are spaced by at least one second.
    if(!imageCache.has(url)) {
      const wait=Math.max(0,1000-(Date.now()-lastImageRequest));
      if(wait) await new Promise(resolve=>setTimeout(resolve,wait));
      if(token!==sequence) return false;
      lastImageRequest=Date.now();
    }
    $('radarPosition').textContent='Loading frame…';
    try {
      await preload(url); if(token!==sequence) return false;
      const previous=overlay;
      const next=L.imageOverlay(url,bounds,{opacity:0,interactive:false,alt:'Regional rainfall radar at '+time(frame.time)+' AEST'});
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{next.remove();reject(Error('Map image timed out'));},12000);
        next.once('load',()=>{clearTimeout(timer);resolve();});
        next.once('error',()=>{clearTimeout(timer);next.remove();reject(Error('Map image failed'));});
        next.addTo(map);
      });
      if(token!==sequence) { next.remove(); return false; }
      next.setOpacity(.8); overlay=next; previous?.remove();
      selected=data.frames.findIndex(item=>item.path===frame.path);
      $('radarFrameTime').textContent=time(frame.time)+' AEST';
      $('radarSlider').value=selected; $('radarSlider').setAttribute('aria-valuetext',time(frame.time)+' AEST');
      $('radarPosition').textContent=(selected+1)+' / '+data.frames.length;
      freshness(); return true;
    } catch {
      if(token===sequence) { pause(); status(overlay?'That radar frame couldn’t load. The time shown belongs to the retained image.':'Radar imagery couldn’t load. The map alone does not show whether it is raining. Try Refresh shortly.','error'); $('radarPosition').textContent=overlay?'Previous image retained':'Image unavailable'; }
      return false;
    }
  }
  async function playNext() {
    if(!playing || document.hidden) { pause(); return; }
    const ok=await show((selected+1)%data.frames.length);
    if(playing && ok) playTimer=setTimeout(playNext,selected===data.frames.length-1?1800:900);
  }
  function expire() {
    pause(); ++sequence; overlay?.remove(); overlay=null; data=null; selected=-1;
    $('radarFrameTime').textContent='Unavailable';
    for(const id of ['radarPlay','radarSlider','radarLatest']) $(id).disabled=true;
  }
  async function load() {
    if(busy) return; busy=true; lastAttempt=Date.now(); $('refreshRadar').disabled=true; pause();
    try {
      const response=await fetch('/api/radar',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(response.status===401) { location.assign('/login?next='+encodeURIComponent(location.pathname+'#radar')); return; }
      if(!response.ok) throw Error('Radar unavailable');
      const incoming=await response.json();
      if(incoming.host!=='https://tilecache.rainviewer.com'||!incoming.frames?.length) throw Error('Invalid radar');
      initMap(incoming.location); data=incoming;
      const valid=new Set(data.frames.map(imageUrl));
      for(const key of imageCache.keys()) if(!valid.has(key)) imageCache.delete(key);
      $('radarSlider').max=data.frames.length-1;
      $('radarStart').textContent=time(data.frames[0].time)+' AEST';
      $('radarEnd').textContent=time(data.frames.at(-1).time)+' · latest';
      for(const id of ['radarPlay','radarSlider','radarLatest']) $(id).disabled=false;
      $('radarPlay').disabled=data.frames.length<2;
      await show(data.frames.length-1);
    } catch {
      if(data && Date.now()-data.frames.at(-1).time*1000<2*60*minute) { data.stale=true; status('Couldn’t refresh radar. The last available frame is still shown with its original time.','stale'); }
      else { expire(); status('The radar feed is taking a break. Please try Refresh shortly.','error'); }
    } finally { busy=false; $('refreshRadar').disabled=false; }
  }
  const about=document.querySelector('.radar-about');
  document.addEventListener('click',event=>{if(about.open&&!about.contains(event.target))about.open=false;});
  about.addEventListener('keydown',event=>{if(event.key==='Escape'){about.open=false;about.querySelector('summary').focus();}});
  $('radarPlay').addEventListener('click',()=>{ if(playing) pause(); else { playing=true; $('radarPlay').textContent='Ⅱ Pause'; $('radarPlay').setAttribute('aria-pressed','true'); playNext(); } });
  $('radarSlider').addEventListener('input',()=>{ pause(); ++sequence; clearTimeout(inputTimer); inputTimer=setTimeout(()=>show(Number($('radarSlider').value)),180); });
  $('radarLatest').addEventListener('click',()=>{pause();show(data.frames.length-1);});
  $('radarReset').addEventListener('click',()=>{pause();if(map&&data)map.setView([data.location.latitude,data.location.longitude],map.getMinZoom());});
  $('refreshRadar').addEventListener('click',()=>{if(baseError&&baseLayer){baseError=false;baseLayer.redraw();}load();});
  function tick() {
    if(document.hidden) { pause(); return; }
    if(data && Date.now()-data.frames.at(-1).time*1000>=2*60*minute) { expire(); status('The last radar image is too old to show. Refreshing…','stale'); }
    if(Date.now()-lastAttempt>=(data?5*minute:minute)) load();
    else if(data && $('radarStatus').dataset.kind!=='error') freshness();
  }
  document.addEventListener('visibilitychange',tick); window.addEventListener('pagehide',pause); setInterval(tick,minute);
  load();
})();
