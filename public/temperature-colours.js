(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MooreTemperatureColours = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // Shared with the current air/globe readings. Keep the established Celsius
  // bands and descriptions; missing readings must never coerce to zero.
  function getTemperatureColorAndDesc(temp) {
    if (typeof temp !== 'number' || !Number.isFinite(temp)) return { color: 'var(--text)', desc: '' };
    let color, desc;
    if (temp < -20) { color = 'var(--temp-deep-freeze)'; desc = ''; }
    else if (temp < -10) { color = 'var(--temp-severe-cold)'; desc = 'Severely cold'; }
    else if (temp < 0) { color = 'var(--temp-extreme-cold)'; desc = 'Extremely cold'; }
    else if (temp < 6) { color = 'var(--temp-very-cold)'; desc = 'Very cold'; }
    else if (temp < 11) { color = 'var(--temp-cold)'; desc = 'Cold'; }
    else if (temp < 16) { color = 'var(--temp-cool)'; desc = 'Cool'; }
    else if (temp < 21) { color = 'var(--temp-mild)'; desc = 'Mild'; }
    else if (temp < 28) { color = 'var(--temp-warm)'; desc = 'Warm'; }
    else if (temp < 32) { color = 'var(--temp-warmer)'; desc = 'Warmer'; }
    else if (temp < 36) { color = 'var(--temp-hot)'; desc = 'Hot'; }
    else if (temp < 41) { color = 'var(--temp-very-hot)'; desc = 'Very hot'; }
    else if (temp <= 60) { color = 'var(--temp-extreme-hot)'; desc = 'Extremely hot'; }
    else { color = 'var(--text)'; desc = ''; }
    return { color, desc };
  }

  return { getTemperatureColorAndDesc };
});
