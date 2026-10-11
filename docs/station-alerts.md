# Station notifications

Open **Station alerts** in the station panel, choose **Enable on this device**, allow notifications, then choose **Send test**. Each device subscribes separately. On iPhone/iPad, use the installed Home Screen app on iOS/iPadOS 16.4 or later. Browser delivery and Focus settings can delay or suppress presentation.

The server checks once per minute. An outage notification is due after more than 15 minutes without a fresh, plausible R3 station timestamp. Repeated stale replies and future clock errors cannot reset that timer. One accepted notification is recorded per device per outage, followed by a recovery notice when fresh readings return. Transient provider failures retry after five minutes; expired subscriptions are removed. There is a two-minute startup grace period.

This monitors the station while the Render process runs; it does not independently monitor a Render outage. Provider acceptance is not proof that a notification was displayed on the phone.

Push keys, subscriptions and delivery state live in **station-alerts.sqlite** beside WEATHER_DB_PATH on the existing persistent disk. These private files are excluded from Git. Preserve this database together with weather data if moving the disk; the weather-only rotating backup archive does not include it. Keys are generated once and retained across deployments. No external email/SMS account or extra Render service is needed. Set WEATHER_ALERTS_ENABLED=false to disable notifications.

Authenticated subscription endpoints require a matching Origin and accept only known browser push gateways. Neither subscription keys nor endpoints appear in logs or the public config response. The service worker handles notifications only and never caches weather responses.

References: [Apple/WebKit Home Screen push requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Web Push library](https://github.com/web-push-libs/web-push).
