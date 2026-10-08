# Task A transit and environment evidence

Live checks were made on 8 October 2026. Normal regression tests use attributable fixtures and never require a live service. `scripts/transit.ts` and `scripts/observations.ts` export bounded source probes for the preparation pipeline; there are no continuous feeds or traffic endpoints.

## Transit: verified live

The anonymous TLS broker is `mqtts://mqtt.hsl.fi:8883`. A 45-second session beginning **2026-10-08T10:54:06.135Z** received 459 messages / 136,680 payload bytes with zero decoder rejections. It retained 150 independent owner/vehicle/timestamp reports: **94 tram, 47 bus and 9 ferry**. Some initial coarse-topic reports are buffered before unsubscribe. One in-bounds vehicle per mode is then followed by owner/vehicle topic without a geographic suffix so null positions can be observed. Zero null positions occurred in this window; that does not establish a zero null rate for the service.

- Tram selected for following: `0040/00100`; observed repeat intervals 0.999–1.001 seconds.
- Bus selected: `0022/00025`; intervals 0.999–1.002 seconds.
- Ferry selected: `0060/00005`; intervals 1–8 seconds. A missing ferry in another bounded window remains a separate blocked coverage gate.

Coarse subscriptions are `/hfp/v2/journey/ongoing/vp/{mode}/+/+/+/+/+/+/+/+/60;24/19/#`; coordinates are checked against the release bounds before choosing vehicles. Probe duration is 1–60 seconds, default 30; it caps 10,000 messages, 4 MiB aggregate payload, 32 KiB per payload, and 150 retained reports. Published vehicle records contain the latest observation for each stable ID rather than duplicate time-series positions.

**Observed HFP mappings:** topic owner/operator and vehicle number are preserved with zero padding (`0040/00100`), while payload `oper` is a distinct operating-operator field. Payload `tst` is an ISO UTC timestamp and `tsi` is epoch seconds; the normalized report timestamp uses `tst`, while reception is recorded when the message arrives. `jrn` is retained as a string journey reference. `long`/`lat`, `spd` in m/s, `hdg` in degrees, and raw `dl` in seconds are retained; displayed delay is `-dl`. Missing numeric fields become null, while malformed numeric strings are rejected.

### Exact current GTFS match

The anonymously accessible `https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip` was downloaded at **2026-10-08T10:54:51.167Z**, HTTP 200, **76,200,482 bytes**, 3,835 ms. SHA-256: `5d6b6a170f3150afcb7bc2e377de5f9c1e85ce835804df1f1e2ca9f39c296bbd`. The snapshot feed version was `2026-10-08 04:57:02`, with coverage `20261007–20261205`.

Real HFP vehicle `0040/00100`, service date `2026-10-08`, route `1009`, direction `1`, start `13:27` matched exactly one active GTFS trip: **`1009_20261007_To_1_1327`**. The GTFS direction is `0`, first stop `1203416`, scheduled departure `2026-10-08T10:27:00.000Z`. Matching requires route ID, HFP direction 1/2 mapped to GTFS 0/1, active service date including `calendar_dates` overrides, and the earliest-stop departure clock; route/headsign labels are not matching keys. Missing and ambiguous candidates retain a null trip ID.

The reader scanned **11,187,565 CSV rows / 1,003,841,287 inflated bytes**, retaining 218 active trips for the selected route and one earliest stop per trip. ZIP download is bounded at 128 MiB; each selected entry at 1024 MiB; aggregate inflation at 1536 MiB; processing at 180 seconds; CSV records at 64 KiB; scanned rows at 20 million; retained active trips at 5,000. ZIP entries are read lazily and CSV rows streamed with backpressure. Only routes, calendars, trips, earliest stops and feed metadata are retained. The complete GTFS archive remains ignored in `.cache/task-a`; a one-hour file cache is explicitly identified and hashed when reused.

GTFS extended hours preserve service dates. UTC conversion uses Helsinki local noon minus 12 elapsed hours plus scheduled service seconds, following the GTFS time definition across daylight-saving changes. HFP's wrapped 00–23-hour start clock is compared to the resulting scheduled Helsinki clock, including DST changes; if more than one active candidate matches, the journey remains ambiguous. Integration review added matching regressions for both DST transitions.

## Environment: verified live

Discovery uses FMI `ListStoredQueries` and `DescribeStoredQueries`, validating station/time/parameter inputs before requests. Parameter units and aggregation come from `https://opendata.fmi.fi/meta`, not assumptions based on parameter names or request timestep.

The sample observation window was **2026-10-08T06:00:00Z–09:00:00Z**, fetched around 10:53 UTC. All required requests returned HTTP 200 and valid XML content.

| Source | Station and returned position | Records | Verified unit and aggregation |
|---|---|---:|---|
| `fmi::observations::weather::timevaluepair` | `100971`, Helsinki Kaisaniemi; `60.17523 24.94459` | 12 parameter/time values at one station | `t2m`: degC / avg PT1M; `ws_10min`: m/s / avg PT10M; `wg_10min`: m/s / max PT10M |
| `urban::observations::airquality::hourly::timevaluepair` | `100742`, Helsinki Mannerheimintie; `60.16964 24.93924` | 4 hourly NO2 values at one station | `NO2_PT1H_avg`: ug/m3 / avg PT1H |

Returned `gml:pos` uses **EPSG:4258 latitude longitude**, unlike the longitude/latitude ordering of request bounds and normalized records. Stations are actual observations without spatial interpolation. No quality flags were exposed in the selected responses; normalized quality is `unknown`. Provider `NaN` or explicit nil becomes null; other invalid numeric strings fail. Each observation retains its observed time and the separate response-reception time. Freshness is computed from the latest returned observation and does not pretend the deliberate one-hour end-window lag is a publication-delay measurement.

FMI requests cap each response at 2 MiB / 30 seconds and retained observations at 5,000. Malformed XML, unsupported CRS, unverified parameter units, entity declarations and WFS exception reports are rejected even with HTTP 200.

## Attribution and fixtures

Attribution is HSL / Digitransit for HFP/GTFS, Finnish Meteorological Institute for weather, and HSY via FMI Open Data for central Helsinki air quality. The chosen source license is CC BY 4.0. FMI's [official license page](https://en.ilmatieteenlaitos.fi/open-data-licence), retrieved on 8 October 2026, explicitly applies CC BY 4.0 to FMI and to air-quality datasets stored in its open-data service. [HSY open data](https://www.hsy.fi/en/environmental-information/open-data/) links the CC BY 4.0 terms. The old Digitransit HFP documentation URL returned 404 and HSL's main open-data page required JavaScript/cookies during this check; the final publication gate cites the separately verified [HSL open-data terms](https://www.hsl.fi/en/hsl/open-data). The official page was retrieved through the web connector on 8 October 2026: it explicitly covers MQTT and daily GTFS under CC BY 4.0, requiring HSL attribution and delivery time. Its Journey Planner OSM data exception is not used in this sample.

`tests/fixtures/hfp-samples.json` contains two unmodified received reports per mode; `gtfs-selected.json` and the tiny ZIP retain the one real matched route/trip/calendar/first-stop subset. FMI weather, air-quality, parameter and query-description XML fixtures preserve responses. The query-list fixture is explicitly filtered to the two selected query entries. Evidence JSON preserves original request URLs, dates, byte counts and gates. These are small excerpts, not city-wide raw downloads. Changed scenarios in tests are synthetic mutations of these fixtures, rather than fabricated live evidence.

Streaming implementation was checked against installed sources resolved with `opensrc --cwd`: **yauzl 3.4.0**, `index.js:610–611` and `:919–936` validate actual inflated entry lengths; **csv-parse 7.0.3**, `lib/index.js:14–42` is a Transform stream, and `lib/api/index.js:417–426` enforces `max_record_size`. The additional aggregate-byte limiter bounds total actual inflation independently of ZIP metadata.

## Verification and handoff

Eleven focused fixture tests passed: all three real transit modes, identity/operating-operator separation, report/reception times, deviation sign, nulls, topic/timestamp deduplication, out-of-order positions, exact and ambiguous GTFS matches, calendar overrides, extended hours, both Helsinki DST transitions, streamed archive reading, malformed archive rejection, station/coordinate order, metadata-derived units/aggregation, missing values, malformed XML and WFS exceptions. Shared project type checks reported no errors in these modules; root integration verifies the final whole-project checks and two preparation runs.

Task B owns persistent subscriptions, traffic endpoints and user-facing freshness policy. This implementation provides short evidence probes and normalized sample records only. Live coverage and availability can change; a failed or empty source remains a visibly blocked independent gate.
