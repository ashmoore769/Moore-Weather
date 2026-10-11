# Logger and webpage conditioning review

Status: reviewed 30 September 2026. No logger configuration, production deployment or historical values were changed. The owner has confirmed the extra webpage pressure adjustment and requested moving it into the logger at the next update, not now. Existing settings remain intact pending that coordinated update.

## What is already applied

| Reading | Logger schedule | Current webpage | Daily webpage | Treatment |
| --- | --- | --- | --- | --- |
| Pressure | Sensor 7: multiplier 1, divisor 12, offset 804.20001; limits 700–1200 hPa | Subtracts a further 1.9 hPa | Displays stored pressure without that subtraction | Next update: offset 802.30001 and remove webpage subtraction together; unchanged for now |
| Solar radiation | Sensor 6: multiplier 5, divisor 6, offset -500; lower limit -5 W/m² | Displays `max(0, value)` | Displays stored maximum/average without a floor | Prepared a candidate lower-limit change to zero |
| Solar-panel voltage | Sensor 23 supplies measured voltage | Shows 0 V when panel voltage is below battery voltage | Uses stored measurements | Display/status convention; retain actual voltage in the database |
| Missing last-minute rain | No proposed logger change | Falls back to 0 when parsing fails | No proposed change | Presentation fallback, not proof of zero rain; do not convert missing database values to zero |
| Apparent temperature | Not a separately defined sensor in this schedule | Calculates from air temperature, humidity and wind | Not implemented | Derived display metric; do not replace the measured air-temperature channel |
| Globe/air difference and dew-point margin | Separate measured/derived inputs | Calculates differences for display | Not applied | Derived display metrics |
| Soil moisture/temperature colours and wind directions | Original measurements | Colour interpolation, labels and decimal formatting | Colour/decimal formatting | Presentation only; no logger calibration changes needed |

On 30 September 2026, the owner confirmed that the standard Environdata schedule offset is 750 and that he increased this station's offset to 804.20001 to match elevation-adjusted pressure from a local Elders Weather or BOM reference. The added allowance is therefore approximately 54.2 hPa. He recalled an unadjusted sensor reading around 932 hPa; this is context, not a contemporaneous calibration pair. The schedule already applies the intended pressure adjustment before R3 output and storage. Retain 804.20001 and do not apply another elevation allowance during database ingestion. This records the owner's empirical adjustment; it does not establish a dynamically calculated sea-level pressure reduction or an independently verified calibration.

The owner subsequently confirmed that the webpage's additional fixed -1.9 hPa was a small manual correction made there for convenience instead of revisiting the logger. The EVAP command separately includes a 440 m elevation and 96.7 kPa atmospheric-pressure constant for its evaporation calculation; these are not instructions to add another correction to sensor 7.

The current and daily pressure pages therefore have a 1.9 hPa difference in processing, independent of changes in weather over their different reporting periods. Moving the additional subtraction into sensor 7 would also alter every future pressure aggregate. It should not be described as adding a previously missing elevation correction.

## Pressure change reserved for the next update

At the next coordinated logger/webpage update, change only sensor 7's offset from 804.20001 to 802.30001 (804.20001 minus 1.9) and remove the subtraction in `public/index.html`. Preserve the other sensor parameters. This carries the existing empirical adjustment into recorded data; it is not a newly verified calibration. The resulting allowance above the standard 750 is approximately 52.3 hPa.

Coordinate the two changes to avoid temporarily applying the 1.9 hPa adjustment twice or omitting it. Verify live R3, stored pressure and both pages after changeover, and record the actual activation time and calibration version. Preserve historical values and distinguish old records/aggregation windows from the new calibration. The solar-only candidate below does not implement this pressure change.

Once the system is running, the owner intends to request a one-off comparison with nearby registered weather stations. This is deferred work, not a scheduled monitor. Compare simultaneous observations over several conditions and use the same pressure reference (MSLP versus station pressure or QNH), verified barometer elevation and station metadata. Agreement with a nearby site is a field comparison, not by itself a sensor calibration certificate.

A precise sensor measures pressure at its own elevation; an accurate station-pressure reading can differ substantially from a published mean sea level pressure. BOM defines MSLP as pressure converted to sea level, while QNH uses a standard-atmosphere model. A fixed empirical offset approximates this reduction; a physical sea-level reduction accounts for elevation and a temperature profile. See [BOM observation definitions](https://www.bom.gov.au/resources/observation-network/about-latest-observations) and [NWS pressure definitions](https://www.weather.gov/bou/pressure_definitions). The sensor's model and calibration certificate have not been examined here.

## Evidence

Read-only VER reported CPU `2.55 2025/09/25 Program`, command set 1, I/O `1.28a MK4IO`, hardware L. Live sensor 6 and 7 definitions exactly matched the saved schedule. Captures are under `data/logger-inspection/2026-09-30T12-49-37-756Z/`.

The LISTALL capture includes all 34 sensor and 96 storage lines, but ends at SET ALT without a completion prompt. It is not a verified full configuration backup. Sensor 1 prints multiplier 3.54999 versus 3.55000 in the saved file; this small readback difference was not silently changed or treated as a calibration update.

The local DL3000 Command Specification V1.44, pages 23–25 and 48, defines SENSOR's multiplier, divisor, offset, upper limit and lower limit fields. Page 34 distinguishes EVAP's elevation/pressure inputs. This is a historical command reference: it does not by itself prove the exact lower-limit behaviour of the installed 2.55 firmware. The candidate must be verified on the device rather than assumed to clamp solely from the field name.

## Prepared solar-only change

`station/solar-floor-zero.candidate.dl3` changes only sensor 6's lower limit from -5 to 0. Its multiplier, divisor, offset, name, units, virtual channel and upper limit stay the same. Sensor 7 is absent from the patch, so the pressure calibration is not changed. The separate rollback restores -5.

Before applying, obtain a complete configuration backup, capture the current active-memory state and coordinate access with Render's polling process. The patch pauses logging, changes the sensor definition, saves, and restores the four memories observed active in this station's configuration. Confirm that state is still current. Do not blindly replay the full original schedule: its MEMWRITE and reset commands are unnecessary for this change.

After application, inspect the sensor readback and settled sample periods. At night, confirm the raw R3 solar value is actually zero, not negative, missing or an error value. Check a subsequent ten-minute/hourly stored solar reading and daylight readings. Verify all memories resume. SAVE/configuration changes can interrupt an aggregation window; record the actual changeover and keep transition intervals separate. If the lower limit does not perform the intended conditioning on 2.55, restore the original definition and investigate its firmware path rather than invent another command.

A zero floor in the logger would apply before storage aggregation and to calculations that consume sensor 6, including evaporation. That differs from flooring only the finished webpage value. Historical means cannot be reconstructed exactly by flooring their averages: `average(max(0, samples))` differs from `max(0, average(samples))`. Preserve the original history, create a new verified layout/calibration version at activation, and do not label mixed transition summaries as wholly corrected.

The webpage's zero floor is idempotent, so it can remain as a display safeguard after logger verification. There is no pressure double-correction risk from this solar-only candidate. Neither candidate nor rollback has been transmitted.
