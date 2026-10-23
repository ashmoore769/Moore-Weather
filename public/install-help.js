/* Installation is always optional and requires the visitor's own button press. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const standalone = window.matchMedia('(display-mode: standalone)');
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = !ios && /Android/i.test(ua);
  const embedded = /FBAN|FBAV|Instagram|\bwv\b|Line\//i.test(ua);
  const address = new URL('/', location.href).href;
  let pendingPrompt = null, prompting = false, installed = standalone.matches || navigator.standalone === true;
  const action = $('installAction'), button = $('installAppButton'), status = $('installStatus');
  function tell(text) { status.textContent = text; status.hidden = false; }
  function paint() { action.hidden = installed || (!pendingPrompt && !prompting); button.disabled = prompting; }
  function select(platform) {
    document.querySelectorAll('[data-platform]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.platform === platform)));
    for (const name of ['ios', 'android', 'desktop']) $('install-' + name).hidden = name !== platform;
  }
  $('installPlatforms').hidden = false;
  document.querySelectorAll('[data-platform]').forEach(control => control.addEventListener('click', () => select(control.dataset.platform)));
  select(ios ? 'ios' : android ? 'android' : 'desktop');
  if (embedded) {
    $('installBrowserNote').textContent = 'You may be viewing this inside another app. Open Moore Weather in Safari on iPhone, or Chrome on Android, to add it to your home screen.';
    $('installBrowserNote').hidden = false;
  }
  if (installed) tell('You’re already opening Moore Weather as an app. You’re all set!');
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    if (installed) return;
    pendingPrompt = event; paint();
  });
  window.addEventListener('appinstalled', () => {
    installed = true; pendingPrompt = null;
    tell('Moore Weather has been added. Look for its icon on your home screen or in your apps.'); paint();
  });
  standalone.addEventListener?.('change', event => {
    if (event.matches) { installed = true; pendingPrompt = null; tell('You’re already opening Moore Weather as an app. You’re all set!'); paint(); }
  });
  button.addEventListener('click', async () => {
    if (!pendingPrompt || installed || prompting) return;
    const prompt = pendingPrompt; pendingPrompt = null; prompting = true; paint();
    try {
      const result = await prompt.prompt();
      const choice = result || await prompt.userChoice;
      if (!installed) tell(choice?.outcome === 'accepted'
        ? 'Your browser is adding Moore Weather. Look for its icon on your home screen or in your apps.'
        : 'No problem—you can add Moore Weather later using the steps below.');
    } catch {
      if (!installed) tell('The install prompt couldn’t open. You can still use the steps below.');
    } finally { prompting = false; paint(); }
  });
  $('installAddress').textContent = new URL(address).host;
  const copy = $('copyInstallAddress'), copyStatus = $('installCopyStatus');
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
      await navigator.clipboard.writeText(address);
      copyStatus.textContent = 'Address copied. Paste it into Safari or Chrome.';
    } catch { copyStatus.textContent = 'Select the address above to copy it, then open it in Safari or Chrome.'; }
    copyStatus.hidden = false;
  });
  // Reuse the notification worker. It does not cache private pages or weather.
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  paint();
})();
