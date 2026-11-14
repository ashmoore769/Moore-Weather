# Weather, solar and river notifications

Open **Alerts** in the station panel, choose **Enable on this device**, allow notifications, then choose **Send test**. Each device subscribes separately. On iPhone/iPad, use the installed Home Screen app on iOS/iPadOS 16.4 or later. Browser delivery and Focus settings can delay or suppress presentation.

The server checks once per minute. An outage notification is due after more than 15 minutes without a fresh, plausible R3 station timestamp. Repeated stale replies and future clock errors cannot reset that timer. One accepted notification is recorded per device per outage, followed by a recovery notice when fresh readings return. Transient provider failures retry after five minutes; expired subscriptions are removed. There is a two-minute startup grace period.

This monitors the station while the Render process runs; it does not independently monitor a Render outage. Provider acceptance is not proof that a notification was displayed on the phone.

Push keys, subscriptions and delivery state live in **station-alerts.sqlite** beside WEATHER_DB_PATH on the existing persistent disk. These private files are excluded from Git. Version 1.1 includes this database in the complete encrypted recovery bundle alongside weather data and access requests; earlier weather-only backups do not include it. Keys are generated once and retained across deployments. No external email/SMS account or extra Render service is needed. Set WEATHER_ALERTS_ENABLED=false to disable notifications. See [recovery instructions](RELIABILITY-UPDATE.md) before moving or restoring the disk.

Authenticated subscription endpoints require a matching Origin and accept only known browser push gateways. Neither subscription keys nor endpoints appear in logs or the public config response. The service worker handles notifications only and never caches weather responses.

References: [Apple/WebKit Home Screen push requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Web Push library](https://github.com/web-push-libs/web-push).

## Daily home solar crossovers

Devices with alerts enabled also receive up to two home solar notifications per
**Australia/Brisbane calendar day**. Existing subscriptions and permissions are
reused. There is no Pi update, additional inverter request or separate scheduled
cloud job: the minute monitor reads the latest saved Fronius sample.

| Notification | Confirmation rule |
| --- | --- |
| **House is now running on solar** | Between **05:00 and 15:00 AEST**, AC generation exceeds house use by at least **100 W** for at least **two minutes**, with at least three distinct fresh samples. |
| **House is now using grid power** | From **15:00 AEST**, grid import and the AC generation shortfall are at least **100 W** for at least **ten minutes**, with at least eleven distinct fresh samples. Solar coverage must have been confirmed earlier that day. |

The morning event stays latched for the day, so later cloud cover or appliance
loads cannot generate another morning notice. The evening notice is the first
sustained qualifying afternoon/evening deficit; it cannot predict whether solar
will cover the house again later. Each device receives at most one accepted
notification in each direction that day. A day without confirmed solar coverage
does not produce a misleading evening crossover.

If monitoring first starts after 15:00, a fresh, sustained solar surplus can arm
the evening detection without sending a late morning notification. State and
per-device accepted deliveries survive server restarts. Delivery retries remain
bounded and require a fresh condition that still warrants the notice; old events
are not replayed as current crossovers.

The monitor uses AC inverter output, house consumption and the grid meter.
Repeated timestamps cannot satisfy the confirmation period, and missing, stale or
invalid readings reset an unconfirmed candidate. It withholds source-attribution
alerts while an active battery makes the simple solar/grid interpretation
ambiguous. Ordinary grid imports during the middle of the day do not send an
evening notification.

Solar uses its own Web Push topic and a daily event tag, independently of station,
history and river notifications. Tapping opens **Home solar**. Opening the updated
app refreshes the notification worker; an existing subscription needs no new
permission prompt. Provider acceptance does not establish that iOS displayed the
notification.

All transport topics are encoded as stable, canonical 32-character Base64url
values before sending. This includes solar and river topics, so provider topic
validation cannot reject a logical label because of its encoding. A failed
delivery log identifies the notification type, HTTP status and a recognised
provider reason when available; it never includes raw responses, subscription
endpoints or keys. Daily accepted-delivery state and retry limits are unchanged.

Set `SOLAR_ALERTS_ENABLED=false` to disable only solar crossover notifications.
The feature also stays inactive when solar collection is disabled or unavailable.

## Planned nightly modem pause

The station's owner-confirmed setting is `MODEMTIME HOUR 5 1435 1`: the Elfin's
switched supply is scheduled on at **05:00 AEST** for **1,435 minutes**, leaving a
five-minute pause from **04:55 to 05:00** each day. Station freshness notifications
allow a further **five minutes for reconnection**, through **05:05 AEST**.

That planned pause and grace are ordinarily shorter than the existing
fifteen-minute stale threshold, so a normal five-minute restart was already
expected to stay quiet. Nightly notifications can indicate a longer interruption;
this allowance does not conceal those overruns.

Only an outage attributable to that planned pause is suppressed. A genuine
incident that began before the window retains its alert and recovery handling.
The policy does not change the last good observation, fabricate fresh readings,
or hide the dashboard's actual age/stale status. River and solar monitoring remain
independent.

Saved-history warnings share the same **04:55–05:05 AEST** allowance when every
affected periodic feed first became overdue during that window. For example, a
03:00 hourly record can briefly cross its two-hour threshold at 05:00 after the
04:56 download was blocked by the modem pause. If the retry catches up before
05:05, no warning or recovery notification is sent. If it remains overdue at
05:05, the warning is eligible immediately. Earlier incidents, missing or invalid
record times, unavailable storage and overdue daily records remain alertable.

If the station remains offline beyond the allowance, the normal **more than
15 minutes since the last fresh observation** rule applies. The end of the grace
period does not start a new fifteen-minute timer. A recovery notice is sent only
to a device that received the corresponding genuine outage warning, so the normal
scheduled pause does not create a needless back-online notification.

The authenticated alert configuration exposes the active schedule and grace
period for the Alerts panel, without exposing subscriptions or private keys.
Set `WEATHER_PLANNED_MODEM_OUTAGE_ENABLED=false` if this station schedule is
removed. Changing the logger's actual MODEMTIME setting requires updating the
notification policy separately; this release sends no logger commands.


## Warwick bridge references

Devices with alerts enabled also receive Warwick river notifications, using the saved native BOM **041534** observation and the published **7.00m McCahon Bridge gauge reference**:

- Near reference: river level **6.50m or higher**, while still below 7.00m.
- Reference reached: river level **7.00m or higher**.
- Each threshold is sent once per device per event. Both re-arm only after a newer reading falls **below 6.00m** (more than 1m below the reference).
- If the first observed level is already at/above 7.00m, send only the stronger notice. A device enabling alerts during an event receives the currently applicable warning.

The minute monitor reads the existing SQLite archive through the history worker. It creates no extra BOM requests or station connections. The latest native observation, including a null value, is selected; a missing latest sample cannot fall back to an earlier high. Both the observation and the last successful BOM fetch must be no older than **30 minutes**, with future timestamps rejected. Disabled/failed collection and older or revised timestamps cannot re-arm an event. The collector's normal ten-minute cadence and BOM's publication timing determine detection latency.

Bridge state and per-device accepted deliveries/retry times persist in station-alerts.sqlite, independently of station outage alerts. A failed near warning cannot delay a bridge-crossing notice. Transient failures retry after five minutes only while a fresh reading still warrants that notification. Separate push topics prevent station notices from replacing river notices; stable event tags reduce duplicate presentation if a network acknowledgement is lost. No synthetic notification is sent during deployment or automated tests.

Notifications include the observed level, observation time in AEST and the named bridge reference. Tapping opens the water cards. Delivery depends on the device and push provider; these are reference-level notifications, not road closure information or O. O. Madsen Bridge measurements.

## Saved-history safeguards

Live R3 readings and saved history are monitored independently. A responding
station can still have stopped recording its memories. The monitor reads the
latest native MEM3, MEM2 and MEM1 record timestamps from the existing weather
database once per minute. Repeated downloads, fresh R3 readings, estimated
records and transfer success times cannot reset the history clock. It adds no
station connections or remote commands. Conditional MEM4 rain events are excluded:
no rain is a valid reason for no new event records.

- Ten-minute history: warn after more than 30 minutes without a saved record.
- Hourly history: warn after more than two hours without a saved record.
- Daily history: expect the 09:00 AEST record by 09:30 AEST.
- Missing records, invalid/future timestamps and an unavailable history database
  also need attention; a missing or failed check cannot announce recovery.

All affected feeds are grouped in one warning per subscribed device. While any
feed is overdue, successful reminders repeat every 15 minutes without a daily
cap. Once all three are current, devices that received the warning get one
recovery notice and reminders stop. There is a two-minute startup grace period;
outage identity, successful deliveries, reminder timing and five-minute provider
retry delays persist in station-alerts.sqlite. A restart does not create a new
incident or reset its reminder interval. A new subscription during an incident
gets the current warning. Unsubscribing removes all weather, river and history
deliveries for that device.

The warning identifies the currently overdue feed and its last saved AEST time.
Older archive gaps remain visible in Saved history and are not included as newly
missing records in the push text.

History uses a separate Web Push topic from live station and river alerts. Its
stable incident tag and renotify option request renewed notification presentation
for reminders while replacing the previous history status where supported.
Existing enabled devices receive history alerts automatically. Opening the updated
app refreshes the notification worker; no new permission request is made.
OS notification permissions, Focus modes and provider delivery still apply.

Current, Daily Summary and Forecast show an amber saved-history warning whenever
records are overdue, even without push permission. Alerts shows each feed's last
saved time in AEST. Tapping a history notification opens these details. The
authenticated /api/alerts/history route contains only health and record times;
it exposes no subscriptions or keys. Its snapshot is cached for at most 30 seconds,
and visible pages refresh it every minute. This service still cannot alert while
the Render process itself is unavailable.
