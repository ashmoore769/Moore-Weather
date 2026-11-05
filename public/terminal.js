/* Station controls stay in this page's memory. No command is retried automatically. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const MAX_OUTPUT_BYTES = 2 * 1024 * 1024, MAX_FRAME_CHARS = MAX_OUTPUT_BYTES + 4096;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const quickButtons = [...document.querySelectorAll('[data-command]')];
  let enabled = false, unlocked = false, csrfToken = '', busyElsewhere = false;
  let unlocking = false, locking = false, sending = false, interrupting = false, checking = false;
  let connection = null, output = '', outputBytes = 0, statusTimer;
  let history = [], historyIndex = 0, draft = '';

  function message(text, kind = '') {
    $('terminalStatus').textContent = text;
    $('terminalStatus').dataset.kind = kind;
  }
  function paint() {
    const state = connection?.state || (busyElsewhere ? 'busy' : 'disconnected');
    const connected = unlocked && state === 'connected' && Boolean(connection?.id);
    $('terminalUnlockPanel').hidden = unlocked;
    $('terminalPanel').hidden = !unlocked;
    $('terminalLock').hidden = !unlocked;
    $('terminalLock').disabled = locking;
    $('terminalPassword').disabled = !enabled || unlocking;
    $('terminalUnlock').disabled = !enabled || unlocking;
    $('terminalUnlock').textContent = unlocking ? 'Unlocking…' : 'Unlock';
    $('terminalPanel').dataset.state = state;
    $('terminalConnectionState').textContent = ({ disconnected:'Disconnected', busy:'Busy elsewhere', queued:'Waiting for station', connecting:'Connecting…', connected:'Connected', closing:'Disconnecting…', closed:'Disconnected' })[state] || 'Disconnected';
    $('terminalConnect').disabled = !unlocked || Boolean(connection) || busyElsewhere || locking;
    $('terminalDisconnect').disabled = !connection || state === 'closing';
    $('terminalDisconnect').textContent = ['queued', 'connecting'].includes(state) ? 'Cancel connection' : 'Disconnect';
    $('terminalLeaseNotice').hidden = !connection || !['connecting', 'connected', 'closing'].includes(state);
    $('terminalCommand').disabled = !unlocked || locking;
    $('terminalSend').disabled = !connected || sending || locking || !$('terminalCommand').value.trim();
    $('terminalSend').textContent = sending ? 'Sending…' : 'Send';
    $('terminalInterrupt').disabled = !connected || interrupting || locking;
    for (const button of quickButtons) button.disabled = !unlocked || locking;
    for (const id of ['terminalClear', 'terminalCopy', 'terminalSave']) $(id).disabled = !output;
  }
  function append(text) {
    if (typeof text !== 'string' || !text) return;
    const node = $('terminalOutput'), follow = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    const bytes = encoder.encode(text), remaining = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
    let count = Math.min(remaining, bytes.length);
    if (count < bytes.length) {
      while (count > 0 && (bytes[count] & 0xc0) === 0x80) count--;
      $('terminalOutputLimit').hidden = false;
    }
    if (count) {
      output += count === bytes.length ? text : decoder.decode(bytes.subarray(0, count));
      outputBytes += count;
      node.textContent = output;
      if (follow) node.scrollTop = node.scrollHeight;
    }
    for (const id of ['terminalClear', 'terminalCopy', 'terminalSave']) $(id).disabled = !output;
  }
  function clearOutput() {
    output = ''; outputBytes = 0;
    $('terminalOutput').textContent = '';
    $('terminalOutputLimit').hidden = true;
    paint();
  }
  function endStream(active, reason) {
    if (!active) return;
    active.reason = reason;
    active.state = 'closing';
    active.controller.abort();
    active.reader?.cancel().catch(() => {});
    paint();
  }
  function forgetAccess() {
    unlocked = false; csrfToken = ''; busyElsewhere = false;
    clearTimeout(statusTimer);
    endStream(connection, 'Terminal locked.');
    connection = null;
    history = []; historyIndex = 0; draft = '';
    $('terminalCommand').value = '';
    clearOutput();
  }
  async function responseData(response, unlockRequest = false) {
    const json = /\bjson\b/i.test(response.headers.get('content-type') || '');
    if (response.status === 401 && !json) {
      location.assign('/login?next=%2Fterminal.html');
      throw Object.assign(new Error('Sign in to Moore Weather again.'), { status:401 });
    }
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : 'The terminal request was not accepted.';
      if (response.status === 401 && !unlockRequest && unlocked) {
        forgetAccess();
        message(detail.slice(0, 500), 'error');
      }
      throw Object.assign(new Error(detail.slice(0, 500)), { status:response.status });
    }
    return data;
  }
  async function request(path, body, needsToken = true) {
    const headers = { Accept:'application/json' }, options = { cache:'no-store', credentials:'same-origin', headers, signal:AbortSignal.timeout(12000) };
    if (body !== undefined) {
      options.method = 'POST'; options.body = JSON.stringify(body); headers['Content-Type'] = 'application/json';
      if (needsToken) headers['X-Terminal-CSRF'] = csrfToken;
    }
    return responseData(await fetch('/api/terminal' + path, options), path === '/unlock');
  }
  function applyStatus(data, announce) {
    const wasUnlocked = unlocked, wasBusy = busyElsewhere;
    enabled = data.enabled === true;
    const access = enabled && data.unlocked === true && typeof data.csrfToken === 'string' && data.csrfToken.length > 0;
    if (!access) {
      if (unlocked) forgetAccess();
      unlocked = false; csrfToken = ''; busyElsewhere = false;
    } else {
      unlocked = true; csrfToken = data.csrfToken;
      // The status endpoint never grants this tab ownership of another stream.
      busyElsewhere = data.busy === true && !connection;
    }
    const idle = Number(data.limits?.idleSeconds), maximum = Number(data.limits?.maxSeconds);
    if (Number.isFinite(idle) && idle > 0 && Number.isFinite(maximum) && maximum > 0) {
      $('terminalLimits').textContent = `Disconnects after ${idle} seconds of inactivity or ${maximum / 60} minutes per connection.`;
    }
    paint();
    if (!connection && (announce || wasUnlocked !== unlocked || wasBusy !== busyElsewhere)) {
      message(!enabled ? 'The station terminal is not enabled.' : !unlocked ? 'Enter the terminal password to unlock.' : busyElsewhere ? 'The terminal is in use elsewhere. This tab is not connected.' : 'Unlocked. Connect when you are ready.');
    }
  }
  async function refreshStatus(announce = true) {
    if (checking || unlocking || locking) return;
    checking = true;
    clearTimeout(statusTimer);
    try { applyStatus(await request('/status'), announce); }
    catch (error) { if (announce) message(error.status ? error.message : 'Unable to check terminal access. Reload the page to try again.', 'error'); }
    finally {
      checking = false;
      // Only availability is rechecked while another lease is busy. Own output
      // arrives on its connection stream; these reads never contact the station.
      if (unlocked && busyElsewhere && !connection) statusTimer = setTimeout(() => refreshStatus(false), 5000);
    }
  }
  async function unlock(event) {
    event.preventDefault();
    if (unlocking || !enabled || !$('terminalUnlockForm').reportValidity()) return;
    unlocking = true; paint();
    try {
      const data = await request('/unlock', { password:$('terminalPassword').value }, false);
      applyStatus(data, true);
      if (unlocked) $('terminalConnect').focus();
    } catch (error) { message(error.status ? error.message : 'Unlock could not be confirmed. Please try again.', 'error'); }
    finally {
      $('terminalPassword').value = ''; unlocking = false; paint();
      if (unlocked && busyElsewhere && !connection) statusTimer = setTimeout(() => refreshStatus(false), 5000);
    }
  }
  function streamEvent(active, event) {
    if (connection !== active || !event || typeof event !== 'object') return;
    if (event.type === 'heartbeat') return;
    if (event.type === 'data') { append(event.text); return; }
    if (event.type === 'error') {
      active.reportedError = typeof event.message === 'string' ? event.message : 'The station connection failed.';
      append('\n[Error] ' + active.reportedError + '\n');
      message(active.reportedError, 'error'); return;
    }
    if (event.type !== 'state' || !['queued', 'connecting', 'connected', 'closing', 'closed'].includes(event.state)) return;
    if (event.connectionId !== undefined) {
      if (typeof event.connectionId !== 'string' || !event.connectionId || event.connectionId.length > 512 || (active.id && active.id !== event.connectionId)) throw Error('The connection identity changed unexpectedly.');
      active.id = event.connectionId;
    }
    if (event.state === 'connected' && !active.id) throw Error('The station connection did not provide its controls.');
    active.state = event.state;
    if (event.state === 'connected' && !active.connected) {
      active.connected = true;
      append('\n[Connected to the station]\n');
      active.maximumTimer = setTimeout(() => endStream(active, 'The connection time limit was reached.'), 360000);
    }
    if (event.state === 'closed') active.closed = true;
    const detail = typeof event.message === 'string' ? event.message : ({ queued:'Waiting for the station to finish its current task…', connecting:'Connecting to the station…', connected:'Connected. Enter a command when you are ready.', closing:'Disconnecting from the station…', closed:'Disconnected. Weather collection resumes automatically.' })[event.state];
    if (!active.reportedError) message(detail, event.state === 'connected' ? 'success' : '');
    paint();
  }
  async function connect() {
    if (!unlocked || connection || busyElsewhere || locking) return;
    clearTimeout(statusTimer);
    const active = { controller:new AbortController(), state:'queued', id:null, reader:null, reason:'', connected:false, closed:false };
    connection = active; paint(); message('Requesting a station connection…');
    const headerTimer = setTimeout(() => endStream(active, 'The connection request timed out. It was not retried.'), 20000);
    let silenceTimer;
    const received = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => endStream(active, 'The connection stopped responding. It was not reconnected automatically.'), 45000);
    };
    try {
      const response = await fetch('/api/terminal/connect', { method:'POST', credentials:'same-origin', cache:'no-store', headers:{ 'Content-Type':'application/json', Accept:'application/x-ndjson', 'X-Terminal-CSRF':csrfToken }, body:'{}', signal:active.controller.signal });
      clearTimeout(headerTimer);
      if (!response.ok) { await responseData(response); return; }
      if (!response.body) throw Error('This browser could not open the station stream.');
      active.reader = response.body.getReader();
      const utf8 = new TextDecoder();
      let pending = '';
      received();
      while (connection === active) {
        const { value, done } = await active.reader.read();
        if (done) break;
        received();
        pending += utf8.decode(value, { stream:true });
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          if (newline > MAX_FRAME_CHARS) throw Error('Station output exceeded the stream limit.');
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line.trim()) streamEvent(active, JSON.parse(line));
        }
        if (pending.length > MAX_FRAME_CHARS) throw Error('Station output exceeded the stream limit.');
      }
      pending += utf8.decode();
      if (pending.trim()) streamEvent(active, JSON.parse(pending));
      if (!active.reason && !active.closed && !active.reportedError) message('The station connection ended. Connect again when you are ready.');
    } catch (error) {
      if (!active.reason) {
        active.reportedError = error.status ? error.message : 'The station connection was interrupted. No command was resent.';
        append('\n[Connection ended]\n');
        message(active.reportedError, 'error');
      }
    } finally {
      clearTimeout(headerTimer); clearTimeout(silenceTimer); clearTimeout(active.maximumTimer);
      active.controller.abort();
      active.reader?.cancel().catch(() => {});
      if (connection === active) {
        connection = null; active.id = null;
        if (active.reason) message(active.reason);
        paint();
        if (unlocked) refreshStatus(false);
      }
    }
  }
  async function disconnect() {
    const active = connection;
    if (!active || active.state === 'closing') return;
    if (active.state !== 'connected' || !active.id) {
      endStream(active, 'Connection request cancelled.'); return;
    }
    active.state = 'closing'; paint(); message('Disconnecting from the station…');
    try {
      await request('/disconnect', { connectionId:active.id });
      endStream(active, 'Disconnected. Weather collection resumes automatically.');
    } catch (error) {
      endStream(active, 'The connection was closed from this tab.');
      message(error.status ? error.message : 'Disconnect was not confirmed; this tab has closed its connection stream.', 'error');
    }
  }
  function remember(command) {
    if (history.at(-1) !== command) history.push(command);
    if (history.length > 50) history.shift();
    historyIndex = history.length; draft = '';
  }
  async function send(event) {
    event.preventDefault();
    const active = connection, command = $('terminalCommand').value.trim();
    if (!unlocked || active?.state !== 'connected' || !active.id || sending || locking || !command) return;
    if (command.length > 512 || !/^[\x20-\x7e]+$/.test(command)) { message('Enter one command of up to 512 plain-text ASCII characters, without line breaks.', 'error'); return; }
    const commandId = crypto.randomUUID();
    sending = true; remember(command); paint(); append('> ' + command + '\n'); message('Sending command…');
    try {
      await request('/input', { connectionId:active.id, command, commandId });
      if ($('terminalCommand').value.trim() === command) $('terminalCommand').value = '';
      if (connection === active) message('Command sent. Watch the station output.', 'success');
    } catch (error) {
      if (connection === active && unlocked) message(error.status ? error.message : 'Send could not be confirmed. The command may have reached the station; it was not resent. Check the output before sending again.', 'error');
      if (error.status === 403 && unlocked) refreshStatus(false);
    } finally { sending = false; paint(); }
  }
  async function interrupt() {
    const active = connection;
    if (!unlocked || active?.state !== 'connected' || !active.id || interrupting || locking) return;
    interrupting = true; paint(); message('Sending Ctrl+C…');
    try {
      await request('/interrupt', { connectionId:active.id });
      if (connection === active && unlocked) {
        append('[Ctrl+C sent five times]\n');
        message('Ctrl+C sent. Check the station output; a command already applied cannot be undone.');
      }
    } catch (error) {
      if (connection === active && unlocked) message(error.status ? error.message : 'The interrupt could not be confirmed. It was not retried.', 'error');
      if (error.status === 403 && unlocked) refreshStatus(false);
    } finally { interrupting = false; paint(); }
  }
  async function lock() {
    if (!unlocked || locking) return;
    locking = true; paint();
    try {
      await request('/lock', {});
      forgetAccess(); message('Terminal locked.');
    } catch (error) { message(error.status ? error.message : 'Lock could not be confirmed. Try again before leaving this device.', 'error'); }
    finally { locking = false; paint(); }
  }

  $('terminalUnlockForm').addEventListener('submit', unlock);
  $('terminalCommandForm').addEventListener('submit', send);
  $('terminalConnect').addEventListener('click', connect);
  $('terminalDisconnect').addEventListener('click', disconnect);
  $('terminalInterrupt').addEventListener('click', interrupt);
  $('terminalLock').addEventListener('click', lock);
  $('terminalClear').addEventListener('click', clearOutput);
  $('terminalCommand').addEventListener('input', paint);
  $('terminalCommand').addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || !history.length) return;
    event.preventDefault();
    if (historyIndex === history.length) draft = $('terminalCommand').value;
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
    $('terminalCommand').value = historyIndex === history.length ? draft : history[historyIndex];
    paint();
  });
  for (const button of quickButtons) button.addEventListener('click', () => {
    $('terminalCommand').value = button.dataset.command;
    historyIndex = history.length; draft = button.dataset.command;
    $('terminalCommand').focus(); paint();
  });
  $('terminalCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(output); message('Terminal text copied.'); }
    catch { message('Copy is unavailable here. Select the output or use Save text.', 'error'); }
  });
  $('terminalSave').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([output], { type:'text/plain;charset=utf-8' })), link = document.createElement('a');
    link.href = url; link.download = 'moore-weather-terminal-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !connection) refreshStatus(false); });
  window.addEventListener('pageshow', event => { if (event.persisted && !connection) refreshStatus(false); });
  window.addEventListener('pagehide', () => { clearTimeout(statusTimer); endStream(connection, 'Page closed.'); });
  paint(); refreshStatus();
})();
