# Operations

## Confirmed deployment, 30 September 2026

- GitHub repository: `ashmoore769/Moore-Weather`, branch `main`.
- Local source, GitHub `main` and Render's live deployment initially matched commit `da02195b7e06604518fdf8d19313fa5bc1783d9d` (14 August 2026).
- Render workspace: `My Workspace`, ID `tea-cv6nit3tq21c73dkfhkg`.
- Render service: `Moore-Weather`, ID `srv-cv6nrnt6l47c73da0tcg`.
- Region: Oregon. One Starter instance. No persistent disk was listed for this service.
- Build command: `npm install`. Start command: `node server.js`.
- Automatic deployment: on commit to `main`. Health-check path: unset.
- These are recorded settings, not a new infrastructure configuration.

## Data flow

The server sends `r3` to the station through its TCP connection for current readings every 60 seconds. It sends `MEM 1 LAST` for a daily record, scheduled at 09:10 Australia/Brisbane. A normal refresh avoids repeating a station request when the expected daily record is cached; the maintenance control on the station label can deliberately request it again.

Current, daily and enabled history requests are serialized through one queue within the server process. Setting `WEATHER_DB_PATH` writes the existing current/daily polls to SQL and restores them after restart. `WEATHER_HISTORY_ENABLED=true` adds staggered, bounded recent-history downloads for memories 1–4. The supplied historical exports have been imported into the initial database; see [database notes](DATABASE.md).

SkyCam images and its persistent history manifest originate on Vultr. Render requests them through HTTPS using the configured origin token and private CA certificate. Render keeps a short-lived manifest cache, not the image archive.

## Configuration

| Variables | Purpose |
| --- | --- |
| `MOORE_AUTH_PASSWORD_HASH` | Existing scrypt password verifier, not a recoverable plaintext password |
| `MOORE_AUTH_COOKIE_SECRET` | Signs remembered-device cookies; changing it invalidates existing cookies |
| `MOORE_AUTH_MAX_AGE_DAYS`, `MOORE_AUTH_VERSION` | Login lifetime and token version |
| `SKYCAM_ORIGIN_BASE_URL`, `SKYCAM_ORIGIN_TOKEN`, `SKYCAM_ORIGIN_CA_CERT_B64` | Existing protected camera origin |
| `WEATHER_STATION_HOST`, `WEATHER_STATION_PORT` | Station TCP connection; code defaults are in `.env.example` |
| `PORT` | HTTP listener; default 10000 |
| `WEATHER_DB_PATH`, `WEATHER_DB_LAYOUT` | Optional SQL database path and verified layout override; blank disables recording |
| `WEATHER_HISTORY_ENABLED` | Enables bounded recent-memory collection through the existing queue |
| `WEATHER_BACKUP_DIR` | Enables three recent complete encrypted recovery bundles and the pre-retention checkpoint |
| `WEATHER_BACKUP_ENCRYPTION_KEY` | Optional separate recovery secret; defaults to the existing cookie secret; preserve original keys when rotating |

Production secrets are not in the current Git tree. Keep recovered values in the ignored local `.env`, never in documentation or source control. Do not replace production authentication values merely to start a local development copy.

On 30 September 2026, all six existing Render variables were recovered into this PC's ignored `.env`. Password-hash structure, secret lengths, HTTPS origin, and CA-certificate parsing/validity were checked without displaying the values. Production settings were not changed. Station host/port still use the source defaults because they were not among the six Render variables.

## SQL status

The local schema, importer, duplicate handling, versioned sensor mapping, original-source preservation and database backup command are implemented and tested. The app can optionally persist current/daily readings using its existing polling queue. Updated 11 October: the database contains 1,369,930 measurements, including 46 estimated values across two owner-authorised ten-minute gap fills; 1,367,580 measurements remain usable after screening. The supplied captures extend ten-minute history to 11 October at 22:10 AEST, hourly history to 21:00 and daily history to 09:00. Original source data is unchanged. Schema version 3 labels estimates with their parent records and exposes solar flooring separately from raw values. See `DATABASE.md` and `data/october-history-audit.json` for counts, earlier gaps and exclusions. The current backup is `data/backups/weather-2026-10-11-complete-history.sqlite`.

## Render deployment configuration, 11 October 2026

The owner approved and attached a 5 GB persistent disk at `/var/data`, costing an additional US$1.25/month. The existing Starter service remains a single instance. Disk-backed deployments restart the service briefly. No managed PostgreSQL service is required: this application uses SQLite SQL on the attached disk.

The initial snapshot was uploaded, checked against compressed/uncompressed SHA-256 hashes, checked for integrity and foreign-key errors, and confirmed to contain 1,369,930 measurements before recording was enabled. The source was published to `main`, Render deployed automatically, and the authenticated `/ping` confirmed successful database writes and recent-history imports. The production runtime selected Node 24.21.0. The local database remains the import snapshot rather than a live replica.

```
WEATHER_DB_PATH=/var/data/weather.sqlite
WEATHER_HISTORY_ENABLED=true
WEATHER_BACKUP_DIR=/var/data/backups
```

Use Node 24.14 or later in the 24 release line as declared in `package.json`. Retain all existing authentication and SkyCam secrets. Do not enable SQLite on Render's ephemeral application filesystem: the adapter requires the actual persistent mount and an already-uploaded database.

The collector downloads recent kilobytes only, deduplicates overlaps and logs incomplete replies or missing overlap. It never runs a multi-month memory search. Ten-minute history is checked every ten minutes, hourly history hourly, rainfall events every five minutes, and daily history every six hours in addition to the existing 09:10 request. A failed download retries after five minutes instead of waiting the full normal interval; malformed rows are rejected with a bounded diagnostic excerpt. On each scheduler tick at most one history request is added. The EW10 connection is shared with current/daily polling through the same queue.

Backups run in a child process and now include weather/water data, push-alert/device state and the access-request queue. Native SQLite copies are verified, compressed and encrypted; three recent complete bundles and the initial pre-retention checkpoint remain under `/var/data/backups`. The GitHub backup workflow stores encrypted artifacts off Render daily, with 30-day retention and an acknowledged SHA-256 checksum. The initial rolling 15-day R3 cleanup stays blocked until that checkpoint is offsite. See [reliability update](RELIABILITY-UPDATE.md) for recovery keys, safe restore commands and rollback limitations. Long outages remain visible as durable gaps and can require manual logger backfill. Do not use Render disk snapshot rollback as the primary SQLite recovery method.

Check `/ping` for `database.ready`, `database.lastWrite`, each history feed's last success/error/warning and `databaseBackups`. Database errors leave the current dashboard working but require attention to avoid collection gaps. Stop only history collection with `WEATHER_HISTORY_ENABLED=false`; blank `WEATHER_DB_PATH` disables all SQL recording without deleting the database. Do not delete/recreate the disk or overwrite a live database for rollback. Preserve a native backup before any future repair.

The graph cards, history query endpoints and final GUI redesign are separate follow-up work. Pressure conditioning and the logger schedule remain unchanged during this deployment.

Render's build reported five advisories in older Express dependencies. Compatible lockfile updates resolved them without changing the declared application dependencies. The resulting package audit reported zero known vulnerabilities; 22 database tests, 11 isolated HTTP/login/access checks and 28 syntax checks passed.

## Diagnosing missing recent graphs

A successful current (R3) reading proves the live-reading connection works, but
does not prove that the logger's saved memories are advancing. History logs and
the authenticated `/ping` feed status include actual rows received, the first and
last returned observation timestamps, and the latest stored observation. Times
are UTC (add ten hours for AEST). An identical downloaded batch is deduplicated;
zero new records does not mean zero rows were received.

Regular MEM1/2/3 replies with no rows are rejected without deleting saved data.
Empty conditional MEM4 rainfall history is valid. A completed transfer is still
reported as stale when its last observation exceeds 30 minutes for MEM3, two
hours for MEM2, or two days for MEM1. `lastSuccess` is the transfer time; use
`lastObservedAt` and `storedThrough` to assess freshness. Transfer failures log
received byte counts without dumping station responses. SkyCam manifest logs
also show the newest capture time, independently of a successful refresh.

If returned and stored history timestamps remain fixed while R3 advances,
investigate the logger's recording/memory state before changing database files.
Do not reset station memories, replace the database, or run another collector
against the same serial link as a diagnostic shortcut.
