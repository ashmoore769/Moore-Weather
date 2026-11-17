(function (root, factory) {
  'use strict';
  const commonJS = typeof module === 'object' && module.exports;
  const model = commonJS ? require('./forecast-summary-model.js') : root.MooreForecastSummary;
  const api = factory(model);
  if (commonJS) module.exports = api;
  else {
    root.MooreForecastSummaryCard = api;
    if (root.document && root.fetch) {
      const controller = api.createController({ document: root.document, fetch: root.fetch.bind(root), location: root.location });
      if (controller) controller.start();
    }
  }
})(typeof globalThis === 'object' ? globalThis : this, function (defaultModel) {
  'use strict';

  const PAINT_MS = 30000, REQUEST_TIMEOUT_MS = 15000, RETRY_MIN_MS = 60000, RETRY_MAX_MS = 300000;
  const OFFSET_MS = 10 * 3600000, DAY_MS = 86400000, EMPTY = '–';
  const clock = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit', hour12: true });
  const date = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short' });
  const fullDate = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const dayKey = milliseconds => Math.floor((milliseconds + OFFSET_MS) / DAY_MS);
  const formatTime = (milliseconds, minutes = false) => {
    const value = clock.format(milliseconds).replace(/\s/g, '');
    return minutes ? value : value.replace(/:00/, '');
  };
  const rainText = value => !finite(value) ? EMPTY : value > 0 && value < 0.1 ? '<0.1' : value.toFixed(value >= 100 ? 0 : 1);
  const temperatureText = value => finite(value) ? String(Math.round(value)) + '°' : EMPTY;
  const percentText = value => finite(value) ? String(Math.round(value)) + '%' : EMPTY;

  function dayLabel(milliseconds, now) {
    const difference = dayKey(milliseconds) - dayKey(now);
    return difference === 0 ? 'Today' : difference === 1 ? 'Tomorrow' : date.format(milliseconds);
  }

  function timeRange(startMs, endMs) {
    let first = formatTime(startMs);
    const last = formatTime(endMs);
    if (first.slice(-2) === last.slice(-2)) first = first.slice(0, -2);
    return first + '–' + last;
  }

  function intervalText(hour, now, includeDay = true) {
    return (includeDay ? dayLabel(hour.startMs, now) + ' · ' : '') + timeRange(hour.startMs, hour.endMs);
  }

  function pointWindowText(window, now) {
    const prefix = dayKey(window.firstAtMs) === dayKey(now) ? '' : dayLabel(window.firstAtMs, now).toLowerCase() + ' ';
    if (window.firstAtMs === window.lastAtMs) return prefix + 'around ' + formatTime(window.firstAtMs);
    if (dayKey(window.firstAtMs) !== dayKey(window.lastAtMs)) {
      return prefix + formatTime(window.firstAtMs) + '–' + dayLabel(window.lastAtMs, now).toLowerCase() + ' ' + formatTime(window.lastAtMs);
    }
    return prefix + timeRange(window.firstAtMs, window.lastAtMs);
  }

  function chartScale(hours) {
    const maximum = Math.max(0, ...hours.map(hour => finite(hour.rainMm) ? hour.rainMm : 0));
    if (maximum <= 1) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(maximum));
    return [1, 2, 5, 10].find(step => step * magnitude >= maximum) * magnitude;
  }

  function timingText(summary, now) {
    const rain = summary.rain;
    if (!rain.complete) return rain.knownHours ? rain.knownHours + '/24 rain hours available · incomplete outlook' : 'Hourly rain amounts unavailable';
    if (rain.hasRain === false) return 'No measurable rain forecast in the next 24h';
    if (rain.traceOnly) return 'Trace rain forecast · less than 0.1 mm per hour';
    if (!rain.nextWet) return 'Hourly rain timing unavailable';
    const next = rain.nextWet, peak = rain.wettest;
    const nextText = next.startMs <= now && next.endMs > now ? 'Rain this hour'
      : 'Rain from ' + (dayKey(next.startMs) === dayKey(now) ? '' : 'tomorrow ') + formatTime(next.startMs);
    if (peak && peak.startMs !== next.startMs) {
      return nextText + ' · peak ' + (dayKey(peak.startMs) === dayKey(now) ? '' : 'tomorrow ') + timeRange(peak.startMs, peak.endMs);
    }
    return nextText + ' · ' + rainText(next.rainMm) + ' mm in that hour';
  }

  function createController(options) {
    const doc = options.document, card = doc?.getElementById('forecastSummary');
    if (!card) return null;
    const model = options.model || defaultModel;
    const request = options.fetch, location = options.location;
    const view = options.window || doc.defaultView;
    const now = options.now || Date.now;
    const schedule = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    const cancel = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    const Abort = options.AbortController || view?.AbortController || globalThis.AbortController;
    const Resize = options.ResizeObserver || view?.ResizeObserver;
    const node = id => doc.getElementById(id);
    const plot = node('forecastSummaryPlot'), chart = node('forecastSummaryChart');
    const text = (id, value) => { const element = node(id); if (element && element.textContent !== value) element.textContent = value; };
    const html = (id, value) => { const element = node(id); if (element && element.innerHTML !== value) element.innerHTML = value; };
    const attribute = (element, name, value) => element?.setAttribute(name, String(value));
    let started = false, generation = 0, inFlight = false, failed = false, attempted = false;
    let data = null, summary = null, selectedIndex = 0, selectedStart = null, selectionPinned = false;
    let pollTimer = null, paintTimer = null, requestTimer = null, nextAttemptAt = 0, retryCount = 0;
    let requestAbort = null, observer = null, pointer = null, plotGeometry = null;
    const bindings = [];

    function listen(element, type, handler, options) {
      if (!element?.addEventListener) return;
      element.addEventListener(type, handler, options);
      bindings.push(() => element.removeEventListener(type, handler, options));
    }

    function visible() { return doc.hidden !== true; }

    function setSelection(index, pin = true) {
      if (!summary?.usable || !summary.hours.length) return;
      selectedIndex = clamp(Math.round(index), 0, summary.hours.length - 1);
      selectedStart = summary.hours[selectedIndex].startMs;
      if (pin) selectionPinned = true;
      renderChart();
    }

    function renderChart() {
      if (!plot || !chart || !summary) return;
      const hours = summary.hours;
      const width = Math.max(180, Math.round(plot.clientWidth || plot.getBoundingClientRect?.().width || 360));
      const scale = chartScale(hours);
      const height = 110, left = scale >= 100 ? 43 : 31, right = width - 34, top = 12, bottom = 80;
      const cell = (right - left) / 24;
      const selection = summary.usable ? hours[selectedIndex] : null;
      plotGeometry = { left, right, width };
      attribute(chart, 'viewBox', '0 0 ' + width + ' ' + height);
      const parts = [
        '<line class="forecast-summary-grid" x1="' + left + '" x2="' + right + '" y1="' + top + '" y2="' + top + '"/>',
        '<line class="forecast-summary-grid" x1="' + left + '" x2="' + right + '" y1="' + bottom + '" y2="' + bottom + '"/>',
        '<text class="forecast-summary-axis" x="0" y="' + (top + 3) + '">' + (summary.usable ? escape(scale + ' mm') : 'mm') + '</text>',
        '<text class="forecast-summary-axis" x="20" y="' + (bottom + 3) + '" text-anchor="end">' + (summary.usable ? '0' : EMPTY) + '</text>'
      ];
      // Rain belongs to the whole interval between these hour boundaries.
      // Keep the guides behind the bars and temperature trace at every width.
      for (let i = 0; i <= 24; i++) {
        const x = (left + i * cell).toFixed(2);
        parts.push('<line class="forecast-summary-hour-grid" data-hour-boundary="' + i + '" x1="' + x + '" x2="' + x + '" y1="' + top + '" y2="' + bottom + '"/>');
      }
      if (selection) parts.push('<rect class="forecast-summary-selection" x="' + (left + selectedIndex * cell).toFixed(2) + '" y="4" width="' + cell.toFixed(2) + '" height="83" rx="3"/>');
      for (let i = 0; i < 24; i++) {
        const hour = hours[i], value = hour?.rainMm;
        const missing = !finite(value), zero = value === 0;
        const barHeight = missing ? 5 : zero ? 1.5 : Math.max(2, value / scale * (bottom - top));
        const barWidth = Math.max(2, cell * 0.64), x = left + i * cell + (cell - barWidth) / 2;
        const state = missing ? 'missing' : zero ? 'zero' : 'rain';
        parts.push('<rect class="forecast-summary-bar forecast-summary-bar-' + state + (selection && i === selectedIndex ? ' forecast-summary-bar-selected' : '') + '" data-hour="' + i + '" data-state="' + state + '" x="' + x.toFixed(2) + '" y="' + (bottom - barHeight).toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + barHeight.toFixed(2) + '" rx="1.5"/>');
      }
      // A separate right-hand Celsius scale. The forecast line is derived
      // from the SAME 24 hourly values as the rain bars, without extra fetches.
      // Missing temperature hours split the path rather than being bridged.
      const temperatures = hours.filter(hour => finite(hour?.tempC)).map(hour => hour.tempC);
      if (temperatures.length) {
        const lowest = Math.floor(Math.min(...temperatures)) - 2;
        const highest = Math.ceil(Math.max(...temperatures)) + 2;
        const tempY = value => top + 5 + (highest - value) /
          Math.max(1, highest - lowest) * (bottom - top - 10);
        let path = '', previous = false;
        const singles = [];
        for (let i = 0; i < 24; i++) {
          const value = hours[i]?.tempC;
          if (!finite(value)) { previous = false; continue; }
          // Temperature is instantaneous at the interval's end, unlike rain.
          const x = (left + (hours[i].endMs - summary.startMs) / model.HOUR_MS * cell).toFixed(2), y = tempY(value).toFixed(2);
          path += (previous ? 'L' : 'M') + x + ',' + y;
          previous = true;
          singles.push({ x, y, i });
        }
        parts.push('<path class="forecast-summary-temperature-line" d="' + path + '"/>');
        parts.push('<text class="forecast-summary-axis forecast-summary-temperature-axis" x="' + (width - 1) +
          '" y="' + (top + 3) + '" text-anchor="end">' + escape(highest + '°') + '</text>');
        parts.push('<text class="forecast-summary-axis forecast-summary-temperature-axis" x="' + (width - 1) +
          '" y="' + (bottom + 3) + '" text-anchor="end">' + escape(lowest + '°') + '</text>');
        if (selection && finite(selection.tempC)) {
          const active = singles.find(point => point.i === selectedIndex);
          if (active) parts.push('<circle class="forecast-summary-temperature-selected" cx="' +
            active.x + '" cy="' + active.y + '" r="3.3"/>');
        }
      }
      if (finite(summary.startMs)) {
        const midnight = (dayKey(summary.startMs) + 1) * DAY_MS - OFFSET_MS;
        const midnightIndex = (midnight - summary.startMs) / model.HOUR_MS;
        const markers = [0, 6, 12, 18, 24].map(index => ({ index, label: formatTime(summary.startMs + index * model.HOUR_MS), midnight: false }));
        if (midnightIndex > 0 && midnightIndex <= 24) {
          const midnightX = left + midnightIndex * cell;
          parts.push('<line class="forecast-summary-midnight" x1="' + midnightX.toFixed(2) + '" x2="' + midnightX.toFixed(2) + '" y1="' + top + '" y2="' + (bottom + 4) + '"/>');
          markers.push({ index: midnightIndex, label: 'Tomorrow', midnight: true });
        }
        const positioned = markers.map(marker => {
          const x = left + marker.index * cell, labelWidth = marker.label.length * 6;
          const anchor = x - left < labelWidth / 2 + 1 ? 'start' : right - x < labelWidth / 2 + 1 ? 'end' : 'middle';
          const labelLeft = anchor === 'start' ? x : anchor === 'end' ? x - labelWidth : x - labelWidth / 2;
          return { ...marker, x, anchor, left: labelLeft - 1, right: labelLeft + labelWidth + 1 };
        });
        // Reserve the midnight label first. Bounds include its actual anchor
        // and a conservative width for the 10px axis font, so an edge-anchored
        // date label cannot collide with the next ordinary tick on mobile.
        const labels = [];
        positioned.sort((a, b) => Number(b.midnight) - Number(a.midnight) || a.index - b.index);
        for (const marker of positioned) {
          if (!labels.some(label => marker.left < label.right && marker.right > label.left)) labels.push(marker);
        }
        labels.sort((a, b) => a.index - b.index);
        for (const marker of labels) {
          parts.push('<text class="forecast-summary-axis' + (marker.midnight ? ' forecast-summary-day-label' : '') + '" x="' + marker.x.toFixed(2) + '" y="102" text-anchor="' + marker.anchor + '">' + escape(marker.label) + '</text>');
        }
      }
      const currentTime = now();
      if (summary.usable && finite(currentTime) && currentTime >= summary.startMs && currentTime <= summary.endMs) {
        // The first bar includes the ongoing hour. Mark the real current time
        // within it; its start and the first complete future hour are not Now.
        const x = left + (currentTime - summary.startMs) / model.HOUR_MS * cell;
        const labelX = clamp(x + 4, left + 4, right - 23);
        parts.push('<line class="forecast-summary-now" x1="' + x.toFixed(2) + '" x2="' + x.toFixed(2) + '" y1="' + top + '" y2="' + bottom + '"><title>' + escape('Now · ' + formatTime(currentTime, true) + ' AEST') + '</title></line>');
        parts.push('<text class="forecast-summary-axis forecast-summary-now-label" x="' + labelX.toFixed(2) + '" y="8">Now</text>');
      }
      html('forecastSummaryChart', parts.join(''));
      attribute(plot, 'aria-disabled', selection ? 'false' : 'true');
      attribute(plot, 'tabindex', selection ? '0' : '-1');
      attribute(plot, 'aria-valuenow', selectedIndex);
      if (!selection) {
        const loading = !attempted;
        text('forecastSummaryInspect', loading ? 'Hourly forecast loading.' : 'Hourly forecast unavailable.');
        attribute(plot, 'aria-valuetext', loading ? 'Forecast loading' : 'Forecast unavailable');
        return;
      }
      const rain = rainText(selection.rainMm), chance = percentText(selection.chancePercent), temp = temperatureText(selection.tempC);
      const interval = intervalText(selection, now());
      const temperatureTitle = 'Temperature at ' + formatTime(selection.endMs) + ' AEST';
      html('forecastSummaryInspect', '<strong>' + escape(interval) + '</strong><span class="forecast-summary-inspect-rain">' + escape(rain) + (rain === EMPTY ? ' mm' : ' mm rain') + '</span><span>' + escape(chance) + ' chance</span><span title="' + escape(temperatureTitle) + '">' + escape(temp) + '</span>');
      const spoken = dayLabel(selection.startMs, now()) + ', ' + formatTime(selection.startMs) + ' to ' + formatTime(selection.endMs) + ' AEST; '
        + (finite(selection.rainMm) ? (selection.rainMm < 0.1 && selection.rainMm > 0 ? 'less than 0.1' : selection.rainMm.toFixed(1)) + ' millimetres rain' : 'rain amount unavailable') + '; '
        + (finite(selection.chancePercent) ? Math.round(selection.chancePercent) + ' percent rain chance' : 'rain chance unavailable') + '; '
        + (finite(selection.tempC) ? Math.round(selection.tempC) + ' degrees Celsius at ' + formatTime(selection.endMs) : 'temperature unavailable');
      attribute(plot, 'aria-valuetext', spoken);
    }

    function paint() {
      if (!model?.buildSummary) {
        attribute(card, 'data-state', 'unavailable');
        attribute(card, 'aria-busy', 'false');
        text('forecastSummarySignal', 'Forecast unavailable');
        text('forecastSummaryTiming', 'The full forecast is still available above.');
        return;
      }
      const currentTime = now();
      summary = model.buildSummary(data, currentTime);
      const loading = !attempted && !data;
      const state = loading ? 'loading' : failed && summary.usable ? 'stale' : summary.status;
      attribute(card, 'data-state', state);
      attribute(card, 'aria-busy', loading ? 'true' : 'false');
      attribute(card, 'data-storm', summary.usable ? summary.storms.signal : 'unknown');
      if (summary.usable) {
        html('forecastSummaryRain', escape(rainText(summary.rain.totalMm)) + (finite(summary.rain.totalMm) ? '<small> mm</small>' : ''));
        text('forecastSummaryChance', percentText(summary.rain.peakChancePercent));
        html('forecastSummaryTemps', escape(temperatureText(summary.temperature.highC)) + '<span> / ' + escape(temperatureText(summary.temperature.lowC)) + '</span>');
        if (summary.storms.signal === 'forecast') {
          const firstWindow = summary.storms.windows?.[0] || { firstAtMs: summary.storms.firstAtMs, lastAtMs: summary.storms.lastAtMs };
          text('forecastSummarySignal', 'Thunderstorms possible · ' + pointWindowText(firstWindow, currentTime) + (summary.storms.windows?.length > 1 ? ' + later' : ''));
        } else text('forecastSummarySignal', summary.storms.signal === 'none' ? 'No thunderstorm signal' : 'Storm outlook incomplete');
        text('forecastSummaryTiming', timingText(summary, currentTime));
        let matchingIndex = selectionPinned ? summary.hours.findIndex(hour => hour.startMs === selectedStart) : -1;
        if (matchingIndex < 0) {
          selectionPinned = false;
          matchingIndex = summary.rain.wettest ? summary.hours.findIndex(hour => hour.startMs === summary.rain.wettest.startMs) : 0;
        }
        selectedIndex = Math.max(0, matchingIndex);
        selectedStart = summary.hours[selectedIndex].startMs;
        text('forecastSummarySource', ' · ' + formatTime(summary.fetchedAtMs, true) + ' AEST' + (state === 'stale' ? ' · delayed' : ''));
        attribute(node('forecastSummarySource'), 'title', 'Warwick area forecast fetched ' + fullDate.format(summary.fetchedAtMs) + ' AEST' + (state === 'stale' ? '; refresh delayed' : ''));
      } else {
        text('forecastSummaryRain', EMPTY);
        text('forecastSummaryChance', EMPTY);
        text('forecastSummaryTemps', EMPTY);
        text('forecastSummarySignal', loading ? 'Loading the outlook…' : state === 'expired' ? 'Forecast has expired' : 'Forecast temporarily unavailable');
        text('forecastSummaryTiming', loading ? 'Hourly rain, temperatures and storm outlook' : 'Retrying automatically');
        text('forecastSummarySource', loading ? ' · Warwick area' : state === 'expired' ? ' · older than 6h' : ' · unavailable');
        attribute(node('forecastSummarySource'), 'title', 'Warwick area forecast');
        selectedIndex = 0;
      }
      renderChart();
    }

    function clearTimers() {
      if (pollTimer !== null) cancel(pollTimer);
      if (paintTimer !== null) cancel(paintTimer);
      pollTimer = paintTimer = null;
    }

    function armTimers() {
      clearTimers();
      if (!started || !visible()) return;
      paintTimer = schedule(() => { paintTimer = null; paint(); armTimers(); }, PAINT_MS);
      if (!inFlight) pollTimer = schedule(() => { pollTimer = null; refresh(); }, Math.max(0, nextAttemptAt - now()));
    }

    function delayRetry() {
      retryCount = Math.min(retryCount + 1, 4);
      nextAttemptAt = now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * (2 ** (retryCount - 1)));
    }

    async function refresh() {
      if (!started || !visible() || inFlight || typeof request !== 'function' || !model?.buildSummary) return;
      inFlight = true;
      const run = generation;
      requestAbort = Abort ? new Abort() : null;
      const abort = requestAbort;
      try {
        const deadline = new Promise((_, reject) => {
          requestTimer = schedule(() => { abort?.abort(); reject(new Error('Forecast request timed out')); }, REQUEST_TIMEOUT_MS);
        });
        const fetchData = (async () => {
          const response = await request('/api/forecast', { cache: 'no-store', credentials: 'same-origin', ...(abort ? { signal: abort.signal } : {}) });
          if (response.status === 401) {
            if (started && run === generation && location) location.href = '/login?next=%2F';
            throw new Error('Authentication required');
          }
          if (!response.ok) throw new Error('Forecast request failed');
          return response.json();
        })();
        const candidate = await Promise.race([fetchData, deadline]);
        if (!started || run !== generation) return;
        const candidateSummary = model.buildSummary(candidate, now());
        if (!candidateSummary.usable) {
          // Preserve expiry metadata for an initial expired response, while the
          // model itself withholds its old values. Never replace usable data
          // with an invalid response during a transient failure.
          if (!data && candidateSummary.status === 'expired') data = candidate;
          throw new Error('Forecast data is unavailable');
        }
        data = candidate;
        failed = false;
        if (candidateSummary.status === 'fresh') {
          retryCount = 0;
          nextAttemptAt = Math.max(now() + PAINT_MS, candidateSummary.fetchedAtMs + model.FRESH_MS);
        } else delayRetry();
      } catch (_) {
        if (!started || run !== generation) return;
        failed = true;
        delayRetry();
      } finally {
        if (run === generation) {
          if (requestTimer !== null) cancel(requestTimer);
          requestTimer = null;
          requestAbort = null;
          inFlight = false;
          attempted = true;
          if (started) { paint(); armTimers(); }
        }
      }
    }

    function pointIndex(clientX) {
      if (!plotGeometry || !plot) return 0;
      const bounds = plot.getBoundingClientRect();
      const scale = bounds.width ? plotGeometry.width / bounds.width : 1;
      return Math.floor(((clientX - bounds.left) * scale - plotGeometry.left) / (plotGeometry.right - plotGeometry.left) * 24);
    }

    function releasePointer(event) {
      if (!pointer || (event?.pointerId !== undefined && pointer.id !== event.pointerId)) return;
      try { if (plot?.hasPointerCapture?.(pointer.id)) plot.releasePointerCapture(pointer.id); } catch (_) { /* Capture may have ended during native scrolling. */ }
      pointer = null;
    }

    function visibilityChanged() {
      if (!started) return;
      if (!visible()) { clearTimers(); return; }
      paint();
      if (now() >= nextAttemptAt) refresh();
      armTimers();
    }

    function start() {
      if (started) return;
      started = true;
      generation++;
      listen(doc, 'visibilitychange', visibilityChanged);
      listen(plot, 'keydown', event => {
        if (!summary?.usable) return;
        const target = { ArrowLeft: selectedIndex - 1, ArrowRight: selectedIndex + 1, ArrowDown: selectedIndex - 1, ArrowUp: selectedIndex + 1, Home: 0, End: 23, PageDown: selectedIndex - 6, PageUp: selectedIndex + 6 }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        setSelection(target);
      });
      listen(plot, 'click', event => { if (summary?.usable) setSelection(pointIndex(event.clientX)); });
      listen(plot, 'pointerdown', event => {
        if (!summary?.usable || (event.button !== undefined && event.button !== 0) || event.isPrimary === false) return;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false, scrolling: false };
      });
      listen(plot, 'pointermove', event => {
        if (!pointer || pointer.id !== event.pointerId || pointer.scrolling) return;
        const x = Math.abs(event.clientX - pointer.x), y = Math.abs(event.clientY - pointer.y);
        if (!pointer.dragging) {
          if (y > 6 && y > x) { pointer.scrolling = true; return; }
          if (x < 6 || x < y * 1.4) return;
          pointer.dragging = true;
          try { plot.setPointerCapture?.(pointer.id); } catch (_) { /* Native touch handling can cancel capture. */ }
        }
        setSelection(pointIndex(event.clientX));
      });
      listen(plot, 'pointerup', releasePointer);
      listen(plot, 'pointercancel', releasePointer);
      listen(plot, 'lostpointercapture', releasePointer);
      if (Resize && plot) {
        observer = new Resize(() => { if (started && visible()) renderChart(); });
        observer.observe(plot);
      } else listen(view, 'resize', () => { if (visible()) renderChart(); });
      paint();
      if (visible() && now() >= nextAttemptAt) refresh();
      armTimers();
    }

    function stop() {
      if (!started) return;
      started = false;
      generation++;
      clearTimers();
      if (requestTimer !== null) cancel(requestTimer);
      requestTimer = null;
      requestAbort?.abort();
      requestAbort = null;
      inFlight = false;
      releasePointer();
      observer?.disconnect();
      observer = null;
      while (bindings.length) bindings.pop()();
    }

    return { start, stop, refresh };
  }

  return { createController, chartScale, intervalText, timingText };
});
