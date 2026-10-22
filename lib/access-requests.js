'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const COOLDOWN_MS = 5 * 60 * 1000;
const RECIPIENT = 'ashmoore01@hotmail.com';

class RequestGate {
  constructor(filename) {
    this.db = new DatabaseSync(filename, { timeout: 1000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS access_request_gate (
        id INTEGER PRIMARY KEY CHECK(id=1), next_allowed_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO access_request_gate VALUES(1,0);`);
  }
  remaining(now) {
    return Math.max(0, Math.ceil((this.db.prepare('SELECT next_allowed_at FROM access_request_gate WHERE id=1').get().next_allowed_at - now) / 1000));
  }
  claim(now) {
    // One atomic compare-and-set, shared by all visitors and processes. Reserve
    // before contacting the provider, including when delivery later times out.
    return this.db.prepare('UPDATE access_request_gate SET next_allowed_at=? WHERE id=1 AND next_allowed_at<=?')
      .run(now + COOLDOWN_MS, now).changes === 1;
  }
  complete(now) {
    this.db.prepare('UPDATE access_request_gate SET next_allowed_at=MAX(next_allowed_at,?) WHERE id=1').run(now + COOLDOWN_MS);
  }
  close() { this.db.close(); }
}

function validate(body) {
  if (!body || typeof body.name !== 'string' || typeof body.email !== 'string') return null;
  const name = body.name.trim(), email = body.email.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return null;
  if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email)) return null;
  if (body.website !== undefined && (typeof body.website !== 'string' || body.website.trim())) return null;
  return { name, email };
}

function createAccessRequests({ env = process.env, logger = console, fetchImpl = fetch, clock = Date.now } = {}) {
  const apiKey = env.RESEND_API_KEY || '', from = env.ACCESS_REQUEST_FROM || '';
  const filename = env.ACCESS_REQUEST_DB_PATH || (env.WEATHER_DB_PATH ? path.join(path.dirname(env.WEATHER_DB_PATH), 'access-requests.sqlite') : '');
  const configured = Boolean(apiKey && from && filename && !/[\r\n]/.test(from) && env.ACCESS_REQUESTS_ENABLED !== 'false');
  let gate;
  function storage() { return gate ||= new RequestGate(filename); }
  function status() {
    if (!configured) return { enabled: false, retryAfter: 0 };
    try { return { enabled: true, retryAfter: storage().remaining(clock()) }; }
    catch { return { enabled: false, retryAfter: 0 }; }
  }
  async function submit(body) {
    const person = validate(body);
    if (!person) return { status: 400, body: { error: 'Please enter your name and a valid email address.' } };
    if (!configured) return { status: 503, body: { error: 'Access requests are temporarily unavailable. Please try again later.' } };
    let claimed = false;
    try {
      const store = storage();
      claimed = store.claim(clock());
      if (!claimed) return { status: 429, body: { error: 'A request was recently sent. Please wait before trying again.', retryAfter: store.remaining(clock()) } };
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': 'moore-access-' + randomUUID() },
        body: JSON.stringify({ from, to: [RECIPIENT], reply_to: person.email,
          subject: 'Moore Weather access request',
          text: `A visitor has requested access to Moore Weather.\n\nName: ${person.name}\nEmail: ${person.email}\n\nReply to this email to contact the visitor. Access has not been granted automatically.` })
      });
      if (!response.ok) throw new Error('Email provider rejected the request');
      const result = await response.json();
      if (typeof result.id !== 'string' || !result.id) throw new Error('Email provider did not confirm acceptance');
      store.complete(clock());
      return { status: 200, body: { ok: true, message: 'Request sent. You will receive an email once access has been arranged.', retryAfter: store.remaining(clock()) } };
    } catch {
      // Do not release an uncertain send: the provider may have accepted it.
      if (claimed) { try { storage().complete(clock()); } catch {} }
      logger.warn('[ACCESS] Request unavailable; no visitor details or provider secrets logged.');
      return { status: 503, body: { error: 'We could not confirm your request. Please try again in five minutes.', retryAfter: claimed ? COOLDOWN_MS / 1000 : 0 } };
    }
  }
  function mount(app) {
    app.get('/api/access-request', (req, res) => res.set('Cache-Control', 'no-store').json(status()));
    app.post('/api/access-request', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const origin = req.get('origin');
      if ((origin && origin !== `${req.protocol}://${req.get('host')}`) || req.get('sec-fetch-site') === 'cross-site') {
        return res.status(403).json({ error: 'Please submit the request from the sign-in page.' });
      }
      const result = await submit(req.body);
      if (result.body.retryAfter) res.set('Retry-After', String(result.body.retryAfter));
      res.status(result.status).json(result.body);
    });
  }
  return { mount, status, submit, close: () => { gate?.close(); gate = undefined; } };
}
module.exports = { createAccessRequests, RequestGate, validate, COOLDOWN_MS };
