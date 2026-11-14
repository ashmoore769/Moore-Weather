'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { StationAlerts } = require('../lib/station-alerts');

const MINUTE = 60000;
const time = value => Date.parse(value + '+10:00');
const sub = (id = 'one') => ({ endpoint: 'https://web.push.apple.com/integration-' + id,
  keys: { auth: Buffer.alloc(16, 1).toString('base64url'),
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString('base64url') } });

function setup(t, initial, sender) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moore-alert-integration-'));
  let clock = time(initial);
  const sent = [], options = { filename: path.join(dir, 'alerts.sqlite'), now: () => clock,
    initialObservation: clock, startupGraceMs: 0, logger: { info() {}, warn() {} },
    send: async (device, raw, settings) => {
      const payload = JSON.parse(raw);
      if (sender) await sender(device, payload, settings);
      sent.push({ endpoint: device.endpoint, payload, settings });
    } };
  let alerts = new StationAlerts(options);
  t.after(() => { alerts.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get alerts() { return alerts; }, sent, now: () => clock,
    set: value => { clock = time(value); }, advance: amount => { clock += amount; },
    restart: () => { alerts.close(); alerts = new StationAlerts(options); } };
}

test('scheduled modem shutdown and reconnection remain quiet across restart without inventing fresh readings', async t => {
  const f = setup(t, '2026-11-15T04:54:00');
  f.alerts.subscribe(sub());
  const lastReal = f.now();
  for (let minute = 55; minute < 60; minute++) {
    f.set('2026-11-15T04:' + minute + ':00');
    await f.alerts.tick(null);
  }
  f.restart();
  for (let minute = 0; minute <= 4; minute++) {
    f.set('2026-11-15T05:0' + minute + ':00');
    await f.alerts.tick(lastReal); // Repeated old responses are not recovery.
    assert.equal(f.alerts.lastGood, lastReal);
    assert.equal(Number(f.alerts.db.prepare("SELECT value FROM settings WHERE key='lastGood'").get().value), lastReal);
  }
  assert.equal(f.sent.length, 0);
  assert.equal(f.alerts.find(sub()).alerted, 0);
  await f.alerts.tick(f.now());
  assert.equal(f.alerts.lastGood, f.now());
  assert.equal(f.sent.length, 0, 'a planned interruption does not create a back-online notice');
});

test('a prolonged post-maintenance failure alerts at the normal fifteen-minute threshold and then recovers', async t => {
  const f = setup(t, '2026-11-15T04:54:00');
  f.alerts.subscribe(sub());
  f.set('2026-11-15T05:05:00'); await f.alerts.tick(null);
  assert.equal(f.sent.length, 0);
  f.set('2026-11-15T05:09:00'); await f.alerts.tick(null);
  assert.equal(f.sent.length, 0);
  f.advance(1); await f.alerts.tick(null);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].payload.title, /station offline/);
  assert.match(f.sent[0].payload.body, /15 minutes/);
  f.restart(); await f.alerts.tick(null);
  assert.equal(f.sent.length, 1);
  f.set('2026-11-15T05:10:00'); await f.alerts.tick(f.now());
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].payload.title, /back online/);
});

test('an outage beginning around 04:45 is still reported during maintenance and its real recovery is delivered', async t => {
  const f = setup(t, '2026-11-15T04:44:00');
  f.alerts.subscribe(sub());
  f.set('2026-11-15T04:59:00'); await f.alerts.tick(null);
  assert.equal(f.sent.length, 0);
  f.set('2026-11-15T05:00:00'); await f.alerts.tick(null);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].payload.title, /station offline/);
  f.restart();
  f.set('2026-11-15T05:02:00'); await f.alerts.tick(f.now());
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].payload.title, /back online/);
  assert.equal(f.alerts.find(sub()).alerted, 0);
});

test('a warning delivered before the planned window retains recovery delivery inside it', async t => {
  const f = setup(t, '2026-11-15T04:29:00');
  f.alerts.subscribe(sub());
  f.set('2026-11-15T04:45:00'); await f.alerts.tick(null);
  assert.equal(f.sent.length, 1);
  f.restart();
  f.set('2026-11-15T04:56:00'); await f.alerts.tick(f.now());
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].payload.title, /back online/);
});

test('a genuine outage provider retry survives restart and is not hidden by the maintenance window', async t => {
  let attempts = 0;
  const f = setup(t, '2026-11-15T04:44:00', async () => {
    if (++attempts === 1) throw Object.assign(new Error('temporary'), { statusCode: 503 });
  });
  f.alerts.subscribe(sub());
  f.set('2026-11-15T05:00:00'); await f.alerts.tick(null);
  assert.equal(attempts, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.alerts.find(sub()).retry_after, time('2026-11-15T05:05:00'));
  f.restart();
  f.set('2026-11-15T05:04:00'); await f.alerts.tick(null);
  assert.equal(attempts, 1);
  f.set('2026-11-15T05:05:00'); await f.alerts.tick(null);
  assert.equal(attempts, 2); assert.equal(f.sent.length, 1);
  f.set('2026-11-15T05:06:00'); await f.alerts.tick(f.now());
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].payload.title, /back online/);
});

test('a device never successfully warned does not receive a recovery notice during maintenance', async t => {
  const f = setup(t, '2026-11-15T04:44:00', async () => {
    throw Object.assign(new Error('temporary'), { statusCode: 503 });
  });
  f.alerts.subscribe(sub());
  f.set('2026-11-15T05:00:00'); await f.alerts.tick(null);
  f.restart();
  f.set('2026-11-15T05:02:00'); await f.alerts.tick(f.now());
  f.set('2026-11-15T05:06:00'); await f.alerts.tick(f.now());
  assert.equal(f.sent.length, 0);
  assert.equal(f.alerts.find(sub()).alerted, 0);
});

test('unsubscribing removes only that device solar delivery state and cannot create retrospective notices', async t => {
  const f = setup(t, '2026-11-15T07:00:00');
  f.alerts.subscribe(sub('one')); f.alerts.subscribe(sub('two'));
  const solar = () => ({ enabled: true, ready: true, current: {
    observedAt: new Date(f.now()).toISOString(), collectedAt: new Date(f.now()).toISOString(),
    receivedAt: new Date(f.now()).toISOString(), inverterPowerW: 2000, loadPowerW: 1000,
    gridPowerW: -1000, batteryPowerW: null, meterLocation: 'grid', mode: 'meter'
  } });
  for (let minute = 0; minute <= 2; minute++) {
    if (minute) f.advance(MINUTE);
    await f.alerts.solar.tick(solar());
  }
  assert.equal(f.sent.length, 2);
  assert.equal(f.alerts.db.prepare('SELECT COUNT(*) n FROM solar_alert_deliveries').get().n, 2);
  f.alerts.unsubscribe(sub('one'));
  const remaining = f.alerts.db.prepare('SELECT endpoint FROM solar_alert_deliveries').all();
  assert.deepEqual(remaining.map(row => row.endpoint), [sub('two').endpoint]);
  f.alerts.subscribe(sub('one')); f.advance(MINUTE);
  await f.alerts.solar.tick(solar());
  assert.equal(f.sent.length, 2);
});

test('config API exposes public policy and public VAPID key only, and respects solar and maintenance disable switches', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moore-alert-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Isolate mountAlerts' long-lived database and timer ownership. The child has
  // no subscribers, and its timer is stubbed so no outbound push can occur.
  const script = String.raw`
    const path=require('node:path');
    const {DatabaseSync}=require('node:sqlite');
    global.setInterval=()=>({unref(){}});
    const {mountAlerts}=require('./lib/station-alerts');
    const outputs=[];
    for(const [name,extra] of [['enabled',{}],['solar-disabled',{SOLAR_ALERTS_ENABLED:'false'}],['maintenance-disabled',{WEATHER_PLANNED_MODEM_OUTAGE_ENABLED:'false'}]]) {
      const routes=new Map(), app={get(route,handler){routes.set(route,handler);},post(){}};
      let reads=0;
      const env={WEATHER_DB_PATH:path.join(process.argv[1],name,'weather.sqlite'),...extra};
      mountAlerts(app,{env,logger:{info(){},warn(){},error(message){throw Error(message);}},
        getObservation:()=>Date.now(),getSolarObservation:()=>{reads++;return {enabled:true,ready:false,current:null};}});
      let body,cache;
      routes.get('/api/alerts/config')({}, {set(key,value){cache=[key,value];return this;},json(value){body=value;}});
      const db=new DatabaseSync(path.join(process.argv[1],name,'station-alerts.sqlite'));
      const vapid=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='vapid'").get().value);
      const privateAbsent=!JSON.stringify(body).includes(vapid.privateKey);
      db.close();
      outputs.push({name,body,cache,reads,privateAbsent});
    }
    process.stdout.write(JSON.stringify(outputs));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['-e', script, dir], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' }
  });
  assert.equal(result.status, 0, result.stderr);
  const [enabled, solarOff, maintenanceOff] = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(enabled.body).sort(), ['enabled', 'maintenance', 'publicKey', 'solar', 'thresholdMinutes']);
  assert.equal(enabled.body.enabled, true);
  assert.match(enabled.body.publicKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(enabled.body.thresholdMinutes, 15);
  assert.deepEqual(enabled.cache, ['Cache-Control', 'no-store']);
  assert.equal(enabled.body.solar.enabled, true);
  assert.equal(enabled.body.solar.marginW, 100);
  assert.equal(enabled.body.solar.morningDwellMinutes, 2);
  assert.equal(enabled.body.solar.eveningDwellMinutes, 10);
  assert.deepEqual(enabled.body.maintenance, { enabled: true, timezone: 'Australia/Brisbane', start: '04:55', end: '05:00', graceMinutes: 5 });
  assert.equal(solarOff.body.enabled, true);
  assert.equal(solarOff.body.solar.enabled, false);
  assert.equal(solarOff.reads, 0);
  assert.equal(maintenanceOff.body.maintenance.enabled, false);
  assert.equal(maintenanceOff.body.solar.enabled, true);
  assert.ok([enabled, solarOff, maintenanceOff].every(output => output.privateAbsent));
  for (const output of [enabled, solarOff, maintenanceOff]) {
    assert.doesNotMatch(JSON.stringify(output.body), /privateKey|subscriptions|p256dh|endpoint|SOLAR_INGEST_TOKEN/);
  }
});
