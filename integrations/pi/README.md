# Raspberry Pi network recovery

This integration adds bounded recovery for the weather Pi's Wi-Fi adapter. It
replaces the original `network-healthcheck` script and retains the existing
five-minute systemd timer.

## Why it exists

The Pi's diagnostic journal on 15 November 2026 recorded
`brcmf_fw_crashed: Firmware has halted or crashed`, followed by removal of the
Wi-Fi SDIO device and repeated SDIO initialisation errors. `wlan0` disappeared.
The solar collector and Linux continued running until the following morning,
but NetworkManager could not reconnect a device which no longer existed.

The `mmc1` messages in that incident describe the onboard Wi-Fi SDIO device;
they do not, on their own, establish that the storage microSD card failed.

The systemd hardware watchdog supervises system responsiveness. It does not
automatically reboot a functioning operating system solely because Wi-Fi stops
working. This integration supplies that narrower recovery decision.

## Recovery policy

| Condition | Action |
| --- | --- |
| Configured Wi-Fi interface and profile are connected | Clear the missing-device streak. |
| Interface exists but is disconnected | Try a bounded NetworkManager reconnect using the existing profile UUID. |
| Wi-Fi radio is software disabled | Request that it be enabled, then reassess. The check never turns it off. |
| NetworkManager query fails or times out | Treat state as unknown. Do not infer that hardware is missing. |
| Adapter is connected to a different profile | Preserve that active connection; do not switch it or reboot. |
| A different wireless interface is present | Do not reboot for the absence of the configured interface. |
| A physical Ethernet connection is active, or Wi-Fi is hardware blocked | Suppress the missing-adapter reboot. |
| Configured adapter is absent from both sysfs and a successful NetworkManager query | Count a missing-device observation. |
| Adapter remains missing over three observations spanning at least ten minutes | Consider an orderly reboot, subject to every limit below. |
| Fronius, Render, DNS or the internet is unavailable while the adapter exists | No reboot on that basis. No external endpoint is used as a reboot trigger. |

Automatic reboots are constrained by:

- Ten minutes of boot grace.
- Three observations spanning at least ten minutes, with no interval longer
  than seven minutes between observations.
- At most one request per boot, one per six hours and two in a rolling 24 hours.
- A persistent latch which requires 30 minutes of healthy checks after an
  automatic reboot before another automatic reboot can be considered.
- A final device check immediately before the reboot decision.
- Persistent recording of the attempt before requesting the reboot.
- Conservative handling of invalid state and clock rollback: automatic reboot
  is withheld rather than granting a fresh allowance.

Boot grace and the current failure streak use time within the current boot, so
a clock correction cannot satisfy the missing-device duration prematurely.
The reboot budget survives reboot and updates. A failed reboot request still
consumes its allowance.

The script requests a normal `systemctl reboot`. It does not force a hardware
reset, unload drivers, restart NetworkManager, change Wi-Fi credentials, update
firmware, or access the hardware watchdog directly. No-IP and the solar
collector retain their existing service configuration.

## Install on the Pi

Requirements: Python 3.11 or newer, NetworkManager, systemd, and an active Wi-Fi
connection. Run the installer on the Pi while connected to its normal network.
The source directory must contain `network_healthcheck.py`, `install.sh` and
both unit files from the same reviewed revision.

```sh
sudo bash integrations/pi/install.sh --interface wlan0
```

On first installation, a read-only network check captures the currently active
connection UUID. The installer creates root-only configuration and state. On
updates it validates the existing configuration and preserves the reboot
budget. It refuses an unhealthy preflight, mismatched configuration, corrupt
state, systemd drop-ins, masks or unexpected unit locations.
Existing target files and directories must be root-owned and must not be
writable by a group or by other users; unexpected permissions require review.

Before replacing files it saves the previous script, units, configuration and
state in a private, timestamped directory under
`/var/backups/moore-pi-network/`. If activation fails, it attempts to restore the
previous script and units and the previous timer state. It never rewinds the
reboot budget during rollback.

The installer stops only the network check and its timer while replacing their
files. It does not restart networking, No-IP or the solar collector. It verifies
healthy connectivity before enabling the new timer. Installation does not
intentionally reboot a healthy Pi.

### Installed files

| Path | Purpose |
| --- | --- |
| `/usr/local/sbin/network-healthcheck` | Python recovery check |
| `/etc/systemd/system/network-healthcheck.service` | Bounded oneshot service |
| `/etc/systemd/system/network-healthcheck.timer` | Five-minute schedule |
| `/etc/moore-pi/network-healthcheck.json` | Target interface and existing connection UUID |
| `/var/lib/moore-pi-network/state.json` | Failure streak, recovery latch and reboot budget |

Do not delete or restore an older state file to bypass the reboot limits. If a
configuration or state error is reported, inspect the error and preserve the
current file before repairing it.

## Inspect without taking recovery action

```sh
sudo /usr/local/sbin/network-healthcheck --status
systemctl show network-healthcheck.timer --property=ActiveState,SubState
sudo journalctl -u network-healthcheck.service --since '1 day ago' --no-pager
```

`--status` prints JSON and does not reconnect, reboot or update recovery state.
Its exit status is `0` only when the configured interface and UUID are connected,
the radio is enabled and there is no hard block; `1` means unhealthy or unknown;
`2` means configuration or state needs attention.

To stop scheduled network recovery while investigating:

```sh
sudo systemctl disable --now network-healthcheck.timer
```

To resume it after confirming a healthy status:

```sh
sudo /usr/local/sbin/network-healthcheck --status &&
  sudo systemctl enable --now network-healthcheck.timer
```

## Verification and limits

Run the isolated Python tests on a development machine:

```sh
python3 -m unittest discover -s integrations/pi -p 'test_*.py' -v
```

The tests use simulated probes, clocks and commands. They must not invoke
NetworkManager or reboot the development machine.

This is a recovery improvement for an observed failure mode. The log does not
establish the original cause of the firmware crash. An orderly warm reboot is
also not yet proven to recover every SDIO fault that a power cycle can clear.
If the fault recurs, retain the previous boot's journal so that firmware,
driver, power and hardware causes can be investigated using the evidence.

The recovery latch and budget can deliberately leave a repeatedly failing Pi
offline rather than reboot it endlessly. A site visit or other access can still
be required in that case. Solar readings which could not be collected while
the adapter was unavailable cannot be recreated by this recovery script.
