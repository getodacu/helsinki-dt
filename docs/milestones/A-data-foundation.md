# Milestone A Data foundation

**Status:** Implemented and verified; modeled-energy and solar gates blocked  
**Depends on:** None  
**Task:** Prove the Helsinki sources and create the minimum runnable project and preparation pipeline. Follow the shared scope and contracts in [the implementation plan](../implementation-plan.md).

## Outcome

Produce a reproducible small dataset that makes the later tasks executable. Confirm what can be retrieved, how records join, and what coverage is missing before investing in the full city interface.

## Implementation steps

1. Establish the project foundation from selected Ocean Lens conventions: SvelteKit with Node adapter, TypeScript, Three.js, one lockfile, type checking, build command, and fixture-based tests. Create a minimal application shell, not the finished interface. Inspect applicable repository instructions before reusing code. Do not copy secrets, analytics identifiers, caches, or generated marine assets.
2. Select and save the initial area polygon/bounds, a smaller central test district, and geographic control locations. Include the Suomenlinna ferry corridor in the intended release extent. Record source feature counts and download sizes before retrieving full tiles.
3. Implement bounded source probes. Record URL/query, sample date, request duration, status, decoded result count, freshness, units, coordinate system, source terms, and any authentication requirement. Validate payload content rather than treating HTTP success as proof. Bound MQTT subscriptions by time and relevant modes/region; avoid an unlimited archive.
4. Fetch semantic CityGML containing actual building attributes. Inspect LoD1/LoD2 availability, roof and terrain geometry, identifier fields, invalid/duplicate objects, and chunk sizes. Evaluate an existing converter on the sample. Produce a small browser-ready chunk and metadata index with stable pickable building IDs. Record the conversion command and source-to-output identity mapping.
5. Probe HFP trams, buses, and ferries independently during an appropriate service period. Sample update intervals, null positions, deviation fields, operator identities, mode values, and journey references. Fetch a bounded or locally filtered GTFS snapshot, inspect service dates, and demonstrate one unambiguous HFP-to-GTFS journey match. Separate the core broker from APIs that may require registration.
6. Discover weather and air-quality query types/stations from provider metadata. Fetch bounded observations for the area and record available parameters, quality flags, aggregation intervals, null encodings, and publication lag. Prefer station observations; do not generate interpolated pollution fields.
7. Probe Atlas/other documented energy exports, municipal Nuuka records, and HSY/Atlas solar resources. Inspect actual identifiers and sample units. Demonstrate exact joins where possible, identify property-to-many-building cases, and calculate match/missing/ambiguous counts. Record historical/model vintage independently of retrieval time.
8. Create the typed normalized records, tiny source fixtures, source manifest, and repeatable sample preparation command. Write outputs atomically so a failed refresh cannot replace valid assets. Keep bulky raw downloads and runtime caches ignored.

## Deliverables

- Runnable application foundation and documented install/check/test/build commands.
- `docs/data-access.md` with probes, source terms, resource URLs, coverage, sample times, and authentication requirements.
- `docs/data-contracts.md` with verified source mappings, coordinate conversion, units, and identity rules.
- A small semantic building sample, transit fixtures for each obtained mode, observation fixtures, and energy/solar join examples.
- Reproducible preparation scripts and generated-asset manifest with source vintage and checksums where available.
- `docs/milestone-results/A.md`, including independent gate outcomes.

## Acceptance checklist

Results and dated evidence are recorded in [Task A results](../milestone-results/A.md). The core, ferry, environmental and publication gates pass; A remains incomplete until modeled-energy units and solar associations are verified.

- [x] **Core gate:** the clean project installs, type-checks, tests, and builds using documented commands.
- [x] **Core gate:** at least 20 actual buildings in the central sample retain semantic identity and available attributes after conversion. At least three identifiable locations verify horizontal alignment and elevation treatment.
- [x] **Core gate:** real tram and bus samples are decoded.
- [x] **Ferry coverage gate:** a real ferry sample is decoded. If ferry service cannot be sampled, this separate gate remains open for B rather than blocking initial city development or declaring absence of service.
- [x] **Core gate:** one selected transit journey matches the current GTFS snapshot without a label-only guess; unknown matches remain unknown.
- [x] **Environmental gate:** valid weather and air-quality observations identify their station, time, unit, and quality/aggregation context. Seven reported weather observations are not assumed to mean seven distinct stations.
- [ ] **Energy and solar gate:** demonstrate at least one valid measured-energy association, one modeled energy association, and one solar association within the intended area, plus a documented multi-building case where present. Record coverage percentages and ambiguities. Missing source categories remain blocked. **Blocked:** measured association and shared-property totals pass; modeled units and solar association/metadata remain unverified.
- [x] **Publication gate:** each intended distributed asset has documented attribution and applicable reuse terms; uncertain datasets remain outside distributable outputs.
- [x] A second preparation run produces a usable sample without corrupting previous outputs; time-varying data may legitimately differ.

## Verification

Use focused tests for longitude/latitude order, coordinate control points, source ID preservation, HFP deviation sign and vehicle identity, UTC/service-date handling, missing numeric values, and deterministic identifier joins. Check a known multi-building record does not duplicate total consumption onto every member. Test a rejected or malformed source response and a failed preparation write.

Live checks are separate from fixture tests. Preserve compact evidence and sample timestamps. An HTTP denial, unavailable source, unknown license, or missing ferry sample becomes an explicit open gate with the exact affected feature and next action.

## Scope boundary and handoff

Do not build the complete UI, collect citywide history, or add a database. B may proceed once its core requirements are met, even if environmental or energy gates remain open; C and D must resolve their corresponding gates before completion. Reuse later discovery to update these mappings instead of introducing parallel definitions.
