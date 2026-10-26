/* Lightweight, optional usage measurement. No station readings or form contents. */
(() => {
  'use strict';
  const DOMAIN = 'moore-weather.onrender.com';
  const WEBSITE = 'cc26784e-27b2-48ef-80d6-a6da05212489';
  const DISABLED = 'umami.disabled';
  const pages = {
    '/': ['/', 'Moore Weather · Current'],
    '/index.html': ['/', 'Moore Weather · Current'],
    '/daily.html': ['/daily.html', 'Moore Weather · Daily Summary'],
    '/forecast.html': ['/forecast.html', 'Moore Weather · Forecast'],
    '/login': ['/login', 'Moore Weather · Sign in'],
    '/login.html': ['/login', 'Moore Weather · Sign in'],
    '/help.html': ['/help.html', 'Moore Weather · Help']
  };
  const page = pages[location.pathname];
  const features = new Set(['history-open', 'history-measurement', 'skycam-timelapse',
    'skycam-history', 'skycam-download', 'skycam-enlarge', 'skycam-live',
    'radar-playback', 'radar-timeline', 'radar-reset', 'radar-refresh', 'radar-latest',
    'forecast-refresh', 'alerts-open', 'install-prompt']);
  const measurements = new Set(['air', 'globe', 'humidity', 'pressure', 'wind', 'gust',
    'direction', 'solar', 'rain', 'dew', 'evaporation', 'evaporation-total', 'ground',
    'battery', 'load', 'panel', 'charge', 'leslie-storage', 'leslie-volume',
    'condamine-warwick-level', 'condamine-level', 'condamine-flow',
    ...[10, 20, 30, 40].flatMap(depth => ['soil-temp-' + depth, 'soil-moisture-' + depth])]);
  const clicks = {
    skycamTimelapse: 'skycam-timelapse', skycamPrev: 'skycam-history',
    skycamNext: 'skycam-history', skycamDownload: 'skycam-download',
    skycamFocus: 'skycam-enlarge', skycamLive: 'skycam-live',
    radarPlay: 'radar-playback', radarReset: 'radar-reset',
    refreshRadar: 'radar-refresh', radarLatest: 'radar-latest',
    refreshForecast: 'forecast-refresh', stationAlertsBtn: 'alerts-open',
    installAppButton: 'install-prompt'
  };
  let memoryExcluded = false, storageUnavailable = false, ready = false, loading = false;
  let tracked = false, queue = [], timer = null, checkpoint = 0, visible = false, elapsed = 0;
  const recent = new Map();
  function excluded() {
    try { return memoryExcluded || Boolean(localStorage.getItem(DISABLED)); }
    catch { return memoryExcluded; }
  }
  function privacySignal() {
    return navigator.globalPrivacyControl === true ||
      ['1', 'yes'].includes(String(navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack));
  }
  function allowed() { return Boolean(page) && location.hostname === DOMAIN && !excluded() && !privacySignal(); }
  function cleanData(name, data = {}) {
    if (name === 'visible-time') {
      const seconds = Number(data.seconds);
      return Number.isFinite(seconds) && seconds >= 1 && seconds <= 600 ? { seconds: Math.floor(seconds) } : null;
    }
    if (!features.has(name)) return null;
    if (name.startsWith('history-')) return measurements.has(data.measurement) ? { measurement: data.measurement } : null;
    return {};
  }
  function referrer() {
    try {
      const url = new URL(document.referrer);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.hostname === DOMAIN ? (pages[url.pathname]?.[0] || '') : url.origin;
    } catch { return ''; }
  }
  // Applied to ALL provider payloads, including manual calls. Never pass query
  // strings, fragments, form text, user identifiers, or arbitrary event data.
  window.mooreAnalyticsBeforeSend = (type, payload) => {
    if (type !== 'event' || !allowed()) return false;
    const clean = { website: WEBSITE, hostname: DOMAIN, url: page[0], title: page[1], referrer: referrer() };
    if (/^\d{1,6}x\d{1,6}$/.test(payload.screen || '')) clean.screen = payload.screen;
    if (/^[a-z-]{2,35}$/i.test(payload.language || '')) clean.language = payload.language;
    if (payload.name) {
      const data = cleanData(payload.name, payload.data);
      if (!data) return false;
      clean.name = payload.name;
      if (Object.keys(data).length) clean.data = data;
    }
    return clean;
  };
  function send(name, data) {
    if (!allowed() || !ready || !window.umami?.track) return;
    try {
      const result = name ? window.umami.track(name, data) : window.umami.track();
      Promise.resolve(result).catch(() => {}); // Analytics must never disrupt the app.
    } catch { /* A blocked/unavailable analytics provider is harmless. */ }
  }
  function track(name, data = {}) {
    if (!allowed() || !features.has(name)) return;
    const clean = cleanData(name, data);
    if (!clean) return;
    const key = name + ':' + (clean.measurement || '');
    const now = performance.now();
    if (recent.has(key) && now - recent.get(key) < 1500) return;
    recent.set(key, now);
    if (ready) send(name, clean);
    else if (queue.length < 20) queue.push([name, clean]);
  }
  window.mooreAnalytics = Object.freeze({ track });
  function accrue() {
    const now = performance.now(), delta = now - checkpoint;
    // Long timer gaps indicate suspension/sleep; don't guess that it was usage.
    if (visible && allowed() && delta > 0 && delta <= 45000) elapsed += delta;
    checkpoint = now;
  }
  function flush(force = false) {
    if (!ready || !allowed()) return;
    const seconds = Math.floor(elapsed / 1000);
    if (seconds < (force ? 1 : 300)) return;
    elapsed -= seconds * 1000;
    send('visible-time', { seconds: Math.min(600, seconds) });
  }
  function resume() {
    if (!ready || !allowed()) return;
    if (!tracked) {
      send(); tracked = true;
      for (const [name, data] of queue.splice(0)) send(name, data);
    }
    checkpoint = performance.now();
    visible = document.visibilityState === 'visible';
    if (!timer) timer = setInterval(() => { accrue(); flush(); }, 15000);
  }
  function stop() {
    queue = []; recent.clear(); elapsed = 0; visible = false; tracked = false;
    if (timer) clearInterval(timer);
    timer = null; checkpoint = performance.now();
  }
  function start() {
    if (!allowed()) return;
    if (ready) { resume(); return; }
    if (loading) return;
    loading = true;
    const script = document.createElement('script');
    script.src = 'https://cloud.umami.is/script.js';
    script.defer = true;
    script.setAttribute('data-website-id', WEBSITE);
    script.setAttribute('data-domains', DOMAIN);
    script.setAttribute('data-auto-track', 'false');
    script.setAttribute('data-exclude-search', 'true');
    script.setAttribute('data-exclude-hash', 'true');
    script.setAttribute('data-do-not-track', 'true');
    script.setAttribute('data-before-send', 'mooreAnalyticsBeforeSend');
    script.onload = () => { loading = false; ready = Boolean(window.umami?.track); resume(); };
    script.onerror = () => { loading = false; queue = []; script.remove(); };
    document.head.append(script);
  }
  document.addEventListener('visibilitychange', () => {
    accrue();
    visible = document.visibilityState === 'visible';
    if (!visible) flush(true);
  });
  window.addEventListener('pagehide', () => { accrue(); visible = false; flush(true); });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { tracked = false; elapsed = 0; resume(); }
  });
  document.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    if (button && !button.disabled && clicks[button.id]) track(clicks[button.id]);
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'radarSlider' && !event.target.disabled) track('radar-timeline');
  });
  const button = document.getElementById('analyticsExclude');
  const status = document.getElementById('analyticsStatus');
  function paint() {
    if (!button || !status) return;
    button.hidden = false;
    button.disabled = privacySignal();
    button.setAttribute('aria-pressed', String(excluded() || privacySignal()));
    button.textContent = excluded() ? 'Include this browser in statistics' : 'Exclude this browser from statistics';
    status.textContent = privacySignal() ? 'Usage measurement is off because of your browser privacy setting.' :
      excluded() ? 'This browser is excluded from usage statistics.' : 'This browser is included in usage statistics.';
    if (storageUnavailable) status.textContent += ' Your browser could not save the change; it applies to this page only.';
  }
  button?.addEventListener('click', () => {
    memoryExcluded = !excluded(); storageUnavailable = false;
    try {
      if (memoryExcluded) localStorage.setItem(DISABLED, '1');
      else localStorage.removeItem(DISABLED);
    } catch { storageUnavailable = true; }
    stop(); paint(); start();
  });
  window.addEventListener('storage', event => {
    if (event.key === DISABLED || event.key === null) {
      memoryExcluded = false; stop(); paint(); start();
    }
  });
  paint(); start();
})();
