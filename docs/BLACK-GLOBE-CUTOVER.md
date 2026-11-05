# Ten-minute black globe recording: layout changeovers

Moore Weather 1.2.1 supports replacing a ten-minute storage field while preserving the meaning of older records. The current use replaces MEM3's wind-direction variability field with an average black globe measurement. The original [storage review](BLACK-GLOBE-STORAGE.md) explains that trade-off.

## Private changeover configuration

The installation's exact changeover times, station identity and supporting capture metadata belong in the Render service's private `WEATHER_LAYOUT_CUTOVER_JSON` environment variable. They are not shipped as production configuration in this repository. The public test fixture is fictional and must not be used to configure a real station.

The private JSON specifies the verified original layout fingerprint, storage position and before/after field definitions, the schedule change and confirmation timestamps, the first new native record, and the first complete averaging period. It also records the evidence used to establish the change. Times use explicit ISO UTC timestamps; the station's display timezone remains Australia/Brisbane.

The first successful startup stores this metadata with the immutable layouts in the private database. Later starts can recover the same configuration from the database even if the environment variable is omitted. If the private environment variable is present, it must agree with the stored metadata. Invalid or contradictory configuration must fail safely rather than guess a new interpretation.

| Native MEM3 record | Meaning of the changed field | Display treatment |
|---|---|---|
| Before `firstNewObservedAt` | Original wind statistic | Never interpreted as globe temperature |
| At `firstNewObservedAt` | New globe field, possibly a partial averaging interval | Retained for review; excluded from the globe trend |
| From `firstCompleteObservedAt` | Complete globe average | Eligible for the ten-minute trend, subject to ordinary quality and conflict checks |

Record timestamps identify interval ends. The other measurements in the transitional row retain their normal quality rules.

## Archive handling

The original [station-layout.json](../config/station-layout.json) remains immutable. The app registers a second immutable mapping and chooses the correct MEM3 mapping for each record, including responses containing both old and new records. R3 and MEM0/MEM1/MEM2/MEM4 retain their existing mappings and identities.

Startup reconciliation corrects eligible MEM3 rows collected under the previous mapping after the physical change. It preserves record IDs, timestamps, numeric and raw values, original lines, source bytes, source line numbers and references. Only the affected layout and field associations change. A durable identity alias connects a corrected record to its canonical new identity, so overlapping downloads do not create a second record. Genuine differing-value records remain conflicts.

The repair, view upgrade and audit metadata commit together in a transaction. Reopening the database is idempotent. Evidence that a future-dated record was already captured before the physical change takes precedence over its misleading logger timestamp. Records with uncertain provenance and existing interpolation records keep their original meaning and lineage; later receipts of the same bytes cannot silently resolve that uncertainty. Live future-timestamp quarantine remains active.

The raw transition globe observation remains available for audit. The common usable-readings view excludes only that measurement, so chart availability and summaries agree about the first complete interval. Earlier hourly and daily globe readings remain at their actual resolutions. No earlier ten-minute values are invented.

## Chart behaviour

The Current Readings globe preview uses ten-minute history once usable ten-minute coverage exists. Until then, it preserves the hourly fallback. History retains hourly and daily options for browsing the earlier archive. Measurement identity includes sensor, unit and aggregation across layouts; column position alone is insufficient.

## Operational verification

At startup and after a normal MEM3 import changes the evidence, the private application log emits a `[LAYOUT]` summary containing the configured boundaries, reconciliation count, transitional exclusions and first/latest usable globe readings. These checks use stored native rows and add no station command or connection. The same cached summary is available through authenticated database status.

Tests cover mixed responses, original-source preservation, repeated tails, restart reconciliation, old-schema view upgrades, rollback after failure, foreign keys, ambiguous records, estimated-record lineage, transition exclusion, future timestamps, hourly fallback and usable ten-minute coverage. Production verification must also confirm a real complete native globe record and continued normal collection.

## Rollback

After a physical logger change, an application rollback must retain the corresponding mapping support or pause native-history ingestion until compatible code is restored. Reverting only to a pre-change ingestion version would resume interpreting new values under the old definition.

Restoring the old logger definition requires a separate recorded boundary while preserving intervening globe records under their original meaning. This app update does not reset the logger, erase its memory or replay a complete configuration capture.
