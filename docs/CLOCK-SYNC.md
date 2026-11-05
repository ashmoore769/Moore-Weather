# Station clock synchronisation

Moore Weather 1.1.1 checks the station's own `TIME` reply against the server clock in Brisbane AEST (UTC+10). It does not infer clock drift from the age of a cached weather report.

## Schedule and commands

The check runs at startup, before the first Current poll, then at **06:05 and 18:05 Australia/Brisbane**. All clock commands share the existing station transaction queue with Current, Daily and memory collection. A complete read, correction and verification stays together in that queue.

1. Send `TIME` and parse exactly one valid `YYYY/MM/DD HH:MM:SS` response, allowing the normal command echo and prompt.
2. Compare the station time with the midpoint between sending the command and receiving its reply. The reply has one-second precision. Reads taking more than three seconds, or showing an inconsistent server-clock change during the transaction, cannot authorise a correction.
3. If the difference is at most five seconds, record a successful check and leave the station alone.
4. Otherwise, calculate `SETTIME HH MM SS` from the current server time when the queued TCP connection is actually ready. No time prepared before the queue or connection wait is used.
5. Read `TIME` again. Only a fresh result within five seconds confirms synchronisation. A successful write or echoed command alone is insufficient.

Each connection has an eight-second total deadline and a 2 KiB response limit. A failed check gets at most two additional checks five minutes apart before returning to the fixed schedule. A recorded correction attempt imposes a 15-minute cooldown on further writes, including after a restart while that attempt is pending. Normal weather polling continues after a clock-check failure.

## Clock and archive boundaries

Automatic correction is limited to five minutes in either direction and requires the station and server to have the same Brisbane calendar date. The server does not send a date-setting command. Corrections are deferred within two minutes of midnight or the 09:00 daily boundary, and a step across 09:00 is refused even when both endpoints are outside that window. These conditions are reported in clock health and the logs.

Before any `SETTIME` write, the server durably records the intended old and new times in the weather database. If that commit takes more than one second, the prepared command is withheld rather than sending an outdated target. A successful subsequent `TIME` check marks the intent verified. A recent pending intent can also be verified after a connection failure or restart when a fresh read confirms the correct clock. If enabled database storage cannot record the intent, no correction is sent.

A backward adjustment can put a conditional rainfall memory tail out of timestamp order. The importer accepts a reversal only when it fits a verified, bounded correction window for this station, and permits at most one reversal per correction in a response. Unexplained reversals remain rejected. The original capture bytes and line numbers remain untouched; no observation timestamp or measurement is rewritten. Correction windows remain available for sparse memory tails after restart, rather than expiring before those records leave the logger.

Existing historical gaps are unaffected. Synchronising the clock cannot recreate records missing from the replaced station boards. A code rollback also does not reverse a physical clock correction; the correction journal remains in the additive database table.

## Configuration and status

Clock management is enabled by default on Render. `WEATHER_CLOCK_SYNC_ENABLED=false` disables it. Local development is disabled by default and requires an explicit `WEATHER_CLOCK_SYNC_ENABLED=true` to permit station clock writes. Automated tests inject fake transports and never contact the station.

The authenticated Alerts system-health panel reports the last measured drift and verification time. `/api/system-health` and `/ping` also include clock status; the public health endpoint continues to expose only overall healthy/degraded status. Failed clock checks appear in monitoring after startup grace.

Look for `[CLOCK] TIME checked`, `[CLOCK] Sending SETTIME`, and `[CLOCK] Synchronisation verified by TIME` in Render logs to verify a real correction. An already accurate clock instead logs that no SETTIME was needed. Check subsequent `[CURRENT]` observations to confirm both fresh timestamps and uninterrupted collection.

## Current-page refresh

Current checks the cached server status every 15 seconds and fetches `/weather` when a different observation is available. Other pages retain their 30-second status check. Only successful rendering changes the badge and displayed timestamp. This also handles a legitimate backward correction. A 60-second fallback remains, with the existing timeout and retry backoff. Both HTTP endpoints serve cached server data, so this does not add physical station polls. The shorter cache check leaves room for normal communication time within the unchanged 90-second Live threshold.
