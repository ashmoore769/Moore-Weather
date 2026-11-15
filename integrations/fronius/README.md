# Fronius collector for Moore Weather

This small Python service reads a GEN24 inverter on the home network and sends
measurements to the private Moore Weather service over HTTPS. It uses Python
3.11 or newer and its standard library. It requires no containers, pip packages,
public inbound ports, or changes to an existing No-IP service.

## First check: local data only

Enable the inverter's Solar API through its local interface if needed, then run
this from a computer on the same network. Replace the documentation address:

```sh
FRONIUS_BASE_URL=http://192.0.2.10 python3 -B integrations/fronius/collector.py --check
```

This makes one read-only request to
`/solar_api/v1/GetPowerFlowRealtimeData.fcgi`. It prints only the normalized
measurements. It does not require a token, create a queue, or contact Render.
An unreachable inverter, disabled API, invalid response, or unsynchronized clock
is reported as an error. No equipment controls are called.

## Install after the server endpoint is ready

Review the files in this directory, then run the local installer:

```sh
sudo sh integrations/fronius/install.sh
sudoedit /etc/moore-solar/collector.env
```

The installer creates the `moore-solar` system user and installs only this
service's files. It preserves an existing environment file. It does not enable,
start, restart, or stop any services. It does not change Wi-Fi, SSH, firewall,
No-IP, health-check timers, or the system watchdog.

Set these values in the root-owned environment file:

| Variable | Value |
| --- | --- |
| `FRONIUS_BASE_URL` | The inverter's HTTP(S) origin, without a path or password |
| `SOLAR_INGEST_URL` | `https://YOUR-WEATHER-HOST/internal/solar/ingest` |
| `SOLAR_INGEST_TOKEN` | A dedicated random token, identical to the server setting |
| `SOLAR_POLL_SECONDS` | `60` by default; accepted range 15–120 |
| `SOLAR_STATE_DIR` | `/var/lib/moore-solar` with the supplied service unit |

Keep the environment file owned by root with mode `0600`. Generate and enter the
credential through the approved deployment setup. Do not put it in chat, a Git
commit, a command argument, or the public dashboard. Never reuse a No-IP,
Fronius, or portal password. The collector's credential authorizes ingestion only.

Once the actual inverter response and server setup have been verified:

```sh
sudo systemctl enable --now moore-solar.service
systemctl is-active moore-solar.service noip-duc.service
journalctl -u moore-solar.service --since '10 minutes ago' --no-pager
```

Confirm the private solar dashboard shows the current observation time. A running
systemd unit by itself does not prove that readings are reaching the server.

To stop this collector, use `sudo systemctl disable --now moore-solar.service`.
This leaves the stored queue and all other services intact. After a code update,
restart only this unit with `sudo systemctl restart moore-solar.service`.

## Data and reliability

- The default is one sequential inverter request every 60 seconds. Local reads
  have a five-second timeout; HTTPS uploads have a ten-second timeout.
- Solar panel power is DC (`P_PV`); inverter power and lifetime energy are AC
  (`P` and `E_Total`). These are separate fields. Grid power is positive for
  import and negative for export. Home consumption is `-P_Load`. Battery power
  is positive for discharge and negative for charge. Missing values remain null.
- The inverter's timestamp must include a time zone and be between fifteen
  minutes behind and five minutes ahead of the Pi clock when collected. The Pi
  clock should use its normal network time synchronization.
- Only whitelisted measurements, timestamps and mode/location categories are
  uploaded. Serial numbers, device identifiers, network addresses and raw API
  responses are not included.
- Samples are committed to a local SQLite queue before upload. HTTPS retries use
  a 30-second initial delay, doubling to at most 15 minutes. Invalid credentials
  and invalid server acknowledgements leave samples queued.
- Uploads contain at most 120 samples and 128 KiB. A backlog batch includes the
  newest queued sample so the live view can recover before all history is sent.
- A lost acknowledgement is safe to retry: the server deduplicates the inverter
  observation timestamp. A queue row is removed only after all rows in its batch
  are acknowledged as accepted or already stored.
- Pending history is bounded to 20,160 samples and 13 days 23 hours, leaving an
  hour inside the server's 14-day acceptance window. At a faster poll interval,
  the count bound gives less time. Overflow or expired samples are dropped with
  a log warning and cumulative count in the queue database; missing history is
  never recreated or represented as zero.
- TLS verification stays enabled and redirects are refused, including on the
  local read, so the machine credential cannot follow a redirected request.
- The provided systemd unit has a 96 MiB memory limit and a 20% CPU quota. Actual
  resource use and uninterrupted No-IP operation must still be checked on the Pi.

These semantics follow the
[Fronius Solar API V1 specification](https://www.fronius.com/~/downloads/Solar%20Energy/Operating%20Instructions/42%2C0410%2C2012.pdf).
The GEN24 local API does not provide Solar.web's daily/yearly energy totals or
its archive endpoint. The server labels derived energy totals and partial days.

If the Pi stays running but its Wi-Fi device disappears after a firmware crash,
the separate [Pi network recovery integration](../pi/README.md) provides bounded
recovery for that condition. It has its own installer and does not change this
collector, its credentials, or the No-IP configuration.

## Offline checks

```sh
python3 -m unittest discover -s integrations/fronius -p 'test_*.py' -v
sh -n integrations/fronius/install.sh
systemd-analyze verify integrations/fronius/moore-solar.service
```

The tests use synthetic samples and local test servers. They do not contact an
inverter, a production service, or No-IP. `systemd-analyze` validates the unit
configuration; it does not run the collector or prove that the required files,
credentials, network access and resource limits work on the target host.
