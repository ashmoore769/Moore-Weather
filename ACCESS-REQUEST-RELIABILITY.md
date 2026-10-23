# Formspree integration — 23 October 2026

## What changes

Moore Weather uses plain HTML and JavaScript with a Node/Express backend on Render. This follows the Vanilla JS/AJAX approach, adapted to the existing page and durable request queue. No React conversion, bundler, external CDN script or new npm dependency is needed.

The browser posts name/email to `/api/access-request`. The server validates the input and saves it to the existing persistent SQLite database, then posts JSON to the fixed owner-supplied endpoint:

`https://formspree.io/f/mrppzvvk`

Only name, email, the fixed subject/source/message and request reference are forwarded. The `email` field supplies Formspree's Reply-To address; the form's verified target email controls the recipient. Visitors cannot override the endpoint, recipient, CC or message content.

The form stays on Moore Weather and never opens an email app. Password sign-in and the private dashboard remain unchanged. The five-minute cooldown remains removed. Validation, honeypot, duplicate suppression, queue capacity and provider-requested backoff remain.

## One-time settings

1. In Formspree, verify `ashmoore01@hotmail.com`, and check that form `mrppzvvk` has this address selected for email notifications. Creating a form alone does not prove that notifications are configured or delivered.
2. This integration sends from the server and does not render a CAPTCHA widget. In this form's **Settings → Spam protection**, leave interactive CAPTCHA disabled. If you want CAPTCHA later, it must be integrated explicitly; a CAPTCHA/verification response is never treated as success. Formspree's own filtering and the application's validation/honeypot still apply. Do not copy the old FormSubmit `_captcha` setting: it is not a Formspree setting.
3. In Render's Moore-Weather service, set `ACCESS_REQUESTS_ENABLED=true` when ready to resume requests. Preserve other variables. No Formspree API key, Resend key or owned domain is required for this form endpoint. Uploading `.env.example` does not change production settings.

## Deploy

Extract the ZIP and upload its contents at the root of `ashmoore769/Moore-Weather`, preserving folders. Commit the files together; Render auto-deploys the main branch.

If requests were paused with `ACCESS_REQUESTS_ENABLED=false`, change that setting to `true` and use **Save and deploy** after the new code is available. A restart alone reuses the old environment. Keep the existing database paths and persistent disk unchanged.

Do not restore, replace or delete the database. On first use, a transactional migration registers the Formspree endpoint, clears the old FormSubmit failure/backoff, and schedules previously queued requests for the new provider. It preserves references, names, emails, creation/expiry times and unexpired delivery leases. Completed requests are not resent. Later restarts preserve Formspree backoff and failure status rather than clearing it again. The manual `false` setting is always respected; the code does not silently override it.

The previously queued requests will be attempted automatically once enabled. Access is not granted automatically, and no passwords are sent by this integration.

## Visitor feedback

- Normal submission: the server waits for Formspree's response, then the button says **Request submitted** and the page confirms submission for review.
- Slow response/backlog: the request is already saved; after at most 12 seconds the page reports that email notification is still pending. The worker continues without another click.
- Rejection: the saved request stays queued, the page explains that notification failed and shows the contact fallback. Subsequent intake pauses during the known outage; background retries respect provider backoff.
- Local storage failure: entered fields remain, the request is not acknowledged as saved, and the visitor can retry.

Success requires an HTTP success response and Formspree's documented client response shape (`next` string), with no error fields, false `ok` flag, payment flow or CAPTCHA/verification destination. Returned URLs are never followed. A bare HTTP 200, HTML page, legacy FormSubmit `success` flag or generic `ok:true` is insufficient.

Formspree acceptance means the provider accepted the form; it is not proof the notification reached the inbox. The page does not claim inbox delivery. Once accepted, the existing queue clears personal details and keeps its short duplicate window. Pending local records remain recoverable for up to 30 days. Formspree maintains its own submissions history according to the account plan (the free plan currently retains 30 days and permits 50 submissions/month).

## Verify actual delivery

1. Wait for Render to report the new deployment **Live**, then reopen `/login` (it loads `/login.js?v=5`).
2. Confirm online requests are enabled. If unavailable immediately, check `ACCESS_REQUESTS_ENABLED` and the `[ACCESS]` logs; do not repeatedly submit.
3. Check Formspree's submissions dashboard and the Hotmail inbox for the existing queued requests. Match the request reference with the Render `provider_accepted` log.
4. Submit one fresh request from the real Moore Weather sign-in page. Confirm both the Formspree dashboard entry and the notification arriving in the inbox. Only then consider end-to-end delivery verified.

These implementation tests use fake email transport and temporary databases. They do not send real messages or connect to the physical weather station. Production inbox delivery has not been verified by those tests.

## Private recovery and troubleshooting

Use Render Shell, not a public website endpoint:

```sh
node tools/access-requests.js list
node tools/access-requests.js summary
```

These read existing unsent requests without sending or deleting anything. `list` includes private names/email addresses; keep its output private. The recovery utility was supplied in the preceding containment update and is unchanged here.

Logs contain references and safe categories only. Examples: `activation_required`, `provider_captcha`, `provider_form_not_found`, `provider_http_403`, `provider_http_429`, `provider_timeout` and `provider_invalid_json`. If Formspree rejects a request, its raw response and visitor details are not printed.

Setting `ACCESS_REQUESTS_ENABLED=false` pauses intake and the worker while preserving the database. Rolling back to the old FormSubmit code restores its broken provider connection; prefer pausing while investigating.

## Primary references

- https://help.formspree.io/articles/building-your-form/submit-forms-with-javascript-ajax
- https://github.com/formspree/formspree-js/blob/main/packages/formspree-core/src/core.ts
- https://github.com/formspree/formspree-js/blob/main/packages/formspree-core/src/submission.ts
- https://help.formspree.io/articles/building-your-form/email-reply-to-address
- https://help.formspree.io/articles/building-your-form/email-subject-line
- https://help.formspree.io/articles/form-and-project-settings/recaptcha-settings
