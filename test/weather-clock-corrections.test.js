'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPersistence } = require('../lib/weather-persistence');
const { recordClockCorrection, verifyClockCorrection, orderVerifiedHistory, PENDING_LIMIT } = require('../lib/weather-clock-corrections');
const layout = require('../config/station-layout.json');
const stationId = layout.station.id;
const base = Date.parse('2026-11-05T02:00:00.000Z');
const at = milliseconds => new Date(milliseconds).toISOString();
const quiet = { error() {}, info() {} };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-clock-journal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = base;
  const filename = path.join(directory, 'weather.sqlite');
  let persistence = createPersistence({ WEATHER_DB_PATH: filename }, quiet, { now: () => clock });
  t.after(() => persistence.close());
  return { filename, get p() { return persistence; }, setNow(value) { clock = value; },
    restart() { persistence.close(); persistence = createPersistence({ WEATHER_DB_PATH: filename }, quiet, { now: () => clock }); },
    inspect(callback) { const db = new DatabaseSync(filename); try { return callback(db); } finally { db.close(); } } };
}
function correction(server = base, adjustmentMs = -150000) {
  return { at: at(server), serverAt: at(server), stationAt: at(server - adjustmentMs), adjustmentMs };
}
function row(stream, time, value = '1') {
  const local = at(time + 600 * 60000);
  return [local.slice(0, 10).replaceAll('-', '/'), local.slice(11, 19),
    ...layout.streams[stream].fields.map(field => field.sensorKey === '7' ? '1018.2' : value)].join(',');
}
function reply(stream, times) {
  return `MEM ${stream.slice(3)} LAST 8\r\n${times.map((time, index) => row(stream, time, String(index + 1))).join('\r\n')}\r\n\\END OF DATA\r\n> `;
}
function verified(f, intent = correction()) {
  const id = f.p.recordClockCorrection(intent);
  f.p.verifyClockCorrection(id, at(Date.parse(intent.at) + 2000));
  return id;
}

test('clock intent commits before hardware work and survives restart with a stable identity', t => {
  const f = fixture(t), intent = correction();
  const id = f.p.recordClockCorrection(intent);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(f.p.recordClockCorrection(intent), id);
  assert.equal(f.inspect(db => db.prepare('SELECT verified_at FROM weather_clock_corrections WHERE id=?').get(id).verified_at), null);
  f.setNow(base + 2000); f.restart();
  assert.equal(f.p.pendingClockCorrections()[0].id, id);
  assert.equal(f.p.verifyClockCorrection(id, at(base + 2000)), id);
  assert.deepEqual(f.p.pendingClockCorrections(), []);
  assert.equal(f.p.recordClockCorrection(intent), id, 're-recording must not reset verification');
  assert.deepEqual(f.p.pendingClockCorrections(), []);
  f.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});

test('disabled recording is a no-op but enabled unavailable storage blocks a clock write', t => {
  const disabled = createPersistence({}, quiet);
  assert.equal(disabled.recordClockCorrection(correction()), null);
  assert.equal(disabled.verifyClockCorrection(null, at(base)), null);
  assert.deepEqual(disabled.pendingClockCorrections(), []);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-db-failed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unavailable = createPersistence({ WEATHER_DB_PATH: directory }, quiet);
  t.after(() => unavailable.close());
  assert.equal(unavailable.status().ready, false);
  assert.throws(() => unavailable.recordClockCorrection(correction()), /database unavailable/);
  assert.throws(() => unavailable.pendingClockCorrections(), /database unavailable/);
});

test('closed persistence and a failed SQLite journal statement also block hardware writes', t => {
  const f = fixture(t);
  f.inspect(db => db.exec(`CREATE TRIGGER reject_clock_intent BEFORE INSERT ON weather_clock_corrections
    BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END;`));
  assert.throws(() => f.p.recordClockCorrection(correction()), /fixture journal failure/);
  assert.match(f.p.status().error, /fixture journal failure/);
  f.p.close();
  assert.throws(() => f.p.recordClockCorrection(correction()), /database unavailable/);
});

test('pending recovery queries return only the bounded recent unverified station intents', t => {
  const f = fixture(t), ids = [];
  f.p.recordClockCorrection(correction(base - 16 * 60000));
  for (let index = 0; index < 20; index++) ids.push(f.p.recordClockCorrection(correction(base + index * 1000)));
  f.p.recordClockCorrection(correction(base + 60000));
  f.p.verifyClockCorrection(ids[18], at(base + 20000));
  f.setNow(base + 20000);
  const pending = f.p.pendingClockCorrections();
  assert.equal(pending.length, PENDING_LIMIT);
  assert.deepEqual(pending.map(item => item.id), [ids[19], ...ids.slice(11, 18).reverse()]);
  assert.ok(pending.every(item => Date.parse(item.at) <= base + 20000));
});

test('pending recovery has an exact fifteen-minute limit and cannot verify unknown or stale intents', t => {
  const f = fixture(t), id = f.p.recordClockCorrection(correction());
  f.setNow(base + 15 * 60000);
  assert.equal(f.p.pendingClockCorrections().length, 1);
  f.setNow(base + 15 * 60000 + 1);
  assert.equal(f.p.pendingClockCorrections().length, 0);
  assert.throws(() => f.p.verifyClockCorrection(id, at(base + 15 * 60000 + 1)), /recovery window/);
  assert.throws(() => f.p.verifyClockCorrection(id, at(base - 1)), /recovery window/);
  assert.throws(() => f.p.verifyClockCorrection('f'.repeat(64), at(base)), /not recorded/);
});

test('invalid timestamps, signs, magnitudes and inconsistent clock intents are rejected', t => {
  const f = fixture(t);
  for (const extra of [{ at: '2026-02-30T02:00:00.000Z' }, { serverAt: '2026-11-05T12:00:00+10:00' },
    { adjustmentMs: -300001 }, { adjustmentMs: NaN }, { adjustmentMs: '-150000' }, { adjustmentMs: 0 },
    { adjustmentMs: 150000 }, { serverAt: at(base - 4000) }, { stationAt: at(base + 180000) }]) {
    assert.throws(() => f.p.recordClockCorrection({ ...correction(), ...extra }));
  }
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM weather_clock_corrections').get().n), 0);
});

test('unexplained and pending backward rain tails remain rejected until fresh verification', t => {
  const f = fixture(t), capture = reply('mem4', [base + 120000, base + 60000]);
  f.setNow(base + 600000);
  assert.throws(() => f.p.recordHistory('mem4', capture), /not chronological/);
  const id = f.p.recordClockCorrection(correction());
  assert.throws(() => f.p.recordHistory('mem4', capture), /not chronological/);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM sources').get().n), 0);
  f.p.verifyClockCorrection(id, at(base + 2000));
  const result = f.p.recordHistory('mem4', capture);
  assert.equal(result.inserted, 2); assert.deepEqual(result.clockCorrectionIds, [id]);
});

test('verified rain reversal preserves original bytes, line links and values while metadata uses date order', t => {
  const f = fixture(t), id = verified(f);
  f.setNow(base + 600000);
  const times = [base - 60000, base + 120000, base + 60000], capture = reply('mem4', times);
  const result = f.p.recordHistory('mem4', capture);
  assert.equal(result.inserted, 3); assert.equal(result.firstObservedAt, at(base - 60000));
  assert.equal(result.lastObservedAt, at(base + 120000)); assert.equal(result.storedThrough, at(base + 120000));
  assert.deepEqual(result.clockCorrectionIds, [id]); assert.match(result.warning, /verified clock correction/);
  f.inspect(db => {
    assert.deepEqual(Buffer.from(db.prepare('SELECT original_bytes FROM sources').get().original_bytes), Buffer.from(capture));
    const links = db.prepare(`SELECT s.line_number,r.observed_at,r.raw_line FROM source_records s JOIN records r ON r.id=s.record_id ORDER BY s.line_number`).all();
    assert.deepEqual(links.map(item => item.line_number), [2, 3, 4]);
    assert.deepEqual(links.map(item => item.observed_at), times.map(at));
    assert.deepEqual(links.map(item => item.raw_line), times.map((time, index) => row('mem4', time, String(index + 1))));
  });
});

test('a sparse rain tail can retain a verified correction for weeks and across restart', t => {
  const f = fixture(t), id = verified(f), capture = reply('mem4', [base + 120000, base + 60000]);
  f.setNow(base + 600000); f.p.recordHistory('mem4', capture);
  f.setNow(base + 60 * 86400000); f.restart();
  const repeated = f.p.recordHistory('mem4', capture);
  assert.equal(repeated.unchanged, true); assert.deepEqual(repeated.clockCorrectionIds, [id]);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM records').get().n), 2);
  assert.deepEqual(f.p.pendingClockCorrections(), []);
});

test('forward corrections and another station cannot authorize a backward edge', t => {
  const f = fixture(t); verified(f, correction(base, 150000)); f.setNow(base + 600000);
  f.inspect(db => {
    db.prepare('INSERT INTO stations VALUES(?,?,?,?,?)').run('other', 'Other', 'OTHER', 'Australia/Brisbane', 600);
    const id = recordClockCorrection(db, 'other', correction());
    verifyClockCorrection(db, 'other', id, at(base + 2000));
  });
  assert.throws(() => f.p.recordHistory('mem4', reply('mem4', [base + 120000, base + 60000])), /not chronological/);
});

test('both reversal endpoints must fit the recorded window and its exact three-second tolerance', t => {
  const f = fixture(t); verified(f); f.setNow(base + 600000);
  const ordered = times => f.inspect(db => orderVerifiedHistory(db, stationId, times.map(time => ({ utc: at(time) })), at(base + 600000)));
  assert.equal(ordered([base + 153000, base - 3000]).correctionIds.length, 1);
  for (const times of [[base + 153001, base], [base + 120000, base - 3001],
    [base + 300000, base + 200000], [base + 600000, base + 60000]]) assert.throws(() => ordered(times), /not chronological/);
});

test('one verified hardware correction cannot explain multiple downward edges in one capture', t => {
  const f = fixture(t); verified(f); f.setNow(base + 600000);
  assert.throws(() => f.p.recordHistory('mem4', reply('mem4', [base + 120000, base + 60000, base + 130000, base + 70000])), /not chronological/);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM records').get().n), 0);
});

test('two separately verified corrections can each explain one distinct native tail reversal', t => {
  const f = fixture(t), first = verified(f), second = verified(f, correction(base + 600000));
  f.setNow(base + 1200000);
  const result = f.p.recordHistory('mem4', reply('mem4', [base + 120000, base + 60000, base + 720000, base + 660000]));
  assert.equal(result.inserted, 4); assert.deepEqual(new Set(result.clockCorrectionIds), new Set([first, second]));
});

test('a verification later than capture receipt cannot retroactively authorize that incoming reply', t => {
  const f = fixture(t); verified(f, correction(base, -10000)); f.setNow(base + 1000);
  assert.throws(() => f.p.recordHistory('mem4', reply('mem4', [base + 8000, base + 1000])), /not chronological/);
});

test('known corrections do not weaken future quarantine or nonnumeric reply rejection', t => {
  const f = fixture(t); verified(f, correction(base, -300000)); f.setNow(base + 2000);
  const future = f.p.recordHistory('mem4', reply('mem4', [base + 240000, base + 60000]));
  assert.equal(future.quarantined, 1); assert.equal(future.inserted, 1); assert.deepEqual(future.clockCorrectionIds, []);
  assert.match(future.warning, /future logger/);
  f.setNow(base + 600000);
  const malformed = `MEM 4 LAST 8\r\n${row('mem4', base + 120000, 'not-numeric')}\r\n${row('mem4', base + 60000)}\r\n\\END OF DATA\r\n> `;
  assert.throws(() => f.p.recordHistory('mem4', malformed), /nonnumeric/);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM records').get().n), 1);
});

test('equal native timestamps retain distinct measured variants without requiring or inventing a correction', t => {
  const f = fixture(t); f.setNow(base + 600000);
  const result = f.p.recordHistory('mem3', reply('mem3', [base, base]));
  assert.equal(result.inserted, 2); assert.deepEqual(result.clockCorrectionIds, []);
  assert.equal(f.inspect(db => db.prepare('SELECT variants FROM conflicting_records').get().variants), 2);
});
