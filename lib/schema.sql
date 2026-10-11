PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, serial TEXT NOT NULL,
  timezone TEXT NOT NULL, utc_offset_minutes INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sensors (
  station_id TEXT NOT NULL REFERENCES stations(id), sensor_key TEXT NOT NULL,
  PRIMARY KEY (station_id, sensor_key)
) STRICT;
CREATE TABLE IF NOT EXISTS layouts (
  id TEXT PRIMARY KEY, station_id TEXT NOT NULL REFERENCES stations(id),
  definition_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY, layout_id TEXT NOT NULL REFERENCES layouts(id),
  stream TEXT NOT NULL, position INTEGER NOT NULL, sensor_key TEXT NOT NULL,
  name TEXT NOT NULL, unit TEXT NOT NULL, aggregation TEXT NOT NULL,
  metadata_json TEXT NOT NULL, UNIQUE(layout_id, stream, position)
) STRICT;
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, format TEXT NOT NULL,
  station_id TEXT NOT NULL REFERENCES stations(id), stream TEXT NOT NULL,
  layout_id TEXT NOT NULL REFERENCES layouts(id), imported_at TEXT NOT NULL,
  original_bytes BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, station_id TEXT NOT NULL REFERENCES stations(id),
  stream TEXT NOT NULL, layout_id TEXT NOT NULL REFERENCES layouts(id),
  observed_at TEXT NOT NULL, local_timestamp TEXT NOT NULL,
  interval_start TEXT, reporting_date TEXT, raw_line TEXT NOT NULL,
  diagnostic_message TEXT, received_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS records_time ON records(station_id, stream, observed_at);
CREATE TABLE IF NOT EXISTS observations (
  record_id TEXT NOT NULL REFERENCES records(id), field_id INTEGER NOT NULL REFERENCES fields(id),
  value REAL, raw_value TEXT NOT NULL, quality TEXT NOT NULL CHECK(quality IN ('valid','missing','invalid')),
  PRIMARY KEY(record_id, field_id)
) STRICT;
CREATE INDEX IF NOT EXISTS observations_field ON observations(field_id, record_id);
CREATE TABLE IF NOT EXISTS source_records (
  source_id TEXT NOT NULL REFERENCES sources(id), line_number INTEGER NOT NULL,
  record_id TEXT NOT NULL REFERENCES records(id), PRIMARY KEY(source_id, line_number)
) STRICT;
CREATE TABLE IF NOT EXISTS rejected_rows (
  source_id TEXT NOT NULL REFERENCES sources(id), line_number INTEGER NOT NULL,
  raw_line TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(source_id, line_number)
) STRICT;
CREATE TABLE IF NOT EXISTS data_quality_policies (
  station_id TEXT PRIMARY KEY REFERENCES stations(id), earliest_local_timestamp TEXT NOT NULL,
  pressure_min_hpa REAL NOT NULL, pressure_max_hpa REAL NOT NULL,
  note TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sensor_quality_limits (
  station_id TEXT NOT NULL REFERENCES stations(id), sensor_key TEXT NOT NULL,
  minimum REAL NOT NULL, maximum REAL NOT NULL, floor_zero INTEGER NOT NULL CHECK(floor_zero IN (0,1)),
  note TEXT NOT NULL, CHECK(minimum < maximum), PRIMARY KEY(station_id, sensor_key)
) STRICT;
CREATE TABLE IF NOT EXISTS record_estimates (
  record_id TEXT PRIMARY KEY REFERENCES records(id),
  previous_record_id TEXT NOT NULL REFERENCES records(id), next_record_id TEXT NOT NULL REFERENCES records(id),
  method TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE VIEW IF NOT EXISTS weather_readings_raw AS
SELECT r.station_id, r.stream, r.observed_at, r.local_timestamp, r.interval_start,
       r.reporting_date, f.sensor_key, f.name, f.unit, f.aggregation,
       o.value, o.raw_value, o.quality, r.id AS record_id, r.layout_id,
       f.id AS field_id, CASE WHEN e.record_id IS NULL THEN 0 ELSE 1 END AS is_estimated,
       e.method AS estimation_method
FROM observations o JOIN records r ON r.id=o.record_id JOIN fields f ON f.id=o.field_id
LEFT JOIN record_estimates e ON e.record_id=r.id;
CREATE VIEW IF NOT EXISTS weather_readings_review AS
SELECT w.*, CASE
  WHEN p.station_id IS NULL THEN NULL
  WHEN w.local_timestamp < p.earliest_local_timestamp THEN 'before-current-format'
  WHEN w.quality != 'valid' THEN 'not-numeric'
  WHEN lim.sensor_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM observations bad JOIN fields bf ON bf.id=bad.field_id
    WHERE bad.record_id=w.record_id AND bf.sensor_key=w.sensor_key
      AND (bad.value < lim.minimum OR bad.value > lim.maximum)
  ) THEN 'outside-sensor-range'
  WHEN w.unit IN ('%', 'VWC %') AND (w.value < 0 OR w.value > 100) THEN 'percentage-out-of-range'
  WHEN w.sensor_key IN ('1','25','26') AND w.unit='km/h' AND w.value < 0 THEN 'negative-wind-speed'
  WHEN w.sensor_key IN ('5','30') AND w.unit='mm' AND w.value < 0 THEN 'negative-rainfall'
  WHEN w.unit='Degs' AND (w.value < 0 OR w.value > 360) THEN 'direction-out-of-range'
  WHEN w.unit IN ('DegC','deg C') AND (w.value < -90 OR w.value > 100) THEN 'temperature-out-of-range'
  WHEN w.sensor_key='7' AND w.unit='hPa' AND EXISTS (
    SELECT 1 FROM observations bad JOIN fields bf ON bf.id=bad.field_id
    WHERE bad.record_id=w.record_id AND bf.sensor_key='7' AND bf.unit='hPa'
      AND (bad.value < p.pressure_min_hpa OR bad.value > p.pressure_max_hpa)
  ) THEN 'pressure-outside-station-range'
  ELSE NULL END AS exclusion_reason
FROM weather_readings_raw w LEFT JOIN data_quality_policies p ON p.station_id=w.station_id
LEFT JOIN sensor_quality_limits lim ON lim.station_id=w.station_id AND lim.sensor_key=w.sensor_key;
CREATE VIEW IF NOT EXISTS weather_readings AS
SELECT w.station_id, w.stream, w.observed_at, w.local_timestamp, w.interval_start,
       w.reporting_date, w.sensor_key, w.name, w.unit, w.aggregation,
       CASE WHEN lim.floor_zero=1 AND w.value<0 THEN 0.0 ELSE w.value END AS value,
       w.raw_value, w.quality, w.record_id, w.layout_id, w.field_id, w.is_estimated, w.estimation_method,
       CASE WHEN lim.floor_zero=1 AND w.value<0 THEN 'solar-zero-floor' ELSE NULL END AS adjustment,
       w.value AS original_value
FROM weather_readings_review w
LEFT JOIN sensor_quality_limits lim ON lim.station_id=w.station_id AND lim.sensor_key=w.sensor_key
WHERE w.exclusion_reason IS NULL AND (w.is_estimated=0 OR NOT EXISTS (
  SELECT 1 FROM records measured WHERE measured.station_id=w.station_id AND measured.stream=w.stream
    AND measured.observed_at=w.observed_at AND NOT EXISTS (
      SELECT 1 FROM record_estimates e WHERE e.record_id=measured.id
    )
));
CREATE VIEW IF NOT EXISTS conflicting_records AS
SELECT station_id, stream, observed_at, COUNT(*) AS variants
FROM records WHERE stream != 'mem0' AND NOT EXISTS (SELECT 1 FROM record_estimates e WHERE e.record_id=records.id)
GROUP BY station_id, stream, observed_at HAVING COUNT(*) > 1;
PRAGMA user_version = 3;
