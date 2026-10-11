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

## Graphs and history

The Current page has five-hour trends on weather, soil and power readings. Select a card to open the history viewer, change measurement, choose 10-minute/hourly/daily records, and browse earlier end dates. Daily Summary cards show 30-day trends. The viewer supports pointer/touch inspection, arrow-key navigation and an accessible readings table in both themes.

Charts read the SQL archive only and never issue station commands. See [history chart notes](docs/HISTORY.md) for native intervals, measurement conventions, query limits and verification.

## Deployment

- GitHub: <https://github.com/ashmoore769/Moore-Weather>
- Live app: <https://moore-weather.onrender.com>
- Render service: <https://dashboard.render.com/web/srv-cv6nrnt6l47c73da0tcg>

Render deploys automatically when `main` changes. See [operations](docs/OPERATIONS.md) for the persistent-disk deployment configuration and [migration notes](docs/MIGRATION.md) for what was preserved.

The initial SQL database is at `data/weather.sqlite`, with imported historical observations and verified logger mappings. Render uses `/var/data/weather.sqlite` on its persistent disk. See [database notes](docs/DATABASE.md) for counts, queries, import/backup commands, future sensor support and deployment steps. Recording is enabled by a database path; optional bounded history collection and rotating backups use the settings in `.env.example`.
