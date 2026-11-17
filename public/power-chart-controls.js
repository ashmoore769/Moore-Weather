/* Cached power-chart navigation. Uses the same bounded viewport maths as Home Solar. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./solar-chart') : root.SolarChart);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoorePowerChartControls = api;
})(typeof globalThis === 'object' ? globalThis : this, function (navigation) {
  'use strict';
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const stamp = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  function create({ plot, prefix, label, redraw }) {
    const doc = plot.ownerDocument;
    let bounds = null, view = null, minSpan = 3600000, domainKey, items = [], visible = [];
    let geometry = null, selected = null, pinned = false, gesture = null;
    const pointers = new Map(), buttons = {};
    const ui = doc.createElement('div'); ui.className = 'power-chart-controls';
    const toolbar = doc.createElement('div'); toolbar.className = 'power-chart-navigation';
    toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', label + ' chart navigation');
    const duration = doc.createElement('span'); duration.className = 'power-chart-window';
    toolbar.append(duration);
    const actions = [
      ['PanEarlier', 'Pan ' + label + ' chart earlier', 'm14 6-6 6 6 6', () => pan(-.5)],
      ['ZoomOut', 'Zoom out ' + label + ' chart', 'M5 12h14', () => zoom(2)],
      ['ZoomReset', 'Reset ' + label + ' chart zoom', null, reset],
      ['ZoomIn', 'Zoom in ' + label + ' chart', 'M5 12h14M12 5v14', () => zoom(.5)],
      ['PanLater', 'Pan ' + label + ' chart later', 'm10 6 6 6-6 6', () => pan(.5)]
    ];
    for (const [name, accessibleLabel, path, action] of actions) {
      const button = doc.createElement('button'); button.type = 'button'; button.id = prefix + name;
      button.setAttribute('aria-label', accessibleLabel); button.title = accessibleLabel; button.disabled = true;
      if (path) button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + path + '"/></svg>';
      else button.textContent = 'Reset';
      button.addEventListener('click', action); toolbar.append(button); buttons[name] = button;
    }
    const slider = doc.createElement('input'); slider.type = 'range'; slider.id = prefix + 'Scrubber';
    slider.className = 'power-chart-scrubber'; slider.min = '0'; slider.max = '0'; slider.step = '1'; slider.hidden = true;
    slider.setAttribute('aria-label', 'Inspect a time on the ' + label + ' chart');
    const inspection = doc.createElement('div'); inspection.id = prefix + 'Inspect';
    inspection.className = 'power-chart-inspect'; inspection.setAttribute('aria-live', 'polite');
    inspection.textContent = 'No recorded readings.';
    const hint = doc.createElement('p'); hint.id = prefix + 'NavigationHint'; hint.className = 'power-chart-hint';
    hint.textContent = 'Pinch or scroll to zoom · drag to pan';
    ui.append(toolbar, slider, inspection, hint);
    const legend = plot.nextElementSibling;
    (legend?.matches('.station-power-legend,.yard-power-legend') ? legend : plot).after(ui);
    plot.classList.add('power-chart-plot'); plot.tabIndex = 0; plot.setAttribute('role', 'group');
    plot.setAttribute('aria-label', label + ' history. Arrow keys inspect readings. Shift and arrow keys pan. Plus and minus zoom. Zero resets.');
    plot.setAttribute('aria-describedby', hint.id);

    function hasData() { return items.some(item => item.values.some(value => Number.isFinite(value.value))); }
    function plotBounds() {
      const rect = plot.getBoundingClientRect(), scale = geometry ? rect.width / geometry.width : 1;
      return { left: rect.left + (geometry?.left || 0) * scale,
        width: geometry ? (geometry.right - geometry.left) * scale : rect.width };
    }
    function fraction(clientX) {
      const rect = plotBounds(); return rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : .5;
    }
    function inspect(position, pin = true) {
      const item = visible[clamp(position, 0, visible.length - 1)];
      if (!item) return;
      selected = item.t; pinned = pin; slider.value = String(visible.indexOf(item));
      slider.setAttribute('aria-valuetext', stamp.format(item.t) + ' AEST');
      inspection.replaceChildren();
      const time = doc.createElement('strong'); time.textContent = stamp.format(item.t) + ' AEST'; inspection.append(time);
      for (const reading of item.values) {
        const value = doc.createElement('span');
        value.textContent = reading.name + ' ' + (Number.isFinite(reading.value)
          ? reading.value.toFixed(reading.precision ?? 2) + ' ' + reading.unit : '—');
        inspection.append(value);
      }
      const cursor = geometry?.svg.querySelector('.power-chart-selection');
      if (cursor) {
        const x = geometry.left + (item.t - view.start) / (view.end - view.start) * (geometry.right - geometry.left);
        cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.setAttribute('visibility', pinned ? 'visible' : 'hidden');
      }
    }
    function present(nextGeometry) {
      geometry = nextGeometry;
      if (!view || !bounds) return;
      visible = items.filter(item => item.t >= view.start && item.t <= view.end);
      const span = view.end - view.start, zoomed = span < bounds.end - bounds.start - 1;
      for (const [name, value] of Object.entries({ windowStart: view.start, windowEnd: view.end, windowSpan: span, zoomed })) plot.dataset[name] = String(value);
      const hours = span / 3600000;
      duration.textContent = (hours >= 48 ? (hours / 24).toFixed(hours % 24 ? 1 : 0) + ' days' : hours.toFixed(hours % 1 ? 1 : 0) + 'h');
      const empty = !hasData();
      for (const [name, disabled] of Object.entries({ ZoomIn: empty || span <= minSpan + 1, ZoomOut: empty || !zoomed,
        ZoomReset: !zoomed, PanEarlier: empty || view.start <= bounds.start + 1, PanLater: empty || view.end >= bounds.end - 1 })) buttons[name].disabled = disabled;
      slider.hidden = !visible.length || empty; slider.max = String(Math.max(0, visible.length - 1));
      const cursor = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
      cursor.setAttribute('class', 'power-chart-selection'); cursor.setAttribute('y1', geometry.top); cursor.setAttribute('y2', geometry.bottom);
      cursor.setAttribute('visibility', 'hidden'); geometry.svg.append(cursor);
      if (visible.length && !empty) {
        const position = visible.findIndex(item => item.t === selected);
        inspect(position < 0 ? visible.length - 1 : position, position >= 0 && pinned);
      } else inspection.textContent = empty ? 'No recorded readings.' : 'No recorded readings in this view.';
    }
    function setData(data) {
      cancelGesture();
      const wasFull = !bounds || !view || view.end - view.start >= bounds.end - bounds.start - 1;
      const changed = domainKey !== data.domainKey;
      bounds = data.bounds; domainKey = data.domainKey; minSpan = data.minSpan;
      items = data.items.filter(item => Number.isFinite(item.t) && item.t >= bounds.start && item.t <= bounds.end).sort((a, b) => a.t - b.t);
      view = navigation.navigationWindow(changed || wasFull ? null : view?.start, changed || wasFull ? null : view?.end, bounds, minSpan);
      if (changed) { selected = null; pinned = false; }
    }
    function navigate(next) {
      if (!next || !view || (Math.abs(next.start - view.start) < .01 && Math.abs(next.end - view.end) < .01)) return;
      view = next; redraw();
    }
    function zoom(factor, anchor = .5) { if (hasData()) navigate(navigation.zoomWindow(view, factor, anchor, bounds, minSpan)); }
    function pan(amount) { if (hasData() && view) navigate(navigation.panWindow(view, (view.end - view.start) * amount, bounds, minSpan)); }
    function reset() { cancelGesture(); pinned = false; if (bounds) { view = { ...bounds }; redraw(); } }
    function pointerInspect(event) {
      if (!visible.length || !view || !hasData()) return;
      const time = view.start + fraction(event.clientX) * (view.end - view.start);
      const position = visible.reduce((best, item, index) => Math.abs(item.t - time) < Math.abs(visible[best].t - time) ? index : best, 0);
      inspect(position);
    }
    function startGesture(moved = false) {
      const contacts = [...pointers.values()].slice(0, 2), rect = plotBounds();
      if (!view || !contacts.length || !rect.width) { gesture = null; return; }
      gesture = { view: { ...view }, x: contacts[0].x, y: contacts[0].y, width: rect.width, moved, axis: null,
        distance: contacts.length > 1 ? Math.hypot(contacts[1].x - contacts[0].x, contacts[1].y - contacts[0].y) : null,
        fraction: fraction(contacts.length > 1 ? (contacts[0].x + contacts[1].x) / 2 : contacts[0].x) };
    }
    function cancelGesture() {
      const contacts = [...pointers.keys()]; pointers.clear(); gesture = null; plot.dataset.dragging = 'false';
      for (const id of contacts) { try { plot.releasePointerCapture(id); } catch { /* Already released by native scrolling. */ } }
    }
    plot.addEventListener('pointerdown', event => {
      if (!hasData() || !view || (event.button !== undefined && event.button !== 0)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try { plot.setPointerCapture(event.pointerId); } catch { /* A cancelled contact cannot be captured. */ }
      if (event.pointerType === 'mouse') plot.focus({ preventScroll: true });
      startGesture(pointers.size > 1);
    });
    plot.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId) || !gesture) {
        if (!pointers.size && event.pointerType === 'mouse') pointerInspect(event);
        return;
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const contacts = [...pointers.values()].slice(0, 2);
      if (contacts.length > 1 && gesture.distance > 0) {
        gesture.moved = true;
        navigate(navigation.pinchWindow(gesture.view, { initialDistance: gesture.distance,
          distance: Math.hypot(contacts[1].x - contacts[0].x, contacts[1].y - contacts[0].y),
          initialMidpointFraction: gesture.fraction, midpointFraction: fraction((contacts[0].x + contacts[1].x) / 2) }, bounds, minSpan));
      } else {
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
        if (!gesture.axis) gesture.axis = event.pointerType === 'touch' && Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
        if (gesture.axis === 'y') return;
        gesture.moved = true;
        navigate(navigation.panWindow(gesture.view, -dx / gesture.width * (gesture.view.end - gesture.view.start), bounds, minSpan));
      }
      plot.dataset.dragging = 'true';
    });
    function finishPointer(event) {
      if (!pointers.has(event.pointerId)) return;
      const moved = gesture?.moved; pointers.delete(event.pointerId);
      try { plot.releasePointerCapture(event.pointerId); } catch { /* Native scrolling may already have released it. */ }
      if (pointers.size) { startGesture(true); return; }
      gesture = null; plot.dataset.dragging = 'false';
      if (!moved && event.type === 'pointerup') pointerInspect(event);
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) plot.addEventListener(type, finishPointer);
    for (const type of ['touchstart', 'touchmove']) plot.addEventListener(type, event => {
      if (hasData() && event.touches?.length > 1 && event.cancelable !== false) event.preventDefault();
    }, { passive: false });
    plot.addEventListener('wheel', event => {
      if (!hasData() || !view || pointers.size || !event.deltaY) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 190 : 1);
      zoom(Math.exp(clamp(delta * .004, -.7, .7)), fraction(event.clientX));
    }, { passive: false });
    plot.addEventListener('keydown', event => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === '0') { event.preventDefault(); reset(); return; }
      if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoom(event.key === '-' ? 2 : .5); return; }
      if (event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); pan(event.key === 'ArrowLeft' ? -.5 : .5); return; }
      if (!visible.length || !hasData() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const position = Math.max(0, visible.findIndex(item => item.t === selected));
      inspect(event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : position + (event.key === 'ArrowLeft' ? -1 : 1));
    });
    slider.addEventListener('input', () => inspect(Number(slider.value)));
    return { setData, present, reset, get window() { return view; } };
  }
  return { create };
});
