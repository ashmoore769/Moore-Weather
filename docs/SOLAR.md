# Home solar integration

This optional integration reads a Fronius GEN24 on its local network and sends
selected measurements to Moore Weather over outbound HTTPS. It runs alongside an
existing No-IP updater as a separate Raspberry Pi service.

Version 1.3.0 adds household solar coverage, spare power, live financial estimates,
graphs and a durable daily log. An existing version 1 collector works unchanged.
New installations still require a real inverter response, an authenticated
upload and an advancing dashboard timestamp before being considered operational.

## Data flow and access

The collector reads `/solar_api/v1/GetPowerFlowRealtimeData.fcgi` once per minute.
It submits versioned, normalized samples to `POST /internal/solar/ingest` with a
dedicated bearer token. The receiver authenticates before parsing a bounded JSON
body and acknowledges only after a database commit. Retrying an identical sample
does not create another observation.

`GET /api/solar` serves saved readings behind the portal's existing shared-password
login. Solar readings therefore have the same audience as the other private
Moore Weather readings. The browser never receives the collector token or contacts
the inverter. An optional `?history=today` query adds a bounded five-minute series
and thirty daily summaries. The live card refreshes readings once a minute while
visible and requests history at most once every five minutes. Normal polling
omits the history payload to reduce bandwidth.

The integration uses outbound connections. It does not require an inbound router
port forward, an inbound SSH service exposed to the internet, or a Solar.web cloud
API subscription. A later private-network or router migration can retain the same
collector and receiver; update the private inverter address if it changes.

## Measurements

| Stored field | Source and interpretation |
| --- | --- |
| `observedAt` | Inverter `Head.Timestamp`, normalized to UTC |
| `collectedAt` | Collector's read time, in UTC |
| `receivedAt` | Added by the receiver when the sample is stored |
| `pvPowerW` | `Site.P_PV`, DC-side power from the panels on GEN24 |
| `inverterPowerW` | `Inverters["1"].P`, inverter AC output |
| `gridPowerW` | `Site.P_Grid`; positive imports, negative exports |
| `loadPowerW` | Negative of `Site.P_Load`; positive household consumption |
| `batteryPowerW` | `Site.P_Akku`; positive discharge, negative charge |
| `batterySocPercent` | Optional inverter `SOC` |
| `totalAcEnergyWh` | Cumulative AC energy counter `E_Total` |
| `meterLocation`, `mode` | Bounded power-flow metadata |

Missing or null measurements remain unavailable. A real zero remains zero. DC
panel power and AC inverter output are distinct values. The weather station's
solar-radiation measurement in W/m² and its own panel voltage remain separate.

GEN24's documented daily and yearly energy fields are null. Its cumulative AC
energy counter updates about every five minutes. The dashboard derives **AC energy
recorded today** from stored cumulative observations and reports coverage. A
missing midnight baseline produces a partial figure with a start time. A counter
decrease marks a reset and withholds the daily total. The first partial day and
data gaps are not presented as complete history. Reporting days use Brisbane
midnight, independently of the weather station's 9 am reporting day.

## Dashboard and financial estimates

The top of the card answers three immediate questions: whether solar covers the
house, how much solar is being exported, and the current cost of grid imports.
It compares AC output with household and grid measurements. Panel DC power stays
available under inverter details and is not treated as usable household power.
Missing, old or future-dated observations cannot present an actionable spare-solar
claim. An active battery makes direct solar attribution ambiguous, so that
attribution is withheld rather than guessed.

The Today graph shows recorded power through the Brisbane day. Seven- and
thirty-day views show daily net cost or imported/exported energy. The graph can
be inspected with touch, a pointer or its keyboard-accessible slider. The daily
log can be expanded and downloaded as CSV. Missing dates and partial days remain
explicit, including the first day of collection.

### Dated tariffs

Rates are manual, dated inputs verified against the owner's supplied electricity
statements on 14 November 2026. They are stored in `lib/solar-energy.js`, with no
bill documents, account identifiers or addresses. They do not update automatically
when the retailer changes its prices.

| Effective period | Grid import, AUD/kWh | Feed-in credit, AUD/kWh | Supply, AUD/day |
| --- | ---: | ---: | ---: |
| 1 July 2025 to 30 June 2026 | 0.329725 | 0.0866 | 1.688423 |
| From 1 July 2026 | 0.288948 | 0.06006 | 1.805078 |

Import and supply rates include GST. No extra GST is added to the feed-in credit.
Dates before the first verified tariff have no financial estimate.

- Current grid cost per hour = positive grid kW multiplied by the import rate.
- Current export credit per hour = exported kW multiplied by the feed-in rate.
- Estimated day cost = recorded import cost minus recorded export credit plus
  the **whole daily supply charge**. A partial day omits unknown usage and export;
  it is not a projection of the finished day or an amount currently owed.
- Solar used at home can be valued as an avoided grid purchase. It is not an
  additional deduction from estimated day cost. Moving 1 kWh of grid use into
  otherwise-exported solar has a marginal benefit of import price minus feed-in
  price, rather than the full import price.

Amounts are calculated at full precision and rounded for display. Actual
statements round individual charge and GST lines, and the retailer's meter is
the billing authority. The dashboard's values are estimates, not a replacement
for that meter or a reconstruction of pre-collection history.

### Energy integration and coverage

The installed collector supplies instantaneous power rather than cumulative
import/export meter counters. The server integrates adjacent observations using
their actual timestamps, allowing no more than 180 seconds between them. It
splits signed grid intervals at zero so imports and exports are priced separately,
and clips intervals at Brisbane midnight. It never extends the final sample
forward or bridges a longer gap. Generation and household-use estimates follow
the same time basis. Counter-derived AC generation remains separately identified.

Each daily summary contains per-measurement coverage as well as the shared
coverage percentage. Missing fields do not become zero. A complete-coverage label
requires at least 98% shared coverage, no long gaps or missing essential channels,
and observations within three minutes of both reporting boundaries; today's
denominator is elapsed time since midnight.
The percentage and partial-day label describe the measurements actually captured,
not confidence that an estimate matches a bill to the cent.

`GET /api/solar` retains the original `current` and counter-derived `today`
objects. Additive `rates` and `energy.today` objects provide the new calculations.
With `history=today`, `history.points` includes AC, DC, house and grid power,
while `energy.days` contains thirty chronological date slots. Without that query,
history and `energy.days` are null. A short snapshot cache is invalidated after
each committed upload.

## Verify local access first

Run the following on the collector's home network, replacing the documentation
address with the inverter's actual private address:

```sh
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  'http://192.0.2.10/solar_api/v1/GetPowerFlowRealtimeData.fcgi'
```

Inspect `Head.Status.Code` and the power-flow fields. An HTML response, a timeout,
an HTTP failure and a valid JSON response containing an inverter error are
different conditions; preserve the actual error for diagnosis. A successful
Solar.web login does not verify that the local API is enabled or reachable.

If necessary, inspect **Communication → Solar API** on the inverter's local
interface. Enabling that interface permits local-network devices to read inverter
information without authentication; do not expose it through a public port
forward. Device-control and grid settings are outside this integration.

After copying the reviewed collector folder to the Pi, its normalized read-only
check is:

```sh
FRONIUS_BASE_URL=http://192.0.2.10 \
  python3 integrations/fronius/collector.py --check
```

This mode reads the inverter, prints the selected measurements, and exits. It
requires no upload token and makes no queue, configuration or service changes.

## Installation and activation

Follow [the collector installation guide](../integrations/fronius/README.md).
Python 3.11 or later and its standard library are sufficient. No Docker image,
pip packages, Home Assistant installation or changes to the No-IP service are
required.

Use a new random token exclusively for this integration. Store its matching value
as `SOLAR_INGEST_TOKEN` in Render and in the protected collector configuration.
Do not reuse a portal password, cookie-signing key, DDNS credential or backup key.
Do not commit the token, actual private network addresses, device identifiers or
household readings to the repository.

Receiver configuration:

| Variable | Requirement |
| --- | --- |
| `WEATHER_DB_PATH` | Existing verified, ready weather database on the persistent disk |
| `SOLAR_INGEST_TOKEN` | Dedicated random token of at least 32 characters; blank disables solar |

Collector configuration uses `FRONIUS_BASE_URL`, `SOLAR_INGEST_URL`,
`SOLAR_INGEST_TOKEN`, `SOLAR_POLL_SECONDS` and `SOLAR_STATE_DIR`. The upload URL must
be the exact HTTPS ingest endpoint. Redirects are refused. Default polling is
60 seconds, with bounded read/upload timeouts and upload retry backoff.

The installer prepares the separate `moore-solar.service`, its service account,
files and directories. It does not start the service automatically. Complete the
private configuration and local check before enabling it as described in the
collector guide. Existing No-IP, network-healthcheck and system watchdog settings
are not part of this installer.

## Outages, storage and recovery

The Pi uses a durable SQLite queue. Internet or receiver failures retain unsent
readings for retry, within a fourteen-day and sample-count limit. Current readings
are included while older observations catch up. Exceeding the queue's retention
limit creates a real coverage gap; it cannot recover inverter observations that
were never collected. The GEN24 local API does not provide the Solar.web archive.

The receiver accepts observations up to fourteen days old, rejects timestamps
more than five minutes in the future, and does not let an older observation
replace the latest one. It keeps raw solar observations for ninety days. Its
tables are namespaced within `weather.sqlite`, preserving the weather schema
version and the existing three-database encrypted backup format.

The additive `solar_daily` table retains daily energy, financial estimates and
coverage without an automatic expiry. It is included in the existing database
backup. A late upload recomputes affected days and boundary neighbours in the
same transaction as raw insertion, so replay or backfill cannot add the same
energy twice. Existing raw observations populate missing summaries on first
startup. Raw pruning occurs only after summary creation; reopening the database
does not overwrite an archived full day with the fragment left at the retention
boundary. A code rollback to the previous solar release can ignore the additive
table without changing the existing observation schema.

A limit of 6,000 unique observations per Brisbane day bounds growth if a producer
is misconfigured. Identical-timestamp retries remain idempotent and keep the
original observation. A batch that would exceed the daily limit is rolled back
and receives HTTP 429; no partial acknowledgement discards its pending readings.

The card has its own freshness indicator based on observation time. A successful
HTTP read of old data does not make that observation fresh. Solar availability
does not change the existing weather-station monitor's health result.

Before calling the integration live, verify a real local response, a successful
authenticated upload, restart/retry behaviour, a timestamp advancing in the
private dashboard, and the existing No-IP service remaining active. Offline tests
cover normalization, queueing, authorization, retention and recovery, but do not
prove connectivity to a particular home network.

## Official interface references

- [Primo GEN24 10.0 interfaces](https://www.fronius.com/en-au/australia/solar-energy/installers-partners/technical-data/all-products/inverters/fronius-primo-gen24/fronius-primo-gen24-10-0)
- [Fronius Solar API V1 specification](https://www.fronius.com/~/downloads/Solar%20Energy/Operating%20Instructions/42%2C0410%2C2012.pdf)
- [Fronius GEN24 local API settings](https://manuals.fronius.com/html/4204260302/en-US.html)
- [Solar.web Query API access](https://www.fronius.com/en/solar-energy/solar-solutions/energy-management/solarweb-query-api)
