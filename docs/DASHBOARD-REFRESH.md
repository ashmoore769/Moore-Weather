# Dashboard refresh and access requests

This update is based on main commit `6b38602d7db27ebf995e706aae454c4984d20c2b` (Leslie Dam).

## Changes

- Shared darker navy surfaces and restrained top accents across the current and daily dashboards; a shorter masthead groups the station identity, observation time and status.
- Rainfall takes the previous pressure position. Station power becomes a compact two-by-two group with one shared five-hour trend caption. Desktop columns place power below the current readings and soil below SkyCam; the existing mobile section order is preserved.
- Ground temperature becomes the first aligned soil row above 10 cm, with no moisture reading added. The four existing probe channels, illustrations and their darker night appearance remain.
- History navigation stops at the first usable database period for each measurement and resolution. Bounds refresh as imports extend the archive. “All available history” fits the stored periods when they fit the resolution's query limit, including the first rainfall total. Recent missing periods remain visible.
- Water graph extrema retain their source dates even when a wide view groups multiple days. River and sampled dam extrema show their actual observation times. Official Sunwater daily minima/maxima show a date only because the source does not supply an occurrence time. Native weather extrema still identify their recording period rather than claiming an unknown exact occurrence time.
- A redesigned sign-in page uses neutral wording and accepts a visitor's name and email without opening their email application. The existing shared-password login and remembered-device cookies remain in place.

The trendline, gestures, fixed-height history loading state, water collection/backfill, raw weather data and existing database schema are retained.

## Roll out the files

1. Upload the contents of the update ZIP into the existing repository root, preserving `public`, `lib`, `test` and `docs` folders: <https://github.com/ashmoore769/Moore-Weather/upload/main>.
2. Commit all the files together. The `.env.example` file contains examples only; production values stay in Render. No database, real `.env`, credentials or dependencies are included in the ZIP.
3. Let the linked Render service deploy that commit, or choose **Manual Deploy → Deploy latest commit** if automatic deployment is off. The project continues to use its existing Node 24 and build/start commands; there are no new npm dependencies.
4. Reload the site. Updated graph assets use new versioned URLs. Check the dashboard and daily view, drag a graph to its oldest data, and open the signed-out page in a private window.

The interface and graphs can deploy before email configuration. If email is not configured, the access-request button explains that requests are temporarily unavailable, while password sign-in continues to work.

## Enable access-request email on Render (FormSubmit follow-up)

The Render web service now sends over HTTPS using FormSubmit. No registration, API key, paid plan or owned domain is needed. The receiving address is fixed to **ashmoore01@hotmail.com**; the visitor's address becomes Reply-To so a normal reply reaches them. The visitor is not sent an automatic password or confirmation email. Visitors remain on the sign-in page and their email application does not open.

Existing archive settings are sufficient. These optional settings on the Moore Weather service's **Environment** page control the feature:

| Setting | Value |
| --- | --- |
| `ACCESS_REQUESTS_ENABLED` | `true` (default; use `false` to turn requests off) |
| `ACCESS_REQUEST_DB_PATH` | Optional. Defaults to `access-requests.sqlite` alongside the existing `WEATHER_DB_PATH` |

Keep the existing authentication, station, SkyCam and database environment variables. `RESEND_API_KEY` and `ACCESS_REQUEST_FROM` are no longer read; if previously added, they can be removed. Nothing needs to be entered on the FormSubmit website.

After deployment, open the sign-in page in a private window and submit your own name and email once. FormSubmit sends an activation email to **ashmoore01@hotmail.com**. Click its confirmation link; check Junk if needed. The form must be activated before delivery is operational. FormSubmit retains pending submissions for up to 30 days and forwards them once activated. Wait at least five minutes before making a second test request, then confirm that it reaches your inbox and that Reply addresses the visitor. A successful API response confirms acceptance, not inbox delivery.

The request database must be on the persistent disk. With `WEATHER_DB_PATH=/var/data/weather.sqlite`, the default is `/var/data/access-requests.sqlite`; no extra path setting is needed. The file is created automatically. This design shares the limit between connections/processes using the same disk, matching the existing single-instance disk-backed service. Separate instances with separate disks would require a shared quota database.

Reference documentation: [FormSubmit setup](https://formsubmit.co/), [AJAX](https://formsubmit.co/ajax-documentation), [activation and form URL](https://formsubmit.co/help), [optional fields](https://formsubmit.co/documentation).

## Five-minute global limit

One atomic SQLite reservation admits one provider submission across all visitors every five minutes. A restart or redeploy retains the reservation. The period runs from confirmed provider acceptance; failures or uncertain delivery retain the reservation so retries cannot flood the inbox. Invalid names/emails, filled honeypots and foreign-origin browser requests do not send mail. The form shows the remaining cooldown, and the server enforces it independently of the form. FormSubmit's interactive CAPTCHA is disabled for this server request; the application's persistent quota and honeypot remain in place. Provider spam filtering can still reject submissions, and the page reports unconfirmed requests without claiming delivery.

Only the next permitted send time is saved in the quota database. The API does not save the visitor's name or email there, and logs omit visitor details and provider secrets. Requests never grant access automatically.

## Verification

Run `npm run check` and `npm test` with the project's supported Node version. Automated tests cover archive bounds, first-period rainfall, source extrema dates, native data quality, backfill, concurrent requests, persisted cooldowns, provider failures and the real server authentication middleware in isolation. Tests use temporary databases and a fake email transport; they do not contact the physical station or send email.

Additional offline DOM checks exercised both dashboard pages, all water graphs, drag/wheel/pinch/keyboard navigation, presets/reset, trendlines, tables, loading/error states, and request-form success/cooldown/failure states. CSS syntax/property validation and preservation of all existing reading IDs were checked. Live browser visual review and production email delivery still need confirmation after deployment; no production database was changed during development.

## Rollback

Redeploy the previous successful Render deployment or revert this update commit. Existing weather and water data require no downgrade or migration. The small `access-requests.sqlite` file may remain on the disk harmlessly. To disable just access requests, set `ACCESS_REQUESTS_ENABLED=false` and deploy the environment change.
