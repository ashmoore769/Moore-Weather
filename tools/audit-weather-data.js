'use strict';
// Read-only audit: report both remaining gaps and explicitly labelled estimates.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const filename = process.argv[2] || path.resolve(__dirname, '../data/weather.sqlite');
const db = new DatabaseSync(filename, { readOnly: true });
try {
  const all = sql => db.prepare(sql).all();
  const hasReview = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='weather_readings_review'").get());
  const hasEstimates = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='record_estimates'").get());
  const report = {
    auditedAt: new Date().toISOString(),
    records: all(`SELECT stream, COUNT(*) AS records, MIN(local_timestamp) AS first,
      MAX(local_timestamp) AS last FROM records GROUP BY stream ORDER BY stream`),
    years: all(`SELECT stream, substr(local_timestamp,1,4) AS year, COUNT(*) AS records
      FROM records GROUP BY stream, year ORDER BY stream, year`),
    observations: db.prepare('SELECT COUNT(*) AS count FROM observations').get().count,
    usableObservations: db.prepare('SELECT COUNT(*) AS count FROM weather_readings').get().count,
    usableStreams: all(`SELECT stream, COUNT(DISTINCT record_id) AS records, COUNT(*) AS measurements,
      MIN(local_timestamp) AS first, MAX(local_timestamp) AS last FROM weather_readings GROUP BY stream`),
    exclusions: hasReview ? all('SELECT exclusion_reason, COUNT(*) AS measurements, COUNT(DISTINCT record_id) AS records FROM weather_readings_review WHERE exclusion_reason IS NOT NULL GROUP BY exclusion_reason') : [],
    rejected: all(`SELECT s.stream, reason, COUNT(*) AS sourceRows, COUNT(DISTINCT raw_line) AS distinctRows
      FROM rejected_rows r JOIN sources s ON s.id=r.source_id GROUP BY s.stream, reason`),
    nonNumeric: all(`SELECT quality, COUNT(*) AS measurements FROM observations
      WHERE quality!='valid' GROUP BY quality`),
    conflicts: all('SELECT * FROM conflicting_records'),
    estimates: hasEstimates ? all(`SELECT r.local_timestamp, r.stream, e.* FROM record_estimates e JOIN records r ON r.id=e.record_id ORDER BY r.observed_at`) : [],
    adjustments: hasEstimates ? all('SELECT adjustment, COUNT(*) AS measurements FROM weather_readings WHERE adjustment IS NOT NULL GROUP BY adjustment') : [],
    gaps: [],
    sourceChecks: [],
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    foreignKeyErrors: all('PRAGMA foreign_key_check')
  };
  for (const [stream, cadence] of [['mem1',86400], ['mem2',3600], ['mem3',600]]) {
    const times = db.prepare('SELECT DISTINCT observed_at, local_timestamp FROM records WHERE stream=? ORDER BY observed_at').all(stream);
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
      const elapsed = (Date.parse(times[i].observed_at) - Date.parse(times[i-1].observed_at)) / 1000;
      if (elapsed > cadence) gaps.push({ after: times[i-1].local_timestamp, before: times[i].local_timestamp,
        missingNominalIntervals: Math.max(0, Math.ceil(elapsed / cadence) - 1) });
    }
    report.gaps.push({ stream, gaps: gaps.length,
      missingNominalIntervals: gaps.reduce((sum, gap) => sum + gap.missingNominalIntervals, 0),
      longest: gaps.sort((a,b) => b.missingNominalIntervals - a.missingNominalIntervals).slice(0,10) });
  }
  const sources = db.prepare('SELECT id, name, sha256, original_bytes FROM sources').all();
  for (const source of sources) {
    const bytes = Buffer.from(source.original_bytes);
    const storedHashMatches = crypto.createHash('sha256').update(bytes).digest('hex') === source.sha256;
    const localPath = path.resolve(__dirname, '../Weather Station Data', path.basename(source.name));
    const exportMatches = source.name.startsWith('inspection/') || source.name.startsWith('live/')
      ? null : fs.existsSync(localPath) && bytes.equals(fs.readFileSync(localPath));
    report.sourceChecks.push({ name: source.name, storedHashMatches, exportMatches });
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.integrity !== 'ok' || report.foreignKeyErrors.length || report.sourceChecks.some(s => !s.storedHashMatches || s.exportMatches === false)) process.exitCode = 1;
} finally { db.close(); }
