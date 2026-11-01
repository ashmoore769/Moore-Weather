# Weather and river notifications

Open **Alerts** in the station panel, choose **Enable on this device**, allow notifications, then choose **Send test**. Each device subscribes separately. On iPhone/iPad, use the installed Home Screen app on iOS/iPadOS 16.4 or later. Browser delivery and Focus settings can delay or suppress presentation.

The server checks once per minute. An outage notification is due after more than 15 minutes without a fresh, plausible R3 station timestamp. Repeated stale replies and future clock errors cannot reset that timer. One accepted notification is recorded per device per outage, followed by a recovery notice when fresh readings return. Transient provider failures retry after five minutes; expired subscriptions are removed. There is a two-minute startup grace period.

This monitors the station while the Render process runs; it does not independently monitor a Render outage. Provider acceptance is not proof that a notification was displayed on the phone.

Push keys, subscriptions and delivery state live in **station-alerts.sqlite** beside WEATHER_DB_PATH on the existing persistent disk. These private files are excluded from Git. Preserve this database together with weather data if moving the disk; the weather-only rotating backup archive does not include it. Keys are generated once and retained across deployments. No external email/SMS account or extra Render service is needed. Set WEATHER_ALERTS_ENABLED=false to disable notifications.

Authenticated subscription endpoints require a matching Origin and accept only known browser push gateways. Neither subscription keys nor endpoints appear in logs or the public config response. The service worker handles notifications only and never caches weather responses.

References: [Apple/WebKit Home Screen push requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Web Push library](https://github.com/web-push-libs/web-push).


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
