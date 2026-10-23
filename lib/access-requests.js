'use strict';
const { DatabaseSync } = require('node:sqlite');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');

const RETRY_BASE_MS = 30000;
const LEASE_MS = 60000;
const DEDUP_MS = 30000;
const HOUR = 60 * 60 * 1000;
const RETENTION_MS = 30 * 24 * HOUR;
const MAX_PENDING = 100;
const FORM_ENDPOINT = 'https://formspree.io/f/mrppzvvk';
const FORM_URL = 'https://moore-weather.onrender.com/login';
const RECEIVED = "Thanks! Your request is saved. The email notification is still pending, so there's no need to submit again.";
const ACCEPTED = "Thanks for requesting access! I'll get back to you shortly by email.";
const DELAYED = "Thanks! Your request is saved, but the email notification hasn't gone through yet. We'll keep trying. You can also use the contact address below.";
const UNAVAILABLE = 'The access-request email service is unavailable. This submission has not been saved. Please use the contact address below.';

class RequestQueue {
  constructor(filename) {
    this.db = new DatabaseSync(filename, { timeout: 1000 });
    // The legacy access_request_gate is deliberately unused: its five-minute
    // restriction must not carry over when upgrading a live installation.
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS access_request_provider_pause (id INTEGER PRIMARY KEY CHECK(id=1), until_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO access_request_provider_pause VALUES(1,0);
      CREATE TABLE IF NOT EXISTS access_request_settings (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access_request_queue (
        id TEXT PRIMARY KEY, email_key TEXT UNIQUE NOT NULL, name TEXT, email TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','sending','sent')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        lease_until INTEGER NOT NULL DEFAULT 0, last_failure TEXT);
      CREATE INDEX IF NOT EXISTS access_request_due ON access_request_queue(state,next_attempt_at);
      CREATE TABLE IF NOT EXISTS access_request_delivery_health (id INTEGER PRIMARY KEY CHECK(id=1), last_failure TEXT);
      INSERT OR IGNORE INTO access_request_delivery_health(id,last_failure)
        VALUES(1,(SELECT last_failure FROM access_request_queue WHERE last_failure IS NOT NULL ORDER BY next_attempt_at DESC LIMIT 1));
      CREATE TABLE IF NOT EXISTS access_request_provider (id INTEGER PRIMARY KEY CHECK(id=1), endpoint TEXT NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO access_request_settings VALUES(1,?)').run(randomBytes(32).toString('hex'));
    this.salt = this.db.prepare('SELECT salt FROM access_request_settings WHERE id=1').get().salt;
  }
  close() { this.db.close(); }
  useProvider(endpoint, now) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT endpoint FROM access_request_provider WHERE id=1').get()?.endpoint === endpoint) return false;
      // This is a provider migration, not a restart reset. FormSubmit's failure
      // and backoff must not disable the new Formspree connection. Keep all
      // request references, contact details, timestamps and unexpired leases.
      this.db.prepare('INSERT OR REPLACE INTO access_request_provider VALUES(1,?)').run(endpoint);
      this.db.exec('UPDATE access_request_provider_pause SET until_at=0 WHERE id=1; UPDATE access_request_delivery_health SET last_failure=NULL WHERE id=1;');
      this.db.prepare("UPDATE access_request_queue SET state='queued',attempts=0,next_attempt_at=?,lease_until=0,last_failure=NULL WHERE state='queued' OR (state='sending' AND lease_until<=?)").run(now, now);
      return true;
    });
  }
  receipt(id) {
    return this.db.prepare('SELECT state,last_failure FROM access_request_queue WHERE id=?').get(id);
  }
  deliveryAvailable() {
    return !this.db.prepare('SELECT last_failure FROM access_request_delivery_health WHERE id=1').get().last_failure;
  }
  key(value) { return createHmac('sha256', this.salt).update(value).digest('hex'); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prune(now) {
    return this.db.prepare('DELETE FROM access_request_queue WHERE expires_at<=? AND (state!=\'sending\' OR lease_until<=?)').run(now, now).changes;
  }
  enqueue(person, now) {
    return this.transaction(() => {
      // Recheck inside the transaction: a worker may have discovered an outage
      // since the visitor loaded the page. Leave existing requests intact.
      if (!this.deliveryAvailable()) return { accepted: false, unavailable: true };
      this.prune(now);
      const emailKey = this.key('email:' + person.email.toLowerCase());
      // Same response for a new or duplicate request; a lost HTTP response is safe
      // to retry and does not create another notification.
      const existing = this.db.prepare('SELECT id FROM access_request_queue WHERE email_key=?').get(emailKey);
      if (existing) return { accepted: true, id: existing.id };
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM access_request_queue WHERE state!='sent'").get().n;
      // Bound storage during an outage; there is no per-person or global timer.
      if (pending >= MAX_PENDING) return { accepted: false };
      const id = randomUUID();
      this.db.prepare(`INSERT INTO access_request_queue
        (id,email_key,name,email,created_at,expires_at,state,next_attempt_at) VALUES(?,?,?,?,?,?,'queued',?)`)
        .run(id, emailKey, person.name, person.email, now, now + RETENTION_MS, now);
      return { accepted: true, id };
    });
  }
  take(now) {
    return this.transaction(() => {
      this.prune(now);
      if (this.db.prepare('SELECT until_at FROM access_request_provider_pause WHERE id=1').get().until_at > now) return null;
      const item = this.db.prepare(`SELECT * FROM access_request_queue WHERE
        (state='queued' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?)
        ORDER BY next_attempt_at,created_at LIMIT 1`).get(now, now);
      if (!item) return null;
      this.db.prepare("UPDATE access_request_queue SET state='sending',lease_until=?,attempts=attempts+1 WHERE id=?")
        .run(now + LEASE_MS, item.id);
      return { ...item, attempts: item.attempts + 1 };
    });
  }
  finish(item, now, failure = null, retryAfter = 0) {
    return this.transaction(() => {
      // A recovered worker owns a new attempt; a stale completion must not
      // overwrite its result after an unusually long process suspension.
      if (!this.db.prepare("SELECT 1 FROM access_request_queue WHERE id=? AND state='sending' AND attempts=?").get(item.id, item.attempts)) return false;
      this.db.prepare('UPDATE access_request_delivery_health SET last_failure=? WHERE id=1').run(failure);
      if (!failure) {
        this.db.prepare("UPDATE access_request_queue SET state='sent',name=NULL,email=NULL,lease_until=0,last_failure=NULL,expires_at=? WHERE id=?")
          .run(now + DEDUP_MS, item.id);
      } else {
        const setupDelay = /activation|captcha|form_origin|http_403|http_429|rate_limit/.test(failure) ? HOUR : 0;
        const delay = Math.max(setupDelay, Math.min(HOUR, RETRY_BASE_MS * 2 ** Math.min(item.attempts - 1, 7)), retryAfter * 1000);
        this.db.prepare('UPDATE access_request_provider_pause SET until_at=MAX(until_at,?) WHERE id=1').run(now + delay);
        this.db.prepare("UPDATE access_request_queue SET state='queued',lease_until=0,next_attempt_at=?,last_failure=? WHERE id=?")
          .run(now + delay, failure, item.id);
      }
      return true;
    });
  }
}

function validate(body) {
  if (!body || typeof body.name !== 'string' || typeof body.email !== 'string') return null;
  const name = body.name.trim(), email = body.email.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return null;
  if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email)) return null;
  if (body.website !== undefined && (typeof body.website !== 'string' || body.website.trim())) return null;
  return { name, email };
}

function providerFailure(result) {
  // Never log raw responses, visitor details, activation tokens or HTML.
  const errors = Array.isArray(result?.errors) ? result.errors.slice(0, 10) : [];
  const message = [result?.message, result?.error, ...errors.flatMap(e => [e?.code, e?.message])]
    .filter(v => typeof v === 'string').map(v => v.slice(0, 200)).join(' ').toLowerCase();
  if (/inactiv|activat|confirm.*form|verify.*email/.test(message)) return 'activation_required';
  if (/rate.limit|too many|submission limit/.test(message)) return 'provider_rate_limit';
  if (/form_not_found|project_not_found/.test(message)) return 'provider_form_not_found';
  if (/blocked/.test(message)) return 'provider_blocked';
  if (/web server|referer|referrer|origin/.test(message)) return 'provider_form_origin';
  if (/captcha/.test(message)) return 'provider_captcha';
  return 'provider_unconfirmed';
}

function providerAccepted(result) {
  // Match Formspree's official client: success contains a string `next` and
  // errors take precedence. Never follow the returned URL or accept an HTML
  // response, legacy FormSubmit flag, false `ok`, or CAPTCHA challenge.
  return Boolean(result && typeof result === 'object' && !Array.isArray(result) &&
    !('error' in result) && !('errors' in result) && !('stripe' in result) &&
    (!('ok' in result) || result.ok === true) && typeof result.next === 'string' && result.next.length > 0 &&
    !/captcha|challenge|verify/i.test(result.next));
}

function createAccessRequests({ env = process.env, logger = console, fetchImpl = fetch, clock = Date.now, responseWaitMs = 12000 } = {}) {
  const filename = env.ACCESS_REQUEST_DB_PATH || (env.WEATHER_DB_PATH ? path.join(path.dirname(env.WEATHER_DB_PATH), 'access-requests.sqlite') : '');
  const configured = Boolean(filename && env.ACCESS_REQUESTS_ENABLED !== 'false');
  let queue, timer, active, controller, closed = false, closing = false;
  function storage() {
    if (closed) throw Error('Closed');
    if (!queue) {
      const opened = new RequestQueue(filename);
      try { opened.useProvider(FORM_ENDPOINT, clock()); queue = opened; }
      catch (error) { opened.close(); throw error; }
    }
    return queue;
  }
  function status() {
    if (!configured || closed || closing) return { enabled: false, retryAfter: 0 };
    try { return { enabled: storage().deliveryAvailable(), retryAfter: 0 }; }
    catch { return { enabled: false, retryAfter: 0 }; }
  }
  async function submit(body) {
    const person = validate(body);
    if (!person) return { status: 400, body: { error: 'Please enter your name and a valid email address.' } };
    if (configured && !closed && !closing) {
      try {
        const result = storage().enqueue(person, clock());
        if (result.unavailable) return { status: 503, body: { unavailable: true, error: UNAVAILABLE } };
        if (result.accepted) return { status: 202, body: { ok: true, reference: result.id, delivery: 'pending', message: RECEIVED } };
        return { status: 503, body: { error: 'Access requests are temporarily full. Your details are still here; please try again later.' } };
      } catch { logger.warn('[ACCESS] Could not save request: storage_unavailable.'); }
    }
    return { status: 503, body: { error: 'We could not save your request just now. Your details are still here; please try again shortly.' } };
  }
  async function deliver() {
    let item;
    try { item = storage().take(clock()); }
    catch { logger.warn('[ACCESS] Queue unavailable: storage_unavailable.'); return; }
    if (!item) return;
    let failure = null, retryAfter = 0;
    controller = new AbortController();
    try {
      const response = await fetchImpl(FORM_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json',
          Referer: FORM_URL, Origin: new URL(FORM_URL).origin },
        body: JSON.stringify({ name: item.name, email: item.email,
          subject: 'Moore Weather access request', source: FORM_URL,
          request_reference: item.id,
          message: 'A visitor has requested access to Moore Weather. Reply to this email to contact them. Access has not been granted automatically.' })
      });
      const retryHeader = response.headers?.get('retry-after');
      const seconds = /^\d+$/.test(retryHeader || '') ? Number(retryHeader) : Math.ceil((Date.parse(retryHeader) - clock()) / 1000);
      if (Number.isFinite(seconds)) retryAfter = Math.min(RETENTION_MS / 1000, Math.max(0, seconds));
      let result;
      try { result = await response.json(); } catch { /* HTTP category takes precedence over a non-JSON error page. */ }
      const category = providerFailure(result);
      if (!response.ok) failure = category !== 'provider_unconfirmed' ? category : 'provider_http_' + (Number.isInteger(response.status) ? response.status : 'error');
      else if (!result) failure = 'provider_invalid_json';
      else if (!providerAccepted(result)) failure = /captcha|challenge|verify/i.test(String(result?.next || '')) ? 'provider_captcha' : category;
    } catch (error) {
      failure = error?.name === 'TimeoutError' ? 'provider_timeout' : error?.name === 'AbortError' ? 'provider_interrupted' : 'provider_network_error';
    } finally { controller = undefined; }
    try { if (!storage().finish(item, clock(), failure, retryAfter)) return; }
    catch { logger.warn('[ACCESS] Email result could not be saved; persisted lease will allow recovery.'); return; }
    if (failure) logger.warn(`[ACCESS] Email ${item.id}: ${failure}; request retained for background retry (attempt ${item.attempts}).`);
    else logger.info?.(`[ACCESS] Email ${item.id}: provider_accepted; personal details cleared.`);
    return true;
  }
  function runDue() {
    if (!configured || closed || closing) return Promise.resolve();
    if (!active) active = (async () => {
      while (!closing && !closed && await deliver()) { /* Drain ready requests without a send cooldown. */ }
    })().finally(() => { active = undefined; });
    return active;
  }
  function start() {
    if (!configured || closed || closing || timer) return;
    timer = setInterval(() => { void runDue(); }, 30000); timer.unref();
    void runDue();
  }
  async function submitAndDeliver(body) {
    const result = await submit(body);
    if (result.status !== 202) return result;
    let deadline;
    try {
      // Normal requests finish on the first provider response. A slow backlog
      // cannot hold the browser indefinitely; the durable worker continues.
      await Promise.race([runDue(), new Promise(resolve => { deadline = setTimeout(resolve, responseWaitMs); })]);
      const receipt = storage().receipt(result.body.reference);
      if (receipt?.state === 'sent') return { status: 200, body: { ...result.body, delivery: 'accepted', message: ACCEPTED } };
      if (receipt?.last_failure) return { status: 202, body: { ...result.body, delivery: 'delayed', message: DELAYED } };
    } catch { logger.warn('[ACCESS] Could not confirm delivery status; request was previously saved.'); }
    finally { clearTimeout(deadline); }
    return result;
  }
  async function close() {
    closing = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    controller?.abort();
    await active;
    closed = true;
    queue?.close(); queue = undefined;
  }
  function mount(app) {
    app.get('/api/access-request', (req, res) => res.set('Cache-Control', 'no-store').json(status()));
    app.post('/api/access-request', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const origin = req.get('origin');
      if ((origin && origin !== `${req.protocol}://${req.get('host')}`) || req.get('sec-fetch-site') === 'cross-site') {
        return res.status(403).json({ error: 'Please submit the request from the sign-in page.' });
      }
      const result = await submitAndDeliver(req.body);
      res.status(result.status).json(result.body);
    });
  }
  return { mount, status, submit, submitAndDeliver, start, runDue, close };
}
module.exports = { createAccessRequests, RequestQueue, validate, providerAccepted, FORM_ENDPOINT, RETRY_BASE_MS, LEASE_MS, DEDUP_MS, MAX_PENDING, RETENTION_MS };
