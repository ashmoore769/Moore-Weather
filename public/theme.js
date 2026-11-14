/* Moore Weather uses the same dark palette on every page and device. */
(() => {
  function paint() {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.dataset.themeMode = 'dark';
    document.documentElement.style.colorScheme = 'dark';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = '#0d1722';
  }
  // Paint synchronously before content, regardless of saved or system preferences.
  paint();
  try {
    // Also replace preferences saved by older releases; storage is optional.
    localStorage.setItem('mooreWeatherTheme', 'dark');
    localStorage.setItem('mooreWeatherThemeVersion', '5');
  } catch {}
  document.addEventListener('DOMContentLoaded', paint);
})();
