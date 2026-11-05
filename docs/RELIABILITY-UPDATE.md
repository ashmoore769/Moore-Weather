# Moore Weather 1.1 reliability release

Version 1.1.2 adds verified Brisbane station-clock synchronisation at startup and twice daily, plus prompt Current-page refresh when the server cache changes. See [Station clock synchronisation](CLOCK-SYNC.md) for the commands, bounded correction policy, archive handling and live verification steps.

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

The worker checks available disk space and uses SQLite's online backup API so committed WAL data is included. It compacts each staged snapshot with `VACUUM INTO` a second file inside its private temporary directory, then checks integrity and foreign keys, hashes, compresses and encrypts a streaming bundle with AES-256-GCM. Compaction operates only on the backup copy and removes unused pages that would otherwise retain deleted payload in later backups. It never vacuums the live database. The worker authenticates the completed ciphertext before publishing the bundle. Each encrypted manifest includes per-database size and SHA-256 checksums. Normal completed local copies rotate to three; the original pre-retention checkpoint and owner-managed or legacy backup files are not removed.

Recovery creation has a bounded 20-minute worker deadline. The workflow allows 25 minutes for deployment readiness and download/retries, with each export response wait capped at 20 minutes, and 40 minutes for the complete backup job so upload and acknowledgement have additional time. Before exporting, it requires `/healthz` to report the exact workflow commit. A superseded or failed deployment cannot silently acknowledge through an older app version; its waiting period is bounded. These limits allow for the existing live weather-only backup's observed completion time of approximately 12 minutes, plus the complete bundle's additional verification and encryption work. They do not promise a fixed completion time: a worker that exceeds its limit is terminated, owned temporary files are cleaned, and retention stays blocked without a verified offsite checkpoint.

The key comes from `WEATHER_BACKUP_ENCRYPTION_KEY` when set, otherwise the existing `MOORE_AUTH_COOKIE_SECRET`. A domain-separated HKDF derivation and random salt/IV are used for every bundle. **Keep the original encryption secret in the owner's password manager before rotating it.** The secret stays in Render and is never sent to GitHub. The database disk and backup artifact alone cannot recover it. Render environment configuration is not itself included in the bundle.

`.github/workflows/backups.yml` runs daily and after main-branch pushes. It downloads only encrypted `.mwb` bytes, verifies the transport checksum, stores the copy as an asset in the dedicated **unpublished draft release** `moore-weather-recovery`, and verifies GitHub's immutable asset SHA-256 digest and byte count before acknowledging successful storage. An already stored copy with the same checksum is verified and reused. The draft is never published by this workflow. Open the repository's Releases page with the owner's GitHub account to find these recovery copies; the receipt described below identifies the release, asset and checksum.

The workflow uses short-lived GitHub OIDC identity to obtain the encrypted copy from Render. No static login password or new repository secret is required. The server accepts only the original numeric repository/owner identity, `main`, and this specific workflow. Forks, pull-request events, other workflows, expired tokens and wrong audiences are rejected. The endpoint cannot choose arbitrary files or export plaintext. GitHub's short-lived repository token uploads the ciphertext; the encryption secret stays on Render.

The checkpoint's offsite acknowledgement must be renewed within 28 days. While it is missing or expired, cleanup remains blocked and the next successful workflow verifies or uploads the **same original checkpoint**, then renews its acknowledgement. This preserves the original archive separately from later copies of the pruned database. The release assets do not have the Actions artifact expiry policy; the 28-day gate provides periodic re-verification. The workflow handles one bundle per run, so its checkpoint-renewal run replaces that day's ordinary offsite copy. Assuming surrounding daily runs succeed, the ordinary offsite recovery point can approach 48 hours old until the following run. Delayed or failed workflows can extend that interval and appear in backup/monitoring status.

The first production checkpoint was 266,236,411 bytes, approximately 254 MiB. Two such copies would exceed GitHub Free's published 500 MB Actions artifact allowance, so ongoing recovery copies use release assets instead of Actions test artifacts. [GitHub documents](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas) a limit of fewer than 2 GiB per release asset, with no total release-size limit. The uploader rejects oversized files before upload. The app retains the original checkpoint and up to three newest ordinary offsite copies, keeping its storage use bounded. No paid plan or billing setting is changed. The original Actions checkpoint is left intact until its existing 30-day expiry; new copies do not consume that artifact allowance.

Rotation runs only after successful storage, server acknowledgement and receipt creation. It recognizes strict `encrypted-recovery-{checkpoint|daily}-{sha256}.mwb` names and validates the dedicated draft, asset digest, metadata and bounded complete inventory before deleting old ordinary copies. It preserves checkpoint assets and unrelated assets. Other releases, CI artifacts, manual exports and repository files are untouched. An upload failure leaves existing recovery copies intact and must be resolved before relying on later backups.

Recovery files remain encrypted even in the unpublished draft: do not add plaintext exports, environment dumps or recovery keys to the workflow. GitHub availability and schedule execution are not a permanent archival guarantee. Save an occasional encrypted bundle and its original key separately for longer-term recovery.

### Backup receipts and scheduled workflows

GitHub's [scheduled-workflow documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) says scheduled workflows in public repositories are automatically disabled after 60 days without repository activity. It also notes that schedules run from the default branch and may be delayed or dropped under load.

After an encrypted copy is stored and its acknowledgement succeeds, a separate job records `latest.json` on the dedicated `recovery-receipts` branch. The receipt contains only the storage provider, release/asset and workflow run identifiers, ciphertext SHA-256 and size, backup creation time, and receipt time. Its commit history preserves earlier receipts, including the first Actions artifact receipt. The first commit has no parents, so this branch does not copy the app's files. Subsequent updates change only `latest.json`, preserve other files on that branch, and advance the branch by fast-forward only; `main` is never changed. A failed or cancelled backup produces no receipt.

The backup job has `contents: write` for draft-release asset storage and `id-token: write` for Render's workflow authentication. The separate receipt/rotation job has `contents: write` and `id-token: none`; it receives only validated metadata and downloads no backup. It records the receipt and removes only older matching daily assets. No Actions write permission is needed. These tools send the short-lived `GITHUB_TOKEN` only to GitHub's fixed API/upload hosts. The checkout does not persist credentials. [GitHub documents](https://docs.github.com/en/actions/concepts/security/github_token) that pushes using this token do not start further push-triggered workflow runs.

These receipt commits create a useful audit trail and are intended to prevent an otherwise finished application from becoming inactive. GitHub does not fully document which automated or non-default-branch activity resets its inactivity timer, so continued schedule execution must still be checked. If GitHub disables a schedule, use its [workflow enable controls](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows), then run the backup manually and confirm the stored copy and matching receipt. A receipt records verification at that time; it cannot guarantee that a person or provider will never remove a recovery copy later.

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

Older archive gaps and routine coverage checks stay in the Alerts panel, with a compact Alerts indicator for unresolved gaps. They do not display a large dashboard banner when current history feeds are up to date. The banner remains available for an active history-feed delay or an unavailable status check.

Current and Daily station transactions have a 15-second total deadline and a 16 KiB response limit, in addition to the socket inactivity timeout. A peer that keeps trickling bytes cannot hold the shared station queue indefinitely. Repeated minute ticks share one current-poll retry chain. Invalid/future timestamps are retained as evidence but cannot replace the displayed cache.

## Monitoring and release gates

`/healthz` is a public process liveness endpoint returning only release identity and `ok`. `/health/monitor` returns only `ok` or `degraded` with HTTP 200/503; it exposes no readings, subscriber information, storage paths or credentials. It checks current collection, database/storage and recovery/retention readiness with a short startup grace. Authenticated `/api/system-health` and the Alerts panel provide detailed operational status.

`.github/workflows/monitor.yml` checks the live app independently about every 15 minutes, with retries for brief network failures. Failures appear as failed Actions runs. Delivery of GitHub's email/web notifications depends on the owner's GitHub notification settings. Scheduled Actions may be delayed, so this is a useful independent monitor, not a guaranteed real-time paging service.

The release is checked on a separate `update/reliability-*` branch before advancing `main`. Existing GitHub checks run syntax/assets, Node tests and Chromium/WebKit responsive browser scenarios. Render's `npm install` also runs the offline syntax and Node tests through a guarded `postinstall`; a failure blocks the build. It does not run the app, contact the physical station or send test notifications. The guard applies only when Render sets `RENDER=true`.

The Render dashboard's separate “After CI Checks Pass” auto-deploy option is not changed by this release. This release uses a verified branch promotion plus Render build checks. Persistent-disk deployments have a short restart window.

## Operational checks after deployment

Verify the expected commit at `/healthz`, the encrypted backup workflow's draft-release asset and acknowledgement, normal current/history polling, and the maintenance/backup entries in authenticated status. On the first deployment, backups and retention can remain pending while the checkpoint is produced and uploaded and the existing archive is audited.

The retention state reports cumulative removals, the cutoff and reusable SQLite pages. A retention or backup failure is shown rather than bypassed. Low disk space is reported below 512 MiB. Resolve a failed offsite backup before relying on future recovery; the local disk copy protects against only some failure modes.
