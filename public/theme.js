/* Start in dark mode; explicit choices made after this update persist on every page. */
(() => {
  const key = 'mooreWeatherTheme', version = 'mooreWeatherThemeVersion';
  let mode = 'dark';
  try {
    // Version 3 saved light even when the visitor had never chosen a theme.
    // Reset that legacy default once, then honour either explicit preference.
    const saved = localStorage.getItem(key);
    if (localStorage.getItem(version) === '4' && ['light', 'dark'].includes(saved)) mode = saved;
    localStorage.setItem(key, mode); localStorage.setItem(version, '4');
  } catch {}
  const icons = { light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>', dark: '<svg viewBox="0 0 24 24"><path d="M20 14.3A8 8 0 0 1 9.7 4a8 8 0 1 0 10.3 10.3Z"/></svg>' };
  function paint() {
    document.documentElement.dataset.theme = mode;
    document.documentElement.dataset.themeMode = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = mode === 'light' ? '#eef2f6' : '#0b1119';
    const button = document.getElementById('themeToggleBtn');
    if (button) { button.setAttribute('aria-label', mode === 'light' ? 'Switch to dark theme' : 'Switch to light theme'); button.title = button.getAttribute('aria-label'); }
    const label = document.getElementById('themeToggleLabel'), icon = document.getElementById('themeToggleIcon');
    if (label) label.textContent = mode === 'light' ? 'Light' : 'Dark';
    if (icon) icon.innerHTML = icons[mode];
  }
  paint();
  document.addEventListener('DOMContentLoaded', () => {
    paint();
    document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
      mode = mode === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(key, mode); } catch {}
      paint();
    });
  });
})();
