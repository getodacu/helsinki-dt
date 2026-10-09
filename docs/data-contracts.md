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
