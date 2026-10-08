# Milestone D Building energy and solar potential

**Status:** Complete — verified 8 October 2026; [results and E handoff](../milestone-results/D.md)  
**Depends on:** C and A energy and solar gate  
**Task:** Join available building energy and solar records to the semantic city and expose them without confusing modeled potential with measured consumption. Follow [the implementation plan](../implementation-plan.md).

## Outcome

A user selects a building and sees the available consumption history, modeled demand, and solar potential with correct scope, units, period, and source. The city can be coloured by supported building-level energy or solar metrics, with visible coverage.

## Implementation steps

1. Turn A's join experiments into deterministic preparation steps. Prefer verified stable identifiers; keep original IDs and provenance. Preserve one-to-many property/building relationships. Do not use nearest-address or nearest-centroid matching as proof. If manual mappings are required, keep a small reviewed mapping file with evidence for each association.
2. Produce a join report per dataset with total source records, records within scope, exact/reviewed matches, unmatched records, ambiguities, and buildings covered. Record denominator and source vintage. Identify conflicts between source versions; never silently attach an old record to a newly reused identifier.
3. Prepare Atlas or equivalent verified modeled demand records with scenario/year and assumptions. Keep projected future demand separate from observations. Show only metrics actually present in the selected source.
4. Add bounded cached retrieval of municipal measured energy series. Default to the latest complete month of daily readings available for a selected property and show that date range explicitly. If the source only supports another granularity, preserve it and label it. Coalesce identical requests, limit date ranges, and retain a dated cache during outages.
5. Treat multi-building consumption as a shared property record. Link its member buildings and label the measurement boundary. Do not divide totals by building count, area, or volume without an explicitly sourced allocation method. Exclude these shared totals from building-level thematic values unless the visual clearly operates on property scope.
6. Prepare solar potential with source vintage, suitable area and production/irradiation metrics only where present, and documented assumptions. Distinguish kW from kWh, irradiation per area from total generation, and modeled potential from installed systems. Avoid calculating financial savings or current output from this dataset.
7. Extend the existing building inspector with measured consumption, modeled demand, and solar sections as data permits. Include date selection for available energy records, clear missing-data explanations, and source details. Reuse the chart conventions from C; show gaps rather than interpolated readings.
8. Add mutually exclusive building colour modes for supported demand and solar metrics. Use comparable periods/units, visible legend limits, a neutral no-data style, and coverage counts. Provide an Energy camera preset for a district with proven data coverage. Never mix measured and modeled values into one scale.
9. Refresh generated joins and static data atomically, preserving the last valid output on failure. Document dataset refresh cadence and source-version compatibility; do not redownload static solar data per user request.

## Deliverables

- Reproducible energy/solar joins and coverage report.
- Bounded energy endpoint and server cache.
- Building charts, solar details, thematic modes, and Energy camera preset.
- `docs/milestone-results/D.md` with representative exact, shared, absent, and ambiguous cases.

## Acceptance checklist

- [x] Demonstrate measured consumption, modeled demand, and solar potential on actual matched records in the release area. The examples may be different buildings.
- [x] Every displayed value includes metric/unit, period or scenario, method, scope, and source; measured/modelled/shared records are visibly distinguished.
- [x] A property covering multiple buildings does not cause its full consumption to be counted as independent consumption in each building.
- [x] Missing and ambiguous associations produce no invented values, charts, or coloured metrics.
- [x] Energy charts preserve missing intervals and only compare compatible units and periods. Annual totals require a complete or explicitly qualified period.
- [x] Solar potential is labelled as modeled potential and does not imply existing panels or live production.
- [x] Thematic legends, no-data style, and coverage counts correspond to the currently selected dataset and period.
- [x] Refresh failure retains a dated valid dataset/cache and a visible warning; no partly written data becomes active.

## Verification

Test exact identifier joins, duplicate and conflicting identifiers, one-to-many properties, ambiguous spatial candidates, source-version changes, unit conversion if needed, chart gaps, and compatible-period filters. Verify at least five representative associations against their original records, including a multi-building property when available. Re-run the C end-to-end selection journey after extending the inspector.

## Scope boundary and handoff

No modeled allocation of shared meters, retrofit optimizer, ROI calculator, live solar generation, or carbon-accounting model is included. If a required source cannot be retrieved or licensed, document that feature as blocked and continue unaffected work; completion requires resolving it or an explicit scope change. E receives the complete asset list, cache requirements, attribution, and known coverage limits.
