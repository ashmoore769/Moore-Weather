# Dashboard refinements, October 2026

Current station, soil and power previews use 12 hours. The history viewer starts
at 12 hours for current weather and keeps selectable shorter/longer ranges.
Daily Summary keeps 30 days. River cards keep 7 days and Leslie keeps 30 days.

The shared header orders Current Readings, Forecast, Daily Summary, Trends.
Current is shortened on phones. Forecast links to the Current page's Trends
dialog. Analytics links to the owner's login-protected Umami dashboard.

Camera and radar viewing areas use 4:3. The direction badge describes the camera
as approximately south-facing; it does not claim a surveyed compass bearing.

Connolly Dam is sourced from Southern Downs Regional Council's published table:
https://www.sdrc.qld.gov.au/living-here/environment-water-waste/dam-levels

This is a periodic council report, not a live telemetry API. Collection checks
every six hours through the existing background worker. It validates column
identity, report date and agreement between percent, volume and capacity.
Failures keep existing readings and retry with backoff. Older cached reports
are rejected. The same report date updates the same SQLite records; fetching
does not create new observations. No schema migration or existing data removal
is needed. Both percentage and ML have independent history.

Only actual report dates are graphed. No hourly or intervening daily values are
invented. Dates have no invented time of day in the UI. History grows from
collected reports. The tile links to council and displays its publication date.
A report older than 14 days is labelled as awaiting a newer report.

Wide screens show Scots, Warwick, Leslie, Connolly. Medium screens show the
rivers above the two dams; phones keep Warwick first, followed by both dams
and Scots. Routine successful-collection footer text is hidden; meaningful
delays and collection failures remain visible.

Validation: offline unit tests, Chromium/WebKit responsive checks, analytics
checks with collection intercepted, and an explicit read-only council source
probe on the update branch. Never start server.js during local validation: it
connects to the physical station.
