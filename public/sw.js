/* Notifications only: weather/API responses are never cached by this worker. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data={};
  try {data=event.data?.json() || {};} catch {}
  event.waitUntil(self.registration.showNotification(data.title || 'Moore Weather',{
    body:data.body || 'Open Moore Weather to check the station.',
    icon:'/moore-weather-icon-192-v2.png',tag:data.tag || 'moore-weather-status',
    renotify:data.kind==='history-missing',
    ...(Number.isFinite(data.timestamp)?{timestamp:data.timestamp}:{}),
    data:{url:['/#localWater','/#historyStatus'].includes(data.url)?data.url:'/'}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const requested=event.notification.data?.url;
    const destination=['/#localWater','/#historyStatus'].includes(requested)?requested:'/';
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows) if(new URL(client.url).origin===self.location.origin) {
      if(destination!=='/') {
        try {const navigated=await client.navigate(destination); if(navigated)return navigated.focus();} catch {}
      }
      return client.focus();
    }
    return self.clients.openWindow(destination);
  })());
});
