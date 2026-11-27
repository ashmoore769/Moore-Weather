# Moore Weather

Private weather station dashboard for West Warwick, Queensland. This directory is the application and Git repository root; the former nested `weather-proxy` folder has been consolidated here.

## Project layout

| Location | Purpose |
| --- | --- |
| `server.js` | Express server, authentication, station polling, daily summary and SkyCam proxy |
| `public/` | Current dashboard, daily summary, login page and active assets |
| `tools/` | Offline checks and the recovered authentication setup helper |
| `lib/`, `config/`, `test/` | SQL storage, verified logger layouts and offline tests |
| `Weather Station Data/` | Supplied historical exports, excluded from Git |
| `data/` | SQLite database, inspection captures and backups, excluded from Git |
| `docs/` | Operations notes and the migration record |
| `.env` | Private local configuration, excluded from Git |
| `.env.example` | Configuration names and non-secret defaults |
| `node_modules/` | Installed dependencies, excluded from Git |
| `_archive/2026-09-30-migration/` | Original snapshot, old versions, artwork and Mac scripts; excluded from Git |

## Local setup

For a fresh checkout, use Node.js 24.14 or later in the 24 release line with npm, then run `npm ci` from this directory. The migrated dependency folder is retained on this PC.

The existing Render configuration has been restored into this PC's ignored `.env`. On a fresh checkout, copy `.env.example` to `.env` only if `.env` does not already exist, then restore the existing authentication and SkyCam environment values from Render. The login password hash is not the original password, and cannot be used to recover it. For a separate local password, run `node tools/generate-auth-env.js` in an interactive terminal and use its output only in your local `.env`.

Run the offline checks with:

```powershell
node tools/check.js
```

The equivalent npm command is `npm run check`. Run the database tests with `node --test test/*.test.js` or `npm test`. These checks do not require credentials or contact external services.

After configuration is ready, `npm start` (or `node server.js`) serves the app at `http://localhost:10000`.

**Starting the server begins polling the physical station immediately.** The Render instance already polls it. Use a mock station for development, or coordinate access before running another live poller: the server's transaction queue only coordinates requests within its own process.

## GUI preview

Run `npm run dev` for a separate dashboard preview with labelled sample data. It does not poll the physical station, read credentials, or write to production storage. The production command remains `npm start`. See [preview modes](tools/preview/README.md) and [the 1.4 GUI release and rollback](docs/DASHBOARD-1.4.md).

## Graphs and history

The Dashboard shows current conditions beside the next 24 hours of forecast on wide screens, followed by Home Solar, SkyCam and radar, supporting measurements and soil, equipment power, and local water levels. Weather and station-power previews cover the previous 24 hours; Yard Power defaults to 12 hours. Select a card to open the history viewer, change measurement, choose 10-minute/hourly/daily records, and browse earlier end dates. Daily Summary cards show 30-day trends. The viewer supports pointer/touch inspection, arrow-key navigation and an accessible readings table in both themes.

Charts read the SQL archive only and never issue station commands. See [history chart notes](docs/HISTORY.md) for native intervals, measurement conventions, query limits and verification.

## Home solar

The Home solar card prioritises household solar coverage, spare solar and the
current cost of grid imports. Its compact layout places live readings and today's
totals beside a tabbed chart, daily log and details area on desktop. It includes
today's power graph, seven- and thirty-day energy/cost views, a downloadable daily
log, and dated electricity rates. Daily estimates retain explicit coverage and
missing readings; recorded daily summaries survive raw-data retention. See [solar integration notes](docs/SOLAR.md)
for the calculation method, tariffs and collector setup.

## Forecast and radar

The Forecast tab adds a free Open-Meteo seven-day forecast. RainViewer regional radar sits beside SkyCam on wide dashboards and below it on narrow screens. There are no API keys or new paid services. See [forecast and radar notes](docs/FORECAST-RADAR.md) for provider terms, caching, AEST reporting and verification.

## Deployment

- GitHub: <https://github.com/ashmoore769/Moore-Weather>
- Live app: <https://moore-weather.onrender.com>
- Render service: <https://dashboard.render.com/web/srv-cv6nrnt6l47c73da0tcg>

Render deploys automatically when `main` changes. See [operations](docs/OPERATIONS.md) for the persistent-disk deployment configuration and [migration notes](docs/MIGRATION.md) for what was preserved.

The initial SQL database is at `data/weather.sqlite`, with imported historical observations and verified logger mappings. Render uses `/var/data/weather.sqlite` on its persistent disk. See [database notes](docs/DATABASE.md) for counts, queries, import/backup commands, future sensor support and deployment steps. Recording is enabled by a database path; optional bounded history collection and rotating backups use the settings in `.env.example`. Version 1.1 keeps a rolling 15 days of one-minute current readings, preserves native historical archives, and adds complete encrypted offsite recovery and independent health monitoring. See [reliability release and recovery instructions](docs/RELIABILITY-UPDATE.md).
