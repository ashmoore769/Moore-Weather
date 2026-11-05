# Ten-minute black globe recording: storage recommendation

**Status: recommendation only, reviewed 5 November 2026. No station configuration, application code, schema or stored observations were changed for this review. The proposed STORAGE line below is not a complete upload instruction.**

## Recommendation

Use **STORAGE entry 77 in MEM3** for the ten-minute **average black globe temperature**, replacing the ten-minute **S-THETA wind-direction variability** statistic. Keep all four native data banks and their other entries.

This is the smallest useful change for Moore Weather: it preserves the existing 23 measurement columns in MEM3, its ten-minute cadence, all rainfall recording, and the wind measurements the app currently displays. Entry 75, wind-speed standard deviation, is the next candidate if retaining ten-minute S-THETA is important to the owner.

S-THETA is useful specialist data. Environdata describes Sigma Theta as the standard deviation of wind direction, used to analyse the spread of airborne particles. The recommendation trades that particular ten-minute statistic for a measurement the app already presents; it does not treat S-THETA as meaningless. See the manufacturer's [Wind Movement & Analysis / Sigma Theta explanation](https://www.environdata.com.au/weather-station-software/weather-station-firmware-and-calculations).

## Evidence and current inventory

The source is the owner-supplied LISTALL capture named `Pasted text(20261105-125123).txt`, supplied on 5 November 2026. Its SHA-256 is:

```text
3287955ded24e63083a1262404e30f6f1311223c00377b21eadd5428d3c8b565
```

Parsing that capture with [build-station-layout.js](../tools/build-station-layout.js) produced **34 sensor metadata entries and identical stream definitions** to [station-layout.json](../config/station-layout.json). This comparison covers the metadata represented by that builder: channel identity, name, unit, model, display precision, and each storage entry's order, aggregation, precision, threshold, parameter, cadence and flags. It does not establish firmware capacity or the effects of changing a live storage definition.

There are **96 configured STORAGE entries, numbered 1 through 96 without gaps**. This confirms the number in use; an absolute 96-entry firmware limit has not been independently established from a matching manufacturer command manual.

| Bank | Purpose / cadence | Storage IDs | Measurement columns | CSV columns including date and time | Existing black globe fields |
|---|---|---|---:|---:|---|
| MEM0 | Diagnostics | No STORAGE entries | Not a measurement row | Diagnostic format | None |
| MEM1 | Daily summary, 09:00 AEST | 1–41 | 41 | 43 | 39 average; 40 maximum; 41 minimum |
| MEM2 | Hourly | 42–72 | 31 | 33 | 72 average |
| MEM3 | Every ten minutes | 73–95 | 23 | 25 | None |
| MEM4 | Conditional minute rainfall / rain intensity | 96 | 1 | 3 | None |
| **Native measurement total** | | **1–96** | **96** | | **Four globe definitions** |

R3 has **30 visible current readings** after date and time, including black globe. Those live readings are separate from the 96 STORAGE definitions. The app's rolling 15-day retention applies to collected R3 data; native MEM1, MEM2, MEM3 and MEM4 records are preserved.

The memory setup lists `SETMEM 1 7 2`, `SETMEM 2 25 2`, `SETMEM 3 58 2` and `SETMEM 4 10 2`. This proposal leaves those settings unchanged. The numbers in these commands should not be confused with the counts of storage definitions in each bank.

### Complete storage-definition inventory

The tables group entries by sensor but identify every configured STORAGE ID and its aggregation. The numbering is significant because the app derives each bank's column order from storage IDs.

#### MEM1: 41 daily definitions

| Sensor channel | Measurement | STORAGE IDs and aggregations |
|---:|---|---|
| 1 | Wind speed | 1 MAXIMUM; 2 AVERAGE; 3 STDEV |
| 2 | Wind direction | 4 AVGDIR; 5 S-THETA |
| 25 | Peak wind gust | 6 MAXIMUM |
| 26 | Vector wind speed | 7 VWSP |
| 27 | Vector wind direction | 8 VWDIR |
| 3 | Humidity | 9 MAXIMUM; 10 MINIMUM; 11 AVERAGE |
| 4 | Air temperature | 12 MAXIMUM; 13 MINIMUM; 14 AVERAGE |
| 5 | Rain gauge | 15 TOTAL |
| 6 | Solar radiation, labelled Sun UV | 16 AVERAGE; 38 MAXIMUM |
| 33 | Daily evaporation | 17 TOTAL |
| 34 | Dew point | 18 AVERAGE |
| 21 | Battery voltage | 19 MINIMUM |
| 32 | Communications | 20 TOTAL |
| 22 | Station load | 21 AVERAGE |
| 23 | Solar panel voltage | 22 AVERAGE |
| 24 | Charge current | 23 AVERAGE |
| 46 | Soil temperature, 10 cm | 24 AVERAGE |
| 47 | Soil temperature, 20 cm | 25 AVERAGE |
| 48 | Soil temperature, 30 cm | 26 AVERAGE |
| 49 | Soil temperature, 40 cm | 27 AVERAGE |
| 54 | Soil moisture, 10 cm | 28 AVERAGE |
| 55 | Soil moisture, 20 cm | 29 AVERAGE |
| 56 | Soil moisture, 30 cm | 30 AVERAGE |
| 57 | Soil moisture, 40 cm | 31 AVERAGE |
| 9 | Dirt / ground temperature | 32 AVERAGE; 33 MAXIMUM; 34 MINIMUM |
| 7 | Pressure | 35 AVERAGE; 36 MAXIMUM; 37 MINIMUM |
| 58 | Black globe temperature | 39 AVERAGE; 40 MAXIMUM; 41 MINIMUM |

#### MEM2: 31 hourly definitions

| Sensor channel | Measurement | STORAGE IDs and aggregations |
|---:|---|---|
| 1 | Wind speed | 42 MAXIMUM; 43 AVERAGE; 44 STDEV |
| 2 | Wind direction | 45 AVGDIR; 46 S-THETA |
| 25 | Peak wind gust | 47 MAXIMUM |
| 26 | Vector wind speed | 48 VWSP |
| 27 | Vector wind direction | 49 VWDIR |
| 3 | Humidity | 50 AVERAGE |
| 4 | Air temperature | 51 AVERAGE |
| 5 | Rain gauge | 52 TOTAL |
| 30 | Rain total | 53 CURRENT |
| 6 | Solar radiation, labelled Sun UV | 54 AVERAGE |
| 31 | Evaporation rate | 55 CURRENT |
| 34 | Dew point | 56 AVERAGE |
| 21 | Battery voltage | 57 MINIMUM |
| 22 | Station load | 58 AVERAGE |
| 23 | Solar panel voltage | 59 AVERAGE |
| 24 | Charge current | 60 AVERAGE |
| 46 | Soil temperature, 10 cm | 61 AVERAGE |
| 47 | Soil temperature, 20 cm | 62 AVERAGE |
| 48 | Soil temperature, 30 cm | 63 AVERAGE |
| 49 | Soil temperature, 40 cm | 64 AVERAGE |
| 54 | Soil moisture, 10 cm | 65 AVERAGE |
| 55 | Soil moisture, 20 cm | 66 AVERAGE |
| 56 | Soil moisture, 30 cm | 67 AVERAGE |
| 57 | Soil moisture, 40 cm | 68 AVERAGE |
| 9 | Dirt / ground temperature | 69 AVERAGE |
| 62 | EnvPro status | 70 AVERAGE |
| 7 | Pressure | 71 AVERAGE |
| 58 | Black globe temperature | 72 AVERAGE |

#### MEM3: 23 ten-minute definitions

| STORAGE ID | Measurement position, zero-based | Sensor channel | Measurement | Aggregation |
|---:|---:|---:|---|---|
| 73 | 0 | 1 | Wind speed | MAXIMUM |
| 74 | 1 | 1 | Wind speed | AVERAGE |
| 75 | 2 | 1 | Wind speed | STDEV |
| 76 | 3 | 2 | Wind direction | AVGDIR |
| **77** | **4** | **2** | **Wind-direction variability: proposed replacement** | **S-THETA** |
| 78 | 5 | 25 | Peak wind gust | MAXIMUM |
| 79 | 6 | 26 | Vector wind speed | VWSP |
| 80 | 7 | 27 | Vector wind direction | VWDIR |
| 81 | 8 | 3 | Humidity | AVERAGE |
| 82 | 9 | 4 | Air temperature | AVERAGE |
| 83 | 10 | 5 | Rain gauge | TOTAL |
| 84 | 11 | 6 | Solar radiation, labelled Sun UV | AVERAGE |
| 85 | 12 | 34 | Dew point | AVERAGE |
| 86 | 13 | 46 | Soil temperature, 10 cm | AVERAGE |
| 87 | 14 | 47 | Soil temperature, 20 cm | AVERAGE |
| 88 | 15 | 48 | Soil temperature, 30 cm | AVERAGE |
| 89 | 16 | 49 | Soil temperature, 40 cm | AVERAGE |
| 90 | 17 | 54 | Soil moisture, 10 cm | AVERAGE |
| 91 | 18 | 55 | Soil moisture, 20 cm | AVERAGE |
| 92 | 19 | 56 | Soil moisture, 30 cm | AVERAGE |
| 93 | 20 | 57 | Soil moisture, 40 cm | AVERAGE |
| 94 | 21 | 9 | Dirt / ground temperature | AVERAGE |
| 95 | 22 | 7 | Pressure | AVERAGE |

Position 4 is the fifth measurement and seventh CSV field after counting the date and time fields. Its proposed replacement retains that position.

#### MEM4: one rainfall definition

| STORAGE ID | Sensor channel | Measurement | Aggregation | Cadence | Flags |
|---:|---:|---|---|---|---:|
| 96 | 5 | Rain gauge / rainfall intensity | TOTGR | EMIN 1 | 33 |

Preserve this definition and MEM3 entry 83. Conditional minute rain events and ten-minute rain totals are distinct native records.

## Proposed definition, for review only

**These two lines document the current and proposed definitions. They are not a complete safe upload procedure, and neither was sent during this review. The effects of live STORAGE replacement and MEMWRITE on this firmware's existing records remain unconfirmed.**

Current entry:

```text
STORAGE 77 S-THETA 3 2 1 0.00000 0 EMIN 10 0 32
```

Proposed entry:

```text
STORAGE 77 AVERAGE 3 58 1 0.00000 0 EMIN 10 0 32
```

The proposed line changes the aggregation to AVERAGE and the channel to **58, Black Globe Temp, DegC**. It keeps storage ID 77, MEM3, precision 1, the zero threshold and parameter, EMIN 10, and flags 32. These settings match the existing ten-minute temperature-average pattern and the existing black-globe averages in the slower banks.

Replaying the complete LISTALL capture is a different operation: it contains `MEMOFF`, `SENSORRESET`, `STORAGERESET`, memory setup commands, `MEMWRITE`, `MEMON` and `SAVE`. This recommendation does not authorise or require replaying that full setup.

### What remains recorded

| Statistic | Daily definition | Hourly definition | Ten-minute definition after the proposal |
|---|---|---|---|
| Wind-speed standard deviation | 3 STDEV | 44 STDEV | 75 STDEV, retained |
| Wind-direction variability | 5 S-THETA | 46 S-THETA | Replaced at 77 |
| Average wind direction | 4 AVGDIR | 45 AVGDIR | 76 AVGDIR, retained |
| Peak gust | 6 MAXIMUM | 47 MAXIMUM | 78 MAXIMUM, retained |
| Vector speed / direction | 7 / 8 | 48 / 49 | 79 / 80, retained |
| Black globe average | 39 AVERAGE | 72 AVERAGE | 77 AVERAGE, newly recorded |
| Black globe maximum / minimum | 40 / 41 | Not configured | Not added by this proposal |

The station would still have 96 STORAGE definitions: 41 daily, 31 hourly, 23 ten-minute and one rain-intensity definition. Black globe would have **five native definitions instead of four**: daily average/maximum/minimum, hourly average and ten-minute average. The R3 globe reading stays available. Existing hourly and daily S-THETA records continue; new ten-minute S-THETA recording stops at the agreed changeover.

[weather-history.js](../lib/weather-history.js) exposes mean wind speed, peak gust and AVGDIR direction. It has no S-THETA or STDEV history metric. The frontend review found no other displayed dependency on those MEM3 statistics. Reassigning a daily or hourly entry instead, such as communications or EnvPro status, would alter two banks' column layouts and make the transition more complicated.

## Compatibility hazards demonstrated locally

### Keeping the old mapping silently mislabels the new value

[weather-store.js](../lib/weather-store.js) validates a memory row's column count and assigns each value by position. [weather-persistence.js](../lib/weather-persistence.js) currently parses and imports a recent memory response using one selected layout. Neither can infer that a same-width field has changed sensor identity.

The proposed MEM3 row still has 25 CSV fields. With the current mapping, its fifth measurement would continue to be stored as **sensor 2 / S-THETA / Degs**, even when the actual value is black globe temperature. Numeric or range checks cannot reliably detect this: a value such as 31.5 is plausible for either meaning.

### Replacing the mapping alone also mishandles overlapping old rows

Layouts and fields are immutable in the database, which correctly protects observations already stored under their original meaning. However, a layout's hash participates in record identity. A simple configuration swap applies the new layout to the old rows still returned in a recent-memory tail. Those rows can then be imported again under a different layout and with an incorrect sensor identity.

An in-memory SQLite reproduction using the current implementation demonstrated all of the following:

1. A synthetic 25-field MEM3 row with 31.5 in the entry-77 position was accepted as sensor 2, S-THETA, Degs.
2. Registering a layout with only entry 77 changed to sensor 58, AVERAGE, DegC enabled ten-minute globe in the history catalogue.
3. Importing the identical old row again under that layout inserted another measured record at the same timestamp.
4. `conflicting_records` reported two variants, and the chart withheld that timestamp rather than choosing one.

The reproduction used only an in-memory database. It made no station request, repository edit or production-data change.

The layout hash covers the complete configuration. Consequently, changing MEM3 must also avoid generating new-layout duplicates when unchanged MEM1, MEM2 or MEM4 rows overlap previously collected records. A different schedule fingerprint alone can change the layout hash; generating a new JSON file is not, by itself, a safe transition plan.

### The existing globe chart can use a correctly introduced new layout

The history metric already identifies globe as **sensor 58 / DegC / AVERAGE** and matches that identity across registered layouts. Once the new mapping is introduced correctly, the reader can expose a ten-minute globe resolution without adding a new metric. The history worker constructs its field catalogue at startup, so it must be recreated after the required layouts are registered.

Ten-minute globe history starts with the first valid new native record. Earlier hourly and daily globe observations remain at their original resolutions. The implementation must not relabel old S-THETA rows or fabricate a ten-minute globe series for the earlier period.

## Requirements for a future safe changeover

1. **Confirm the tradeoff.** Establish that losing future ten-minute S-THETA is acceptable. Hourly and daily S-THETA remain available, but they do not recover the finer ten-minute variability.
2. **Resolve the firmware procedure before sending configuration commands.** Confirm the supported way to replace one STORAGE definition, whether recording must be paused, whether accumulators restart, and whether STORAGE or any required MEMWRITE operation clears or reformats existing native records. These behaviours have not been verified for this installed firmware. Clearing native memory is not part of this recommendation.
3. **Preserve the pre-change evidence and native archive.** Save the current LISTALL, verified mapping, original native MEM1/MEM2/MEM3/MEM4 exports, and a verified database backup. Check that the preserved exports contain the records expected before any operation that could affect logger memory. A database backup alone does not establish that all logger-only records have been collected.
4. **Implement old/new mapping selection before the hardware change.** Retain the original mapping and register a new immutable mapping. Select the correct mapping for each MEM3 record around a verified changeover. A response containing both old and new rows must preserve its original bytes and line identities while assigning each row correctly. Uncertain transition rows should remain retained for review rather than acquire a guessed label.
5. **Preserve identities for unchanged streams and repeated tails.** Keep unchanged R3/MEM1/MEM2/MEM4 semantics stable, or explicitly establish equivalent-record deduplication across layouts. A repeated old row must not become a second measured variant merely because MEM3 changed.
6. **Record a concrete boundary.** Coordinate the change around a known ten-minute logger boundary, retain before/after evidence, and identify the first row produced under the new definition. Do not infer the transition from value ranges. If the first new aggregate covers a partial interval, preserve its raw value and identify that limitation.
7. **Prevent a collection race and verify readback.** The app must not import new-format rows through the old mapping while the station and application change over. After the supported targeted procedure, verify the resulting storage table, sensor table and R3 layout. The expected configuration difference is entry 77 only; MEM3 remains 23 measurement columns and R3 remains 30.
8. **Verify the integrated result.** Check the first complete ten-minute globe aggregate, historical labels on both sides of the change, exact raw-source retention, deduplication on a repeated mixed tail, continued hourly/daily globe recording, and unchanged rainfall/intensity collection. Recreate the history reader and confirm that ten-minute globe availability starts at the correct native record.
9. **Make rollback another explicit boundary.** If entry 77 is later restored to S-THETA, retain the intervening globe records under their original new-layout identity. Restoring the old definition must not reinterpret the period that recorded globe temperature.

The ingestion/cutover work above has not been implemented by this documentation change. The existing [database layout guidance](DATABASE.md) and [history behaviour](HISTORY.md) remain relevant, but a same-width live replacement specifically needs the additional transition handling described here.

## Separate observation: TWL and WBGT channel references

The supplied sensor table names **channel 9 as Dirt Temp** and **channel 58 as Black Globe Temp**. Its calculation settings contain `TWL 9 ...` and `WBGT 9 0.70000 0.20000 0.10000`; the accompanying LISTALL comments identify that first parameter as the black-globe input.

That is a configuration discrepancy worth reviewing if those logger-derived heat calculations are intended to be used. Moore Weather currently displays channel 58 directly and does not expose a TWL or WBGT calculation, so this observation does not change the app's existing globe display or the entry-77 recommendation. No change to either calculation is proposed or performed here.
