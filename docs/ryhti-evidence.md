# Ryhti integration evidence

Verified 9 October 2026 against the open Syke / Ryhti services. Data license: CC BY 4.0; attribution: Finnish Environment Institute (Syke), Ryhti building data.

## Sources and exact identity

- [Service catalogue](https://ryhti.syke.fi/en/front-page/services/)
- [Dataset metadata](https://ckan.ymparisto.fi/dataset/rakennetun-ympariston-tietojarjestelman-rakennustiedot)
- [Open field definitions](https://geoportal.ymparisto.fi/meta/julkinen/dokumentit/Ryhti_rakennustiedot.pdf)
- [API instructions and sustained-use application identifier requirement](https://ryhti.syke.fi/en/front-page/services/instructions-for-using-open-interfaces-in-the-ryhti-system/)

The completed collection is `ryhti_building/ogc/features/v1/collections/open_building/items`; permits use `ryhti_permit/ogc/features/v1/collections/open_permit_building/items`, both under `https://paikkatiedot.ymparisto.fi/geoserver/`.

Verified `filter=permanent_building_identifier IN (...)` with `filter-lang=cql-text` on both collections. Plain `permanent_building_identifier` and `cql_filter` parameters were silently ignored by this OGC endpoint. Preparation validates every returned identifier, expected record counts, safe pagination links and complete coverage of each query. No bounding-box or proximity join is used. Terminal responses can omit `links`.

The three existing control-building identifiers `103027184J`, `103027179C`, and `103036769R` each returned one completed-building record; their permit queries returned four records in total. City Hall retains its exact `103027184J` association, with source completion date `1970-01-01Z`. Completion dates remain calendar dates, separately labelled from municipal construction attributes.

## Full prepared coverage

City generation: `2026-10-09T17:42:21.702Z`. Ryhti catalog prepared: `2026-10-09T18:39:16.885Z`.
Completed source retrieval: `2026-10-09T18:37:54.854Z`; permit source retrieval: `2026-10-09T18:38:25.150Z`.

| Measure | Count |
| --- | ---: |
| Unique prepared municipal buildings | 22,686 |
| Distinct queried VTJ-PRT identifiers | 14,402 |
| Buildings without identifiers | 8,130 |
| Buildings with exact completed records | 14,172 |
| Buildings with linked permits | 9,662 |
| Buildings with ambiguous identifiers, withheld | 284 |
| Buildings with conflicting completed records | 0 |
| Retrieved completed source records | 14,299 |
| Retrieved permit source records | 15,811 |

The completed and permit coverage counts overlap. Counts refer to this prepared area, not all of Helsinki. Some municipal objects have no national identifier; others share one. Source record counts therefore differ from the number of safely enriched municipal buildings.

The catalog is 33,303,849 bytes before compression and 2,509,794 bytes with gzip. The API negotiates gzip and caches compression for each validated state. Catalogs load after scene readiness; all map colors and inspector reads use the local snapshot thereafter.

## Code lists and interpretation

`src/lib/data/ryhti-codes.json` records official Suomi.fi code labels, source API URLs and retrieval time for building use, heating method/source, permit action/status, structural/facade material, construction method and usage status. English labels are used when supplied; Finnish-only labels are explicitly marked. Original URIs remain in record properties; unfamiliar URIs display as unrecognized codes.

Permits include completed historical work. Map permit categories show reported action statuses across all linked records, with a separate Multiple statuses category. No linked permit records never asserts absence of construction. Missing source values, unqueried identities and ambiguous joins remain explicit. This integration does not create geometry or infer that demolition or completion dates supersede the municipal geometry vintage.

## Verification

Attributable normalized source excerpts are in `tests/fixtures/ryhti-original.json`. Unit/integration tests cover real control joins, multiple permits, unknown codes, dates, nulls, ambiguous/conflicting identities, filtered pagination, upstream failures, atomic publication, stale retention, city mismatch, category membership and optional release verification. API tests cover query rejection and gzip.

Full `npm test`: 182 passed. Svelte checking: no errors or warnings. Production build passed (existing large-client-chunk warning). Actual Ryhti assets passed checksum and built-asset parity checks using `verifyRyhtiRelease`.

Chromium desktop and 390 × 844 mobile checks exercised actual thematic rendering, category highlighting, City Hall details, keyboard selection, mode-change reset and return to textures. Mobile screenshots showed no horizontal overflow. Explicit browser fixtures verified restoration of energy modes, loading state, dated stale snapshots and disabled Ryhti choices when no catalog is available; the temporary routes were removed afterward. Screenshots are local ignored artifacts under `output/playwright/ryhti-*.png`.

The reused city assets include energy/route artifacts incompatible with this checkout's existing validators. Energy restoration is tested using an explicitly labelled browser fixture; no replacement energy data is published. Several municipal imagery requests returned HTTP 503 during verification; these are independent of Ryhti. Public deployment, application identifier registration and broader cross-browser/performance soaks are not performed here.
