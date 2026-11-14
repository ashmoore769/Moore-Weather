(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SolarChart = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function limits(bounds, minSpan) {
    if (!Number.isFinite(bounds?.start) || !Number.isFinite(bounds?.end)) return null;
    const span = bounds.end - bounds.start;
    if (!(span > 0) || !Number.isFinite(span)) return null;
    return {
      start: bounds.start, end: bounds.end, span,
      minSpan: Number.isFinite(minSpan) && minSpan > 0 ? Math.min(minSpan, span) : Math.min(1, span),
      epsilon: Number.EPSILON * Math.max(Math.abs(bounds.start), Math.abs(bounds.end), span) * 4
    };
  }

  // Constrain the viewport, never the readings. This same math works for
  // timestamps or daily chart positions and does not resample either series.
  function fit(start, span, bound) {
    span = clamp(span, bound.minSpan, bound.span);
    if (span >= bound.span - bound.epsilon) return { start: bound.start, end: bound.end };
    const latestStart = bound.end - span;
    start = clamp(start, bound.start, latestStart);
    if (start - bound.start < bound.epsilon) start = bound.start;
    else if (latestStart - start < bound.epsilon) start = latestStart;
    return { start, end: Math.min(bound.end, start + span) };
  }

  // Invalid bounds cannot produce a viewport. A missing, reversed or empty
  // window resets to the complete domain; an undersized one expands centrally.
  // A missing minimum permits one domain unit (or the full smaller domain).
  function navigationWindow(start, end, bounds, minSpan) {
    const bound = limits(bounds, minSpan);
    if (!bound) return null;
    const span = end - start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(span > 0) || !Number.isFinite(span)) {
      return { start: bound.start, end: bound.end };
    }
    const size = clamp(span, bound.minSpan, bound.span);
    return fit(start + (span - size) / 2, size, bound);
  }

  function zoomWindow(window, factor, anchorFraction, bounds, minSpan) {
    const current = navigationWindow(window?.start, window?.end, bounds, minSpan);
    if (!current || !Number.isFinite(factor) || factor <= 0) return current;
    const bound = limits(bounds, minSpan);
    const fraction = Number.isFinite(anchorFraction) ? clamp(anchorFraction, 0, 1) : .5;
    const previousSpan = current.end - current.start;
    const span = clamp(previousSpan * factor, bound.minSpan, bound.span);
    const anchor = current.start + previousSpan * fraction;
    return fit(anchor - span * fraction, span, bound);
  }

  function panWindow(window, delta, bounds, minSpan) {
    const current = navigationWindow(window?.start, window?.end, bounds, minSpan);
    if (!current || !Number.isFinite(delta)) return current;
    const bound = limits(bounds, minSpan);
    // Limit the offset before adding it, so a huge gesture cannot overflow.
    const offset = clamp(delta, bound.start - current.start, bound.end - current.end);
    return fit(current.start + offset, current.end - current.start, bound);
  }

  function pinchWindow(window, gesture, bounds, minSpan) {
    const current = navigationWindow(window?.start, window?.end, bounds, minSpan);
    if (!current || !Number.isFinite(gesture?.initialDistance) || gesture.initialDistance <= 0 ||
        !Number.isFinite(gesture?.distance) || gesture.distance <= 0 ||
        !Number.isFinite(gesture?.initialMidpointFraction) || !Number.isFinite(gesture?.midpointFraction)) return current;
    const bound = limits(bounds, minSpan);
    const initialFraction = clamp(gesture.initialMidpointFraction, 0, 1);
    const fraction = clamp(gesture.midpointFraction, 0, 1);
    const previousSpan = current.end - current.start;
    const span = clamp(previousSpan * (gesture.initialDistance / gesture.distance), bound.minSpan, bound.span);
    const anchor = current.start + previousSpan * initialFraction;
    // Use the gesture's original viewport on every move. This preserves the
    // point between the fingers during simultaneous zoom and translation.
    return fit(anchor - span * fraction, span, bound);
  }

  return { navigationWindow, zoomWindow, panWindow, pinchWindow };
});
