'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const solar = require('../public/solar');
const yard = require('../public/yard-power');

test('both power feeds show readable observation ages through a long outage', () => {
  const cases = [
    [0, 'just now'], [59000, 'just now'], [60000, '1 min ago'],
    [59 * 60000, '59 min ago'], [3600000, '1 hr ago'],
    [23 * 3600000, '23 hr ago'], [86400000, '1 d ago'],
    [38 * 3600000, '1 d ago'], [72 * 3600000, '3 d ago'],
    [-120000, 'check clock'], [NaN, 'age unavailable']
  ];
  for (const [elapsed, expected] of cases) {
    assert.equal(solar.ageText(elapsed), expected, 'Solar age ' + elapsed);
    assert.equal(yard.ageText(elapsed), expected, 'Yard age ' + elapsed);
  }
});

test('measured idle solar and zero charging stay neutral without hiding the actual load', () => {
  const sample = { batteryVoltageV:12.9, pvPowerW:0, chargeCurrentA:0,
    controllerLoadCurrentA:0.4, controllerLoadPowerW:5.16 };
  const idle = yard.readingPresentation(sample);
  assert.equal(idle.yardBatteryV.color, 'var(--battery-good)');
  assert.equal(idle.yardChargeA.color, '');
  assert.equal(idle.yardChargeA.text, '0.00');
  assert.equal(idle.yardLoadPower.text, '5.16');
  assert.match(idle.yardChargeA.title, /both zero/);
  assert.equal(yard.readingPresentation({ ...sample, pvPowerW:5 }).yardChargeA.color,
    'var(--battery-bad)', 'a positive solar measurement retains the established amp comparison');
  assert.equal(yard.readingPresentation({ ...sample, pvPowerW:null }).yardChargeA.color,
    'var(--battery-bad)', 'missing solar must not be treated as a measured idle zero');
  assert.equal(yard.readingPresentation({ ...sample, chargeCurrentA:0.5 }).yardChargeA.color,
    'var(--battery-good)', 'positive charging still compares amperes with the controller load');
  assert.equal(yard.readingPresentation({ ...sample, batteryVoltageV:12.8 }).yardBatteryV.color,
    'var(--amber)', 'neutral charging does not conceal a lower battery voltage');
});
