# Access-request delivery incident — 23 October 2026

## What is and is not fixed

Production Render logs show `provider_http_403` from FormSubmit for two different request references. This confirms rejection of server submissions; it does not identify why FormSubmit rejects them. The successful FormSubmit live-demo email was a different submission path.

This patch contains the failure. It does **not** repair FormSubmit delivery or claim that a saved request reached the owner. No production email was sent by its tests.

- Existing queued failures immediately make the public request form unavailable after upgrade. The backend rechecks before writing, including for a visitor who loaded the page before the outage.
- The page shows a copyable contact address. It does not launch an email application.
- A newly saved request displays a neutral, explicit delivery-pending message, never a green delivery confirmation.
- Pending requests remain in the existing database. Background retries keep their existing provider backoff. The five-minute visitor cooldown remains removed.
- A subsequent provider acceptance clears the outage flag. Provider acceptance is still not proof of arrival in the recipient's inbox.
- `tools/access-requests.js` provides private, read-only recovery from Render Shell. It sends nothing, deletes nothing and does not connect to the weather station.

## Immediate production pause (no upload needed)

In Moore-Weather's Render **Environment** settings, add or set `ACCESS_REQUESTS_ENABLED=false`, then choose **Save and deploy**. Preserve all other settings. A restart alone does not apply newly saved environment variables. The persistent-disk service will briefly restart; normal password sign-in remains available after it restarts.

This pauses both new requests and background email attempts. Do not delete or replace `access-requests.sqlite`, `weather.sqlite` or the persistent disk.

## Deploy this containment patch

Extract the ZIP and upload its contents to the root of `ashmoore769/Moore-Weather`, preserving the `public`, `lib`, `tools`, `test` and `docs` folders. Commit the files together. Render auto-deploys the main branch. `.env.example` documents settings; uploading it does not change production environment variables.

After the deployment is live, open `/login` and check that access requests are unavailable and the copyable contact address is visible. `/api/access-request` should return `enabled:false` while manually paused or while the recorded delivery failure remains. Existing password sign-in must still work. The browser loads `/login.js?v=4`.

## Recover pending visitors privately

Once this patch is deployed, open the Moore-Weather service's **Shell** in Render and run:

```sh
node tools/access-requests.js list
```

It displays each pending request's name, email, reference, time, attempts and failure category. Review these privately and contact visitors through your usual email workflow. Do not paste their personal details into GitHub issues or public logs. The command does not send, acknowledge or delete requests.

For a count without personal details:

```sh
node tools/access-requests.js summary
```

The utility reads `ACCESS_REQUEST_DB_PATH`, or `access-requests.sqlite` beside `WEATHER_DB_PATH`, matching the live application's configuration. Missing files are not created. The connected Render tools available in this session cannot execute Shell commands or read this SQLite disk, so the records themselves have not been independently inspected.

The existing worker expires unsent records after 30 days. Recover requests promptly. Requests from the older pre-queue implementation may not have been retained; no recovery is promised for those. Provider-accepted requests have already had their personal details removed by the existing implementation.

## Restore email delivery

Keep the form paused while investigating FormSubmit's HTTP 403, or configuring a replacement service. Retrying the public live-demo does not test Moore Weather's backend. A provider change needs a verified recipient and its actual form endpoint or credentials; do not put secret keys into the repository.

After a provider connection is repaired, re-enable the worker with `ACCESS_REQUESTS_ENABLED=true` and deploy. Existing queued requests retry after their stored provider backoff. Do not delete queue rows or bypass a provider's `Retry-After` to force a retry.

Before declaring email working, verify an actual **Moore Weather access request** reaches `ashmoore01@hotmail.com`, and match its reference with the Render log. An HTTP 202 from Moore Weather only confirms local storage; a `provider_accepted` log only confirms provider acceptance. Neither alone proves inbox delivery.

## Offline verification

Automated tests use temporary SQLite files and fake email transport. They cover legacy HTTP 403 recovery, persistent outage status, concurrent submissions, preservation of pending requests, read-only recovery, retries, and the visitor UI. They do not send emails or connect to the physical weather station.
