'use strict';

const net = require('node:net');
const { performance } = require('node:perf_hooks');
const AEST = 10 * 3600000, DAY = 86400000;
const DRIFT_MS = 5000, MAX_CORRECTION_MS = 5 * 60000, MAX_RTT_MS = 3000;
const IO_TIMEOUT_MS = 8000, MAX_REPLY_BYTES = 2048, SETTLE_MS = 750;
const RETRY_MS = 5 * 60000, CORRECTION_COOLDOWN_MS = 15 * 60000;

function brisbaneParts(epoch) {
  if (!Number.isFinite(epoch)) throw new Error('Server clock is invalid');
  const d = new Date(epoch + AEST), iso = d.toISOString();
  return { date: iso.slice(0, 10).replaceAll('-', '/'), time: iso.slice(11, 19),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

function parseStationTime(text) {
  const values = [];
  for (const raw of String(text).split(/[\r\n]/)) {
    const line = raw.trim().replace(/^>\s*/, '');
    if (!line || /^time$/i.test(line) || /^\\?END(?: OF DATA)?$/i.test(line)) continue;
    if (!/^\d{4}\/\d{2}\/\d{2} ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(line)) {
      throw new Error('Station TIME reply is malformed');
    }
    const iso = line.slice(0, 10).replaceAll('/', '-') + 'T' + line.slice(11) + '+10:00';
    const value = Date.parse(iso);
    if (!Number.isFinite(value) || brisbaneParts(value).date + ' ' + brisbaneParts(value).time !== line) {
      throw new Error('Station TIME calendar date is invalid');
    }
    values.push(value);
  }
  if (values.length !== 1) throw new Error('Station TIME reply must contain exactly one timestamp');
  return values[0];
}

function nextClockCheckAt(epoch) {
  const dayStart = Math.floor((epoch + AEST) / DAY) * DAY - AEST;
  return [dayStart + (6 * 60 + 5) * 60000, dayStart + (18 * 60 + 5) * 60000,
    dayStart + DAY + (6 * 60 + 5) * 60000].find(value => value > epoch);
}

function exchange({ host, port, now = Date.now, monotonic = () => performance.now(),
  createSocket = () => new net.Socket(), setTimer = setTimeout, clearTimer = clearTimeout,
  makeCommand, read = false }) {
  return new Promise((resolve, reject) => {
    let socket, deadline, settle, finished = false, reply = '', bytes = 0;
    let sentAt, sentMono, command, written = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimer(deadline); clearTimer(settle);
      socket?.destroy();
      error ? reject(error) : resolve(value);
    };
    const fail = message => finish(new Error(message));
    const completeRead = () => {
      try {
        const stationAt = parseStationTime(reply);
        finish(null, { stationAt, sentAt, receivedAt: now(), roundTripMs: monotonic() - sentMono });
      } catch (error) { finish(error); }
    };
    const completeWrite = () => finish(null, { sentAt, command });
    try {
      socket = createSocket();
      deadline = setTimer(() => fail('Station clock command timed out'), IO_TIMEOUT_MS);
      socket.on('error', () => fail('Station clock connection failed'));
      socket.on('close', () => {
        if (finished) return;
        if (read && reply) completeRead();
        else if (!read && written) completeWrite();
        else fail('Station clock connection closed before a reply');
      });
      socket.on('data', chunk => {
        if (finished) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_REPLY_BYTES) { fail('Station clock reply exceeded its size limit'); return; }
        reply += chunk.toString();
        if (read) {
          // Parse only a complete date/time, including when the logger leaves
          // its TCP connection open. Echoes/prompts are checked by the parser.
          if (/(?:^|[\r\n])\s*>?\s*\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:[\r\n]|$)/.test(reply)) completeRead();
        } else if (/\b(?:error|invalid|unknown|denied|failed)\b/i.test(reply)) {
          fail('Station rejected SETTIME');
        }
      });
      socket.connect(port, host, () => {
        if (finished) return;
        try {
          // Calculate the time after waiting for both the shared queue and TCP
          // connection. Never send a timestamp prepared before either wait.
          command = read ? 'TIME' : makeCommand();
          if (!read && !/^SETTIME ([01]\d|2[0-3]) [0-5]\d [0-5]\d$/.test(command)) {
            throw new Error('Station clock command is invalid');
          }
          sentAt = now(); sentMono = monotonic();
          socket.write(command + '\r\n', error => {
            if (finished) return;
            if (error) { fail('Station clock command could not be written'); return; }
            written = true;
            // SETTIME has no assumed acknowledgement format. Allow the short
            // command to finish, then establish success with a new TIME read.
            if (!read) settle = setTimer(completeWrite, SETTLE_MS);
          });
        } catch (error) { finish(error); }
      });
    } catch (error) { finish(error); }
  });
}

function readStationTime(options) { return exchange({ ...options, read: true }); }
function writeStationTime(options) { return exchange({ ...options, read: false }); }

function measuredDrift(sample) {
  if (![sample?.stationAt, sample?.sentAt, sample?.receivedAt, sample?.roundTripMs].every(Number.isFinite) ||
      sample.roundTripMs < 0 || sample.roundTripMs > MAX_RTT_MS || sample.receivedAt < sample.sentAt ||
      Math.abs(sample.receivedAt - sample.sentAt - sample.roundTripMs) > 1000) {
    throw new Error('Station TIME timing is too uncertain to set the clock');
  }
  return sample.stationAt - (sample.sentAt + sample.receivedAt) / 2;
}

function correctionAllowed(serverAt, stationAt) {
  const server = brisbaneParts(serverAt), station = brisbaneParts(stationAt);
  if (server.date !== station.date) throw new Error('Station calendar date differs from Brisbane; SETTIME cannot correct the date');
  if (Math.abs(serverAt - stationAt) > MAX_CORRECTION_MS) throw new Error('Station clock differs by more than five minutes; automatic correction withheld');
  if ((server.hour < 9) !== (station.hour < 9)) throw new Error('Station clock correction would cross the 9 am daily boundary');
  for (const parts of [server, station]) {
    const seconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
    if (seconds < 120 || seconds >= 86400 - 120 || Math.abs(seconds - 9 * 3600) < 120) {
      throw new Error('Station clock correction deferred near midnight or the 9 am daily boundary');
    }
  }
}

function createStationClock({ enabled = false, host, port, runTransaction, logger = console,
  now = Date.now, readTime = readStationTime, writeTime = writeStationTime,
  setTimer = setTimeout, clearTimer = clearTimeout, recordCorrection = () => null,
  verifyCorrection = () => {}, pendingCorrections = () => [], onCorrection = async () => {} } = {}) {
  let inFlight = null, timer = null, started = false, stopped = false, failures = 0;
  let lastWriteAttempt = -Infinity;
  const state = { enabled, status: enabled ? 'pending' : 'disabled', timezone: 'Australia/Brisbane',
    schedule: ['06:05', '18:05'], driftSeconds: null, lastCheckedAt: null, lastVerifiedAt: null,
    lastCorrectionAt: null, nextCheckAt: null, error: null };
  const transport = { host, port, now, setTimer, clearTimer };
  function plan() {
    clearTimer(timer);
    if (!started || stopped || !enabled) return;
    const next = failures > 0 && failures <= 2 ? Math.min(nextClockCheckAt(now()), now() + RETRY_MS) : nextClockCheckAt(now());
    state.nextCheckAt = new Date(next).toISOString();
    timer = setTimer(() => { timer = null; api.check(failures ? 'retry' : 'scheduled'); }, Math.max(1, next - now()));
    timer?.unref?.();
  }
  const api = {
    status() { return { ...state, schedule: [...state.schedule], running: Boolean(inFlight) }; },
    check(reason = 'manual') {
      if (!enabled || stopped) return Promise.resolve(api.status());
      if (inFlight) return inFlight;
      clearTimer(timer); state.nextCheckAt = null;
      const execute = async () => {
        if (stopped) return;
        state.status = 'checking'; state.lastCheckedAt = new Date(now()).toISOString();
        const before = await readTime(transport), drift = measuredDrift(before);
        state.driftSeconds = Math.round(drift) / 1000;
        const pending = pendingCorrections();
        for (const item of pending) {
          const attempted = Date.parse(item.at);
          if (Number.isFinite(attempted) && attempted <= now()) lastWriteAttempt = Math.max(lastWriteAttempt, attempted);
        }
        if (brisbaneParts(before.stationAt).date !== brisbaneParts(before.receivedAt).date) {
          throw new Error('Station calendar date differs from Brisbane; SETTIME cannot correct the date');
        }
        logger.info('[CLOCK] TIME checked; station minus server ' + state.driftSeconds.toFixed(3) + 's; round trip ' + Math.round(before.roundTripMs) + 'ms');
        if (Math.abs(drift) <= DRIFT_MS) {
          // A previous SETTIME may have succeeded before its verification
          // connection failed. The bounded durable pending list survives a
          // restart; only a fresh, accurate TIME can confirm those attempts.
          for (const item of pending) verifyCorrection(item.id, new Date(now()).toISOString());
          state.status = 'in-sync'; state.lastVerifiedAt = new Date(now()).toISOString(); state.error = null; failures = 0;
          logger.info('[CLOCK] Verified within 5 seconds of Brisbane AEST; no SETTIME needed');
          return;
        }
        if (now() - lastWriteAttempt < CORRECTION_COOLDOWN_MS) throw new Error('Station clock correction cooldown is active');
        let correction;
        await writeTime({ ...transport, makeCommand() {
          if (stopped) throw new Error('Station clock monitor stopped before correction');
          const serverAt = now(), stationAt = before.stationAt + (serverAt - (before.sentAt + before.receivedAt) / 2);
          correctionAllowed(serverAt, stationAt);
          const time = brisbaneParts(serverAt).time;
          correction = { at: new Date(serverAt).toISOString(), stationAt: new Date(stationAt).toISOString(),
            serverAt: new Date(serverAt).toISOString(), adjustmentMs: Math.round(-drift) };
          // Persist the intent before any hardware write. If persistence is
          // enabled but unavailable, fail here without changing the logger.
          correction.id = recordCorrection(correction);
          lastWriteAttempt = serverAt;
          // A contended SQLite commit can wait for a writer. Do not send the
          // already prepared time if journaling consumed a material interval.
          const preparedAge = now() - serverAt;
          if (preparedAge < 0 || preparedAge > 1000) throw new Error('Station clock target became stale while recording its correction');
          logger.info('[CLOCK] Sending SETTIME ' + time.replaceAll(':', ' ') + ' (Brisbane AEST); adjustment ' + (-drift / 1000).toFixed(3) + 's');
          return 'SETTIME ' + time.replaceAll(':', ' ');
        } });
        if (!correction) throw new Error('Station clock correction was not sent');
        await onCorrection(correction);
        const after = await readTime(transport), afterDrift = measuredDrift(after);
        state.driftSeconds = Math.round(afterDrift) / 1000;
        if (brisbaneParts(after.stationAt).date !== brisbaneParts(after.receivedAt).date || Math.abs(afterDrift) > DRIFT_MS) {
          throw new Error('Station TIME verification did not confirm synchronisation');
        }
        verifyCorrection(correction.id, new Date(now()).toISOString());
        state.status = 'corrected'; state.lastCorrectionAt = correction.at;
        state.lastVerifiedAt = new Date(now()).toISOString(); state.error = null; failures = 0;
        logger.info('[CLOCK] Synchronisation verified by TIME; station minus server ' + state.driftSeconds.toFixed(3) + 's');
      };
      // Enqueue synchronously so startup really precedes the first CURRENT
      // request. Catch synchronous queue failures without deferring that order.
      let queued;
      try { queued = runTransaction('CLOCK ' + reason, execute); }
      catch (error) { queued = Promise.reject(error); }
      const task = Promise.resolve(queued).catch(error => {
        failures++; state.status = 'warning'; state.error = error.message;
        logger.warn('[CLOCK] ' + error.message + '; normal weather polling continues');
      }).finally(() => { inFlight = null; plan(); });
      inFlight = task.then(() => api.status());
      return inFlight;
    },
    start() {
      if (started || stopped || !enabled) return;
      started = true; api.check('startup');
    },
    stop() { stopped = true; started = false; clearTimer(timer); state.nextCheckAt = null; }
  };
  return api;
}

module.exports = { createStationClock, parseStationTime, brisbaneParts, nextClockCheckAt,
  readStationTime, writeStationTime, measuredDrift, correctionAllowed,
  DRIFT_MS, MAX_CORRECTION_MS, MAX_RTT_MS, IO_TIMEOUT_MS, MAX_REPLY_BYTES, CORRECTION_COOLDOWN_MS };
