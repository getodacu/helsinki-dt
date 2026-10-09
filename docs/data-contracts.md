# Helsinki Lens data contracts

The authoritative TypeScript records are in `src/lib/types.ts`. Source-specific adapters validate upstream content before creating these records; ordinary tests use small recorded fixtures, not live providers.

## Shared rules

- IDs remain strings, including operator/vehicle numbers with leading zeroes. Preserve original GMLID, national VTJ-PRT, municipal RATU and UUID alongside the internal building ID.
- Missing readings are null or absent, never zero. Reject non-finite coordinates, malformed timestamps, unsupported units and unknown source references.
- Reported/observed timestamps and receipt timestamps are separate UTC instants. Display dates in `Europe/Helsinki`; a new metadata fetch does not refresh an older position.
- Dataset metadata identifies provider, original URL, attribution/reuse terms, retrieval time, vintage, units, coverage, method, coordinates, vertical reference and checksum where available.
- Prepared source samples are dated snapshots. They are not a live feed or simulated replacement during outages.

## Geometry and coordinates

Release bounds are WGS84 `[24.86, 60.135, 25.06, 60.225]`, and the Senate district is `[24.944, 60.164, 24.958, 60.174]`. Bounds are ordered west, south, east, north. Scene origin is longitude 24.952, latitude 60.1695, N2000 elevation 0 m.

CityGML tuples are ETRS-GK25 / EPSG:3879 easting, northing, elevation in metres, with N2000 vertical reference. The published sample contains the malformed declaration `urn:ogc:drf:crs:EPSG::3879`; retain it as source evidence while using verified EPSG:3879. The projection uses the GRS80 ellipsoid, central meridian 25°, scale 1 and false easting 25,500,000m. Local Three coordinates are `[E−E0, H−H0, −(N−N0)]`; WGS84 is retained for exchange. Projection does not perform a vertical datum conversion.

Repeated GMLIDs can contain different LoDs of the same building. Reconcile compatible records to one building identity and preserve identifier conflicts. National building IDs may themselves map to multiple GML objects. Do not silently pick one candidate. Source GroundLevel attributes can be negative and are not a validated terrain surface for positioning vehicles.

`BuildingChunk.positions` contains non-indexed triangles in local metres. Each range identifies its first triangle, triangle count and stable building ID. A raycast triangle index resolves through this range table. Original IDs and attributes remain in the separate building index; browser metadata does not need to parse CityGML.

## Transport

| HFP field | Normalized meaning |
| --- | --- |
| Topic owner operator and vehicle | Provider-scoped stable vehicle identity; preserve zeroes |
| Payload `oper` | Operating/subcontracting operator, separate from owner |
| `tst` | Reported UTC instant |
| `lat`, `long` | Latitude, longitude; null positions remain null |
| `spd`, `hdg` | m/s, clockwise degrees from north |
| `dl` | Raw schedule deviation; normalized positive-late delay is `−dl` |
| `route`, topic direction, `oday`, `start` | Exact route, direction, original service date and wrapped Helsinki start time |

HFP topic directions 1/2 map to GTFS 0/1. Route labels are display information, not journey identities. Deduplicate identity+reported timestamp before measuring cadence. Geographic subscriptions exclude missing-position reports, so their count cannot establish a zero null-position rate.

GTFS matching checks active service dates and calendar exceptions, exact route/direction and the first stop departure. Keep full GTFS service seconds even for hours beyond 24. Scheduled instants use local noon on the service date minus 12 elapsed hours plus service seconds, preserving DST behavior. Compare the resulting Helsinki clock minute to HFP's wrapped `HH:mm`; zero or multiple candidates remain unknown/ambiguous. Do not infer the service date from a position timestamp.

## Observations

FMI bounding boxes use longitude, latitude, but returned EPSG:4258 `gml:pos` is latitude, longitude. Record actual station identity and coordinates, observed time, parameter, provider unit and aggregation. Sampling interval is separate from the physical aggregation interval. `NaN` is null; quality is unknown when no per-reading flag exists. Weather and urban air-quality queries are separate source records even though they use the same time-value XML layout.

## Energy and solar

Energy scope is property, building or meter. Each record preserves its measurement boundary, matched members, unmatched source identifiers, metric, period, unit, measured/modeled method, scenario and source. Exact joins use verified original identifiers; ambiguous IDs remain unresolved.

Nuuka building-code queries return the property's consumption. Store that total once and associate its members; never allocate or duplicate the total across buildings. Date-only daily periods remain date-only: a source date lacking an offset must not become an invented UTC measurement instant.

Atlas modeled exports are not measured consumption. An unverified model unit blocks normalized modeled records. Retrieval date is not model/scenario vintage.

HSY solar production is modeled potential, not installed panels or live output. Preserve kWh/year versus MWh/year, source vintage and model assumptions. Accessible geometry without a shared building identifier does not prove a join. Only exact or explicitly evidenced reviewed associations may attach solar values to buildings; unmatched records remain unmatched.

## Publication

Only licensed records enter distributable sample assets. An asset manifest records bytes, SHA-256, count and generation-relative path. Stage and validate the complete generation before replacing `static/data/manifest.json`. Failed preparation keeps the prior valid pointer; old generations are bounded and retained briefly for clients finishing older samples. Raw downloads, converter tools and runtime caches are ignored.

## Server-side entity queries

Private SQLite generations are derived from the prepared municipal building metadata, energy and Ryhti catalogs. Stable building IDs and all original attributes are retained. Split render chunks link to one entity without merging conflicting identities. Search normalizes accents/case with the existing Finnish search helper, uses a trigram FTS5 index for substrings of at least three characters, and a bounded source scan for shorter queries. Exact original identifiers rank first. Cursor ordering is stable by rank and original ID; cursors are bound to the normalized query, category and generation.

Detail responses contain one building's applicable records and associations, plus the identities of its shared-property members. Summary responses omit catalog record arrays and association lists while keeping global source metadata, coverage and join counts. Existing energy/solar exact-match and ambiguity exclusions determine precomputed theme colours; ranges and category counts describe the full prepared release and never change with viewport size. Unknown values stay neutral.

Every data query specifies the active generation. The server validates it against the private manifest; responses carry the same generation. The frontend declines a catalog from a different city generation. Source refresh failures retain dated, labelled data; a city mismatch prevents any catalog attachment. No source refresh runs inside an entity request.

## Digitraffic rail contract

`Vehicle.mode` includes `train`. Train source is exclusively `digitraffic`; identity is `digitraffic:<departureDate|undated>:<trainNumber>`. Rail-specific summary contains public label, category, operator, origin/destination, cancellation, the next timetable event and its retrieval time. Undated reports cannot match a journey. Source longitude/latitude order is retained, and speed converts km/h to m/s once at decode. Owner/operator identity may be null for rail. HSL IDs and deviation semantics remain unchanged.

`/api/traffic` and SSE snapshots/updates merge the two fleets and include independent `sources.hsl` and `sources.rail` states. The existing top-level `status` remains HSL for compatibility. Timetable enrichment can change a vehicle's metadata and named-event delay but cannot change `reportedAt` or `receivedAt`. Reports are stale at 30 seconds and removed at 120 seconds. Successful bounded snapshots remove absent rail IDs; unavailable requests retain the last positions until expiry. Source failures never remove the other fleet.

Read-only APIs return `RailResult<T>` (`ready|stale|unavailable`, data, retrievedAt, error):

- `GET /api/rail/stations`: in-area passenger stations, shared 24-hour catalog.
- `GET /api/rail/trains/YYYY-MM-DD/number`: shared 30-second journey metadata plus separate `route` context.
- `GET /api/rail/stations/code/departures`: next 12 passenger departures from a bounded source response, cached 30 seconds; GPS is not required. Unknown/out-of-area codes are rejected.

Rail times are ISO UTC instants displayed in `Europe/Helsinki`. Estimated and actual times remain distinct from scheduled time. Delay is `(actual or estimated) - scheduled` for the named event; absence stays null. Cancelled services and events are explicit. The next event comes from ordered timetable progress, labelled schedule-based, never from snapping a position.

The rail index is independent of HSL. It groups exact numeric train IDs with their service calendars, ordered stops and clipped shapes. The date suffix of an upstream trip ID denotes its timetable period; it is not used as the live departure date. Only one active journey for the reported date yields a route. Unknown, conflicting, missing-shape or expired data yields no invented geometry. GTFS extended hours and Helsinki DST use the shared noon-minus-12-hour service-day rule.

## Digitraffic marine AIS contract

Ships are separate `Vehicle` records with mode `ship`, source `digitraffic-marine`, and identity `ais:<canonical-nine-digit-MMSI>`. AIS identity is never merged with an HSL ferry by proximity or name. A valid in-area position remains visible when its optional metadata is absent. The current release bounds exclude Vuosaari; Digitraffic supplies Class A AIS only and filters fishing vessels, so local counts are reports rather than a complete or deduplicated harbour inventory.

| Field | Meaning and boundary rule |
| --- | --- |
| REST `properties.timestampExternal` | Position record time in epoch milliseconds; this drives `reportedAt`. |
| REST `properties.timestamp` | AIS second-of-minute/status code, not a timestamp. Codes 61 and 62 flag manual/estimated fixes; 63 is inoperative and not animated. |
| MQTT location `time` | Position record time in epoch seconds; convert to milliseconds exactly once. |
| REST/MQTT metadata `timestamp` | Metadata record time in epoch milliseconds; cannot refresh position age or receipt time. |
| MQTT status `updated` | Marine status record time in epoch seconds; does not refresh vessel positions. |
| Local receipt time | Record independently from each upstream timestamp for latency and age reporting. |
| SOG / COG / heading | Speeds arrive in knots and convert by `1852/3600` to shared metres/second. SOG `102.3`, COG `360`, and heading `511` mean unavailable; capped SOG `102.2` is unusable for motion. True heading stays distinct from course over ground. |
| Position and identity | Require finite WGS84 coordinates, reject `181/91` unavailable sentinels, validate the MMSI range/topic/property agreement, and reject older position revisions. Invalid optional metadata never discards a valid position. |

REST and MQTT records are reconciled by position record time. Since MQTT position time has second precision while REST keeps milliseconds, an equal-second record prefers the more precise REST observation; identical records are duplicates and conflicting same-second samples do not animate. A later-second MQTT report wins. Neither reconnect nor bootstrap may move a ship backward in record time. Metadata revisions are checked independently.

Marine age uses the provider position time. Moving or unknown-status vessels become stale after two minutes and leave the active scene after ten minutes. The stationary exception applies only to an anchored/moored vessel with valid speed no greater than 0.5 knots: stale after ten minutes, removed after thirty. Metadata age and marine source health remain separate. Rendering buffers ten seconds of received position samples, retains at most 64 points over 30 seconds plus a preceding point, and never extrapolates. Orientation uses true heading or, above 0.5 knots, course; otherwise the marker is nondirectional.

The feed bounds active ships at 250, metadata entries at 500, recent identity/version entries at 1,000, and queued metadata lookups at 250. It allows two concurrent metadata requests and 20 starts per minute, caches successful metadata for six hours and misses/failures for 15 minutes, and caps an individual REST body at 8 MiB with a 12-second timeout and no redirects. Position fallback/recovery is at most once per minute. MQTT input is capped at 32 KiB per message, 1,000 messages per second and 1 MiB per second. One WebSocket MQTT connection is shared per Node process; reconnect delays are 15/30/60 seconds plus jitter. Quiet marine state becomes stale after two minutes without a valid source update. The combined per-client SSE queue remains 8 MiB.
