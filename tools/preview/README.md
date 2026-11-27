# GUI preview fixtures

`tools/gui-preview.mjs` serves the real `public/` frontend and local representative sample data. It never imports the production server, reads credentials, opens a database, or connects to the station. Non-read requests return HTTP 405.

Set the development entry point to `node tools/gui-preview.mjs`, then use the managed preview service. The preview accepts `--port` and `--host`; `PORT` takes precedence over the port flag. Without a host flag it listens on `0.0.0.0`. A busy port fails rather than silently choosing another port.

Available page query modes, persisted in a preview-only cookie:

- `?preview=healthy`: fresh observations with power readings following current AEST daylight.
- `?preview=day`: fresh home solar exporting power.
- `?preview=night`: fresh home solar importing power.
- `?preview=stale`: a 38-hour station/power delay and stale forecast.
- `?preview=partial`: unavailable globe/soil sensors, history gaps, and a missing solar load reading.
- `?preview=unavailable`: unavailable live inputs and empty weather histories.
- `?preview=long`: the exact current-reading defaults and long-value overrides from the dashboard CI overflow regression, including 225 mm rainfall and 1399.9 W/m² solar radiation.

The on-screen preview badge identifies sample data. Camera frames are explicitly labelled illustrations. The radar overlay is synthetic, served locally by a preview-only response transformation; OpenStreetMap base tiles retain the public URL used by the production frontend. External font, Leaflet, and map assets remain normal frontend dependencies.

The current page, Daily Summary, forecast, history, station power, Home Solar, Yard Power, water, SkyCam controls, and health dialogs have fixture endpoints. Alerts are intentionally disabled in this read-only preview. Current and daily feeds use the real CSV parser contracts; histories reuse the production metric catalog without opening any storage. Solar energy totals use the production pure integration function over synthetic measurements. Stale and unavailable states do not invent current-day solar totals.
