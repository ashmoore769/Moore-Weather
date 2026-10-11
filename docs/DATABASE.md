# Weather database

The initial database is `data/weather.sqlite`, built from the supplied exports, five live checks on 30 September 2026, and four terminal captures supplied on 11 October. Its verified copy was deployed on 11 October to `/var/data/weather.sqlite` on Render's persistent disk, where ongoing observations are collected. The PC copy is an initial snapshot, not a live replica. Source files, captures, databases and backups are excluded from Git.

Use Node.js 24.14 or later in the 24 release line. Storage uses Node's built-in SQLite library; no database server, new package installation or credentials are needed on this PC.

## Initial imported snapshot: 11 October 2026

The database contains **1,369,930 measurements**, including 46 estimated values across two explicitly labelled records. **1,367,580 usable measurements across 57,722 weather records** remain after screening. The October captures added 8,486 measured records (202,414 measurements); the two gap fills added another 46 measurements. There are 5,539 retained diagnostic entries and 34 source entries, representing 24 original export/capture files plus five September inspections (multi-stream captures have a source entry per stream).

| Feed | Total records, including archived exclusions | Latest supplied reading, AEST |
| --- | ---: | --- |
| Daily / memory 1 | 469 | 11 October 2026, 09:00 |
| Hourly / memory 2 | 10,841 | 11 October 2026, 21:00 |
| Ten-minute / memory 3 | 43,936, including 2 estimates | 11 October 2026, 22:10 |
| Rain events / memory 4 | 3,712 | 11 October 2026, 03:37 |
| Current / R3 | 13 | 11 October 2026, 22:11:30 |

The downloaded period from 21 August through each feed's endpoint has no remaining daily, hourly or ten-minute timestamp gaps after the two authorised fills. Earlier historical gaps remain: 18 daily intervals across 5 gaps, 830 hourly intervals across 65 gaps, and 1,685 ten-minute intervals across 36 gaps. No new retrieval from the station was attempted. Rain events are conditional records, so the final rain timestamp does not imply a continuous feed ending then.

All original observations and records from the pre-import backup were compared against the updated database: none were lost or changed. All stored source hashes match; all original files available in `Weather Station Data` match their stored bytes. No conflicting measured timestamps or foreign-key errors were found, and database integrity passed. Two incomplete terminal fragments were quarantined alongside the existing 192 legacy source rows.

Additional screening identified a -20 °C black-globe minimum and -1% humidity minimum in the daily record ending 27 September at 09:00. The three black-globe aggregates and invalid humidity minimum are excluded. Together with existing exclusions, 2,350 measurements are excluded. The solar zero floor affects 26,456 usable readings, with original values retained.

The import report is `data/october-terminal-import-report.json`; the full audit is `data/october-history-audit.json`. Backups before and after this update are `data/backups/weather-2026-10-11-before-terminal-import.sqlite` and `data/backups/weather-2026-10-11-complete-history.sqlite`. The CSV ZIP produced earlier on 11 October remains a snapshot of the database before these new captures were imported.

## September baseline (superseded by the current status above)

The default `weather_readings` view now contains **1,165,124 usable measurements from 49,234 weather records**, starting on **12 June 2025**. This follows the owner's instruction to omit pre-current-format data and vet obvious junk. The counts below describe the complete preserved archive, including exclusions.

| Feed | Supplied historical records | Live check records | Values per weather record |
| --- | ---: | ---: | ---: |
| Diagnostics / memory 0 | 5,539 | 0 | Diagnostic text |
| Daily / memory 1 | 420 mapped; 96 held for mapping | 1 | 41 in the current layout |
| Hourly / memory 2 | 9,658 | 1 | 31 |
| Ten-minute / memory 3 | 36,833 | 1 | 23 |
| Rain events / memory 4 | 3,567 | 1 | 1 |
| Current / R3 | 0 | 1 | 30 |

After the expanded import on 30 September: **50,483 mapped weather records, 1,167,470 individual measurements and 5,539 diagnostic entries**. All twenty supplied files are preserved byte-for-byte as sources, alongside the five live captures. The paired CSV and Environdata exports share their records rather than doubling them. Repeated identical diagnostic messages within a file are retained.

The expanded files include 2025–2026 history: mapped daily/hourly data begins **12 June 2025**, ten-minute data **29 November 2025**, and rain events **9 March 2025**, plus 58 rain events dated 20 June 2012. The older daily rows include dates from March 2025 and one 2012 timestamp. These dates are retained as supplied; their cause and any correction have not been established.

The supplied exports end on **23 August 2026**. The live readings are snapshots from 30 September; the latest rain snapshot is from 29 September. The gap between the exports and these snapshots remains. Earlier gaps also exist in the supplied records; no values were interpolated. An earliest/latest date range does not imply continuous coverage. The read-only audit reports 6 daily, 66 hourly and 38 ten-minute gaps between mapped records, including the final August–September gap. These counts do not include the 96 unmapped daily rows.

**96 older daily rows use 39 measurement columns rather than the current 41.** They have been preserved in `rejected_rows` and the original source bytes without assigning uncertain sensor names. There are 192 source-row entries because each exists in both formats, representing 96 distinct rows. The older layout's final row in export order is dated 11 June 2025, followed by the current layout on 12 June. An earlier row is dated 4 July before the export jumps back to March, so date alone cannot safely select the layout. The available schedule and earliest application history do not establish the older mapping. Per the owner's instruction, these legacy rows are intentionally omitted from usable history; recovering their mapping is no longer required for this task.

All mapped measurements are numeric, with no conflicting records or broken references. Database integrity checks passed. All twenty source files match their stored bytes and SHA-256 checksums. Reports are saved in `data/expanded-history-import.json` and `data/expanded-history-audit.json`. Reimporting the folder leaves counts unchanged; the importer continues to report the 192 held source rows as a nonzero result so they cannot be overlooked.

The final screened database backup is `data/backups/weather-2026-09-30-vetted-history.sqlite`; the initial, pre-expansion and full unfiltered expansion backups are retained.

## September quality screening baseline

The reviewed policy is in `config/data-quality.json` and stored in the database's `data_quality_policies` table. It applies to future imports into this database as well as existing rows. Schema version 2 adds filtered views without deleting or changing original records.

- **1,249 older rain measurements** are excluded by the 12 June 2025 cutoff, including all 58 rain events dated 2012. The 96 legacy daily rows, including one dated 2012, remain unmapped and excluded separately.
- **1,097 pressure measurements** are excluded. Of these, 1,095 read 804.2–809.4 hPa, mostly a repeated 809.2 from late July to early October 2025. This is treated as a suspected station sensor failure; 804.2 also matches the schedule's zero-input pressure offset. The station-specific screening envelope is 850–1100 hPa. When any pressure statistic in a record falls outside it, the other pressure statistics in that same record are excluded too, accounting for two additional values. Other sensors in those records remain usable. No pressure values are reconstructed or corrected.
- Additional conservative checks reject percentages outside 0–100, negative rain/wind speed, directions outside 0–360, temperatures outside -90–100 degrees C, and nonnumeric values. None added exclusions in this import. These are screening rules, not calibration validation.
- Zero rain, subzero temperatures, slightly negative solar readings, negative calculated evaporation, and diagnostic status counts are retained. No outlier smoothing, gap filling or broad rejection of otherwise plausible readings was performed.

Use `weather_readings` for normal queries, `weather_readings_raw` for all mapped originals, and `weather_readings_review` to see each exclusion reason. Raw `records`, `observations` and `sources` remain archival tables. The live dashboard's current cache is not rewritten by this historical screening. The final audit is `data/vetted-history-audit.json`; the backup has its own verification report.

## Logger verification

The read-only commands used were `GETSERIAL`, `GETTITLE`, `LISTSENSOR`, `LISTSTORAGE`, `r3`, and `MEM 1 LAST` through `MEM 4 LAST`. These commands were identified in the local ATMEL CPU project. No logger settings were changed.

The serial matched the exports and saved schedule. All **34 sensor definitions and 96 storage definitions** matched the saved schedule's names, units, precisions and storage settings. The generated mapping is in `config/station-layout.json`; it includes the schedule fingerprint. Raw inspection replies remain under `data/logger-inspection/`.

R3 has 32 comma-separated fields: date, time and 30 values. Its final value is EnvPro Status, which the current dashboard does not display. Four intermediate wind channels appear in LISTSENSOR but are hidden in R3. The database includes the status channel and does not shift the other values.

GETTITLE returned unreadable characters. The live match relies on the serial and the complete sensor/storage tables, not that title response. The historical file title matches the saved schedule. The first LISTSTORAGE inspection reached its initial time limit; the subsequent longer bounded read retrieved and verified all 96 definitions.

## Meaning of the data

- Logger timestamps are retained in Brisbane local time and converted to UTC using Brisbane's fixed UTC+10 offset. Other time zones require a reviewed conversion implementation.
- Daily records end at **09:00 Brisbane time**. `reporting_date` is the previous local date, matching the daily dashboard. `interval_start` is the nominal start of the logging window, not proof that the logger was running throughout it. In particular, diagnostics show configuration/startup activity during the first historical day.
- Hourly and ten-minute records retain their individual aggregation methods: maximum, minimum, average, standard deviation, vector quantities, totals and current values. They must not be treated as interchangeable instantaneous observations.
- Memory 4 is named “Rainfall Intensity” on the logger, but its configured field is **a conditional one-minute rainfall total in millimetres** (`TOTGR`, threshold zero). The stored `0.2` remains 0.2 mm. It is not relabelled as mm/hour. Missing rain-event rows alone do not prove zero rain or complete communications coverage.
- Values are already scaled by the logger. Importing does not apply sensor multipliers again. Original negative readings, zero, decimal text and status values are preserved. Numeric quality describes successful parsing, not physical plausibility, calibration or firmware error-code interpretation. The 11 October update adds explicitly labelled interpolation and a solar zero floor to usable readings, as described below.

## Structure and future sensors

`stations` identifies each source station. `sensors` identifies channels within that station. `layouts` and `fields` hold immutable versions of the sensor order, names, units and aggregation definitions. `records` holds each timestamped logger row. `observations` holds one value per field. `sources` stores original file bytes and SHA-256 checksums; `source_records` links every imported data line to its record.

New sensors are new channel/field records, rather than new columns in a giant weather table. A changed sensor layout receives a new version; existing observations retain their original meanings. Additional station identities are supported. Distributed indoor temperature and humidity are a future use case for this structure; their transport, hardware discovery and user interface have not been implemented.

To add or reorder sensors, save the new logger schedule, generate a separate mapping using `tools/build-station-layout.js`, and verify it against LISTSENSOR, LISTSTORAGE and R3 before using it. Import older exports with their original mapping. A matching column count alone cannot detect a reordered or replaced sensor.

Unknown row widths, invalid dates and unexpected daily boundaries go into `rejected_rows`, with the original text and reason. Missing values remain SQL NULL with `missing` quality; nonnumeric values remain NULL with `invalid` quality. Original value text is kept in either case. Different versions of a weather record at the same station/feed/timestamp are retained and exposed in `conflicting_records`; the importer never silently overwrites them.

## October terminal captures and quality handling

The four owner-supplied `.bin` files are plain-text terminal captures. Their complete original bytes are preserved in `Weather Station Data` and in `sources` for each imported stream. The terminal parser uses command boundaries, strips a leading terminal prompt from data lines, and preserves original line numbers. A continuation capture requires an explicitly identified stream. Embedded debug messages are retained in the capture and import report. Truncated fragments are quarantined, never joined across unrelated timestamps.

Schema version 3 adds `sensor_quality_limits` and `record_estimates`. The usable `weather_readings` view retains `raw_value` and `original_value`, exposes any `adjustment`, and includes `is_estimated`, `estimation_method` and `field_id`. Consumers must use `value` for conditioned numerical readings, not reparse `raw_value`. The raw view preserves source values and identifies estimates too.

At the owner's request, only 23 August 2026 at 11:30 and 14:40 AEST are filled. Each of the 23 fields is estimated from the two adjacent measured records of the same layout. Scalar fields use the arithmetic midpoint, compass bearings use the shortest circular arc, and directional spread remains a scalar. Both neighbours must pass quality screening. Estimates retain links to both source records and never become independent measured observations. Estimated rain totals, maxima and spread are approximations, not recovered measurements. They do not change the independently recorded hourly or daily summaries. If actual data later arrives for that timestamp, the usable view prefers it and retains the estimate for provenance. Other historical gaps are not filled.

The reviewed local screening limits are configurable in `config/data-quality.json`: air -15 to 55 °C, black globe -15 to 85 °C, surface soil -15 to 80 °C, buried soil -15 to 65 °C. These are conservative screening bounds, not verified climatological extremes. Dew point has a separate -60 to 55 °C range because it can be much lower than air temperature. Existing pressure, percentage, rainfall and wind checks remain. If a sensor statistic falls outside its limits, the sensor's other aggregates in that same record are excluded too; unrelated sensors are retained.

Solar values from -5 to below 0 W/m² become 0 in the usable view with `adjustment='solar-zero-floor'`; the raw originals remain unchanged. Values below -5 or above 2000 are excluded for review. This floors the recorded aggregate and cannot reconstruct clamping of the original samples before averaging. Negative evaporation estimates are retained, since they are not solar radiation. Pressure calibration and logger/webpage settings remain unchanged.

Re-run the exact local import with `node tools/import-terminal-history.js data/october-terminal-import.json`. Repeated imports and the two estimates are idempotent. The manifest records the verified station identity, the continuation stream, the explicit two timestamps and the output report. No command in a capture is executed and no station download is performed.

Diagnostic logs do not include a stable event identifier. Identical complete export batches are deduplicated by ordered content, preserving repeated events within the batch. Partially overlapping diagnostic downloads may retain duplicate events rather than discard potentially genuine ones.

## Future dashboard: trends and detailed history

Owner direction, 30 September 2026: build a sophisticated, polished weather dashboard once the database is hosted, collecting continuously and brought up to date. The supplied screenshot of the existing Moore Weather dashboard is the visual starting point: prominent current readings, grouped sensor cards, a soil profile and the SkyCam alongside. This is a recorded future requirement; no graph interface has been implemented in this step.

- Add a small trend graph beneath each measurement, with approximately the last five hours as the initial proposal. Keep the current value and units prominent, and use restrained colours and consistent spacing. Five hours is provisional, not a fixed requirement.
- Clicking or tapping a measurement opens a larger graph in a popup, starting with temperature and extending the same interaction to other measurements. Include 10-minute, hourly and daily resolution choices, a suitable selectable date range, timestamps and values on inspection. Clearly distinguish the sampling/aggregation interval from the total time displayed.
- Adapt the detail view to small screens and support keyboard opening, closing and navigation. Clearly label units, Brisbane time, the selected statistic and the latest available observation.
- Use actual available sensor history. Ten-minute data is the initial candidate for the small five-hour trends, subject to coverage and field availability. Do not invent a ten-minute channel for a variable absent from that memory; indicate unavailable history or use a clearly labelled supported source.
- Preserve the meaning of each statistic: averages, minima/maxima, rainfall totals and wind direction require appropriate displays. Missing or excluded data must remain visible as gaps, not fabricated zeroes or an apparently continuous trace. Keep historical calibration changes identifiable, including the planned pressure adjustment in `LOGGER-CONDITIONING.md`.

Implementation order: durable production storage and backups; reliable collection and catch-up for memories 1–4; coverage/freshness verification; bounded history queries for each sensor and resolution; then the graph cards and popup. Production storage and bounded collection are implemented. Historical gaps that cannot be recovered should be disclosed rather than block use of otherwise valid history.

## Everyday commands

From the application root:

```powershell
# Import both formats; safe to repeat.
node tools/weather-db.js import "Weather Station Data"

# Inspect counts and database integrity.
node tools/weather-db.js summary

# Detailed source checks, timestamp years and gaps (read-only).
node tools/audit-weather-data.js

# Apply the reviewed policy to a newly rebuilt database.
node tools/weather-db.js vet config/data-quality.json

# Make a consistent backup, including any committed WAL contents.
# Choose a fresh filename each time; an existing backup is not overwritten.
node tools/weather-db.js backup data/backups/weather-2026-09-30.sqlite

# Run offline database tests and application checks.
node --test test/*.test.js
node tools/check.js
```

CSV headers in these exports do not identify their sensor columns. Folder imports identify each CSV by matching its dated data exactly to its Environdata counterpart. For a CSV without its counterpart, explicitly supply a verified stream, for example `--stream mem2`. `--db PATH` and `--layout PATH` select another database or verified mapping.

An example read-only query in any SQLite viewer:

```sql
SELECT local_timestamp, name, aggregation, value, unit
FROM weather_readings
WHERE station_id = 'moore-weather'
  AND stream = 'mem3'
  AND sensor_key = '4'
ORDER BY observed_at;
```

Do not copy an actively written `.sqlite` file alone: committed data may still be in its WAL sidecar. Use the backup command. A verified initial snapshot is saved in `data/backups/`; keep another copy off this PC for disaster recovery. No retention policy deletes historical observations.

## Optional app recording and production hosting

`WEATHER_DB_PATH` is blank by default. Setting it to `data/weather.sqlite` enables recording of **the existing R3 and memory 1 polls** and restores their last unambiguous, numerically valid records after restart. It does not start an additional polling process. Database failures are logged and exposed in the authenticated `/ping` response while the live dashboard continues operating. Failed writes are not replayed automatically; unresolved failures can leave gaps.

`WEATHER_HISTORY_ENABLED=true` enables bounded recent-history downloads through the same station queue: memory 3 every ten minutes, memory 2 hourly, memory 4 every five minutes and memory 1 every six hours. Requests are staggered, with at most one history request per minute. They use `MEM n LAST 8` (eight kilobytes), or four kilobytes for memory 1, rather than a full-memory search. Replies require a completion marker and valid chronological rows before import; a 20-second deadline and 32 KB response cap limit failures. Overlapping records deduplicate. A missing overlap is reported in `/ping` and logs; long outages may still require a manually downloaded history file.

The owner approved a 5 GB persistent disk on 11 October 2026 at US$1.25/month, mounted at `/var/data`. The initial transfer passed compressed and uncompressed SHA-256 comparisons, integrity and foreign-key checks, and the expected measurement count. Production recording is enabled with `WEATHER_DB_PATH=/var/data/weather.sqlite`. The adapter only enables writes beneath that actual persistent mount and refuses to create an empty initial database. Local recording remains disabled in this PC's private `.env`.

Set `WEATHER_BACKUP_DIR=/var/data/backups` for automatic native SQLite backups, with integrity and foreign-key checks before gzip compression. The scheduler checks hourly, creates a backup when the last one is at least 23 hours old and retains three completed compressed copies. Backup work runs in a separate process. These backups share the database disk: retain the verified PC copy and periodically download a recent backup for independent disaster recovery. Render disk snapshots are not a substitute for consistent SQLite backups.

Only one application process should own station polling. All enabled history requests share the existing server queue. The manually run inspection tool is bounded and allows only the listed read commands; do not run it as a second recurring poller beside Render.
