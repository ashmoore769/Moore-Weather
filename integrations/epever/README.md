# Yard Power - EPEVER Tracer / MT50

This optional, noncritical monitoring integration makes the **Yard Power** card available below **Station power** in Moore Weather.

## What it does
- Passively receives the existing MT50 RS485 conversations through the Elfin EW11A.
- Connects from the **existing Pi** to reserved LAN address `192.168.86.69:8899`, without sending any bytes back.
- Recognises the manufacturer's sparse Modbus command `01 43 31 00 00 76 CB 1F`, validates each response's CRC, and decodes six measurements in the 0x3100 register group.
- Stores one minute-stamped observation per minute in a bounded local SQLite upload queue; sends batches to the existing Moore Weather Render backend using a **new, dedicated token** and HTTPS.
- Shows one 3 x 2 responsive tile grid and 24-hour, seven-day and 30-day histories. A late or missing reading is visibly delayed; historical gaps are never interpolated.

The 660-frame supplied capture was decoded offline with 660 valid CRCs. That verifies the example, **not** the reliability of the installed device over time.

## Deployment sequence

1. Reserve `192.168.86.69` in the router. Leave the Elfin itself on DHCP and TCP Server port 8899. **Do not forward port 8899 on the internet.**
2. Deploy the backend to Render with `YARD_POWER_INGEST_TOKEN` set to a unique, random, visible-ASCII token of at least 32 characters. The card remains hidden if this is unset. Do not reuse the Fronius `SOLAR_INGEST_TOKEN`.
3. On the Pi, obtain this integration's source from the reviewed commit and run its offline test: `python3 -m unittest discover -s integrations/epever -p 'test_*.py' -v`.
4. Before installing, check the existing MT50 feed *without writing to it*: `YARD_POWER_ELFIN_HOST=192.168.86.69 python3 integrations/epever/collector.py --check`. The check exits after one valid measurement and makes no storage writes or HTTPS requests.
5. Run `sudo sh integrations/epever/install.sh`. It only installs the separate service, and **does not start or restart** any existing service.
6. Edit `sudoedit /etc/moore-yard-power/collector.env`, supplying the full HTTPS URL and the identical secret to the one configured in Render. Keep this file root-readable only.
7. Run `sudo systemctl enable --now moore-yard-power.service`. Verify with `systemctl status moore-yard-power.service` and `journalctl -u moore-yard-power.service --since '10 minutes ago' --no-pager`.
8. Confirm the Yard Power tile appears below Station power, values advance, and stale readings show a visible delay. Confirm Fronius remains healthy.

## Design constraints

The MT50 is the only Modbus bus master. An Elfin as a passive electrical tap can observe both directions because its current connection is receiving the MT50 traffic. The collector never writes to its TCP socket, so it will not start a competing Modbus transaction.

The Tracer's LOAD measurement is only what the controller measures. Loads powered directly from the battery (including the large pump inverter) are **not** included. Battery state of charge is omitted because the Tracer's estimate is not an accurate LiFePO4 battery monitor.

The Pi's `moore-solar.service` and `noip-duc.service` remain completely untouched. You may retire No-IP separately after your Milesight/WireGuard cutover. The Elfin's existing analogue supply timer may provide a periodic hard reset, but no automatic relay power-cycling is required for this information-only system.

## Troubleshooting and rollback

- The collector reconnects automatically after TCP failures, Elfin power resets and timeout, with bounded backoff.
- Unsent samples remain in its independent queue for up to 13 days; power/network gaps cannot be reconstructed.
- The weather backend returns "waiting" before the first reading, "fresh" under three minutes old, and "stale" afterwards.
- To disable the Pi collector only: `sudo systemctl disable --now moore-yard-power.service`.
- To hide the card without modifying existing services: remove `YARD_POWER_INGEST_TOKEN` from Render and redeploy. Existing historical database rows remain intact.
- Do not change the Elfin's 115200 8N1 half-duplex serial settings, nor the existing MT50 wiring, when the capture continues passing CRC checks.
