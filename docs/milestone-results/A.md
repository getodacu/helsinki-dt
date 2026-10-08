# Task A — Helsinki data foundation results

> **D resolution — 8 October 2026:** The [completed D report](D.md) and [original energy/solar evidence](../energy-solar-evidence.md) resolve the modeled-unit and solar-association gates for the current release city. D verifies kWh demand, seven original annual scenarios and original Atlas solar parent IDs with historical export vintage and explicit unknown assumptions. The status, blocked findings and 159-building ambiguity counts below describe A's earlier snapshot and remain unchanged historical evidence. Current release counts and five verified associations are in D.

**Status: implemented and verified; incomplete while modeled energy and solar are blocked.**  
**Evidence date:** 8 October 2026.  
**Handoff:** the core, ferry and environmental gates pass. B may proceed; D must resolve its modeled-energy and solar gates before completion.

## Acceptance results

Every item in [Milestone A](../milestones/A-data-foundation.md) is assessed below. No final acceptance item is failed; the combined energy/solar item remains blocked.

| Acceptance item | Result | Evidence |
| --- | --- | --- |
| Clean install, type checking, tests and build | **Pass** | Node 24.19.0 / npm 11.17.0; clean `npm ci`, zero type errors/warnings, 42/42 offline tests and production build passed. One npm lockfile and the specified exact application versions. |
| At least 20 semantic buildings; three location controls and elevation treatment | **Pass** | Actual citygml-tools 2.5.0 conversion produced 159 original buildings and 44,853 triangles. City Hall, Cathedral and National Library controls fall within actual mesh extents; source N2000 extrema are preserved. Identity, duplicate LoDs and real raycast picking are tested. [Evidence](../geometry-energy-evidence.md), [controls](../coordinate-controls-evidence.md). |
| Real tram and bus samples decoded | **Pass** | Second combined preparation retained 28 trams and 5 buses; its bounded probes decoded 57 tram and 37 bus reports. Owner/vehicle identity, payload operator and `−dl` delay mapping are preserved. [Evidence](../transit-environment-evidence.md). |
| Real ferry sample decoded independently | **Pass** | One ferry retained; 9 real reports decoded in the second preparation, including a selected vehicle subscription without the regional filter. |
| One exact current HFP-to-GTFS journey match | **Pass** | Owner/vehicle `0040/00444`, route `1002`, direction `2`, service date `2026-10-08`, Helsinki start `13:52` uniquely matched `1002_20261007_To_2_1352`. Active service, direction and first-stop departure are checked; ambiguous matches stay unknown. |
| Weather and air-quality station observations with context | **Pass** | 12 parameter/time readings at Kaisaniemi station `100971`, plus 4 NO₂ readings at Mannerheimintie station `100742`. Times, coordinates, provider units and aggregation are retained; unavailable quality flags remain unknown and `NaN` becomes null. These are two stations, not 16. |
| Measured energy, modeled energy and solar associations; shared-property coverage | **Blocked** | Measured association passes: City Hall uniquely joins Leijonakortteli property `091-001-0030-0001`. Two property/day kWh totals are stored once. Model association is exact but units are unverified; solar has no evidenced building crosswalk or complete authoritative model metadata. No modeled or solar values are published. [Evidence](../geometry-energy-evidence.md). |
| Applicable publication terms and attribution for distributed assets | **Pass** | All distributed records identify their source and verified CC BY 4.0 terms. Provider attribution and transformations are recorded. Unverified model/solar values remain outside normalized outputs. [Access and terms](../data-access.md). |
| Second preparation produces usable assets and preserves valid outputs | **Pass** | Two full live runs published usable generations with exit 2 solely for the two intentional open gates. Stable building/geometry hashes match. Failed-source and failed-write tests verify that the previous manifest and asset bytes remain available. |

The prepared manifest exposes 12 independent source gates: **10 pass, 2 blocked**.

| Source gate | Result | Evidence / next action |
| --- | --- | --- |
| `building_geometry` | **Pass** | 159 usable original buildings; 7 compatible repeated GMLID records reconciled; one degenerate building excluded with its identity and reason. |
| `coordinate_controls` | **Pass** | Three independent official Service Map coordinates checked against converted meshes; N2000 heights retained. This is datum preservation, not an independent absolute-height survey. |
| `tram` | **Pass** | Real bounded MQTT probe and attributable fixture. |
| `bus` | **Pass** | Real bounded MQTT probe and attributable fixture. |
| `ferry` | **Pass** | Real bounded MQTT probe and attributable fixture. |
| `gtfs_journey` | **Pass** | Exact current route/direction/service/departure match; calendar exceptions, extended hours and both DST transitions tested. |
| `weather` | **Pass** | Kaisaniemi station observations with discovered query and parameter metadata. |
| `air_quality` | **Pass** | Central Mannerheimintie station observations with hourly NO₂ aggregation metadata. |
| `measured_energy` | **Pass** | One exact, one missing and one ambiguous property member; two kWh daily records retain property scope without duplicated totals. |
| `modeled_energy` | **Blocked** | 118 exact retained model rows (74.2% of 159 buildings), 9 identifier conflicts and 32 buildings without a retained row. Obtain authoritative energy units for the 2020-10-21 heating-demand workbook; its City Hall identifiers already match. |
| `solar` | **Blocked** | Five real HSY building-level features decoded; 331 district bbox matches advertised, zero attached records. Establish an evidenced feature-to-building association and authoritative units, vintage and model assumptions. |
| `publication` | **Pass** | Licensed normalized assets only, with attribution, byte sizes, counts and SHA-256 checksums. |

## Prepared sample and source dates

Release bounds are `[24.90, 60.135, 25.04, 60.195]`; Senate district bounds are `[24.944, 60.164, 24.958, 60.174]`. The origin is `[24.952, 60.1695, 0]`, with local metre axes `[east, elevation, −north]` and N2000 heights.

| Generation UTC timestamp | Buildings / triangles | Latest vehicles | Observations | Measured property/day records | Preparation exit |
| --- | --- | --- | --- | --- | --- |
| 2026-10-08T11:02:56.306Z | 159 / 44,853 | 60 | 16 | 2 | 2: usable sample, open gates |
| 2026-10-08T11:15:33.022Z | 159 / 44,853 | 34: 28 tram, 5 bus, 1 ferry | 16: 12 weather, 4 AQ | 2 | 2: usable sample, open gates |

The current manifest is `static/data/manifest.json`, pointing to generation `20261008111533022-4ac4774e-dad2-443e-8e60-1c667162cd35`. All seven current assets were checked against manifest byte sizes, counts and SHA-256. Both generations remain usable. Their building and geometry hashes agree:

- Building index: `14bcfd810ca8e0e57a42f58d1b999942645ccbc2e00a1fc0eefa5a1236cc9cc2`.
- Triangle chunk: `364676adf4bb27485288e6f1fa973b651fc862fc3e6ecbada08e5282c04e0a3a`, 9,696,361 bytes.

The geometry archive vintage is 2019-03-26, independent of its 2026-10-08 retrieval. Its compressed/inflated sizes are 23,546,638 / 268,161,653 bytes. The current GTFS snapshot covers 2026-10-07–2026-12-05 and was retrieved at 2026-10-08T10:54:54.985Z. The second MQTT window began at 11:15:33.023Z and ran for about 30 seconds. FMI readings cover 07:00–10:00Z; their latest observation is about 75 minutes older than reception. Nuuka values are daily local date labels for 6–7 October 2026, not invented UTC instants. Atlas vintage/scenario years and unresolved HSY vintage remain separate from retrieval time.

Nuuka's three declared property members yield one exact match (33.3%), one ambiguous match and one missing ID. The exact measured association covers 1/159 district buildings (0.6%); this is shared-property electricity, not a City Hall-only consumption total. Atlas basic rows cover 152/159 (95.6%); HEKA has no district association. Coverage here describes this selected sample, not all Helsinki buildings.

Tiny attributable geometry, transit, FMI and energy fixtures remain in `tests/fixtures/`. [Geometry/energy fixture notes](../../tests/fixtures/geometry-energy-fixtures.md) distinguish real source records from synthetic parser cases. Larger downloads, caches, converter files and generated generations are ignored. A clean checkout is explicitly unprepared until live preparation succeeds.

## Verification performed

```sh
npm ci --cache /private/tmp/helsinki-task-a-npm-cache
npm run check
npm test
npm run data:prepare
npm run data:prepare
npm run build
HOST=127.0.0.1 PORT=4180 node build/index.js
```

Clean installation completed with 308 packages and zero reported audit vulnerabilities. Type checking returned zero errors and warnings; all 42 regression tests passed; the production build succeeded. The commands above record the checks performed; [README](../../README.md) gives the normal installation and preparation workflow. Separate `npm run data:probe -- --source observations|transit|geometry|energy|all` commands support bounded live investigation without publication.

The offline suite covers coordinate order/control points, original string identity, compatible/conflicting duplicate LoDs, highest usable geometry, polygon holes, real raycast-to-building picking, HFP delay sign/operator identity, active service/calendar exceptions, extended GTFS hours, Helsinki DST transitions and repeated-hour ambiguity, null observations, deterministic joins, shared-property totals, malformed responses, bounded workbook/ZIP parsing and failed writes/refreshes. The ExcelJS UUID override also has a workbook write/read regression.

The built application was started locally at `http://127.0.0.1:4180/`. Browser verification loaded the real prepared sample and selected City Hall with the keyboard. Its inspector showed original GMLID `BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e`, VTJ-PRT `103027184J`, RATU `216`, source attributes and provenance. A local preview screenshot was saved as review evidence. No deployment or public uptime claim was made.

Integration review identified and resolved DST-clock matching, all-null measured-energy gate handling and failed-refresh publication. Failed refresh diagnostics are saved under `.cache/task-a/latest-preparation.json`; they do not replace the previous valid sample. Old-generation cleanup after successful publication is best effort so a cleanup failure cannot misreport a valid publication as a failed refresh.

## Changed areas and handoff

- Foundation: `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig.json`, `vite.config.ts`, `src/app.html`, `src/app.css`, `src/routes/` and `README.md` establish the pinned npm/Node stack and minimal status/building inspector shell.
- Contracts and normalization: `src/lib/types.ts`, `src/lib/area.ts`, `src/lib/geo.ts` and `src/lib/data/` preserve provenance, identities, scope, units, timestamps, coordinates and independent gates.
- Bounded access and reproducible preparation: `src/lib/server/io.ts` and `scripts/` implement MQTT/GTFS/FMI/CityGML/workbook/Nuuka/HSY probing, conversion, staging, checksums and atomic manifest publication. HTTP time/byte, inflation and retained-record limits are explicit.
- Regression evidence: `tests/` and small fixtures; [access findings](../data-access.md), [contracts](../data-contracts.md), [coordinate controls](../coordinate-controls-evidence.md), [transit/environment evidence](../transit-environment-evidence.md), [geometry/energy evidence](../geometry-energy-evidence.md) and this report.

B can use actual pickable triangles, the building index and all three transport adapters. Continuous subscriptions, traffic endpoints, the scene renderer, performance targets and the finished interface remain B/C work. The environmental data gate is ready for C. D must verify the modeled units and solar association/metadata before exposing values or declaring its gate complete.

ExcelJS streaming supports the inspected provider workbook layout; unsupported ZIP entry ordering fails visibly. No general XLSX/CityGML engine, database, full-city history, independent height survey or deployment was added. Preparation needs Java 17+ and live anonymous provider access; source outages retain dated assets with explicit failure diagnostics. Production static assets require rebuilding after a refresh.
