# Milestone C Inspection and environmental context

**Status:** Complete — 8 October 2026  
**Depends on:** B and A environmental gate  
**Task:** Complete the journey from a selected live vehicle to nearby conditions and an inspected building. Follow [the implementation plan](../implementation-plan.md).

## Outcome

Users can understand a vehicle's reported delay, see where and when nearby conditions were observed, and inspect the buildings around it. The interface makes source coverage and timing differences visible.

## Implementation steps

1. Adapt the Ocean Lens layout into Helsinki branding and responsive panels. Add layer controls, conditions summary, inspector, source drawer, and a clear live indicator. Build narrow-screen controls with a bottom sheet or equivalent that preserves access to the scene and selected object.
2. Expand vehicle inspection with route label, mode, direction/destination when available, speed, last report time, deviation, and feed status. Display late/early/unknown explicitly. Start with an application-defined on-time band of ±60 seconds; label it as a display convention and retain the exact reported deviation in details.
3. Use A's verified GTFS mapping for the selected journey's route shape and stops. Account for operator/service date/direction/start time as appropriate. An unresolved or ambiguous match shows no guessed route. Route geometry provides context; never snap raw positions onto an uncertain route or use a straight line as a claimed scheduled path.
4. Add a route/mode filter and keyboard-accessible search for vehicles/routes, buildings, and addresses present in the prepared index. Debounce local search if necessary. Selecting results calls the same scene selection code as pointer picking. Do not introduce a commercial geocoder for this scope.
5. Implement cached FMI weather and municipal air-quality adapters using A's verified queries. Fetch shared bounded observations server-side, with single-flight refresh, timeouts, validation, and stale-cache handling. Start with five-minute weather and fifteen-minute air-quality refresh checks, then align with source cadence and usage limits. Refresh frequency must not imply that a provider publishes at that frequency.
6. Add selectable observation stations and parameter controls. Show temperature, wind and precipitation where supplied; show available PM2.5, PM10, NO2 or other confirmed pollutants with actual units. Preserve aggregation periods and quality flags. Do not compute a generic AQI unless a separate agreed specification is added.
7. Connect selection to the nearest valid observation of each requested parameter within the regional station set. Show station name, distance, measurement time, and why no reading is available. Nearest weather and air-quality stations may differ. Treat the reading as station context, not a measurement at the selected building or vehicle.
8. Implement a building inspector with address/name, stable identifiers, year, floors, use, and other verified attributes. Missing attributes remain unknown. Provide the source link and geometry vintage. Leave space for D's records through the existing selection contract without adding speculative tabs or empty charts.
9. Add small station history charts for a bounded recent window where the source supplies observations. Keep observed time on the axis and preserve gaps. Current transit remains live while viewing observation history; show independent timestamps. No transit history chart or synchronized replay is implied.
10. Implement the source drawer with attribution, license, method, resolution/coverage, vintage, freshness, and outages. Add a short explanation that juxtaposed weather and delay values do not establish causation.

## Deliverables

- Responsive application shell and meaningful vehicle, building, and station inspectors.
- Local search, selected-route highlighting, route and mode filters.
- Observation endpoints, station layers, nearby-conditions cards, and bounded station charts.
- Complete source drawer and `docs/milestone-results/C.md`.

## Acceptance checklist

- [x] A user can follow a real tram, read its delay, inspect nearby weather and air quality, then select a building without losing live updates.
- [x] Known late and early fixture values produce the correct labels and signs; unknown delay stays unknown.
- [x] The selected verified journey highlights the correct shape/stops, including an overnight-service fixture. Ambiguous mapping has an explicit unavailable state.
- [x] Building and route search operate by keyboard and select the same identities as scene clicks.
- [x] Every environmental value exposes station, distance where contextual, observed time, unit, and quality/aggregation information when supplied.
- [x] Air quality renders at actual stations; no unsupported continuous pollution heatmap appears.
- [x] Failed, stale, empty, and partially missing source responses have distinct readable states.
- [x] Current vehicles never appear to correspond to a historical chart cursor.
- [x] Core controls and inspectors are usable on desktop and a narrow mobile viewport, with visible focus and reduced motion.

Acceptance evidence, source timestamps, tested viewports and the D handoff are recorded in [Task C results](../milestone-results/C.md).

## Verification

Test delay formatting, journey identity and service dates, station selection by parameter, observation null/quality handling, stale cache transitions, and chart gaps. Test source query bounds and rejects of invalid requests. Run an end-to-end fixture journey through search, follow, route context, station selection, building selection, source drawer, and close/reset controls. Repeat a small live smoke check with source timestamps recorded.

## Scope boundary and handoff

Exclude causal weather explanations, predictions, journey planning, pollution interpolation, and transit replay. D receives the building selection/inspector, shared source metadata, chart conventions, and layer-colour controls. Keep ambiguous mappings visible for correction rather than hiding them through automatic guesses.
