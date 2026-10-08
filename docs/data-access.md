# Helsinki Lens data access

> **D resolution — 8 October 2026:** [D's completed source evidence](energy-solar-evidence.md) verifies modeled demand units and original Atlas solar building associations for the release city. [Solar method/export evidence](solar-method-evidence.md) records the historical export vintage and unknown weather/run settings. The source probes, blocked energy/solar findings and smaller geometry counts below remain A's dated evidence; use the [D report](milestone-results/D.md) for current joins, runtime cache and release requirements.

Task A's bounded live checks ran on 8 October 2026. Prepared assets are dated source samples, not a live application feed. The exact queries, reception times, counts, freshness, byte limits and diagnostics are retained in the generated manifest/probe evidence and ignored `.cache/task-a` inspection results. Source vintage is separate from retrieval time.

## Sources, access and terms

| Dataset | Access and schema | Reuse / attribution |
| --- | --- | --- |
| [Helsinki semantic CityGML](https://3d.hel.ninja/data/citygml/Helsinki3D_CityGML_Kalasatama_20190326.zip) | Anonymous ZIP; 2019-03-26 CityGML2; EPSG:3879 E/N/metre-height tuples, N2000. LoD1/LoD2 and national/municipal/UUID identifiers. | City of Helsinki, CC BY 4.0; [Helsinki3D terms/source](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d). Sample strips missing appearances, corrects declared CRS typo, triangulates and preserves identities. |
| HSL HFP | Anonymous TLS MQTT `mqtts://mqtt.hsl.fi:8883`; separate tram/bus/ferry topics, owner/vehicle identity and UTC reports. | HSL/Digitransit, CC BY 4.0; [official HSL terms](https://www.hsl.fi/en/hsl/open-data), delivery time included. |
| [HSL GTFS](https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip) | Anonymous daily ZIP, 76,200,482bytes compressed; ~1GB allowlisted CSV inflation streamed. Snapshot validity 20261007–20261205. | HSL, CC BY 4.0 with delivery time. No OSM JourneyPlanner geometry/address dataset included. |
| [FMI WFS](https://opendata.fmi.fi/wfs) | Anonymous List/DescribeStoredQueries, parameter metadata and station time-value XML. Weather 100971 and urban AQ 100742. EPSG:4258 response latitude/longitude, query bbox longitude/latitude. | FMI weather; HSY urban AQ via FMI. [FMI license](https://en.ilmatieteenlaitos.fi/open-data-licence) covers both CC BY 4.0 datasets. |
| [Nuuka municipal energy](https://helsinki-openapi.nuuka.cloud/swagger/Nuuka%20Open%20API/swagger.json) | Anonymous property search and bounded daily Electricity query; property-scope kWh and dated daily periods. BuildingCode query still returns property consumption. | City of Helsinki CC BY 4.0; [HRI dataset](https://hri.fi/data/en_GB/dataset/helsingin-kaupungin-palvelukiinteistojen-energiankulutustietoja). |
| Atlas basic / HEKA / modeled workbooks | Anonymous published XLSX exports; explicit GMLID/VTJ fields, historical 2015–2018 measurements and 2020–2050 modeled scenarios. Model units remain unverified. | City of Helsinki CC BY 4.0; exact resource URLs, checksums and periods in [geometry/energy evidence](geometry-energy-evidence.md). |
| [HSY solar WFS](https://kartta.hsy.fi/geoserver/wfs) | Anonymous schema and bbox sampling of `ilmasto_ja_energia:rakennukset_aurinkosahkopotentiaali`; real feature IDs/geometry/area/potential, no shared building IDs. | HSY CC BY 4.0; [dataset metadata](https://hri.fi/data/fi/dataset/paakaupunkiseudun-aurinkosahkopotentiaali). No normalized solar value distributed before association/units/vintage are evidenced. |

CC BY 4.0 requires attribution and disclosure of transformations. The current official HSL terms were separately retrieved through the web connector after a direct request encountered a JavaScript/cookie challenge. The old Digitransit documentation path returned 404; do not confuse documentation access with the successfully sampled anonymous MQTT broker. Additional Digitransit APIs can require separate registration; they are not used here. No credentials are needed for the selected sources.

The CityGML WFS returned 503/timeouts during source discovery, so the reproducible geometry path uses the verified published ZIP. Archive names do not define coverage: source envelopes are projected and filtered against the saved Senate polygon. No full-city history or full uncompressed GTFS archive is retained.

## First combined preparation evidence

The first complete generation began at **2026-10-08T11:02:56.306Z** and published 159 usable semantic buildings, 44,853 triangles, 60 distinct latest vehicle records, 16 parameter/time observations from two stations and 2 shared-property daily measurements. The generated geometry JSON is 9,696,361bytes. Exact counts for subsequent samples legitimately vary.

| Probe | UTC query time | Status | Duration ms | Bytes | Decoded count |
| --- | --- | --- | ---: | ---: | ---: |
| buildings-citygml | 2026-10-08T10:45:13.763Z | cached checksum verified | 0 | 23546638 | 3011 |
| citygml-converter | 2026-10-08T10:45:32.869Z | cached checksum verified | 0 | 28859935 | 159 |
| nuuka-property-energy | 2026-10-08T11:03:02.296Z | 200 | 590 | 22758 | 2 |
| atlas-atlas | 2026-10-08T10:51:53.185Z | cached checksum verified | 15 | 8050709 | 77249 |
| atlas-heka | 2026-10-08T10:53:04.961Z | cached checksum verified | 1 | 360824 | 1937 |
| atlas-modeled | 2026-10-08T10:51:57.732Z | cached checksum verified | 19 | 31131188 | 46641 |
| hsy-solar | 2026-10-08T11:03:02.749Z | 200 | 580 | 7645 | 5 |
| hfp-tram | 2026-10-08T11:02:56.307Z | bounded MQTT session completed | 30029 | 77676 | 49 |
| hfp-bus | 2026-10-08T11:02:56.307Z | bounded MQTT session completed | 30030 | 77676 | 68 |
| hfp-ferry | 2026-10-08T11:02:56.307Z | bounded MQTT session completed | 30030 | 77676 | 7 |
| hsl-gtfs | 2026-10-08T10:54:54.985Z | one-hour bounded cache | 0 | 76200482 | 215 |
| fmi-query-list | 2026-10-08T11:02:56.333Z | 200 | 413 | 66273 | 0 |
| fmi-query-description | 2026-10-08T11:02:56.746Z | 200 | 61 | 8702 | 2 |
| fmi-parameters | 2026-10-08T11:02:56.813Z | 200 | 65 | 2436 | 4 |
| fmi-weather | 2026-10-08T11:02:56.877Z | 200 | 67 | 15221 | 12 |
| fmi-air-quality | 2026-10-08T11:02:56.946Z | 200 | 69 | 6313 | 4 |

Weather and air-quality counts are readings/series, not distinct stations. The source's lack of quality flags remains unknown; averaging intervals come from parameter metadata. MQTT cadence is deduplicated by owner/vehicle/reported timestamp. Null-position sampling follows selected owner/vehicle topics because regional subscriptions exclude null locations.

## Reproduction and independent gates

Use Node 24+, Java 17+ and the commands in [README](../README.md): `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run data:probe -- --source observations|transit|geometry|energy|all`, and `npm run data:prepare`. Protocol/parser versions and one npm lockfile are pinned. The converter is pinned to 2.5.0 and checksum-verified; original conversion options and source-to-output identity mapping are documented in the geometry report.

`data:prepare` exit 0 means every recorded source gate passed; exit 2 means usable assets were published with explicit open gates; exit 1 means no usable licensed geometry or a failed refresh, with the previous sample retained. Regression tests stay offline. A clean checkout starts in the explicit unprepared state; bulky generated assets, downloads and caches are ignored. Running preparation creates the local licensed sample.

The geometry, coordinate, tram, bus, ferry, GTFS, weather, AQ, measured-energy and publication gates pass. Modeled energy is blocked on an authoritative unit declaration despite an exact City Hall join. Solar is blocked on an evidenced building association and authoritative units/vintage/assumptions. The milestone remains incomplete; B can use the passed core gate, while D requires those source gaps to be resolved.

See [contracts](data-contracts.md), [coordinate evidence](coordinate-controls-evidence.md), [transit/environment evidence](transit-environment-evidence.md), [geometry/energy evidence](geometry-energy-evidence.md), and [acceptance results](milestone-results/A.md).
