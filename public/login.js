(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search), next = params.get('next');
  if (next?.startsWith('/') && !next.startsWith('//') && !/[\\\r\n]/.test(next)) $('nextPath').value = next;
  function message(element, text, kind = '') {
    element.textContent = text; element.dataset.kind = kind; element.hidden = !text;
  }
  if (params.get('error') === 'invalid') message($('loginMessage'), 'That password was not accepted. Please try again.', 'error');
  else if (params.get('error') === 'locked') message($('loginMessage'), 'Too many unsuccessful attempts. Please wait about 30 minutes before trying again.', 'error');
  else if (params.get('loggedOut') === '1') message($('loginMessage'), 'This device has been signed out.', 'success');

  const form = $('accessRequestForm'), button = $('requestAccessButton'), feedback = $('requestMessage');
  let enabled = false, busy = false, sent = false, until = 0;
  function paint() {
    const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    button.disabled = !enabled || busy || sent || seconds > 0;
    button.textContent = sent ? 'Request received' : busy ? 'Sending request…' : seconds ? `Try again in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Request access';
  }
  async function checkAvailability() {
    $('requestRetry').hidden = true;
    try {
      const response = await fetch('/api/access-request', { cache:'no-store', headers:{ Accept:'application/json' }, signal:AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('Unavailable');
      const data = await response.json();
      enabled = data.enabled === true;
      until = Date.now() + Math.max(0, Number(data.retryAfter) || 0) * 1000;
      message(feedback, !enabled ? 'Access requests are temporarily unavailable. Please try again later.' : data.retryAfter ? 'A request was recently sent. Please wait a moment before submitting yours.' : '');
      $('requestRetry').hidden = enabled;
    } catch {
      enabled = false;
      message(feedback, 'Unable to check access requests. Please check your connection and try again.', 'error');
      $('requestRetry').hidden = false;
    }
    paint();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    busy = true; paint(); form.setAttribute('aria-busy','true'); message(feedback,'');
    try {
      const response = await fetch('/api/access-request', { method:'POST', headers:{ Accept:'application/json' },
        body:new URLSearchParams(new FormData(form)), signal:AbortSignal.timeout(15000) });
      const data = await response.json();
      until = Date.now() + Math.max(0, Number(data.retryAfter) || 0) * 1000;
      if (response.ok && data.ok === true) {
        sent = true; form.reset(); message(feedback,data.message,'success');
      } else message(feedback,data.error || 'Your request could not be sent. Please try again.',response.status === 429 ? '' : 'error');
    } catch {
      until = Date.now() + 300000;
      message(feedback,'We could not confirm your request. Please wait five minutes before trying again.','error');
    } finally { busy = false; form.removeAttribute('aria-busy'); paint(); }
  });
  $('requestRetry').addEventListener('click',checkAvailability);
  checkAvailability(); setInterval(paint,1000);
})();
