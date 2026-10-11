'use strict';
const { hash, timestamp } = require('./weather-store');

function midpoint(a, b, circular = false) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Invalid interpolation endpoint');
  if (!circular) return (a + b) / 2;
  const delta = ((b - a + 540) % 360) - 180;
  if (Math.abs(delta) === 180) throw new Error('Opposite wind directions have an ambiguous midpoint');
  const value = (a + delta / 2 + 360) % 360;
  return Math.abs(value - 360) < 1e-9 ? 0 : value;
}

// Only a specifically requested single ten-minute gap can be filled. No automatic
// filling of other historical gaps or extrapolation beyond measured neighbours.
function interpolateTenMinute(store, local, note) {
  const parsed = timestamp(local.slice(0, 10).replaceAll('-', '/'), local.slice(11), 600);
  const at = Date.parse(parsed.utc);
  if (at % 600000 !== 0 || !note) throw new Error('Expected ten-minute boundary and reason');
  const existing = store.db.prepare('SELECT r.id, e.method FROM records r LEFT JOIN record_estimates e ON e.record_id=r.id WHERE r.station_id=? AND r.stream=? AND r.observed_at=?').all(store.layout.station.id, 'mem3', parsed.utc);
  if (existing.length) return { timestamp: local, unchanged: true, existingRecords: existing.length };
  const neighbour = utc => {
    const rows = store.db.prepare(`SELECT r.* FROM records r WHERE r.station_id=? AND r.layout_id=? AND r.stream='mem3'
      AND r.observed_at=? AND NOT EXISTS (SELECT 1 FROM record_estimates e WHERE e.record_id=r.id)`).all(store.layout.station.id, store.layoutId, utc);
    if (rows.length !== 1) throw new Error('Missing or ambiguous measured neighbour');
    const readings = store.db.prepare('SELECT field_id,value FROM weather_readings WHERE record_id=?').all(rows[0].id);
    const values = new Map(readings.map(r => [r.field_id, r.value]));
    if (values.size !== store.fields.mem3.length) throw new Error('Neighbour contains excluded or missing measurements');
    return { record: rows[0], values };
  };
  const previous = neighbour(new Date(at - 600000).toISOString());
  const next = neighbour(new Date(at + 600000).toISOString());
  const values = store.fields.mem3.map(f => String(Number(midpoint(previous.values.get(f.id), next.values.get(f.id),
    f.unit === 'Degs' && ['AVGDIR', 'VWDIR', 'CURRENT'].includes(f.aggregation)).toFixed(6))));
  const id = hash(JSON.stringify(['estimated-midpoint-v1', store.layout.station.id, store.layoutId, parsed.utc, previous.record.id, next.record.id, values]));
  const created = new Date().toISOString();
  const line = [local.slice(0, 10).replaceAll('-', '/'), local.slice(11), ...values].join(',');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, store.layout.station.id, 'mem3', store.layoutId, parsed.utc, local,
      new Date(at - 600000).toISOString(), null, line, null, created);
    store.db.prepare('INSERT INTO record_estimates VALUES(?,?,?,?,?,?)').run(id, previous.record.id, next.record.id,
      'linear-midpoint; compass-shortest-arc', note, created);
    const insert = store.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?)');
    values.forEach((value, i) => insert.run(id, store.fields.mem3[i].id, Number(value), value, 'valid'));
    store.db.exec('COMMIT');
    return { timestamp: local, recordId: id, previousRecordId: previous.record.id, nextRecordId: next.record.id, values };
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

module.exports = { midpoint, interpolateTenMinute };
