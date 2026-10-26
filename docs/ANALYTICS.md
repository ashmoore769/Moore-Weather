# Moore Weather usage analytics

Umami Cloud website ID: `cc26784e-27b2-48ef-80d6-a6da05212489`.
Owner dashboard: https://cloud.umami.is/ (sign in using the owner's Umami account).
No API key, paid plan, new server, or database migration is needed. This public
tracking ID does not grant access to the dashboard. Do not enable a public share
URL unless the owner explicitly wants to share statistics.

## Collection

`public/analytics.js` loads the supplied official
`https://cloud.umami.is/script.js` asynchronously on the production hostname only.
It is included on Current, Daily Summary, Forecast, sign-in, and Help. The loader
is a public branding/support asset; private weather pages stay behind the
existing authentication middleware.

Manual pageviews prevent duplicate automatic pageviews. `/index.html` is grouped
with `/`; `/login.html` is grouped with `/login`. Back-forward cache restoration
starts a new pageview. No analytics runs on local servers, preview hosts, unknown
paths, or excluded browsers.

The owner can view pageviews, visits, estimated visitors, device/browser summaries,
approximate geographic locations, and referrers in Umami. Set the dashboard time
zone to Australia/Brisbane when comparing usage with weather observations.
Analytics begins at deployment; past visits cannot be reconstructed.

## Feature events

- `history-open`: a chart was requested; `measurement` identifies rain, river,
  dam, soil, or another allowed weather parameter.
- `history-measurement`: a different measurement was selected in an open chart.
- `skycam-timelapse`, `skycam-history`, `skycam-download`, `skycam-enlarge`,
  `skycam-live`: the corresponding SkyCam control was used.
- `radar-playback`, `radar-timeline`, `radar-reset`, `radar-refresh`,
  `radar-latest`: a radar control was used.
- `forecast-refresh`, `alerts-open`, `install-prompt`: the corresponding control
  was used.
- `visible-time`: numeric `seconds` spent with this page visible. Sum the
  `seconds` property to get measured foreground time, and divide by 60 for minutes.
  These are incremental chunks, not cumulative totals.

Control events measure use/intent, not confirmation that a download, installation,
notification subscription or data request succeeded. Fast repeated taps are
deduplicated for 1.5 seconds. Rainfall and river values, selected dates, map
coordinates, and form contents are not analytics properties.

## Time spent

A lightweight timer counts only visible intervals. It sends a time chunk every
five minutes and on visibility loss/page exit. This limits event volume on a
live dashboard. Background time and long timer gaps caused by sleep/suspension
are excluded; a restored page resumes normally. Time is approximate and may be
undercounted if the browser closes abruptly, blocks delivery, or suspends timers.
Visible time is not proof of a person's attention. Multiple visible tabs may
overlap; totals represent page-visible time, not unique person-minutes.
Umami's standard visit-duration metric is separate and based on event timestamps.
Neither every API poll nor every radar animation frame becomes an event.

## Excluding a device

Open **Help → Usage statistics & privacy → Exclude this browser from statistics**:
https://moore-weather.onrender.com/help.html#usage-statistics

The control stores Umami's standard `umami.disabled` flag. It stops collection
immediately and persists across reloads. Repeat on each browser/device and in the
installed home-screen app when it uses separate storage. Clearing website data
resets the choice. Already-recorded visits are not deleted. The setting is available
to all visitors, so they may also opt out. If storage is unavailable, the page
clearly explains that the change could not be saved.

The integration also respects available Do Not Track and Global Privacy Control
signals. The help control cannot override those browser privacy preferences.

## Data minimisation

A before-send allowlist strips query strings, fragments, form values, arbitrary
properties and user identifiers from every outgoing payload. Page titles are
static; internal referrers use only known page paths and external referrers retain
only the origin. Passwords, access-request names/emails, weather values, and
notification subscriptions are never passed into tracking calls. No session replay,
heatmaps, form tracking, custom visitor IDs or precise-location permission is used.

Umami receives the network information required for its service, including the
request IP and browser user agent, and derives approximate locations/visitor
estimates. It does not provide exact addresses or verified identities. IP-based
location may reflect a mobile carrier or VPN exit. See https://umami.is/privacy
and https://docs.umami.is/docs/metric-definitions for provider processing details.

An unavailable or blocked tracker must not affect weather, login, forms or charts.
The application catches failed sends and keeps a bounded pre-load feature queue.

## Validation

`npm run check` and `npm test` include privacy, visibility timing, exclusion,
failure handling and page-mirror checks. `node tools/check-analytics.cjs` tests
Chromium and WebKit using the official public SDK, while intercepting every
collection request locally. It sends no fake visits into the owner's dashboard.
The existing dashboard browser fixture verifies the real rainfall and river chart
hooks alongside layout and data behavior. No test starts `server.js` or contacts
the physical station.

CI uses the matching official Playwright Docker image with browsers and system
dependencies already installed, avoiding repeated slow Ubuntu package downloads.
The package version and image version must remain matched.
