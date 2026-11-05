'use strict';

const crypto = require('node:crypto');
const baseline = require('../config/station-layout.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const baselineId = hash(JSON.stringify(baseline));
const MAX_REPAIR_RECORDS = 1000, MAX_SOURCE_LINKS = 256;
const PARTIAL_REASON = 'layout-transition-partial-interval';
const PRECHANGE_REASON = 'layout-transition-prechange-evidence';
const UNVERIFIED_REASON = 'layout-transition-unverified-provenance';

function fail(message) { throw new Error('Weather layout cutover: ' + message); }
function epoch(value) { return typeof value === 'string' ? Date.parse(value) : NaN; }
function stamp() { return new Date().toISOString(); }

function validateConfiguration(value) {
  let serialized, cutover;
  try { serialized = JSON.stringify(value); }
  catch { fail('configuration must be a JSON object'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 16384) fail('configuration is missing or exceeds the bounded size');
  try { cutover = JSON.parse(serialized); }
  catch { fail('configuration must be a JSON object'); }
  if (!cutover || typeof cutover !== 'object' || Array.isArray(cutover) ||
      typeof cutover.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(cutover.id) || cutover.stream !== 'mem3' ||
      cutover.stationId !== baseline.station.id || cutover.stationSerial !== baseline.station.serial ||
      cutover.baselineLayoutSha256 !== baselineId || !Number.isInteger(cutover.position) ||
      cutover.position < 0 || cutover.position >= baseline.streams.mem3.fields.length || !Number.isInteger(cutover.storageId)) {
    fail('configuration does not identify a supported immutable source layout');
  }
  const keys = ['aggregation', 'name', 'sensorKey', 'unit'];
  for (const mapping of [cutover.before, cutover.after]) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
        JSON.stringify(Object.keys(mapping).sort()) !== JSON.stringify(keys) ||
        Object.values(mapping).some(item => typeof item !== 'string' || !item.length || item.length > 128)) {
      fail('configuration field mapping is invalid');
    }
  }
  const times = ['scheduleChangedAt', 'confirmedStationAt', 'firstNewObservedAt', 'firstCompleteObservedAt'].map(key => {
    const time = epoch(cutover[key]);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== cutover[key]) fail('configuration timestamps must be canonical UTC');
    return time;
  });
  const [changed, confirmed, first, complete] = times, interval = baseline.streams.mem3.intervalSeconds * 1000;
  if (changed >= confirmed || confirmed >= first || first % interval !== 0 || first - changed >= interval || complete !== first + interval) {
    fail('configuration does not describe one partial interval followed by a complete interval');
  }
  const evidence = cutover.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.savedByOwner !== true ||
      typeof evidence.captureSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.captureSha256) ||
      typeof evidence.captureName !== 'string' || !evidence.captureName.length || evidence.captureName.length > 255 ||
      typeof evidence.note !== 'string' || !evidence.note.length || evidence.note.length > 4096) fail('configuration evidence is incomplete');
  return cutover;
}

function newLayout(cutover) {
  if (baselineId !== cutover.baselineLayoutSha256) fail('immutable baseline fingerprint does not match the verified cutover');
  const layout = structuredClone(baseline), field = layout.streams.mem3.fields[cutover.position];
  if (layout.station.id !== cutover.stationId || layout.station.serial !== cutover.stationSerial ||
      field.storageId !== cutover.storageId || Object.entries(cutover.before).some(([key, value]) => field[key] !== value)) {
    fail('the verified source field is not present in the baseline');
  }
  Object.assign(field, cutover.after);
  layout.evidence = { scheduleSha256: cutover.evidence.captureSha256,
    note: cutover.evidence.note, cutoverId: cutover.id, baselineLayoutSha256: baselineId,
    firstNewObservedAt: cutover.firstNewObservedAt, firstCompleteObservedAt: cutover.firstCompleteObservedAt };
  return layout;
}

function assertFields(db, layout, layoutId, fields) {
  const definition = db.prepare('SELECT definition_json FROM layouts WHERE id=?').get(layoutId);
  if (!definition || definition.definition_json !== JSON.stringify(layout)) fail('registered layout definition is inconsistent');
  const expected = layout.streams.mem3.fields;
  if (fields.length !== expected.length || fields.some((field, index) => {
    const want = expected[index];
    return field.layout_id !== layoutId || field.stream !== 'mem3' || field.position !== index ||
      field.sensor_key !== want.sensorKey || field.name !== want.name || field.unit !== want.unit ||
      field.aggregation !== want.aggregation || field.metadata_json !== JSON.stringify(want);
  })) fail('registered MEM3 fields differ from the verified layout');
}

function initializeLayoutCutover(store, suppliedConfiguration) {
  // Runtime configuration is private operational evidence. Once accepted, the
  // database retains the exact immutable configuration for later restarts.
  // Never infer a transition merely from a matching station or column count.
  const existing = store.db.prepare(`SELECT * FROM weather_layout_cutovers
    WHERE station_id=? AND stream='mem3' AND old_layout_id=? LIMIT 2`).all(store.layout.station.id, store.layoutId);
  if (existing.length > 1) fail('multiple saved cutovers require an explicit reviewed migration');
  let configuration = suppliedConfiguration;
  if (configuration === undefined) {
    if (!existing.length) return null;
    try { configuration = JSON.parse(existing[0].evidence_json); }
    catch { fail('saved configuration is not valid JSON'); }
  }
  if (store.layoutId !== baselineId) fail('configured cutover does not apply to the selected custom layout');
  const cutover = validateConfiguration(configuration);
  if (existing.length && existing[0].evidence_json !== JSON.stringify(cutover)) {
    fail('existing cutover metadata differs from the supplied configuration');
  }
  const layout = newLayout(cutover), layoutId = hash(JSON.stringify(layout));
  store.validateLayout(layout);
  const fields = store.registerLayout(layout, layoutId).mem3;
  assertFields(store.db, baseline, baselineId, store.fields.mem3);
  assertFields(store.db, layout, layoutId, fields);
  const row = { id: cutover.id, station_id: cutover.stationId, stream: 'mem3', old_layout_id: baselineId,
    new_layout_id: layoutId, schedule_changed_at: cutover.scheduleChangedAt,
    first_new_at: cutover.firstNewObservedAt, first_complete_at: cutover.firstCompleteObservedAt,
    evidence_json: JSON.stringify(cutover) };
  store.db.prepare(`INSERT OR IGNORE INTO weather_layout_cutovers
    (id,station_id,stream,old_layout_id,new_layout_id,schedule_changed_at,first_new_at,first_complete_at,evidence_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(row), stamp());
  const saved = store.db.prepare('SELECT * FROM weather_layout_cutovers WHERE id=?').get(cutover.id);
  if (Object.entries(row).some(([key, value]) => saved[key] !== value)) fail('existing cutover metadata differs from the verified change');
  return { cutover, layout, layoutId, fields, oldFields: store.fields.mem3 };
}

function identity(store, layoutId, utc, values) {
  return hash(JSON.stringify([store.layout.station.id, layoutId, 'mem3', utc, values]));
}

function validateRecord(store, record, fields, layoutId) {
  const cutover = store.layoutCutover.cutover;
  if (!record || record.station_id !== cutover.stationId || record.stream !== 'mem3' || record.layout_id !== layoutId) {
    fail('record identity or layout is inconsistent');
  }
  let parsed;
  try { parsed = store.parseRow(record.raw_line.replace(/^>\s*/, '').trim(), 'mem3'); }
  catch { fail('an existing MEM3 raw row cannot be verified'); }
  if (parsed.utc !== record.observed_at || parsed.local !== record.local_timestamp) fail('raw row timestamp differs from stored metadata');
  const observations = store.db.prepare(`SELECT o.*,f.position FROM observations o JOIN fields f ON f.id=o.field_id
    WHERE o.record_id=? ORDER BY f.position`).all(record.id);
  if (observations.length !== fields.length || observations.some((value, index) =>
    value.field_id !== fields[index].id || value.position !== index || value.raw_value !== parsed.values[index])) {
    fail('existing observations do not match the verified field definitions and raw row');
  }
  return parsed;
}

function excludeField(store, recordId, fieldId, reason, evidence) {
  const cutover = store.layoutCutover.cutover;
  store.db.prepare(`INSERT OR IGNORE INTO weather_layout_field_exclusions
    (record_id,field_id,cutover_id,reason,evidence_json,created_at) VALUES(?,?,?,?,?,?)`)
    .run(recordId, fieldId, cutover.id, reason, JSON.stringify(evidence), stamp());
}

function oldRecordEvidence(store, record) {
  const cutover = store.layoutCutover.cutover;
  const sources = store.db.prepare(`SELECT s.id,s.imported_at,sr.line_number FROM source_records sr
    JOIN sources s ON s.id=sr.source_id WHERE sr.record_id=? ORDER BY s.id LIMIT ?`)
    .all(record.id, MAX_SOURCE_LINKS + 1);
  const received = epoch(record.received_at), change = epoch(cutover.scheduleChangedAt);
  const times = [received, ...sources.map(source => epoch(source.imported_at))];
  if (times.some(time => Number.isFinite(time) && time < change)) return { reason: PRECHANGE_REASON, receivedAt: record.received_at };
  if (!sources.length || sources.length > MAX_SOURCE_LINKS || times.some(time => !Number.isFinite(time))) {
    return { reason: UNVERIFIED_REASON, receivedAt: record.received_at };
  }
  return { receivedAt: record.received_at, sourceCount: sources.length };
}

function validateAlias(store, alias, expectedId, expectedValues) {
  const context = store.layoutCutover, cutover = context.cutover;
  if (alias.cutover_id !== cutover.id || alias.old_layout_id !== baselineId || alias.new_layout_id !== context.layoutId ||
      alias.canonical_id !== expectedId || alias.original_field_ids_json !== JSON.stringify(context.oldFields.map(field => field.id))) {
    fail('repair identity alias metadata is inconsistent');
  }
  const record = store.db.prepare('SELECT * FROM records WHERE id=?').get(alias.record_id);
  const parsed = validateRecord(store, record, context.fields, context.layoutId);
  if (identity(store, context.layoutId, parsed.utc, parsed.values) !== expectedId ||
      identity(store, baselineId, parsed.utc, parsed.values) !== record.id ||
      (expectedValues && JSON.stringify(parsed.values) !== JSON.stringify(expectedValues))) fail('repair identity alias does not match its preserved record');
  const collision = store.db.prepare('SELECT id FROM records WHERE id=? AND id!=?').get(expectedId, record.id);
  if (collision) fail('canonical identity collides with another existing record');
  return record;
}

function repairRecord(store, record) {
  const context = store.layoutCutover, cutover = context.cutover;
  const parsed = validateRecord(store, record, context.oldFields, baselineId);
  const estimated = store.db.prepare('SELECT 1 FROM record_estimates WHERE record_id=?').get(record.id);
  // An interpolation has a different identity and references its measured
  // endpoints. Retain that lineage and original interpretation; its creation
  // timestamp cannot establish which physical schedule produced a measurement.
  if (!estimated && identity(store, baselineId, parsed.utc, parsed.values) !== record.id) {
    fail('existing record does not have its verified original identity');
  }
  const previousExclusions = store.db.prepare(`SELECT field_id,reason FROM weather_layout_field_exclusions
    WHERE record_id=? AND cutover_id=?`).all(record.id, cutover.id);
  if (previousExclusions.length) {
    if (previousExclusions.length !== 1 || previousExclusions[0].field_id !== context.oldFields[cutover.position].id ||
        ![PRECHANGE_REASON, UNVERIFIED_REASON].includes(previousExclusions[0].reason)) {
      fail('existing original-layout exclusion does not match the preserved ambiguous field');
    }
    // New overlapping tails are new receipts of old bytes, not proof of their
    // original meaning. An ambiguity decision remains durable across imports.
    return previousExclusions[0].reason;
  }
  if (estimated) {
    excludeField(store, record.id, context.oldFields[cutover.position].id, UNVERIFIED_REASON,
      { receivedAt: record.received_at, note: 'Preserved pre-existing interpolation and its endpoint lineage.' });
    return UNVERIFIED_REASON;
  }
  const evidence = oldRecordEvidence(store, record);
  if (evidence.reason) {
    excludeField(store, record.id, context.oldFields[cutover.position].id, evidence.reason, evidence);
    return evidence.reason;
  }
  const canonicalId = identity(store, context.layoutId, parsed.utc, parsed.values);
  if (store.db.prepare('SELECT 1 FROM records WHERE id=?').get(canonicalId) ||
      store.db.prepare('SELECT 1 FROM weather_layout_repairs WHERE canonical_id=? OR record_id=?').get(canonicalId, record.id)) {
    fail('canonical identity collides with an existing record or repair alias');
  }
  // Change only interpretation. Record IDs, measured values, raw text, source
  // bytes, source line links and estimate dependencies retain their identities.
  store.db.prepare('UPDATE records SET layout_id=? WHERE id=? AND layout_id=?').run(context.layoutId, record.id, baselineId);
  const update = store.db.prepare('UPDATE observations SET field_id=? WHERE record_id=? AND field_id=?');
  for (let index = 0; index < context.fields.length; index++) {
    if (update.run(context.fields[index].id, record.id, context.oldFields[index].id).changes !== 1) fail('an observation could not be remapped exactly once');
  }
  store.db.prepare(`INSERT INTO weather_layout_repairs
    (record_id,cutover_id,old_layout_id,new_layout_id,canonical_id,original_field_ids_json,evidence_json,repaired_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(record.id, cutover.id, baselineId, context.layoutId, canonicalId,
    JSON.stringify(context.oldFields.map(field => field.id)), JSON.stringify(evidence), stamp());
  markCutoverRecord(store, record.id, 'mem3', parsed, { layoutId: context.layoutId, fields: context.fields });
  return true;
}

function repairLayoutCutover(store) {
  const context = store.layoutCutover;
  if (!context) return;
  const cutover = context.cutover;
  const aliases = store.db.prepare('SELECT * FROM weather_layout_repairs WHERE cutover_id=? LIMIT ?').all(cutover.id, MAX_REPAIR_RECORDS + 1);
  if (aliases.length > MAX_REPAIR_RECORDS) fail('repair audit exceeds the bounded startup limit; review it before continuing');
  for (const alias of aliases) validateAlias(store, alias, alias.canonical_id);
  const records = store.db.prepare(`SELECT r.* FROM records r WHERE r.station_id=? AND r.stream='mem3'
    AND r.layout_id=? AND r.observed_at>=? AND NOT EXISTS (
      SELECT 1 FROM weather_layout_field_exclusions x WHERE x.record_id=r.id AND x.cutover_id=?)
    ORDER BY r.observed_at,r.id LIMIT ?`).all(cutover.stationId, baselineId, cutover.firstNewObservedAt, cutover.id, MAX_REPAIR_RECORDS + 1);
  if (records.length > MAX_REPAIR_RECORDS) fail('more than 1000 original-layout rows need review; refusing an unbounded startup migration');
  for (const record of records) repairRecord(store, record);
}

function routeCutoverRecord(store, stream, parsed, receivedAt) {
  const context = store.layoutCutover;
  const fallback = { layoutId: store.layoutId, fields: store.fields[stream] };
  if (!context || stream !== 'mem3') return fallback;
  const cutover = context.cutover;
  if (parsed.utc < cutover.firstNewObservedAt) return fallback;
  const oldId = identity(store, baselineId, parsed.utc, parsed.values);
  const canonicalId = identity(store, context.layoutId, parsed.utc, parsed.values);
  const original = store.db.prepare('SELECT * FROM records WHERE id=?').get(oldId);
  const receivedBeforeChange = epoch(receivedAt) < epoch(cutover.scheduleChangedAt);
  if (original?.layout_id === baselineId) {
    const repaired = repairRecord(store, original);
    if (repaired !== true) return { ...fallback, id: oldId, exclusionReason: repaired };
  }
  const alias = store.db.prepare('SELECT * FROM weather_layout_repairs WHERE canonical_id=?').get(canonicalId);
  if (alias) {
    const record = validateAlias(store, alias, canonicalId, parsed.values);
    if (receivedBeforeChange) fail('new-layout alias conflicts with newly supplied pre-change source evidence');
    return { layoutId: context.layoutId, fields: context.fields, id: record.id };
  }
  if (original && original.layout_id !== baselineId) fail('preserved original identity has no valid repair alias');
  if (receivedBeforeChange) return { ...fallback, id: oldId, exclusionReason: PRECHANGE_REASON };
  return { layoutId: context.layoutId, fields: context.fields, id: canonicalId };
}

function markCutoverRecord(store, recordId, stream, parsed, route) {
  if (!store.layoutCutover || stream !== 'mem3') return;
  const cutover = store.layoutCutover.cutover;
  if (route.exclusionReason) excludeField(store, recordId, route.fields[cutover.position].id, route.exclusionReason,
    { observedAt: parsed.utc, note: 'Original pre-change or unverifiable provenance remains preserved; the slot is not assumed to be globe.' });
  else if (route.layoutId === store.layoutCutover.layoutId && parsed.utc === cutover.firstNewObservedAt) {
    excludeField(store, recordId, route.fields[cutover.position].id, PARTIAL_REASON,
      { firstCompleteObservedAt: cutover.firstCompleteObservedAt, scheduleChangedAt: cutover.scheduleChangedAt });
  }
}

function layoutTransitionStatus(store, now = Date.now()) {
  const context = store.layoutCutover;
  if (!context) return { enabled: false, reason: 'No verified layout transition is configured for the selected layout.' };
  const cutover = context.cutover;
  if (!Number.isFinite(now)) fail('status time is invalid');
  const upper = new Date(now).toISOString(), fieldId = context.fields[cutover.position].id;
  const edge = direction => {
    const row = store.db.prepare(`SELECT r.id AS recordId,r.observed_at AS observedAt,w.value,w.raw_value AS rawValue
      FROM records r JOIN weather_readings w ON w.record_id=r.id AND w.field_id=?
      WHERE r.station_id=? AND r.stream='mem3' AND r.layout_id=? AND r.observed_at>=? AND r.observed_at<=?
        AND w.quality='valid' AND w.value IS NOT NULL AND NOT EXISTS (SELECT 1 FROM record_estimates e WHERE e.record_id=r.id)
        AND (SELECT COUNT(*) FROM records other WHERE other.station_id=r.station_id AND other.stream=r.stream
          AND other.observed_at=r.observed_at AND NOT EXISTS(SELECT 1 FROM record_estimates e WHERE e.record_id=other.id))=1
      ORDER BY r.observed_at ${direction} LIMIT 1`).get(fieldId, cutover.stationId, context.layoutId, cutover.firstCompleteObservedAt, upper);
    return row ? { ...row } : null;
  };
  const count = store.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE station_id=? AND stream='mem3'
    AND layout_id=? AND observed_at>=? AND observed_at<=?`).get(cutover.stationId, context.layoutId, cutover.firstNewObservedAt, upper).n;
  const transitionRows = store.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE station_id=? AND stream='mem3'
    AND layout_id=? AND observed_at=?`).get(cutover.stationId, context.layoutId, cutover.firstNewObservedAt).n;
  const repaired = store.db.prepare('SELECT COUNT(*) AS n FROM weather_layout_repairs WHERE cutover_id=?').get(cutover.id).n;
  const exclusions = store.db.prepare('SELECT reason,COUNT(*) AS n FROM weather_layout_field_exclusions WHERE cutover_id=? GROUP BY reason').all(cutover.id);
  return { enabled: true, id: cutover.id, oldLayoutId: baselineId, newLayoutId: context.layoutId,
    scheduleChangedAt: cutover.scheduleChangedAt, confirmedStationAt: cutover.confirmedStationAt,
    firstNewObservedAt: cutover.firstNewObservedAt, firstCompleteObservedAt: cutover.firstCompleteObservedAt,
    repairedRecords: repaired, mappedGlobeRecords: count, transitionRows,
    transitionExcludedRows: exclusions.find(row => row.reason === PARTIAL_REASON)?.n || 0,
    ambiguousRows: exclusions.filter(row => row.reason !== PARTIAL_REASON).reduce((sum, row) => sum + row.n, 0),
    firstUsableGlobe: edge('ASC'), latestUsableGlobe: edge('DESC') };
}

module.exports = { initializeLayoutCutover, repairLayoutCutover, routeCutoverRecord, markCutoverRecord,
  layoutTransitionStatus, baselineId, newLayout, MAX_REPAIR_RECORDS };
