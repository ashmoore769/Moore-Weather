# Moore Weather 1.1 reliability release

## Scope and rollback

This release follows the full-app audit of commit `e8bb54a6e5412371059ece6eff9e30c64bb5089c`. It addresses security, misleading freshness, interrupted camera transfers, unbounded current-reading storage and incomplete recovery coverage. It keeps the station's logger configuration and calibration unchanged.

The application can be rolled back to that commit on Render. The new database tables are additive and the existing weather schema version stays compatible with the previous app. A code rollback does not rewind the database or restore removed one-minute records. The immutable pre-retention recovery checkpoint contains those records. Restore it to a **new directory** for inspection before planning any live data restoration; replacing the active database would also discard newer readings.

## Rolling 15-day current readings

Only the `r3` stream, collected once a minute, expires. A record whose observation time is strictly older than 15 days can be removed. The exact cutoff is retained. Native ten-minute, hourly, daily, conditional rainfall and river/dam archives do not expire under this policy. Existing trend charts use the native archives.

Cleanup removes dependent R3 measurements and source links together, and removes an original R3 response only when no retained record refers to it. References needed by estimated records remain protected. Old rejected-only R3 captures expire by their receipt time; diagnostic evidence for other streams remains untouched.

The first cleanup is blocked until a complete, integrity-checked, encrypted recovery checkpoint exists **and** the GitHub backup workflow has uploaded the ciphertext and acknowledged the matching SHA-256 digest. The checkpoint is retained separately from normal rotation. Maintenance checks this gate for every small transaction. Deletion runs in a worker, yields between batches and has bounded work per pass. The initial backlog drains over multiple passes instead of holding up polling.

SQLite reuses freed pages for new inserts. The database file does not immediately shrink on disk, and this release does not run a blocking full `VACUUM` on the live database. Archive data still grows, so the status panel reports free disk space.

## Complete encrypted recovery

The existing `WEATHER_BACKUP_DIR` enables complete native SQLite snapshots of:

- `weather.sqlite`, including weather and water tables;
- `station-alerts.sqlite`, including VAPID keys, subscriptions and delivery state;
- `access-requests.sqlite`, including the durable request queue.

An explicitly disabled component may be absent. An enabled component whose database is missing fails the backup instead of silently producing an incomplete copy. Custom `ACCESS_REQUEST_DB_PATH` is respected. Each database is transactionally consistent independently; the databases have no cross-database transactions.

The worker checks available disk space, uses SQLite's online backup API so committed WAL data is included, checks integrity and foreign keys, compresses each snapshot and encrypts a streaming bundle with AES-256-GCM. It authenticates the completed ciphertext before publishing the bundle. Each encrypted manifest includes per-database size and SHA-256 checksums. Normal completed copies rotate to three; the pre-retention checkpoint and owner-managed or legacy backup files are not removed.

The key comes from `WEATHER_BACKUP_ENCRYPTION_KEY` when set, otherwise the existing `MOORE_AUTH_COOKIE_SECRET`. A domain-separated HKDF derivation and random salt/IV are used for every bundle. **Keep the original encryption secret in the owner's password manager before rotating it.** The secret stays in Render and is never sent to GitHub. The database disk and backup artifact alone cannot recover it. Render environment configuration is not itself included in the bundle.

`.github/workflows/backups.yml` runs daily and after main-branch pushes. It downloads only encrypted `.mwb` bytes, verifies the transport checksum, saves a GitHub Actions artifact for 30 days, then acknowledges successful upload. It uses short-lived GitHub OIDC identity instead of a static login password or repository secret. The server accepts only the original numeric repository/owner identity, `main`, and this specific workflow. Forks, pull-request events, other workflows, expired tokens and wrong audiences are rejected. The endpoint cannot choose arbitrary files or export plaintext.

The immutable checkpoint's offsite acknowledgement expires after 28 days, before its 30-day artifact can be deleted. While that acknowledgement is missing or expired, cleanup remains blocked and the next successful workflow re-uploads the **same original checkpoint**, then renews its acknowledgement. This preserves the original archive separately from later copies of the pruned database. The current workflow uploads one bundle per run, so its scheduled checkpoint-renewal run replaces that day's ordinary offsite copy; assuming the surrounding daily runs succeed, the latest ordinary offsite recovery point can approach 48 hours old until the following run. Delayed or failed workflows can extend that interval and appear in backup/monitoring status. Local backup creation continues after the renewed acknowledgement.

Artifacts are ciphertext, but this is a public repository: do not add plaintext exports, environment dumps or recovery keys to the workflow. GitHub artifact retention and schedule execution are not a permanent archival guarantee. Save an occasional encrypted bundle and its original key separately for longer-term recovery.

### Backup receipts and scheduled workflows

GitHub's [scheduled-workflow documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) says scheduled workflows in public repositories are automatically disabled after 60 days without repository activity. It also notes that schedules run from the default branch and may be delayed or dropped under load.

After an encrypted artifact is uploaded and its acknowledgment succeeds, a separate job records `latest.json` on the dedicated `recovery-receipts` branch. The receipt contains only the artifact and workflow run identifiers, ciphertext SHA-256 and size, backup creation time, and receipt time. Its commit history preserves earlier receipts. The first commit has no parents, so this branch does not copy the app's files. Subsequent updates change only `latest.json`, preserve other files on that branch, and advance the branch by fast-forward only; `main` is never changed. A failed or cancelled backup produces no receipt.

The backup job keeps `contents: read` and `id-token: write`. The receipt job has `contents: write` and `id-token: none`; it receives only four validated metadata outputs and downloads no backup. The receipt writer sends its short-lived `GITHUB_TOKEN` only in authenticated GitHub API requests. The checkout does not persist credentials. [GitHub documents](https://docs.github.com/en/actions/concepts/security/github_token) that pushes using this token do not start further push-triggered workflow runs.

These receipt commits create a useful audit trail and are intended to prevent an otherwise finished application from becoming inactive. GitHub does not fully document which automated or non-default-branch activity resets its inactivity timer, so continued schedule execution must still be checked. If GitHub disables a schedule, use its [workflow enable controls](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows), then run the backup manually and confirm a fresh artifact and matching receipt. A receipt is evidence that an artifact was stored at that time; it does not extend the artifact's retention period.

To verify or restore a downloaded bundle, use Node 24 and put the original key in the appropriate environment variable without passing it on the command line:

```sh
node tools/restore-recovery.js backup.mwb data/recovered-inspection
```

The destination must not exist. The tool authenticates the entire bundle before interpreting it, permits only the three known database filenames, checks all checksums and SQLite integrity, and publishes the restored directory only after every file passes. It never overwrites the running database. The release tests restore real WAL-backed databases and reject a wrong key and altered ciphertext.

## Truthful status

Current values update independently when an unrelated sensor is unavailable. Values rejected by the configured sensor-quality ranges are displayed as unavailable. Current and Daily presentation share the same bounds as the archive; legitimate negative values and the intentional pressure/panel conventions are preserved.

The page's displayed observation time controls its live status. A successful connectivity ping cannot certify values that the page failed to download or display. Requests and camera preloads have bounded waits. A SkyCam label changes only after its corresponding image loads; failed images retain the previous frame and can retry. Camera freshness depends on capture time, not just being the last manifest entry.

If the latest native water observation is invalid, an older usable observation is explicitly shown as last available. It is not promoted to a current bridge reading. Irregular council reports select the nearest real timestamp under the graph cursor.

Future logger rows are quarantined with their original evidence. Valid latest-record queries ignore future maxima. Historical missing intervals are recorded in a durable ledger and remain visible when new readings resume. Actual measured backfills resolve gaps. Existing archives are audited in bounded background pages. No unbounded logger download or fabricated gap fill is performed automatically.

Current and Daily station transactions have a 15-second total deadline and a 16 KiB response limit, in addition to the socket inactivity timeout. A peer that keeps trickling bytes cannot hold the shared station queue indefinitely. Repeated minute ticks share one current-poll retry chain. Invalid/future timestamps are retained as evidence but cannot replace the displayed cache.

## Monitoring and release gates

`/healthz` is a public process liveness endpoint returning only release identity and `ok`. `/health/monitor` returns only `ok` or `degraded` with HTTP 200/503; it exposes no readings, subscriber information, storage paths or credentials. It checks current collection, database/storage and recovery/retention readiness with a short startup grace. Authenticated `/api/system-health` and the Alerts panel provide detailed operational status.

`.github/workflows/monitor.yml` checks the live app independently about every 15 minutes, with retries for brief network failures. Failures appear as failed Actions runs. Delivery of GitHub's email/web notifications depends on the owner's GitHub notification settings. Scheduled Actions may be delayed, so this is a useful independent monitor, not a guaranteed real-time paging service.

The release is checked on a separate `update/reliability-*` branch before advancing `main`. Existing GitHub checks run syntax/assets, Node tests and Chromium/WebKit responsive browser scenarios. Render's `npm install` also runs the offline syntax and Node tests through a guarded `postinstall`; a failure blocks the build. It does not run the app, contact the physical station or send test notifications. The guard applies only when Render sets `RENDER=true`.

The Render dashboard's separate “After CI Checks Pass” auto-deploy option is not changed by this release. This release uses a verified branch promotion plus Render build checks. Persistent-disk deployments have a short restart window.

## Operational checks after deployment

Verify the expected commit at `/healthz`, the encrypted backup workflow artifact and acknowledgment, normal current/history polling, and the maintenance/backup entries in authenticated status. On the first deployment, backups and retention can remain pending while the checkpoint is produced and uploaded and the existing archive is audited.

The retention state reports cumulative removals, the cutoff and reusable SQLite pages. A retention or backup failure is shown rather than bypassed. Low disk space is reported below 512 MiB. Resolve a failed offsite backup before relying on future recovery; the local disk copy protects against only some failure modes.
