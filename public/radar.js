/* Regional images use one RainViewer request per frame, rather than a tile grid.
   This keeps a two-hour animation comfortably within the free feed's limits. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id), minute=60000;
  const time=seconds=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(seconds*1000);
  let map, bounds, overlay, baseLayer, zoomControl, baseError=false, data, selected=-1, sequence=0, playing=false, playTimer, inputTimer, busy=false, lastAttempt=0, lastImageRequest=0;
  let interactive=false, tapPointer=null, tapReady=false;
  const panel=$('radar'), stage=panel.querySelector('.radar-map-stage'), mapElement=$('radarMap'), interaction=$('radarInteraction');
  // Verified QLD address point. The regional image remains centred on Warwick;
  // only this unobtrusive station marker sits at the property to its west.
  const stationLocation=[-28.213713,151.9893045];
  const imageCache=new Map();
  function status(message,kind='') { $('radarStatus').textContent=message; $('radarStatus').dataset.kind=kind; }
  function pause() { playing=false; clearTimeout(playTimer); $('radarPlay').innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z"/></svg><span>Play</span>'; $('radarPlay').setAttribute('aria-pressed','false'); }
  function setInteractive(enabled) {
    interactive=Boolean(map && enabled); tapPointer=null; tapReady=false;
    for(const name of ['dragging','touchZoom','doubleClickZoom','scrollWheelZoom','boxZoom','keyboard','tapHold']) map?.[name]?.[interactive?'enable':'disable']();
    zoomControl?.[interactive?'enable':'disable']();
    if(!interactive) { map?.stop(); map?.closePopup(); }
    stage.dataset.interactive=String(interactive);
    // Explicitly override Leaflet's touch classes while locked. Scrolling past
    // the tile must move the page, and browser-level pinch remains available.
    mapElement.style.touchAction=interactive?'none':'pan-y pinch-zoom';
    mapElement.tabIndex=interactive?0:-1;
    interaction.disabled=!map;
    interaction.textContent=interactive?'Done':'Tap to explore';
    interaction.setAttribute('aria-pressed',String(interactive));
    interaction.setAttribute('aria-label',interactive?'Lock radar map movement':'Enable radar map movement');
  }
  function mapControl(target) { return target.closest?.('.leaflet-control,.leaflet-popup'); }
  mapElement.addEventListener('pointerdown',event=>{
    tapReady=false;
    if(interactive || event.button>0 || event.isPrimary===false || mapControl(event.target)) { tapPointer=null; return; }
    tapPointer={id:event.pointerId,x:event.clientX,y:event.clientY,at:Date.now(),moved:false};
  },{passive:true});
  mapElement.addEventListener('pointermove',event=>{
    if(tapPointer?.id===event.pointerId && Math.hypot(event.clientX-tapPointer.x,event.clientY-tapPointer.y)>8) tapPointer.moved=true;
  },{passive:true});
  mapElement.addEventListener('pointerup',event=>{
    tapReady=Boolean(tapPointer?.id===event.pointerId && !tapPointer.moved && Date.now()-tapPointer.at<600 && Math.hypot(event.clientX-tapPointer.x,event.clientY-tapPointer.y)<=8);
    tapPointer=null;
  },{passive:true});
  mapElement.addEventListener('pointercancel',()=>{tapPointer=null;tapReady=false;},{passive:true});
  mapElement.addEventListener('click',event=>{
    // A completed short tap activates; a scroll, drag, long-press or pinch never
    // unlocks the map as a side effect of moving down the dashboard.
    if(!interactive && tapReady && !mapControl(event.target)) setInteractive(true);
    tapReady=false;
  });
  interaction.addEventListener('click',()=>setInteractive(!interactive));
  document.addEventListener('click',event=>{if(interactive&&!panel.contains(event.target))setInteractive(false);});
  panel.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&interactive) { setInteractive(false); interaction.focus(); event.preventDefault(); }
  });
  setInteractive(false);
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
    map=L.map('radarMap',{center:centre,zoom:7,minZoom:7,maxZoom:10,zoomSnap:.5,dragging:false,touchZoom:false,doubleClickZoom:false,scrollWheelZoom:false,boxZoom:false,keyboard:false,tapHold:false,zoomControl:false,attributionControl:true});
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
    zoomControl=L.control.zoom({position:'bottomright'}).addTo(map);
    L.circleMarker(stationLocation,{radius:5,weight:2,color:'#fff',fillColor:'#178a84',fillOpacity:1}).addTo(map).bindPopup('Moore Weather station',{closeButton:false});
    L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
    setInteractive(false);
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
  $('radarPlay').addEventListener('click',()=>{ if(playing) pause(); else { playing=true; $('radarPlay').innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg><span>Pause</span>'; $('radarPlay').setAttribute('aria-pressed','true'); playNext(); } });
  $('radarSlider').addEventListener('input',()=>{ pause(); ++sequence; clearTimeout(inputTimer); inputTimer=setTimeout(()=>show(Number($('radarSlider').value)),180); });
  $('radarLatest').addEventListener('click',()=>{pause();show(data.frames.length-1);});
  $('radarReset').addEventListener('click',()=>{pause();if(map&&data)map.setView([data.location.latitude,data.location.longitude],map.getMinZoom());});
  $('refreshRadar').addEventListener('click',()=>{if(baseError&&baseLayer){baseError=false;baseLayer.redraw();}load();});
  function tick() {
    if(document.hidden) { pause(); setInteractive(false); return; }
    if(data && Date.now()-data.frames.at(-1).time*1000>=2*60*minute) { expire(); status('The last radar image is too old to show. Refreshing…','stale'); }
    if(Date.now()-lastAttempt>=(data?5*minute:minute)) load();
    else if(data && $('radarStatus').dataset.kind!=='error') freshness();
  }
  document.addEventListener('visibilitychange',tick); window.addEventListener('pagehide',()=>{pause();setInteractive(false);}); setInterval(tick,minute);
  load();
})();
