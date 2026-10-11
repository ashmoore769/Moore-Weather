# Windows consolidation — 30 September 2026

The existing repository was moved from `weather-proxy/` into this project root. Git history, the `main` branch, remote configuration and the saved `WIP before rebase` stash were retained.

Before any moves, every original file was recorded with a SHA-256 hash in `_archive/2026-09-30-migration/original-files.csv`. The entire original app, including `.git`, dependencies, ignored backups and logs, was saved in `weather-proxy-before-cleanup.zip`. All 1,286 source-file hashes were checked against that snapshot.

## Archive contents

- `weather-proxy-before-cleanup.zip`: complete original application and repository.
- `imported/`: the added Render staging folder, rollout backups and Mac archive metadata.
- `legacy-app/`: former backup folders, logs, Mac commit/push scripts, the old ZIP and unused artwork.
- `legacy-app/public/solar.html`: an unlinked home-solar prototype whose `/solar/powerflow` and `/solar/today` endpoints are absent from the current server. This is separate from the weather dashboard's solar-radiation readings.
- `legacy-app/git-hooks/`: the already-disabled Mac post-commit push hooks.
- `original-files.csv` and `moves.jsonl`: original hashes and completed move records.

The main server, three active HTML pages and all assets referenced by those pages were retained. The 9 August staging versions were older than the 13–14 August app files and were not applied over them. The missing `tools/generate-auth-env.js` was recovered from staging unchanged.

Installed dependencies were removed from the Git index but remain on disk. `package-lock.json` remains tracked. New ignore rules exclude the archive, local configuration, database files and certificates. Windows executable-bit differences are ignored through the repository's local `core.filemode=false` setting.

No old watcher process was found on this PC. The legacy scripts and hooks were archived rather than restarted. GitHub push authentication from this PC still needs verification before a release. Reading GitHub succeeded; it does not prove write access.

The consolidation was initially saved on a local cleanup branch. On 11 October 2026, it was published to GitHub and deployed to Render with the database implementation. Render's existing automatic deployment from `main` remains enabled. GitHub connector writes were verified; local SSH push credentials were not added.

## Verification

- Offline checks passed for 12 JavaScript scripts, referenced local assets, the app manifest and dependency declarations.
- Eleven isolated HTTP checks passed for login, access control, the two dashboards, branding, manifest, status and logout. The test used temporary in-memory login values and disabled station polling; it made no requests to the station or SkyCam.
- All six existing Render settings were restored to the ignored local `.env` and structurally validated. No production values were replaced or printed in the migration report.
- `preservation-check.json` in the archive records the final comparison of moved files with the original hashes. Original Git metadata is retained in the verified snapshot, while the active repository contains the cleanup changes.
