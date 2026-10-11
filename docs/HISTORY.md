# History charts

The two dashboards share `public/history.js`, `history-chart.js` and `history.css`. SVG charts are rendered locally without a CDN or chart dependency. A native dialog provides measurement, resolution, span and end-date controls. Cards refresh their trends once a minute while the page is visible. An open detail view stays still for inspection; “Latest readings” refreshes it.

## Sources and interpretation

| Resolution | Native feed | Maximum query | Usual range |
| --- | --- | --- | --- |
| 10 minute | MEM3 | 7 days / 1,008 intervals | 24 hours |
| Hourly | MEM2 | 31 days / 744 intervals | 7 days |
| Daily | MEM1 | 730 days | 30 days |

Current cards show five hours. Black globe, evaporation rate and power use hourly records because MEM3 does not contain them. Daily evaporation is a separate daily total in mm, distinct from the hourly rate in mm/h. Unsupported intervals are disabled; nothing is synthesized to make them available. All four soil depths can be chosen in the viewer, including on the Daily Summary page.

- Timestamps are interval **ends**, displayed in Australia/Brisbane (AEST). Daily points represent the 24 hours ending at 9 AM on the plotted date. The database's reporting date is the preceding date; the viewer explicitly labels the ending boundary.
- Air/soil/globe temperature, humidity, pressure and solar use recorded averages. Available daily low/high statistics form a shaded band. A maximum without a minimum (e.g. wind or solar) is shown as a dashed line. Gust uses its own maximum channel; battery uses interval minimums.
- Rain bars are interval totals, not the live card's running “since 9 AM” total. Conditional MEM4 event records are not used to infer zero rainfall.
- Bearings use the logger's AVGDIR statistic. Lines break at north rather than crossing the whole compass scale.
- The existing quality-screened view supplies values; invalid or missing intervals remain gaps. Conflicting measured records are withheld. A measured record supersedes an interpolated one. Interpolations have hollow markers and an explicit tooltip/table label. Plausible negative solar readings retain the existing zero-floor flag.
- Pressure graphs show stored logger values. The Current card's existing −1.9 hPa presentation correction is **unchanged** and explained in the viewer. No calibration, logger schedule or database values are altered by this feature. Panel-voltage graphs similarly show recorded voltage, including values hidden by the live card's night-time convention.
- “Feels like” and “globe − air” remain live derived annotations; their parent cards open measured temperature history. No historical derived series is silently invented.

## API and workload

Both routes sit behind the existing authentication middleware:

```
GET /api/trends?view=current
GET /api/trends?view=daily
GET /api/history?metric=air&resolution=10m&hours=24
GET /api/history?metric=rain&resolution=daily&hours=720&end=2026-10-10T13:59:59.999Z
```

The API accepts only named measurements, supported resolutions, bounded integer hours and an optional strict ISO UTC end timestamp. Unknown parameters, arrays and invalid dates return 400. Missing/failed storage returns a generic 503; unauthenticated requests return 401. Responses are private/no-store.

`lib/weather-history.js` matches sensor identity, native unit and aggregation across registered layouts. It first selects a bounded timestamp window using `records_time`, then reads only relevant observation fields. It does not scan the archive or contact the EW10. Windows include explicit null slots so gaps are never bridged.

`weather-history-api.js` runs reads in one read-only worker thread so chart rendering requests cannot block the polling event loop. Duplicate requests share a promise. There are at most eight outstanding jobs, 32 cached responses, a 60-second cache lifetime and a 15-second timeout. A failed worker is terminated and can restart after ten seconds. Normal recording and backups retain their existing owner and settings. No schema migration or new environment variables are needed.

## Verification

Run `node tools/check.js` and `node --test test/*.test.js`. Chart tests cover native means/totals, gaps, quality floors and outliers, the daily boundary, availability, conflicts/interpolation, bounds, compass discontinuities and concurrent recording with the read-only worker. Keep the existing importer/collector tests intact.

Browser verification uses a private copy of the local database and a mock station socket; never start another development poller against the live home station. Check both themes, phone width, both pages, table/keyboard access, earlier dates, empty history and unsupported resolutions. Check production authenticated history endpoints after Render's normal automatic deployment.
