# Helsinki Lens implementation plan

Build a browser-based digital twin of central Helsinki that combines semantic 3D buildings, live public transport, weather and air-quality observations, and building energy and solar records. The defining journey is to follow a tram, inspect its reported delay beside nearby observations, then select a building and explore its available records.

This plan defines five implementation tasks. Completion is recorded in the milestone acceptance checklists and results. Complete their acceptance checklists and record evidence before marking a task complete. The implementation belongs in this repository; Ocean Lens at `/Users/radu/Projects/ocean-leans` is the reference for appearance and reusable patterns.

## Milestones and dependencies

| ID | Task | Depends on | Result |
| --- | --- | --- | --- |
| A | [Prove the data and establish the foundation](milestones/A-data-foundation.md) | None | Reproducible source probes, sample assets, data contracts, runnable project |
| B | [Build the living city](milestones/B-living-city.md) | A core data gate | Selectable city geometry and real moving trams, buses, and ferries |
| C | [Connect inspection and environmental context](milestones/C-inspection-and-context.md) | B; A environmental gate | Vehicle, building, and station inspectors; contextual comparison and search |
| D | [Add building energy and solar potential](milestones/D-energy-and-solar.md) | C; A energy and solar gate | Correctly matched consumption and potential records, charts, thematic buildings |
| E | [Prepare and verify the release](milestones/E-release-readiness.md) | B, C, D | Accessible, responsive, tested production package and operating instructions |

Default execution order: **A → B → C → D → E**. A defines independent source gates so unresolved energy access does not prevent city and transit development. An unresolved gate remains visibly open; neither a missing-data placeholder nor an alternative dataset silently completes the corresponding feature. Reopen an upstream task when its assumptions prove wrong.

To use a milestone as a task, use its title and linked file as the task description, together with this master plan. Its scope is implementation plus verification and handoff. This planning request does not create separate Codex chats, assign people, or publish the application.

## Product scope

The initial area covers the city centre, the harbour, and the corridor to Suomenlinna. A fixes the exact geographic boundary after sampling source coverage and building sizes. Select a smaller central district within it for the first working slice. District loading should support expanding the initial area without loading every building at startup.

The first working slice is semantic buildings, live trams, a real weather station, and a building inspector. B delivers the geometry and movement; C completes this journey. The complete first release adds buses and HSL ferries, air-quality stations, route context, search, and energy and solar records.

Keep Ocean Lens's scene-first layout: compact header, layer panel on the left, conditions summary, selected-object inspector on the right, camera presets, and a source drawer. Use a light building palette over a restrained geographic base, distinct transit mode colours, and explicit legends for thematic overlays. Preserve readability at street and district scales. A detailed vehicle model is illustrative and must never imply knowledge of the exact vehicle appearance.

No historical transit replay, forecast playback, citywide photogrammetric mesh, predictive delay model, pollution dispersion model, accounts, or editing of city assets is included. Current transit and historical energy charts use separate time controls. Add those larger capabilities only through new tasks.

## Architecture decisions

Use SvelteKit, TypeScript, Three.js, and the Node adapter, following the existing Ocean Lens structure. Reuse selected UI and rendering patterns; do not copy the entire application or change Ocean Lens. Keep a single package manager and lockfile. Establish actual supported package versions during A.

Use prepared spatial chunks for static geometry, small JSON indexes for identifiers and metadata, one shared server-side HSL MQTT subscription per process, and server-sent events for browser traffic updates. Use an MQTT library for protocol handling rather than implementing it. Parse XML with an appropriate maintained library if the selected FMI and CityGML formats require it. Add dependencies only for concrete format or protocol needs.

Use file-backed caches and in-memory current state initially. No database, queue service, general plugin framework, or distributed feed coordination is required. Production initially runs a single application process; multi-process operation requires a later shared-feed design.

Choose a CityGML conversion tool in A using an actual source sample. Browser assets should retain the semantic building identity while reducing geometry transfer and draw calls. Do not write a general CityGML engine. If the scoped Three.js renderer fails the measured B budgets even after chunking and batching, document the evidence and revise the renderer choice before expanding coverage.

## Shared data contracts

The contracts below describe required semantics, not a mandate for a generic framework. Implement small typed records and source-specific adapters. Keep fixtures beside their corresponding tests.

| Record | Required information |
| --- | --- |
| Dataset source | Provider, URL, license and attribution, retrieval time, source vintage or validity, units, coverage, method, and source version/checksum where available |
| Building | Internal stable ID, original GMLID/RATU/VTJ-PRT identifiers when available, chunk reference, geometry location, available attributes, source reference |
| Vehicle | Provider-scoped vehicle identity, mode, route and journey references, reported and received times, position, speed, heading, schedule deviation, data quality, source reference |
| Observation | Station identity and location, parameter, value or null, unit, observed and received times, quality/aggregation information, source reference |
| Energy record | Property/meter/building scope, matched building IDs, metric, period, value or null, unit, measured or modeled method, source reference |
| Solar record | Building or surface scope, matched IDs, potential metric and unit, calculation period, source vintage, model assumptions, source reference |

All source IDs remain strings. Missing values stay null or absent, never zero. Preserve original identifiers alongside normalized values. Separate reported/observed time from received time. Store timestamps in UTC; display time in `Europe/Helsinki`. Transit service dates and times beyond midnight must not be treated as ordinary calendar timestamps without GTFS rules.

Preserve each dataset's declared coordinate system, axis order, units, and vertical reference. Convert to a common local metric scene with a nearby origin; keep WGS84 for API exchange. Verify Helsinki's ETRS-GK25/N2000 geometry against control locations. GPS vehicles use the rendered ground surface, not assumed GPS altitude.

Retain raw HFP timetable deviation and normalize a display value where positive means late. HFP documents negative deviation as lagging behind schedule. Do not reuse GTFS-RT sign assumptions without an adapter. Scope vehicle identity by operator and vehicle identifier as required by HFP; route labels alone are not vehicle or journey IDs.

## Suggested implementation areas

These paths establish ownership boundaries without requiring every file in advance. Reuse the surrounding structure and merge files where simpler.

- `src/routes/+page.svelte` and `src/lib/components/`: application layout, controls, inspectors, source drawer.
- `src/lib/scene.ts`, `src/lib/geo.ts`, and `src/lib/live-fleet.ts`: rendering, coordinate conversion, selection, vehicle movement.
- `src/lib/types.ts` and source-specific data modules: the shared contracts and normalization.
- `src/lib/server/`: HSL subscription, observation and energy adapters, validation, caches.
- `src/routes/api/`: traffic snapshot/stream and bounded observation/energy endpoints.
- `scripts/`: bounded source probes and reproducible asset preparation.
- `static/data/`: generated manifests, indexes, and spatial assets; keep large downloaded/generated assets out of Git.
- `tests/fixtures/` and `tests/`: small attributable samples and meaningful regression tests.
- `docs/`: access findings, preparation instructions, verification evidence, and release operations.

## Shared quality requirements

Validate upstream data, finite coordinates, timestamps, units, and scope before use. Enforce bounds, request timeouts, bounded payloads, and cache limits. Browser parameters must never become arbitrary upstream URLs. Keep credentials on the server and out of logs and generated assets.

Disconnected feeds retain dated observations with visible status. They never substitute invented readings or simulated vehicles. Metadata refresh must not make an old position appear fresh. Offline fixtures belong only in an explicitly labelled development/test mode.

Colour is supplemented with labels and legends. Every selectable scene object needed for the core journey must have a keyboard-accessible list or search equivalent. Respect reduced motion. Distinguish loading, empty coverage, unknown values, stale reports, and upstream failure.

Initial performance targets, to be measured and recorded in B, are at least 30 FPS in the representative district view, an interactive initial view within 5 seconds on a documented 20 Mbps connection, and p95 server-receipt-to-browser-update latency under 2 seconds in a controlled test. These are targets rather than claims about provider latency. Record the test hardware, browser, asset size, vehicle count, and network assumptions. Test the observed local fleet and twice its sampled peak count. E verifies the same workloads.

## Completion and handoff

Task E completed on **8 October 2026**: B/C/D gates verified, full production soak and reproducible local release checked. See [E results](milestone-results/E.md) for final assets, browser exceptions, source coverage and operating evidence. Public deployment remains a separate action.

Each milestone records the changed files, commands/checks run, source sample dates, acceptance results, remaining gaps, and implications for the next task in `docs/milestone-results/<ID>.md`. Mark each acceptance item pass, fail, or blocked with evidence. Do not label an entire milestone complete while a required feature is blocked.

At the end of each task, run the appropriate type/build checks and meaningful tests for changed behavior. Do not require live third-party availability for ordinary regression tests. Use separate live smoke checks, preserving source timestamps and sample outcomes. No deployment, public URL, or uptime claim is complete without direct verification of that environment.

## Source references and current evidence

The user reported a successful anonymous tram subscription and seven weather observations. Official documentation was reviewed during planning on 8 October 2026; that review is not a new live endpoint test. A must produce dated, reproducible runtime evidence.

- [Ocean Lens reference architecture](../../ocean-leans/README.md) is the local product reference; its marine projection, AIS parser, forecasting timeline, branding, and analytics configuration must not be carried across unchanged.
- [Helsinki 3D](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d) describes semantic identifiers, CityGML downloads, coordinate references, and the Energy and Climate Atlas. Some visual downloads omit building characteristics.
- [HSL HFP](https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/high-frequency-positioning/) describes the feed, message fields, and expected reporting cadence. Verify authentication for each additional API separately.
- [HSL open data and terms](https://www.hsl.fi/en/hsl/open-data) covers GTFS and attribution; OSM-derived content has separate terms.
- [FMI open data](https://en.ilmatieteenlaitos.fi/open-data) and [WFS guidance](https://en.ilmatieteenlaitos.fi/open-data-manual-wfs-examples-and-guidelines) cover observations and query patterns.
- [Municipal energy records](https://hri.fi/data/en_GB/dataset/helsingin-kaupungin-palvelukiinteistojen-energiankulutustietoja) describes Nuuka and the distinction between properties and buildings.
- [HSY solar potential](https://hri.fi/data/fi/dataset/paakaupunkiseudun-aurinkosahkopotentiaali) is a candidate building-level solar source. The exact resource, vintage, units, and schema must be verified in A.
