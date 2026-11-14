'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const { BridgeAlerts } = require('./bridge-alerts');
const { HistoryAlerts, historyHealth } = require('./history-alerts');
const { SolarAlerts, POLICY: SOLAR_POLICY } = require('./solar-alerts');
const { createStationMaintenance } = require('./station-maintenance');
const { encodePushTopic, pushFailureReason } = require('./push-delivery');
const STALE_MS = 15 * 60 * 1000;
const FRESH_MS = 3 * 60 * 1000;
function observationTime(raw) {
  const fields = String(raw || '').split(',');
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(fields[0]) || !/^\d{2}:\d{2}:\d{2}$/.test(fields[1])) return null;
  const iso = fields[0].replaceAll('/', '-') + 'T' + fields[1] + '+10:00';
  const value = Date.parse(iso);
  if (!Number.isFinite(value) || new Date(value + 36000000).toISOString().slice(0,19) !== iso.slice(0,19)) return null;
  return value;
}
function validateSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) throw Error('Invalid push subscription.');
  const url = new URL(value.endpoint);
  const allowed = ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','notify.windows.com'];
  // Only browser push gateways may receive requests; never arbitrary URLs.
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !allowed.some(host => url.hostname === host || (host !== 'fcm.googleapis.com' && url.hostname.endsWith('.'+host)))) throw Error('Unsupported push provider.');
  for (const [name,length] of [['auth',16],['p256dh',65]]) {
    const key = value.keys?.[name];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(key) || Buffer.from(key,'base64url').length !== length) throw Error('Invalid subscription key.');
  }
  if (Buffer.from(value.keys.p256dh,'base64url')[0] !== 4) throw Error('Invalid public key.');
  return {endpoint:url.href,keys:{auth:value.keys.auth,p256dh:value.keys.p256dh}};
}
class StationAlerts {
  constructor({filename,now=Date.now,send=webpush.sendNotification.bind(webpush),logger=console,initialObservation=null,startupGraceMs=120000,maintenance=createStationMaintenance()}) {
    this.now=now; this.send=send; this.logger=logger; this.busy=false;
    this.maintenance=maintenance;
    this.started=now(); this.startupGraceMs=startupGraceMs;
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename); fs.chmodSync(filename,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY,payload TEXT NOT NULL,alerted INTEGER NOT NULL DEFAULT 0,retry_after INTEGER NOT NULL DEFAULT 0,test_after INTEGER NOT NULL DEFAULT 0);');
    const get=key=>this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
    const saved=get('vapid');
    this.vapid=saved ? JSON.parse(saved) : webpush.generateVAPIDKeys();
    if(!saved)this.save('vapid',JSON.stringify(this.vapid));
    this.lastGood=Number(get('lastGood')) || (Number.isFinite(initialObservation) && initialObservation <= now()+90000 ? initialObservation : now());
    this.save('lastGood',String(this.lastGood));
    this.history = new HistoryAlerts({ db: this.db, now: this.now, deliver: (row, payload, options) => this.deliver(row, payload, options), logger, startupGraceMs, maintenance });
    this.bridge = new BridgeAlerts({ db: this.db, now: this.now, deliver: (row, payload, options) => this.deliver(row, payload, options) });
    this.solar = new SolarAlerts({ db: this.db, now: this.now, deliver: (row, payload, options) => this.deliver(row, payload, options), logger, startupGraceMs });
  }
  save(key,value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  observe(value) {
    const now=this.now();
    if (Number.isFinite(value) && value<=now+90000 && now-value<=FRESH_MS && value>this.lastGood) {
      this.lastGood=Math.min(value,now); this.save('lastGood',String(this.lastGood));
    }
  }
  subscribe(input) {
    const sub=validateSubscription(input), old=this.db.prepare('SELECT payload FROM subscriptions WHERE endpoint=?').get(sub.endpoint);
    if(old && JSON.parse(old.payload).keys.auth !== sub.keys.auth) throw Error('Subscription does not match this device.');
    if(!old && this.db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n>=100) throw Error('The station alert device limit has been reached.');
    this.db.prepare('INSERT INTO subscriptions(endpoint,payload) VALUES (?,?) ON CONFLICT(endpoint) DO UPDATE SET payload=excluded.payload').run(sub.endpoint,JSON.stringify(sub));
    return sub;
  }
  find(input) {
    const sub=validateSubscription(input), row=this.db.prepare('SELECT * FROM subscriptions WHERE endpoint=?').get(sub.endpoint);
    if(!row || JSON.parse(row.payload).keys.auth!==sub.keys.auth) throw Error('This device is not subscribed.');
    return row;
  }
  unsubscribe(input) { const row=this.find(input); this.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(row.endpoint); this.bridge.forget(row.endpoint); this.history.forget(row.endpoint); this.solar.forget(row.endpoint); }
  async deliver(row,payload,options={}) {
    try {
      const deliveryOptions={vapidDetails:{subject:'https://moore-weather.onrender.com',...this.vapid},TTL:900,urgency:'normal',topic:'moore-station-status',timeout:10000,...options};
      deliveryOptions.topic=encodePushTopic(deliveryOptions.topic);
      await this.send(JSON.parse(row.payload),JSON.stringify(payload),deliveryOptions);
      return true;
    } catch(error) {
      if(error.statusCode===404 || error.statusCode===410) this.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(row.endpoint);
      else {
        const kind=['solar-solar','solar-grid','history-missing','history-recovered','bridge-near','bridge-cross'].includes(payload.kind)?' '+payload.kind:'';
        const reason=pushFailureReason(error);
        this.logger.warn('[ALERTS] Push'+kind+' delivery failed'+(Number.isInteger(error.statusCode)?' (HTTP '+error.statusCode+')':'')+(reason?' ['+reason+']':'')+'; retrying later.');
      }
      return false;
    }
  }
  async test(input) {
    const row=this.find(input);
    if(row.test_after>this.now()) throw Error('Please wait one minute before sending another test.');
    this.db.prepare('UPDATE subscriptions SET test_after=? WHERE endpoint=?').run(this.now()+60000,row.endpoint);
    if(!await this.deliver(row,{title:'Moore Weather alerts are ready',body:'Moore Weather can send push notifications to this device.',tag:'moore-weather-test'})) throw Error('The push provider could not accept the test. Try enabling alerts again.');
  }
  async tick(observed) {
    this.observe(observed);
    if(this.busy || this.now()-this.started<this.startupGraceMs) return;
    this.busy=true;
    try {
      const age=this.now()-this.lastGood, stale=age>STALE_MS, fresh=age<=FRESH_MS;
      for(const row of this.db.prepare('SELECT * FROM subscriptions WHERE retry_after<=?').all(this.now())) {
        // Planned modem downtime never changes the real observation time or
        // clears a genuine incident. Without an accepted outage push, there is
        // also no routine "back online" push for that planned interruption.
        if(stale && this.maintenance.suppressOffline({now:this.now(),lastGood:this.lastGood,alreadyAlerted:Boolean(row.alerted)})) continue;
        if((stale&&!row.alerted)||(fresh&&row.alerted)) {
          this.db.prepare('UPDATE subscriptions SET retry_after=? WHERE endpoint=?').run(this.now()+300000,row.endpoint);
          const payload=stale ? {title:'Moore Weather · station offline',body:'No fresh station reading for '+Math.floor(age/60000)+' minutes. Open the app to check its status.',tag:'moore-weather-status'} : {title:'Moore Weather · back online',body:'Fresh weather readings are arriving again.',tag:'moore-weather-status'};
          if(await this.deliver(row,payload)) {
            this.db.prepare('UPDATE subscriptions SET alerted=?,retry_after=0 WHERE endpoint=?').run(stale?1:0,row.endpoint);
            this.logger.info?.('[ALERTS] Station '+(stale?'offline':'recovered')+' notification accepted by push provider.');
          }
        }
      }
    } finally {this.busy=false;}
  }
  close(){this.db.close();}
}
function mountAlerts(app,{env,logger,getObservation,getBridgeObservation,getHistoryObservation,getSolarObservation}) {
  let alerts=null;
  const maintenance=createStationMaintenance(env);
  const solarEnabled=typeof getSolarObservation==='function' && env.SOLAR_ALERTS_ENABLED!=='false';
  if(env.WEATHER_DB_PATH && env.WEATHER_ALERTS_ENABLED!=='false') {
    try {alerts=new StationAlerts({filename:path.join(path.dirname(path.resolve(env.WEATHER_DB_PATH)),'station-alerts.sqlite'),logger,initialObservation:getObservation(),maintenance});}
    catch {logger.error('[ALERTS] Notification storage could not be opened. Station polling remains active.');}
  }
  let historySnapshot, historyCheckedAt = 0;
  const readHistory = () => {
    if (!historySnapshot || Date.now() - historyCheckedAt >= 30000) {
      try { historySnapshot = getHistoryObservation ? getHistoryObservation() : { enabled: false }; }
      catch { historySnapshot = { enabled: true, ready: false, streams: {} }; }
      historyCheckedAt = Date.now();
    }
    return historySnapshot;
  };
  const readSolar = () => {
    if(!solarEnabled)return {enabled:false,ready:false,current:null};
    try {return getSolarObservation();}
    catch {return {enabled:true,ready:false,current:null};}
  };
  const solarConfig = () => ({enabled:!!alerts && solarEnabled && readSolar()?.enabled===true,
    timezone:SOLAR_POLICY.timezone,marginW:SOLAR_POLICY.marginW,
    morningDwellMinutes:SOLAR_POLICY.solarHoldMinutes,eveningDwellMinutes:SOLAR_POLICY.gridHoldMinutes,
    eveningStart:String(SOLAR_POLICY.eveningStartHour).padStart(2,'0')+':00'});
  app.get('/api/alerts/history',(req,res)=>{
    res.set('Cache-Control','no-store').json(historyHealth(readHistory()));
  });
  app.get('/api/alerts/config',(req,res)=>{res.set('Cache-Control','no-store').json({enabled:!!alerts,publicKey:alerts?.vapid.publicKey || null,thresholdMinutes:15,solar:solarConfig(),maintenance:maintenance.config});});
  const json=require('express').json({limit:'8kb'});
  app.post('/api/alerts/:action',(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!alerts)return res.status(503).json({error:'Station alerts are not available.'});
    if(req.get('origin') !== req.protocol+'://'+req.get('host'))return res.status(403).json({error:'Open alerts from the weather app.'});
    if(!req.is('application/json'))return res.status(415).json({error:'JSON required.'});
    json(req,res,next);
  },async(req,res)=>{
    try {
      if(req.params.action==='subscribe')alerts.subscribe(req.body);
      else if(req.params.action==='unsubscribe')alerts.unsubscribe(req.body);
      else if(req.params.action==='test')await alerts.test(req.body);
      else return res.status(404).json({error:'Unknown alert action.'});
      res.json({ok:true});
    } catch(error) {res.status(400).json({error:error.message});}
  });
  if(alerts) {
    let checkingBridge=false;
    const checkBridge=async()=>{
      if(!getBridgeObservation || checkingBridge)return;
      checkingBridge=true;
      try { await alerts.bridge.tick(await getBridgeObservation()); }
      catch {logger.warn('[ALERTS] River check unavailable; waiting for fresh saved readings.');}
      finally {checkingBridge=false;}
    };
    const timer=setInterval(()=>{
      alerts.tick(getObservation()).catch(()=>logger.error('[ALERTS] Monitor check failed.'));
      checkBridge();
      alerts.history.tick(readHistory()).catch(()=>logger.error('[ALERTS] History monitor check failed.'));
      alerts.solar.tick(readSolar()).catch(()=>logger.error('[ALERTS] Solar monitor check failed.'));
    },60000); timer.unref();
  }
  if(alerts && getHistoryObservation) logger.info('[ALERTS] Saved-history monitor enabled; repeat reminders every 15 minutes; '+alerts.db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n+' subscribed devices.');
  if(alerts && solarEnabled) logger.info('[ALERTS] Solar crossover monitor enabled; once per direction per AEST day.');
  if(alerts && maintenance.config.enabled) logger.info('[ALERTS] Planned modem pause: 04:55-05:00 AEST; reconnection grace ends 05:05.');
  return {status:()=>({enabled:!!alerts,thresholdMinutes:15,history:historyHealth(readHistory()),solar:solarConfig(),maintenance:maintenance.config})};
}
module.exports={StationAlerts,validateSubscription,observationTime,mountAlerts,STALE_MS};
