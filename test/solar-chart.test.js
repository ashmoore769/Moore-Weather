'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { navigationWindow, zoomWindow, panWindow, pinchWindow } = require('../public/solar-chart.js');

const bounds = { start: 0, end: 100 };
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

test('solar navigation keeps the domain exact and expands small windows around their centre', () => {
  assert.deepEqual(navigationWindow(0, 100, bounds, 10), bounds);
  assert.deepEqual(navigationWindow(-100, 200, bounds, 10), bounds);
  assert.deepEqual(navigationWindow(49, 51, bounds, 10), { start: 45, end: 55 });
  assert.deepEqual(navigationWindow(-20, 20, bounds, 10), { start: 0, end: 40 });
  assert.deepEqual(navigationWindow(80, 120, bounds, 10), { start: 60, end: 100 });
  assert.deepEqual(navigationWindow(10, 20, bounds, 200), bounds);
});

test('solar navigation rejects unusable domains without inventing positions', () => {
  for (const invalid of [null, {}, { start: 0, end: 0 }, { start: 10, end: 0 }, { start: 0, end: Infinity }, { start: -1e308, end: 1e308 }, { start: '0', end: 100 }]) {
    assert.equal(navigationWindow(10, 20, invalid, 10), null);
    assert.equal(zoomWindow({ start: 10, end: 20 }, .5, .5, invalid, 10), null);
    assert.equal(panWindow({ start: 10, end: 20 }, 5, invalid, 10), null);
    assert.equal(pinchWindow({ start: 10, end: 20 }, {}, invalid, 10), null);
  }
  for (const [start, end] of [[null, 20], [undefined, undefined], [30, 20], [20, 20], [NaN, 50], [-1e308, 1e308]]) {
    assert.deepEqual(navigationWindow(start, end, bounds, 10), bounds);
  }
});

test('solar zoom anchors the touched point and stops at minimum or full width', () => {
  const initial = { start: 20, end: 80 };
  assert.deepEqual(zoomWindow(initial, .5, .25, bounds, 10), { start: 27.5, end: 57.5 });
  assert.deepEqual(zoomWindow(initial, .00001, .25, bounds, 10), { start: 32.5, end: 42.5 });
  assert.deepEqual(zoomWindow(initial, 10, .25, bounds, 10), bounds);
  assert.deepEqual(zoomWindow(initial, .5, 0, bounds, 10), { start: 20, end: 50 });
  assert.deepEqual(zoomWindow(initial, .5, 1, bounds, 10), { start: 50, end: 80 });
  assert.deepEqual(zoomWindow(initial, .5, NaN, bounds, 10), { start: 35, end: 65 });
  assert.deepEqual(initial, { start: 20, end: 80 });
});

test('solar zoom clamps at the archive edge without shortening the viewport', () => {
  assert.deepEqual(zoomWindow({ start: 10, end: 30 }, 3, 1, bounds, 10), { start: 0, end: 60 });
  assert.deepEqual(zoomWindow({ start: 70, end: 90 }, 3, 0, bounds, 10), { start: 40, end: 100 });
  assert.deepEqual(zoomWindow({ start: 20, end: 80 }, .5, -5, bounds, 10), { start: 20, end: 50 });
  assert.deepEqual(zoomWindow({ start: 20, end: 80 }, .5, 5, bounds, 10), { start: 50, end: 80 });
});

test('solar pan preserves width at either boundary, including very large drags', () => {
  const initial = { start: 30, end: 60 };
  assert.deepEqual(panWindow(initial, 7, bounds, 10), { start: 37, end: 67 });
  assert.deepEqual(panWindow(initial, -50, bounds, 10), { start: 0, end: 30 });
  assert.deepEqual(panWindow(initial, 1e308, bounds, 10), { start: 70, end: 100 });
  assert.deepEqual(panWindow(initial, -1e308, bounds, 10), { start: 0, end: 30 });
  assert.deepEqual(panWindow(bounds, 80, bounds, 10), bounds);
});

test('solar pinch scales and translates around the original two-finger midpoint', () => {
  const initial = { start: 20, end: 80 };
  const gesture = { initialDistance: 100, distance: 200, initialMidpointFraction: .5, midpointFraction: .75 };
  const result = pinchWindow(initial, gesture, bounds, 10);
  assert.deepEqual(result, { start: 27.5, end: 57.5 });
  near(initial.start + (initial.end - initial.start) * gesture.initialMidpointFraction,
    result.start + (result.end - result.start) * gesture.midpointFraction);
  assert.deepEqual(pinchWindow(initial, { ...gesture, distance: 100 }, bounds, 10), { start: 5, end: 65 });
  assert.deepEqual(pinchWindow(initial, { ...gesture, distance: 10000 }, bounds, 10), { start: 42.5, end: 52.5 });
  assert.deepEqual(pinchWindow(initial, { ...gesture, distance: .0001 }, bounds, 10), bounds);
});

test('solar gestures leave the normalized view unchanged for invalid input', () => {
  const initial = { start: 20, end: 80 };
  for (const factor of [0, -1, NaN, Infinity, '2', null]) {
    assert.deepEqual(zoomWindow(initial, factor, .5, bounds, 10), initial);
  }
  for (const delta of [NaN, Infinity, '2', null]) assert.deepEqual(panWindow(initial, delta, bounds, 10), initial);
  const valid = { initialDistance: 100, distance: 200, initialMidpointFraction: .5, midpointFraction: .5 };
  for (const gesture of [null, {}, ...['initialDistance', 'distance'].flatMap(key => [0, -1, NaN, Infinity].map(value => ({ ...valid, [key]: value }))),
    { ...valid, initialMidpointFraction: NaN }, { ...valid, midpointFraction: undefined }]) {
    assert.deepEqual(pinchWindow(initial, gesture, bounds, 10), initial);
  }
});

test('solar viewport remains bounded for epoch timestamps and repeated fractional gestures', () => {
  const start = Date.parse('2026-11-14T00:00:00+10:00');
  const end = start + 86400000, domain = { start, end }, minimum = 3600000;
  let window = domain;
  for (let i = 0; i < 500; i++) {
    window = zoomWindow(window, i % 5 ? .93 : 1.8, (i % 9) / 8, domain, minimum);
    window = panWindow(window, (i % 3 - 1) * 123456.789, domain, minimum);
    assert.ok(window.start >= start && window.end <= end);
    assert.ok(window.end - window.start >= minimum - .001);
  }
  assert.deepEqual(zoomWindow(window, 1e308, .1, domain, minimum), domain);
  const edge = navigationWindow(start + .0001, start + minimum + .0001, domain, minimum);
  assert.equal(edge.start, start);
  near(edge.end - edge.start, minimum, .001);
});

test('solar minimum and fractional day domains have defined defaults', () => {
  assert.deepEqual(navigationWindow(.2, .3, { start: 0, end: .5 }), { start: 0, end: .5 });
  assert.deepEqual(zoomWindow(bounds, Number.MIN_VALUE, .5, bounds), { start: 49.5, end: 50.5 });
  assert.deepEqual(navigationWindow(49.9, 50.1, bounds, -1), { start: 49.5, end: 50.5 });
  assert.deepEqual(zoomWindow({ start: 20, end: 80 }, Number.MAX_VALUE, .5, bounds, 10), bounds);
});
