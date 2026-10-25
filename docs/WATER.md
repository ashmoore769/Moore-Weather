# Local water records

Leslie Dam is the primary card, followed by Condamine River at Warwick. Both pages show the latest available source observations independently of the weather station. Clicking storage, stored water, river level or flow opens the existing history dialog, with pan, zoom, presets, a fitted trend and the data table.

## Sources and meanings

- Leslie Dam, Sunwater station **422315B**: current percentage, stored ML and published full supply capacity. The daily archive starts **1 January 1986** in the feed inspected on 22 October 2026. It supplies daily minimum/maximum percentages; its zero-filled average field is deliberately ignored. Historical ML is not inferred from today's capacity. The ML archive begins when this collector runs.
- Condamine River at **Scots College**, Queensland WMIP station **422310C**: original point observations of stage (`AT`, 100.00 → 100.00, metres above gauge datum) and discharge (`ATQ`, 140.00 → 140.00, m³/s). The availability endpoint identifies the archive extent, currently **1 October 1960**. Earlier differently identified gauges are not spliced into this record.
- Sunwater data is automated and unverified. WMIP quality codes and labels accompany the retained raw observations. Missing/invalid values and QC 39 or >=151 are retained as raw data but withheld from graphs. No gap is interpreted as zero and no interpolated values are invented.
- Water days end at midnight AEST, separately from the weather station's 9 AM reporting day. The current incomplete day appears in current readings; completed daily buckets appear in graphs. River and locally collected ML lines use the last usable sample with an observed low–high band, not a time-weighted mean. Sparse sampling cannot guarantee continuous extrema. Decade views group days (at most 1,500 chart points) while retaining group minima/maxima; original samples remain stored.

Official references:

- https://www.sunwater.com.au/dams/leslie-dam/
- https://www.sunwater.com.au/water-data/historical-dam-capacity/
- https://water-monitoring.information.qld.gov.au/wini/documents/WMIP_API_2025.pdf
- https://water-monitoring.information.qld.gov.au/wini/documents/webglossary.pdf

WMIP attribution: State of Queensland, Water Monitoring Information Portal, CC BY 4.0. See https://creativecommons.org/licenses/by/4.0/ and the provider's https://www.qld.gov.au/legal/disclaimer .

## Warwick town gauge (26 October 2026)

The main Condamine height card, sparkline and history now use **BOM Warwick Alert 041534**, a different station from Scots College **422310C / BOM 041503**. Flow continues to come from Scots College and is labelled accordingly. The original `condamine-level` and `condamine-flow` metrics, their records and their import checkpoints are preserved; the level remains selectable as “Scots College” in Trends.

New observations use the separate metric `condamine-warwick-level` in the existing `water_samples` and `water_buckets` SQL tables. This normalized schema stores each station/measurement as a metric rather than adding a physical column or overwriting the old gauge. The new `condamine-warwick-live` checkpoint is independent of the WMIP archive jobs.

- Source: https://www.bom.gov.au/fwo/IDQ65396/IDQ65396.041534.tbl.shtml
- This is BOM’s official HTML observation table, not a JSON API. It supplies a rolling **14-day window**. The first successful request imports that window; a central worker refreshes every ten minutes, re-reads the window for revisions, and saves new records permanently. Older saved records are never deleted when the source window moves. Outages longer than that window may leave gaps; no older Scots College readings are relabelled as Warwick Alert.
- The parser verifies station ID, units, AEST, issue date, observation dates and published thresholds before any database write. Invalid/error pages retry with backoff. Duplicate minute timestamps use the last row published by BOM. Missing values stay null. Raw source text values, station ID, source URL and issue time are stored with each sample.
- Published gauge thresholds: minor **5 m**, moderate **6 m**, major **7 m**. BOM’s crossing register names the **7 m crossing as McCahon Bridge**, not O. O. Madsen. Major and bridge therefore share one constant labelled line. Reference lines apply only to this height metric and always stay visible in the main graph; they do not affect flow graphs, Scots College graphs, extrema or sparkline scaling.
- Reference: https://www.bom.gov.au/qld/flood/networks/section5.shtml and station index https://www.bom.gov.au/qld/flood/networks/section3.shtml . Thresholds checked 26 October 2026. If the table publishes different thresholds, ingestion fails visibly for review rather than silently displaying mismatched lines.
- The default Warwick graph is seven days of hourly observations; other ranges and daily history remain available. The current card uses the latest native observation; hourly graphs show completed hours. The bridge line is a height reference, not an indication that a road is open or safe.
- Attribution: Bureau of Meteorology, CC BY 4.0 Australia (https://creativecommons.org/licenses/by/4.0/au/). Operational observations are unverified. Each gauge keeps its own observation timestamp; upstream flow is not presented as a measurement at the town gauge.

## Collection and backfill

`WATER_DATA_ENABLED` defaults to enabled when `WEATHER_DB_PATH` is configured and the existing weather persistence checks have succeeded. It does not create a second database or contact the physical weather station. Set `WATER_DATA_ENABLED=false` to pause collection while retaining saved history.

An isolated worker adds three namespaced tables to the existing SQLite database: `water_samples`, `water_buckets`, and `water_ingestion`. The weather schema version and its tables remain unchanged. Existing native SQLite backups include the water tables. Source responses, units/metric identities, QC, source observation times and retrieval times are retained. Imports are idempotent and each page/batch commits atomically with its cursor.

The worker issues at most one request per 30 seconds, with a 45-second timeout and a 24 MiB response limit. Leslie uses opaque continuation tokens until the source returns an empty page or no next token. The two river archives import backwards in 31-day batches, independently, from the present to the provider-reported earliest date. Large river responses reduce batch size. Requests that fail retain their cursor and back off, capped at six hours. Backfill can take many hours; it resumes after deployment/restart. Provider gaps remain gaps.

Live dam and recent river records refresh hourly, scheduled near hh:30 as recommended by WMIP. River collection overlaps two days and catches up after downtime in bounded batches. The most recent 90 days are re-read daily to pick up quality/value revisions; Sunwater's last seven days are also refreshed daily. The original native timestamps and values are saved, not merely the values visible in each browser session.

`GET /api/water` is protected by the existing authentication and returns saved current readings, progress, source timestamps and water sparklines. It does not call providers. `/api/history` also accepts `leslie-storage`, `leslie-volume`, `condamine-warwick-level`, `condamine-level`, and `condamine-flow`; hourly windows stay limited to 744 hours and water daily windows can span 150 years. `/ping` includes worker health under `water`.

## Rollout and verification

1. Deploy this code using the established GitHub/Render workflow. No new package or API key is needed. Keep the existing persistent `WEATHER_DB_PATH` and backup settings.
2. Allow the worker to start, then check the Local water cards, `/api/water` and `/ping`. The first live records and daily archive pages arrive over the first few minutes. River history fills progressively over hours; the page reports progress and retry delays.
3. Check that each current value has its provider observation timestamp, then open each graph. Leslie's daily and hourly charts represent different published/collected data and may have different coverage. Stored ML should initially have little history.
4. Monitor disk usage during the initial archive import. Native river points plus retained SQLite backups can consume substantial space. Water collection pauses if the disk has less than 512 MiB free, preserving headroom for station recording; it resumes when space is available. This importer does not discard older records to enforce a retention limit.
5. To pause, set `WATER_DATA_ENABLED=false`. To roll back, restore the prior application commit. The additional namespaced tables are harmless to the previous weather app; do not delete or replace the production database.

Offline checks: `node tools/check.js` and `node --test test/*.test.js`. They do not start station polling. Production import completion must be verified after deployment; a prepared code update does not itself populate the hosted database.
