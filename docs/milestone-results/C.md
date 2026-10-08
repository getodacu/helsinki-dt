# Task C — Inspection and environmental context results

**Status: Complete.**  
**Evidence date:** 8 October 2026.

Task B and Task A’s environmental gate pass. C’s implementation, 95 offline tests, type checking, production build, independent review, production fixture journey, mobile controls/focus/reduced motion and separate live journey pass. A’s modeled-energy and solar gates remain open for D. No deployment or commit was made; all existing A/B work was preserved.

## Acceptance results

| Acceptance item | Result | Evidence |
| --- | --- | --- |
| Follow a real tram, delay, environmental context, then building without losing live updates | **Pass** | Final production live journey at 13:37:12.692Z followed tram 0040/00075, route 1001 / trip 1001_20261007_To_2_1607 with 18 scheduled stops; inspected real AQ and weather history, then City Hall. Live HSL report times continued changing at every step. |
| Correct early/late/unknown delay and signs | **Pass** | Fixture regressions preserve HFP sign inversion, exact signed seconds, null/unknown and the inclusive application ±60 s band; browser fixture shows 120 s late. |
| Exact shape/stops, overnight service, ambiguous unavailable state | **Pass** | A’s actual route-1002 journey has 164 shape points and 14 stops; production fixture verifies matching trip/stop count. Overnight 25:10, calendars/DST, ambiguity, outside-shape competing trips, clipped path gaps and unavailable geometry pass deterministic tests. |
| Keyboard building/route search uses scene identities | **Pass** | Production fixture at 1440 × 1000 uses keyboard route search to select 0040/00444 and building search to select City Hall VTJ-PRT 103027184J/GMLID BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e. Both use scene.select, the same identity contract as pointer picking. Actual Three.js building, vehicle and station raycasts pass. All 8,909 prepared building identities are searchable. |
| Environmental station/distance/time/unit/quality/aggregation | **Pass** | Live source check at 12:55:22.972Z returned temperature/wind/gusts, hourly rain and NO₂ with station metadata, actual units/aggregation and explicit unknown quality. Cards expose distance, observed/received times, station scope and source. |
| Air quality at actual stations | **Pass** | NO₂ is a selectable marker at Mannerheimintie (100742), 24.93924° E / 60.16964° N. Kaisaniemi weather (100971) is a separate actual station. No heatmap, interpolation or generic AQI. Source/type/coordinates survive real picking tests. |
| Failed/stale/empty/partially missing responses distinguished | **Pass** | Offline cache tests verify cold unavailable, successful empty, null/absent partial, observed staleness and refresh-failed dated retention with unchanged retrieval/measurement times. Production fixture shows partial weather/current AQ with null chart gaps. A separate production browser fixture at 13:40:53.410Z verifies distinct stale/empty/unavailable/partial badges and readable explanations for both sources. Actual HTTP invalid observation and incomplete journey requests return 400; tests reject alternate stations/windows/URLs/duplicates. |
| Live transit independent from historical observation cursor | **Pass** | Production fixture at 13:09:11.471Z holds a real historical 07:00Z temperature while four fixture traffic updates arrive; chart cursor/time remains unchanged and independent-time explanation is visible. The separate real-source journey holds the 07:40Z historical temperature while HSL timestamps advance; the historical value/time stays unchanged. |
| Desktop/mobile controls, visible focus/reduced motion | **Pass** | Desktop 1440 × 1000 and mobile 390 × 844 pass. Mobile sheets/scene, building selection, layers, source drawer/Escape and reduced motion pass with no horizontal scroll. At 13:39:52.075Z actual Tab focus matches :focus-visible and displays a solid 2 px teal outline. Real-source mobile screenshots at 13:42:17.871Z were inspected. |

## Deterministic and build verification

Final `npm test` passed **95/95**, zero failed/skipped tests. `npm run check` reported zero errors and zero warnings. `npm run build` passed with the existing Three.js bundle-size advisory and terminal colour advisory. Svelte’s official component checker found zero issues in the page, city scene and new components; expected imperative-effect suggestions were reviewed. No application code changed after these checks.

The regression suite adds bounded observation single-flight/cadence/error/state/metadata/null/gap/request checks; delay/search/address formatting; all-building metadata-only loading with partial failure and cancellation; GTFS exact/missing/ambiguous/overnight/DST/shape/stops/preparation/atomic-publication/source-checksum/bounds validation; route filter track retention and station/route rendering/picking. Live services are excluded from ordinary regression tests.

An independent Sol 6.1 xhigh review caught two issues that were corrected before final checks: outside-shape trips must remain match candidates, and route-index preparation time must not be labelled archive retrieval time. Rechecked review found no remaining concrete C blockers.

## Environmental source evidence

`node scripts/verify-observations.ts` made a separate live anonymous check at **2026-10-08T12:55:22.972Z**. It retained 114 weather and six NO₂ observations in the bounded six-hour window. Metadata retrieval was 12:55:22.580Z; observation query retrievals were 12:55:22.791Z/12:55:22.792Z; separate receptions were 12:55:22.856Z, 12:55:22.969Z and 12:55:22.971Z. Exact queries and values remain in ignored `.cache/task-c/observations-live.json`; attributable XML and evidence excerpts are in `tests/fixtures/fmi-c-*`.

| Station / parameter | Latest observed UTC | Value / actual unit | Provider aggregation / quality |
| --- | --- | --- | --- |
| Kaisaniemi 100971 / temperature | 12:50:00Z | 12.5 degC | avg PT1M / unknown, absent provider flag |
| Kaisaniemi / wind speed | 12:50:00Z | 6.2 m/s | avg PT10M / unknown |
| Kaisaniemi / gust | 12:50:00Z | 8.4 m/s | max PT10M / unknown |
| Kaisaniemi / precipitation | 12:00:00Z | 0 mm | acc PT1H / unknown |
| Mannerheimintie 100742 / NO₂ | 12:00:00Z | 16.5 ug/m3 | avg PT1H / unknown |

Temperature/wind are queried at ten-minute timestamps; precipitation has its own hourly query to preserve supplied hourly rain and gaps. NO₂ is hourly. Weather checks are eligible every five minutes and AQ checks every fifteen; metadata checks every 24 hours. These checks do not claim provider publication cadence. Parameter freshness limits are 30 minutes for temperature/wind and two hours for hourly rain/NO₂.

`GET /api/observations` accepts no browser arguments and fixes the two verified stations and six-hour window. Each upstream XML response is limited to 2 MiB/30 seconds and each source to 5,000 retained records. Query bounds, station IDs, coordinates, parameters, timestamps, duplicate readings and metadata are validated. Per-source single-flight refresh retains dated valid observations during failed requests; no background provider poll is created without demand.

## GTFS source and preparation evidence

`npm run routes:prepare` streamed A’s actual source archive and atomically published the ignored **12,015,931-byte** route index at **2026-10-08T13:01:45.034Z**. It contains 32 routes, 53,387 candidate trips, 160 shape entries, 587 regional stops and 123 stop patterns. Outside/missing shape candidates remain available to ambiguity checks; empty drawable geometry never becomes a guessed scheduled path.

Source: HSL daily GTFS, archive SHA-256 `5d6b6a170f3150afcb7bc2e377de5f9c1e85ce835804df1f1e2ca9f39c296bbd`, version `2026-10-08 04:57:02`, valid 7 October–5 December 2026. Archive retrieval **2026-10-08T10:54:54.985Z** was recovered only from the matching-checksum A source record; a regression rejects retrieval metadata for a different checksum. Prepared time remains separate.

Runtime `GET /api/route` returns labels, or resolves complete bounded reported journey keys against the prepared index. It does not scan/download the GTFS archive per update. Single-flight file loading/revalidation checks at most once a minute, a 64 MiB index bound, route-grouped lookup and a 128-journey result cache bound runtime work. Shapes retain actual consecutive source segments clipped to the release bounds; positions remain unsnapped and unknown ground sections stay absent. Stop arrival times not retained by this minimal index are explicitly unknown.

## Browser verification

Production Node preview: `http://127.0.0.1:4183/`. Hardware: Apple M2 Ultra Mac Studio, 24 CPU cores/64 GB memory; Node 24.19.0/npm 11.17.0; headed Chrome 154. Browser evidence is saved in ignored `output/playwright/task-c-*` and `.cache/task-c/` logs. The development preview was stopped; no host-validation change was made.

The explicitly labelled offline fixture uses attributable A/C source values, a real exact GTFS shape/stops, synthetic current traffic report times/deviation and deliberate null gaps. It never enters production application data. It covers route search, follow, station selection, source metadata, a chart cursor with continuing updates, building identity, source drawer and clear/reset controls. It passed at **13:09:11.471Z**, then at **13:42:28.632Z** after aligning the fixture status to the real API’s `live` state. Mobile checks passed at **13:35:10.390Z** with 374 px wide sheets inside the 390 px viewport. Actual Tab focus passed at **13:39:52.075Z**; real-source mobile inspector/conditions/source/scene screenshots were captured and visually inspected at **13:42:17.871Z**. The screenshot harness checks existing open-sheet state before toggling it. Structured final results are in ignored `.cache/task-c/browser-summary.json`.

Automatic approval review briefly failed with HTTP 403 from its model proxy. The rejected browser commands were not executed. Normal approval succeeded after the human’s resume instruction; all remaining checks completed through the normal flow. No validation was weakened to work around that infrastructure failure.

## Final production live smoke

The live journey completed at **2026-10-08T13:37:12.692Z** against the built Node server, with no fixture interception. Real tram **0040/00075** reported **114 s late**, **24.4 km/h**, destination Eira; route 1001, HFP direction 2, exact trip `1001_20261007_To_2_1607`, departure 13:07Z, 18 regional scheduled stops. Its report/receipt time was 13:36:55Z when followed. The source drawer distinguishes archive retrieval from preparation time.

Real Mannerheimintie NO₂ was **18.5 ug/m3**, observed **13:00Z**, received **13:28:20.502Z**, hourly average/unknown quality. The latest weather source was retrieved **13:36:54.655Z**, with latest ten-minute observations at **13:30Z**. Holding the weather chart at **07:40Z**, **10.9 degC** did not change its history cursor as current HSL reports advanced. Selecting City Hall afterward also preserved live updates. At the end there were **227** current reports; latest provider time **13:37:12.649Z**, snapshot generation **13:37:12.686Z**. Weather and AQ source states were current. Invalid bounded observation and incomplete journey requests each returned HTTP 400.

The short C performance smoke used disabled browser cache, **20 Mbps** download/upload and **50 ms** network latency at **1440 × 1000**. Readiness was **1,434 ms**; five stabilized samples were **240, 240, 240, 240, 240 FPS**. This is a short desktop smoke, not a repeat of B’s 30-minute soak or p95 latency measurement. Other hardware/mobile frame rates remain E’s verification. Final screenshots were inspected; the existing `/favicon.ico` 404 is a release-polish item for E, not an observation/transit regression.

## Changed files

C changes `.gitignore`, `package.json`, `README.md`; `src/app.css`, `src/routes/+page.svelte`; `src/lib/inspection.ts`, `observations.ts`, `route-context.ts`, `city-assets.ts`, `scene.ts`, `live-fleet.ts`; `src/lib/components/CityScene.svelte`, `NearbyConditions.svelte`, `StationHistory.svelte`; `src/lib/data/gtfs.ts`; `src/lib/server/observations.ts`, `route-context.ts`; `src/routes/api/observations/+server.ts`, `api/route/+server.ts`; `scripts/prepare-routes.ts`, `verify-observations.ts`; corresponding inspection/building-search/observations/route-context/scene/fleet tests and five `fmi-c-*` fixtures; this result report and C’s milestone checklist. Generated route index, diagnostics and screenshots remain ignored.

## D handoff and limits

The existing `Selection` contract retains building/vehicle identities and now supports actual station selection. `CityScene`/controller accepts stations, selected route context and route filter; weather/AQ layers remain independent from building/transit layers. D should extend the existing building inspector without speculative empty tabs. Building IDs and source attributes remain strings/null with explicit source vintage and unknown attributes.

Use `StationHistory.svelte` and `chartSegments` as references for observed-time axes, visible units, null gaps and keyboard cursor/clear conventions; preserve method/scope and compatible-unit/period boundaries for D’s energy records. The current gap helper’s absent-interval checks know only the verified environmental cadences; D must supply its verified energy period cadence and adapt the record contract rather than present energy as a station observation. History is independent from the live SSE feed. The source drawer already exposes source attribution/license/method/coverage/vintage/checksum/freshness/outages. D’s mutually exclusive building colour modes remain D work; C keeps the existing neutral palette.

Measured energy, modeled demand and solar potential are not implemented here. A’s modeled-energy/solar gates remain open and must be resolved by D. Other station/pollutant coverage, citywide pollution, forecasts, causation, journey planning and transit replay are excluded. Environmental coverage is two verified stations. GTFS refresh is preparation-only: preserve the index at the project-root path and rebuild it when its source validity changes. Production remains one Node process for the shared MQTT feed. No deployment, native-device/browser matrix, or repeat of B’s 30-minute soak is claimed.

**Handoff:** C is complete and unblocked. D may begin with the existing building selection/source/chart conventions, while resolving its independent modeled-energy and solar source gates. E should repeat the full B workloads and device/accessibility matrix after D, and resolve the favicon polish item.
