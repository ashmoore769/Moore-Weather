# History charts

The two dashboards share `public/history.js`, `history-chart.js` and `history.css`. SVG charts are rendered locally without a CDN or chart dependency. A native dialog provides measurement, resolution, span and end-date controls. Cards refresh their trends once a minute while the page is visible. An open detail view stays still for inspection; “Latest readings” refreshes it.

## Exploring a graph

Drag the plot horizontally to pan, scroll over it or pinch to zoom, or use the Earlier/Later and +/− buttons. The existing time-span presets remain available. Navigation shows **Custom view**, the actual AEST date/time bounds and the selected resolution. **Reset view** returns to the last preset and its original end time; selecting a time-span preset returns to that span ending now. An explicit end date still selects an earlier day.

Panning keeps the chosen resolution. Zooming selects the finest supported native feed within the existing query bounds (up to 30 days of rainfall (7 days for other measurements) at ten-minute resolution, 31 days hourly and 730 days daily). Windows snap to whole hours, or whole weather days ending at 9 AM for daily data; the minimum span is one hour, or one day for daily-only measurements. No readings are fabricated. Older periods without the finer feed remain gaps and can still be viewed by selecting a coarser resolution. Scroll requests are debounced, pointer gestures fetch on release, and closing the viewer cancels pending work. The plot handles touch gestures; scroll the dialog outside the plot to move down the page.

Left/right arrows inspect readings, Home/End select the first/last reading, Shift+left/right pan, +/− zoom and 0 resets. Statistics, table and the existing fitted trend use the loaded visible window. During navigation, summary values are withheld until the new window is loaded.

After the first loaded view, the dialog retains its height until it closes or the viewport is resized. Loading and drag previews keep summary/footer/table sections in layout while hiding stale values, so the panel does not shrink or lose its scroll position. Open tables stay open and refresh with the new data. Error/retry states retain the same space.

Temperature extrema include compact AEST date/time details for their native recording period, labelled **10 min ending**, **Hour ending** or **Day ending**. The archive does not retain the exact occurrence time within that period: a daily 9 AM timestamp is the end of the weather day, not the instant the extreme occurred. Dates follow the same min/max statistic as the displayed value, ties use the earliest period, and estimates are labelled. Missing extrema have no timestamp.

Rainfall has an additional **Total rainfall** summary, calculated from the recorded native totals in the displayed range. Missing, screened and interpolated values are excluded; an incomplete record is labelled explicitly and never presented as zero rain. The note gives the exact recording-period boundaries covered by the bars, which can differ from an arbitrary preset end time. All-empty ranges show an unavailable total. Rainfall extremes identify daily/hourly/ten-minute totals; other measurements distinguish recorded extrema from extrema of native averages. Evaporation rates, bearings and temperatures are never summed.

The Current page's dark soil profile dims only decorative soil and grass layers. Reading text, coloured indicators and trend graphs retain their contrast; light mode is unchanged.

The graph dialog reserves all four `safe-area-inset` margins and uses the dynamic viewport height. Its Moore Weather header and labelled 44px Close control sit outside the scrolling content. Narrow screens give the measurement selector a full row and constrain native date-input sizing. This follows [WebKit's safe-area guidance](https://webkit.org/blog/7929/designing-websites-for-iphone-x/); simulated insets validate layout, while final installed-iPhone behavior still needs a device check.

## Daily report and freshness

`daily.css` and `daily-summary.js` provide a responsive daily report: air range, rainfall and gust highlights, atmospheric averages, sun/exposure, ground temperature, all four EnviroPro depths and battery health. Each measured tile retains its native history. The displayed reporting date and explicit 9 AM–9 AM AEST boundaries come from the received MEM1 record, independent of the viewer's timezone. A record remains the latest complete day across midnight until the next 9 AM boundary.

The page checks existing server status every 15 seconds while visible. When status reports a newly cached daily record, it reads that cache into the page. Only the explicit “Request station update” control uses the existing bounded manual-refresh route; it replaces the old hidden logo control. The current page's freshness badge now checks the displayed station timestamp as well as the server poll timestamp, and shows a failed status request as offline.

This UI pass changes neither collection scheduling nor database contents. Daily solar values have a presentation floor of zero; missing values remain unavailable. Pressure retains the existing separate Current/history conventions described below.

## Sources and interpretation

| Resolution | Native feed | Maximum query | Usual range |
| --- | --- | --- | --- |
| 10 minute | MEM3 | Rain: 30 days / 4,320 readings; others: 7 days / 1,008 readings | 24 hours |
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


### Comparing monthly rainfall

Rainfall offers **30 days** at both ten-minute and hourly resolution. That preset ends at the last completed hour so both views cover the same native recording periods. Switching between those resolutions keeps the selected duration (up to 30 days) and end time, aligned to a completed hour; panned partial hours are aligned once on switching. Archive bounds still apply independently to each feed, so compare the displayed AEST start/end and missing-reading counts when their coverage differs. Totals are calculated from each feed's own recorded values; no hourly record is divided into synthetic ten-minute readings.


### Rainfall display units and peak dates

Millimetres remain the primary stored and displayed unit. The history total and Current page's rain-since-9am card show a muted parenthesised inches conversion (25.4mm = 1 inch), rounded to two decimal places. Missing totals have no conversion; measured zero displays 0.00 in. The highest rainfall reading includes its native recording-period ending date/time in AEST. Ties use the earliest period; interpolated rainfall is excluded from recorded totals and rainfall extremes. The timestamp is not an assertion of the exact moment rain fell within that period.
