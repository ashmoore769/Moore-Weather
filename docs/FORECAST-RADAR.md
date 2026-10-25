# Free forecast and radar

The Forecast tab at `/forecast.html` adds a seven-day Warwick outlook, prominent rain probability and daily rainfall estimates, selectable days, the next 24 hours (or the selected day's hours), and hourly rain, temperature and wind. The regional radar animation lives on Current, directly below the SkyCam, with the same embedded presentation. On phones the order is readings, SkyCam, radar, soil, local water and station power. Desktop pairs readings and soil with the two visuals; local water and a compact power strip follow. The Forecast header links to Current’s radar, and old `/forecast.html#radar` bookmarks redirect there. Daily Summary and history remain available.

## Providers and cost

No paid account, API key, new Render resource or configuration change is required.

- Open-Meteo: `https://api.open-meteo.com/v1/forecast`, free non-commercial service, with visible Open-Meteo and CC BY 4.0 attribution. This is model guidance, not Elders/Weatherzone's forecast.
- RainViewer: `https://api.rainviewer.com/public/weather-maps.json`, free personal/community API, with visible RainViewer and BOM source credit. Only past radar is used: up to 13 frames over two hours in ten-minute steps. Image URLs use the API-supplied host and opaque frame path, never a guessed timestamp path.
- OpenStreetMap: standard browser tiles with visible contributor attribution, normal HTTP caching and an origin Referer. No background downloading, offline map storage or tile prefetching.
- Leaflet 1.9.4: vendored locally under `public/vendor/leaflet`, including its BSD-2-Clause licence and images. No CDN script dependency or added npm production dependency.

The map carries its rain-intensity legend at the top left and centre/refresh controls at the top right. A compact footer keeps frame freshness and linked RainViewer/BOM credits visible; OpenStreetMap attribution remains on the map. Coverage and timing notes are available from the information button.

The radar uses a single 512px, coordinate-centred native-zoom-7 image per frame, projected onto its Web Mercator bounds. The viewport stays inside this regional footprint; enlarging it adds no radar detail. Uncached frame requests are spaced by at least one second, playback starts only on request and stops while hidden. The background map alone is never presented as proof of dry weather. The RainViewer palette's name is “Universal Blue”; its intense returns also include yellow and red. Free providers do not guarantee availability.

Provider references checked 25 October 2026:
- https://open-meteo.com/en/docs
- https://open-meteo.com/en/terms
- https://www.rainviewer.com/api/weather-maps-api.html
- https://www.rainviewer.com/api/transition-faq.html
- https://www.rainviewer.com/api/color-schemes.html
- https://operations.osmfoundation.org/policies/tiles/

## Data boundaries and reliability

`lib/forecast-service.js` mounts `/api/forecast` and `/api/radar` after the existing authentication middleware. Neither feed starts a timer or contacts a provider until an authenticated visitor requests it. No station connection, database write, schema migration or observation-history change is involved.

The forecast is centred on Warwick town (-28.22, 152.03), labelled “Warwick area”, and uses metric units and Australia/Brisbane timestamps. Forecast days run midnight to midnight, separately from station summaries' 9 am boundary. Daily rainfall is a full-day estimate, not the remaining rain from the current time. Forecast fetch time is labelled as such; it is not claimed to be a model issue time. Null measurements remain missing rather than becoming zero.

All visitors share a 20-minute forecast cache and five-minute radar manifest cache. In-flight requests are coalesced. Upstream requests time out after 12 seconds and responses are capped at 512 KiB. Failures back off for one minute, including cold-cache failures. Forecasts can remain explicitly stale for up to six hours after collection. Radar manifest fallback is limited to one hour, and radar whose latest frame is over two hours old is rejected. Successful retrieval of an old radar feed still produces a delayed status. Caches are memory-only and naturally reset on deployment.

The browser shows AEST independently of the visitor's timezone. It retains useful data during a failed refresh, exposes retry controls and displays separate feed errors. Forecast and radar failures are independent. Browser clients stop automatic work while hidden; radar never autoplays.

## Verification

- Existing offline test suite plus eight new service tests: metric/timezone contract, nulls/zero, invalid data, concurrent cache refresh, failed refresh/backoff, expiry, radar URL restrictions and feed independence.
- Authentication checks now include the Forecast page and both new API endpoints. No production credentials are used in tests.
- Live read-only provider requests returned seven daily rows, 168 hourly rows and 13 radar frames.
- Isolated browser preview uses these real responses without starting `server.js`, station polling, database collectors or email delivery. Checks cover small/large widths, themes, day selection, hourly detail, radar controls and forecast outage/recovery.

Publish all changes together. Render's existing `main` auto-deploy remains the rollout mechanism. No settings, secrets, paid plans or disk contents need changing. Reverting the code commit removes this feature without altering recorded observations.
