'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { StringDecoder } = require('node:string_decoder');
const express = require('express');

const COOKIE = 'moore_terminal';
const SESSION_MS = 15 * 60000, IDLE_MS = 60000, MAX_SESSION_MS = 5 * 60000;
const CONNECT_MS = 15000, HEARTBEAT_MS = 15000, WRITE_MS = 5000, BACKPRESSURE_MS = 5000;
const DRAIN_MS = 8000, CLOSE_MS = 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024, MAX_COMMAND_BYTES = 512;
const MAX_SESSIONS = 64, MAX_ATTEMPTS = 512, MAX_COMMANDS = 256;
const ATTEMPT_WINDOW_MS = 15 * 60000, MAX_FAILURES = 8;
const INTERRUPT_COUNT = 5, INTERRUPT_GAP_MS = 100, INTERRUPT_COOLDOWN_MS = 1000;
const limits = Object.freeze({ idleSeconds: IDLE_MS / 1000, maxSeconds: MAX_SESSION_MS / 1000 });

function passwordConfig(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parts = value.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || parts.slice(1).some(part => !part || /[^A-Za-z0-9_-]/.test(part))) return null;
  const salt = Buffer.from(parts[1], 'base64url'), hash = Buffer.from(parts[2], 'base64url');
  if (salt.length < 16 || salt.length > 64 || hash.length < 32 || hash.length > 64 ||
      salt.toString('base64url') !== parts[1] || hash.toString('base64url') !== parts[2]) return null;
  return { salt, hash };
}

function derivePassword(password, salt, length) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, length,
    (error, derived) => error ? reject(error) : resolve(derived)));
}

function sameSecret(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const left = Buffer.from(first), right = Buffer.from(second);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieToken(req) {
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index >= 0 && part.slice(0, index).trim() === COOKIE) {
      const token = part.slice(index + 1).trim();
      return token.length === 43 && !/[^A-Za-z0-9_-]/.test(token) ? token : null;
    }
  }
  return null;
}

function failure(status, message) { const error = new Error(message); error.status = status; return error; }

function createStationTerminal({ env = process.env, host, port, runTransaction, logger = console,
  now = Date.now, createSocket = () => new net.Socket(), setTimer = setTimeout, clearTimer = clearTimeout,
  deriveKey = derivePassword } = {}) {
  const config = passwordConfig(env.MOORE_TERMINAL_PASSWORD_HASH);
  const configured = Boolean(config && typeof host === 'string' && host && Number.isInteger(port) && port > 0 && port <= 65535 &&
    typeof runTransaction === 'function' && env.WEATHER_TERMINAL_ENABLED !== 'false');
  const secure = env.RENDER === 'true' || env.NODE_ENV === 'production';
  const sessions = new Map(), attempts = new Map();
  let active = null, stopped = false, verifying = false, stopping = null;
  const cookieOptions = () => ({ httpOnly: true, secure, sameSite: 'strict', path: '/' });
  const enabled = () => configured && !stopped;

  function later(fn, ms) { const timer = setTimer(fn, ms); timer?.unref?.(); return timer; }
  function setLeaseTimer(lease, name, fn, ms) {
    if (lease.finished) return;
    clearTimer(lease.timers[name]);
    const timer = later(() => { delete lease.timers[name]; fn(); }, ms);
    lease.timers[name] = timer;
  }
  function clearLeaseTimer(lease, name) { clearTimer(lease.timers[name]); delete lease.timers[name]; }
  function touch(lease) {
    if (lease.state === 'connected') setLeaseTimer(lease, 'idle', () => closeLease(lease, 'Terminal disconnected after 60 seconds without input or output.'), IDLE_MS);
  }

  function sendEvent(lease, event) {
    const res = lease.res;
    if (res.destroyed || res.writableEnded) return false;
    try {
      const accepted = res.write(JSON.stringify(event) + '\n');
      if (!accepted && !lease.backpressured) {
        lease.backpressured = true;
        if (!lease.finished) {
          lease.socket?.pause();
          setLeaseTimer(lease, 'backpressure', () => {
            lease.outputStopped = true;
            closeLease(lease, 'Terminal disconnected because the browser stopped receiving output.');
          }, BACKPRESSURE_MS);
        }
      }
      return accepted;
    } catch { closeLease(lease, 'Browser connection ended.'); return false; }
  }
  function stateEvent(lease, state, message) {
    lease.state = state;
    sendEvent(lease, { type: 'state', state, connectionId: lease.id, ...(message ? { message } : {}) });
  }
  function heartbeat(lease) {
    if (lease.finished || lease.state === 'closing') return;
    if (!lease.backpressured) sendEvent(lease, { type: 'heartbeat' });
    setLeaseTimer(lease, 'heartbeat', () => heartbeat(lease), HEARTBEAT_MS);
  }

  function finishLease(lease) {
    // The shared resource is the gateway's UART, which can keep transmitting
    // after its TCP client closes. A connected lease keeps its original drain
    // deadline even when the socket closes or an interrupt write fails early.
    if (lease.finished || Object.hasOwn(lease.timers, 'drain')) return;
    lease.finished = true;
    for (const name of Object.keys(lease.timers)) clearLeaseTimer(lease, name);
    lease.cancelInterrupt?.();
    lease.pendingInput?.fail(failure(409, 'Terminal connection ended before the command write completed.'));
    stateEvent(lease, 'closed', lease.closeMessage || 'Terminal disconnected.');
    // A stalled browser must not leave response buffers and sockets behind.
    if (lease.backpressured || lease.res.destroyed) lease.res.destroy();
    else if (!lease.res.writableEnded) lease.res.end();
    if (active === lease) active = null;
    lease.resolveDone();
    logger.info('[TERMINAL] Connection closed; station queue released');
  }

  function destroySocket(lease) {
    if (!lease.socket || lease.socketClosed) { finishLease(lease); return; }
    try { lease.socket.destroy(); }
    catch { finishLease(lease); return; }
    // net.Socket emits close after destroy. This bounds cleanup of a socket
    // that was destroyed during connection setup before its close callback.
    if (!lease.finished && !Object.hasOwn(lease.timers, 'drain')) setLeaseTimer(lease, 'close', () => {
      if (lease.socket.destroyed) finishLease(lease);
    }, CLOSE_MS);
  }

  function interrupt(lease, cleanup = false) {
    if (lease.interrupting) return lease.interrupting;
    if (!lease.socket || !lease.connected || lease.socket.destroyed || lease.socketClosed) {
      return Promise.reject(failure(409, 'Terminal is not connected.'));
    }
    if (now() - lease.lastInterruptAt < INTERRUPT_COOLDOWN_MS) {
      return cleanup ? Promise.resolve() : Promise.reject(failure(429, 'Please wait a moment before interrupting again.'));
    }
    lease.lastInterruptAt = now();
    touch(lease);
    let resolve, reject, count = 0, settled = false;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const settle = error => {
      if (settled) return;
      settled = true; clearLeaseTimer(lease, 'interrupt');
      error ? reject(error) : resolve();
    };
    const shared = pending.finally(() => {
      if (lease.interrupting === shared) { lease.interrupting = null; lease.cancelInterrupt = null; }
    });
    lease.interrupting = shared;
    lease.cancelInterrupt = () => settle(failure(409, 'Terminal connection ended.'));
    const send = () => {
      if (lease.finished || lease.socket.destroyed || lease.socketClosed) { settle(failure(409, 'Terminal connection ended.')); return; }
      try {
        lease.socket.write(Buffer.from([3]), error => {
          if (error) { settle(failure(502, 'Could not send the interrupt sequence.')); closeLease(lease, 'Station connection failed.'); }
        });
      } catch { settle(failure(502, 'Could not send the interrupt sequence.')); closeLease(lease, 'Station connection failed.'); return; }
      if (settled || lease.finished) return;
      count++;
      if (count < INTERRUPT_COUNT) setLeaseTimer(lease, 'interrupt', send, INTERRUPT_GAP_MS);
      else settle();
    };
    send();
    return shared;
  }

  function closeLease(lease, message = 'Terminal disconnected.') {
    if (lease.finished || lease.state === 'closing') return lease.done;
    lease.closeMessage = message;
    stateEvent(lease, 'closing', message);
    for (const name of ['idle', 'hard', 'connect', 'heartbeat', 'backpressure']) clearLeaseTimer(lease, name);
    lease.socket?.resume(); // Drain bounded station output even if the browser vanished.
    if (!lease.started || !lease.socket || !lease.connected) {
      destroySocket(lease);
      return lease.done;
    }
    // Ctrl+C is an interrupt request, not proof that a logger command was
    // undone. Keep the UART lease while the repeated bytes and reply drain.
    setLeaseTimer(lease, 'drain', () => destroySocket(lease), DRAIN_MS);
    if (lease.socketClosed || lease.socket.destroyed) return lease.done;
    interrupt(lease, true).catch(() => destroySocket(lease));
    return lease.done;
  }

  function removeSession(session, message) {
    sessions.delete(session.token); clearTimer(session.timer);
    return active?.owner === session ? closeLease(active, message) : Promise.resolve();
  }
  function getSession(req) {
    const session = sessions.get(cookieToken(req));
    if (session && session.expires <= now()) { removeSession(session, 'Terminal unlock expired.'); return null; }
    return session || null;
  }
  function clientStatus(req) {
    const session = getSession(req);
    return { enabled: enabled(), unlocked: Boolean(session), ...(session ? { csrfToken: session.csrf, expiresAt: new Date(session.expires).toISOString() } : {}),
      connected: Boolean(session && active?.owner === session && active.state === 'connected'), busy: Boolean(active), limits: { ...limits } };
  }
  function authorize(req) {
    const session = getSession(req);
    if (!session) throw failure(401, 'Unlock the station terminal first.');
    if (!sameSecret(req.get('X-Terminal-CSRF'), session.csrf)) throw failure(403, 'Terminal request verification failed.');
    return session;
  }
  function ownedLease(req, session) {
    if (!active || active.owner !== session || !sameSecret(req.body?.connectionId, active.id)) {
      throw failure(403, 'This page does not own the terminal connection.');
    }
    return active;
  }
  function requireConnected(lease) {
    if (lease.state !== 'connected' || !lease.socket || lease.socket.destroyed) throw failure(409, 'Terminal is not ready for input.');
  }

  async function unlock(req, res) {
    const password = req.body?.password;
    if (typeof password !== 'string' || !password || password.length > 256) throw failure(400, 'Enter the terminal password.');
    for (const [key, attempt] of attempts) if (attempt.until <= now()) attempts.delete(key);
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    let attempt = attempts.get(key);
    if (attempt?.count >= MAX_FAILURES || (!attempt && attempts.size >= MAX_ATTEMPTS)) throw failure(429, 'Too many unlock attempts. Try again later.');
    if (verifying) throw failure(429, 'Another unlock check is running. Try again shortly.');
    if (!attempt) { attempt = { count: 0, until: now() + ATTEMPT_WINDOW_MS }; attempts.set(key, attempt); }
    attempt.count++;
    verifying = true;
    let valid = false;
    try {
      const derived = await deriveKey(password, config.salt, config.hash.length);
      valid = Buffer.isBuffer(derived) && derived.length === config.hash.length && crypto.timingSafeEqual(derived, config.hash);
    } finally { verifying = false; }
    if (!valid) throw failure(403, 'Terminal password was not accepted.');
    if (stopped) throw failure(503, 'Terminal is unavailable.');
    if (res.destroyed || res.writableEnded) return;
    let session = getSession(req);
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) throw failure(503, 'Too many terminal sessions are open. Try again later.');
      session = { token: crypto.randomBytes(32).toString('base64url'), csrf: crypto.randomBytes(32).toString('base64url') };
      sessions.set(session.token, session);
    }
    attempts.delete(key);
    session.expires = now() + SESSION_MS;
    clearTimer(session.timer);
    session.timer = later(() => removeSession(session, 'Terminal unlock expired.'), SESSION_MS);
    res.cookie(COOKIE, session.token, { ...cookieOptions(), maxAge: SESSION_MS });
    // The response uses the newly created session without exposing its cookie.
    res.json({ enabled: true, unlocked: true, csrfToken: session.csrf, expiresAt: new Date(session.expires).toISOString(),
      connected: Boolean(active?.owner === session && active.state === 'connected'), busy: Boolean(active), limits: { ...limits } });
  }

  function openSocket(lease) {
    lease.started = true;
    if (lease.finished || lease.state === 'closing' || stopped || lease.owner.expires <= now()) {
      closeLease(lease, 'Terminal connection was cancelled.'); return;
    }
    stateEvent(lease, 'connecting');
    try {
      const socket = createSocket(); lease.socket = socket;
      setLeaseTimer(lease, 'connect', () => closeLease(lease, 'Station connection timed out.'), CONNECT_MS);
      socket.on('error', () => {
        sendEvent(lease, { type: 'error', message: 'Station connection failed.' });
        closeLease(lease, 'Station connection failed.');
      });
      socket.on('close', () => {
        lease.socketClosed = true;
        if (!lease.finished) {
          lease.closeMessage ||= 'Station connection closed.';
          if (lease.connected && lease.state !== 'closing') closeLease(lease, lease.closeMessage);
          else finishLease(lease);
        }
      });
      socket.on('data', chunk => {
        if (lease.finished) return;
        if (lease.state === 'closing') return; // Drain without extending deadlines or retaining data.
        lease.bytes += Buffer.byteLength(chunk);
        if (lease.bytes > MAX_OUTPUT_BYTES) {
          lease.outputStopped = true;
          sendEvent(lease, { type: 'error', message: 'Terminal output reached its 2 MiB limit; the connection is closing.' });
          closeLease(lease, 'Terminal output limit reached.'); return;
        }
        touch(lease);
        const text = lease.decoder.write(chunk);
        if (text && !lease.outputStopped) sendEvent(lease, { type: 'data', text });
      });
      socket.connect(port, host, () => {
        if (lease.finished || lease.state === 'closing') { destroySocket(lease); return; }
        lease.connected = true; clearLeaseTimer(lease, 'connect');
        stateEvent(lease, 'connected'); touch(lease);
        logger.info('[TERMINAL] Connected; station queue reserved');
      });
    } catch {
      sendEvent(lease, { type: 'error', message: 'Station connection could not be opened.' });
      closeLease(lease, 'Station connection could not be opened.');
    }
  }

  function connect(req, res, session) {
    if (active) throw failure(409, 'The station terminal is already in use.');
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const lease = { id: crypto.randomBytes(32).toString('base64url'), owner: session, res, done, resolveDone,
      state: 'queued', started: false, connected: false, finished: false, socketClosed: false,
      bytes: 0, decoder: new StringDecoder('utf8'), commands: new Map(), timers: {}, lastInterruptAt: -Infinity };
    active = lease; // Reserve before waiting for the shared station queue.
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    res.on('close', () => { if (!lease.finished) closeLease(lease, 'Browser connection ended.'); });
    res.on('error', () => closeLease(lease, 'Browser connection ended.'));
    res.on('drain', () => {
      lease.backpressured = false; clearLeaseTimer(lease, 'backpressure');
      if (!lease.finished) lease.socket?.resume();
    });
    try { res.flushHeaders(); stateEvent(lease, 'queued'); }
    catch { closeLease(lease, 'Browser connection ended.'); }
    if (lease.finished) return;
    setLeaseTimer(lease, 'hard', () => closeLease(lease, 'Terminal reached its five-minute connection limit.'), MAX_SESSION_MS);
    heartbeat(lease);
    let queued;
    try { queued = runTransaction('TERMINAL', () => { openSocket(lease); return lease.done; }); }
    catch { queued = Promise.reject(new Error('Queue unavailable')); }
    Promise.resolve(queued).catch(() => {
      if (!lease.finished) {
        sendEvent(lease, { type: 'error', message: 'Station queue is unavailable.' });
        closeLease(lease, 'Station queue is unavailable.');
      }
    });
  }

  function input(req, lease) {
    requireConnected(lease);
    const { command, commandId } = req.body;
    if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > MAX_COMMAND_BYTES || /[^\x20-\x7e]/.test(command)) {
      throw failure(400, 'Enter one printable command line of at most 512 bytes.');
    }
    if (typeof commandId !== 'string' || commandId.length < 8 || commandId.length > 80 || /[^A-Za-z0-9_-]/.test(commandId)) {
      throw failure(400, 'Command identifier is invalid.');
    }
    const digest = crypto.createHash('sha256').update(command).digest('hex');
    const existing = lease.commands.get(commandId);
    if (existing) {
      if (existing.digest !== digest) throw failure(409, 'Command identifier was already used for different input.');
      return existing.promise.then(() => ({ ok: true, duplicate: true }));
    }
    if (lease.pendingInput || lease.interrupting) throw failure(409, 'Wait for the current input to finish writing.');
    if (lease.commands.size >= MAX_COMMANDS) throw failure(429, 'Terminal input limit reached. Reconnect to continue.');
    let resolve, reject, settled = false;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const entry = { digest, promise, fail: error => complete(error) };
    function complete(error) {
      if (settled) return;
      settled = true; clearLeaseTimer(lease, 'write');
      if (lease.pendingInput === entry) lease.pendingInput = null;
      error ? reject(error) : resolve();
    }
    lease.commands.set(commandId, entry); lease.pendingInput = entry; touch(lease);
    setLeaseTimer(lease, 'write', () => {
      complete(failure(504, 'Command write timed out; delivery is uncertain.'));
      closeLease(lease, 'Command write timed out.');
    }, WRITE_MS);
    try {
      lease.socket.write(command + '\r\n', error => {
        if (error) {
          complete(failure(502, 'Command write failed; delivery is uncertain.'));
          closeLease(lease, 'Station connection failed.');
        } else complete();
      });
    } catch {
      complete(failure(502, 'Command write failed; delivery is uncertain.'));
      closeLease(lease, 'Station connection failed.');
    }
    return promise.then(() => ({ ok: true }));
  }

  function revoke(req, res) {
    const session = getSession(req);
    if (res && !res.headersSent) res.clearCookie(COOKIE, cookieOptions());
    return session ? removeSession(session, 'Terminal locked.') : Promise.resolve();
  }

  function route(action) {
    return (req, res) => {
      const rejected = error => {
        if (!res.headersSent) res.status(Number.isInteger(error?.status) ? error.status : 503)
          .json({ error: error?.status ? error.message : 'Terminal is temporarily unavailable.' });
      };
      try { Promise.resolve(action(req, res)).catch(rejected); } catch (error) { rejected(error); }
    };
  }

  function mount(app) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    router.get('/status', route((req, res) => res.json(clientStatus(req))));
    router.use((req, res, next) => {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST for terminal controls.' });
      if (req.get('Origin') !== req.protocol + '://' + req.get('host')) return res.status(403).json({ error: 'Open the terminal from Moore Weather.' });
      if (!enabled()) return res.status(503).json({ error: 'Station terminal is not configured.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'JSON is required.' });
      next();
    });
    router.use(express.json({ limit: '2kb', inflate: false }));
    router.use((req, res, next) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'A JSON object is required.' });
      next();
    });
    router.post('/unlock', route(unlock));
    router.use((req, res, next) => {
      try { req.terminalSession = authorize(req); next(); }
      catch (error) { res.status(error.status).json({ error: error.message }); }
    });
    router.post('/connect', route((req, res) => connect(req, res, req.terminalSession)));
    router.post('/input', route(async (req, res) => res.json(await input(req, ownedLease(req, req.terminalSession)))));
    router.post('/interrupt', route(async (req, res) => {
      const lease = ownedLease(req, req.terminalSession); requireConnected(lease);
      await interrupt(lease); res.json({ ok: true });
    }));
    router.post('/disconnect', route(async (req, res) => {
      await closeLease(ownedLease(req, req.terminalSession)); res.json({ ok: true });
    }));
    router.post('/lock', route((req, res) => { revoke(req, res); res.json({ ok: true }); }));
    router.use((error, _req, res, _next) => {
      if (!res.headersSent) res.status(error?.status === 413 ? 413 : error?.status === 415 ? 415 : 400)
        .json({ error: 'Terminal request body is invalid.' });
    });
    app.use('/api/terminal', router);
  }

  return {
    mount, revoke,
    status: () => ({ enabled: enabled(), connected: active?.state === 'connected', busy: Boolean(active),
      state: active?.state || 'closed', limits: { ...limits } }),
    stop() {
      if (stopping) return stopping;
      stopped = true;
      for (const session of sessions.values()) clearTimer(session.timer);
      sessions.clear(); attempts.clear();
      stopping = active ? closeLease(active, 'Terminal closed while the service is restarting.') : Promise.resolve();
      return stopping;
    }
  };
}

module.exports = { createStationTerminal,
  SESSION_MS, IDLE_MS, MAX_SESSION_MS, MAX_OUTPUT_BYTES, DRAIN_MS, INTERRUPT_COUNT, INTERRUPT_GAP_MS };
