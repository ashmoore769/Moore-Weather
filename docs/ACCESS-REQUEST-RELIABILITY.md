# Access request reliability update

Applies on top of `GUI Tidy` / the Layout and FormSubmit update. This replaces its five-minute submission and email cooldown, following the revised preference. No weather, water, graph or camera behaviour changes.

## Visitor experience

The application commits a request to its persistent SQLite disk before returning HTTP 202 and displaying **Request received**. This means saved by Moore Weather, not confirmed inbox delivery. It sends the email in the background. A provider outage no longer makes the visitor wait five minutes or resubmit their details.

There is no global, hourly or per-IP time limit on new requests, and no enforced spacing between successful email sends. Pending requests for the same email address are combined. After provider acceptance, a short 30-second duplicate window prevents accidental repeats; there is no visible countdown. A lost browser response is safe to retry. Genuine storage failures preserve the entered fields and do not report success.

The hidden bot field, input validation, same-origin check and password wall remain. At most 100 unsent requests are retained so an extended outage cannot create an unbounded database. If that storage capacity is full, new requests get an honest unavailable response, without claiming they were saved.

## Storage and delivery

- Uses the existing `access-requests.sqlite` beside `WEATHER_DB_PATH`, or `ACCESS_REQUEST_DB_PATH` if explicitly configured. That path must be on the persistent Render disk. Existing weather and water tables are untouched.
- Adds queue/settings/provider-pause tables automatically. The old five-minute gate is unused, so an existing lockout does not survive the upgrade.
- Name and email remain in the queue while delivery is pending, for up to 30 days. They are cleared from the queue record on confirmed provider acceptance. A salted email digest is retained only for the short duplicate window after acceptance. No visitor IP addresses are stored.
- The existing web process runs the queue worker; no paid worker or other Render service is required. It starts on application startup, wakes every 30 seconds for retries, and is prompted immediately after a new request. Ready requests are sent consecutively.
- Failed requests retry with increasing delays, starting at 30 seconds. Activation, CAPTCHA, origin and provider rate-limit failures pause delivery for an hour. Explicit provider `Retry-After` values are respected. These pauses affect background email only; visitors can still save requests.
- Persisted leases recover an interrupted send after a restart. Multiple processes cannot claim the same live attempt. If the provider accepted an email but its response was lost, a retry can still produce a duplicate email: FormSubmit does not supply an idempotency guarantee here. Each notification includes the same request reference so those duplicates can be recognised.
- FormSubmit receives the fixed recipient, validated name/email, the actual Moore Weather form URL and corresponding Origin/Referer headers. Arbitrary CC, webhook, subject and recipient overrides are never forwarded.
- Provider failures are logged as safe categories (HTTP status, activation required, invalid JSON, timeout, etc.). Visitor details and raw provider responses are not logged. A `provider_accepted` log means accepted by the provider, not proven delivery to the inbox.

## Upload and verify

1. Extract the ZIP and upload its contents to the repository root, preserving the `public`, `lib`, `test` and `docs` folders. Upload `server.js` at the root. Commit all files together and let Render deploy.
2. Reopen the sign-in page to load `/login.js?v=3`. Submit one fresh request. It should acknowledge promptly, without a countdown.
3. Check for **Moore Weather access request** in the recipient inbox. If FormSubmit sends an activation email naming the Moore Weather URL, activate that form. Successful delivery from the FormSubmit live demo alone does not establish this integration works.
4. If the email does not arrive, inspect Render logs filtered to `[ACCESS]`. The request remains stored for background retry. For example, `provider_http_403` identifies a rejected provider call and `activation_required` identifies form activation. Do not treat the saved confirmation as proof email delivery is fixed.

The queued flow and provider failures were checked offline using temporary databases and a fake mail transport. No real email was sent by those tests, and no connection was made to the physical weather station. Production inbox delivery remains unverified until step 3 succeeds.

To pause receipt and background delivery, set `ACCESS_REQUESTS_ENABLED=false`. Reverting the code leaves new queue tables on disk; the old version will not drain them. Restore this version to resume pending delivery. Do not delete the access-request database as part of a rollback.
