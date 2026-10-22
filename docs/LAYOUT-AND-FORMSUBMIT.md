# Layout and FormSubmit follow-up

Applies on top of the dashboard update uploaded as `d9514eae27777894056e178eab556b8aad63d766` (UI Update). No dependency changes or weather/water database migrations are required.

## Included changes

- The weather tiles and SkyCam start on the same visible top edge. The extra outer padding around the readings is removed.
- SkyCam loses its decorative top border. Its image proportions, playback, download and maximise controls remain unchanged.
- The desktop dashboard grows from a maximum of 1180 px to 1360 px with equal-width columns, giving the camera more space without squeezing the readings.
- Soil uses the shared navy theme and clear reading tiles instead of the old coloured blue layer backgrounds. Grass, probe artwork, all five temperature rows and four moisture rows remain. Probe artwork retains its dimensions.
- The desktop soil panel and compact station-power card finish on the same bottom edge. Soil can use remaining column height; the power card keeps its compact two-by-two readings. The mobile section order remains unchanged.
- Navigation sits in the spare middle of the masthead at wide desktop widths. At smaller widths it flows into its own row. No controls are removed.
- Rainfall has a larger total, a distinct smaller mm unit, a clear 'since 9 am' period, and a 'Last min' secondary reading. Other main weather figures and soil values are larger too.
- The browser favicon uses the existing artwork clipped to rounded corners in a self-contained SVG, with a new URL to avoid the old cached icon. Installed app icons are retained.
- FormSubmit replaces Resend for access requests. The server still enforces one provider submission per five minutes across all visitors using the persistent SQLite gate. No account, API key or domain purchase is required.

## Upload and activate

1. Extract the ZIP. Upload its contents to the repository root, preserving the `public`, `lib`, `test`, `tools` and `docs` folders: <https://github.com/ashmoore769/Moore-Weather/upload/main>. Upload `server.js` at the root as well. `.env.example` is documentation only and may be hidden by your file browser.
2. Commit all the files together. Let Render deploy that commit, or use **Manual Deploy > Deploy latest commit** if automatic deployment is disabled. Do not replace production environment values.
3. Open <https://moore-weather.onrender.com/login> in a private window. Submit your own name and email once. This is the only action needed to start FormSubmit activation.
4. In **ashmoore01@hotmail.com**, open the FormSubmit activation email and confirm the form. Check Junk if it is missing. Activation must be completed before relying on access-request delivery.
5. After the five-minute cooldown, submit another request to confirm delivery. Reply-To should contain the visitor's address. Access and passwords are still arranged manually.
6. Reload the dashboard and daily page. Check the desktop header and camera alignment, mobile readings, theme switching and the new browser icon. Existing browser tabs may need reopening to refresh a cached favicon.

The form is enabled by default when `WEATHER_DB_PATH` is set. `ACCESS_REQUEST_DB_PATH` optionally changes the persistent quota-file path. `ACCESS_REQUESTS_ENABLED=false` disables the form. Old `RESEND_API_KEY` and `ACCESS_REQUEST_FROM` settings are unused and can be removed.

Only the next permitted send time is stored in the local access-request database. FormSubmit receives the visitor's name and email and documents 30-day retention of submissions. The browser only submits to the application's own API; provider URLs, arbitrary recipient fields and provider response text are not exposed through that API.

## Validation and rollback

Offline tests use temporary databases and a mocked provider; no activation or test email is sent by the development checks. They cover concurrent submissions, persistent cooldowns, failed/malformed provider replies, fixed recipient and reply-to handling, and unchanged password protection. Syntax/asset checks and offline DOM checks cover the affected pages. Live rendering and real inbox delivery require confirmation after deployment.

To undo this follow-up, redeploy the previous successful Render deployment or revert the upload commit. Weather and water records require no migration or rollback. The access-request quota file remains compatible with the previous update.

Provider references: <https://formsubmit.co/>, <https://formsubmit.co/help>, <https://formsubmit.co/documentation>.
