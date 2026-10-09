# D — deterministic energy and solar source evidence

Verified on **8 October 2026**. This resolves A's previously open modeled-energy and solar source gates using original City records. A's earlier samples remain valid historical evidence; their smaller geometry and blocked unit/identity findings are not substituted for release checks.

## Source choice and units

The [original modeled workbook](https://www.hel.fi/hel2/tietokeskus/data/helsinki/kaupunginkanslia/3D-malli/Helsinki_Buildings_Heating_Energy_Demand_Climate_Change_20201021.xlsx) contains 46,641 data rows, original GMLID and VTJ-PRT strings, a 2020 SQ baseline, and CC years 2025, 2030, 2035, 2040, 2045 and 2050. Its metadata describes `Total_Yearly_Heat_DHW_demand` as annual heating and domestic-hot-water energy demand. The unit is **kWh**, supported by the City's [original chart adapter](https://kartta.hel.fi/3d/heating/Apps/Helsinki/js/myChart.js): it reads the same `SQ_2020_*_Heating_Demand` / `CC_*_Heating_Demand` fields, divides by 1,000, and labels the result MWh. The [model authors' paper](https://www.mdpi.com/2220-9964/9/10/602), coauthored by the City, independently defines demand in kWh. This is source evidence, not an inference from numerical magnitude.

The [original City heating application](https://kartta.hel.fi/3d/heating/Apps/Helsinki/view.html) and paper establish SimStadt, CityGML geometry, building construction/function typologies and available Atlas attributes, DIN V 18599 monthly energy balances, and FMI future climate reference data interpolated in five-year steps. The CC workbook changes climate while retaining the building stock; BAU and rapid refurbishment scenarios in the application are separate and are not fabricated into this workbook. Cooling is excluded. `2020-10-21` is the workbook export vintage; scenario years and 2026 retrieval remain separate.

Preparation publishes the **original annual total** for all seven scenarios. Missing or `non calculated` source values become null. No annual total is calculated from incomplete months. City Hall's source row has the annual value 59,114 kWh while its monthly fields say `non calculated`; the app must not invent a monthly chart for it. The checked-in A fixture records those original monthly values.

The [original Atlas solar configuration](https://kartta.hel.fi/3d/solar/config.json) names annual `globalRadYear` in **kWh** and points directly to the [original solar tile export](https://kartta.hel.fi/3d/data/buildings_solar/tileset.json). Its legacy batch tables retain original building parent GMLIDs, surface identities and parent relations. Class 26 building parents contain the supplied annual aggregate: incoming global solar radiation on roof and wall surfaces. The [method and export evidence](solar-method-evidence.md) verifies the TUM source tool and **2017-08-08 HTTP export modification vintage**. Weather year and calculation date remain unknown; general shading/terrain capabilities do not prove which optional settings were enabled for this run.

Only annual **incoming radiation** is published. It is distinct from irradiation per area in kWh/m², capacity in kW, and photovoltaic electrical generation in kWh. Suitable panel area, PV yield, installed panels, live production, efficiency conversion and financial savings are absent and are not derived.

HSY's A candidate contains panel area/yield but lacks a semantic building identifier. It is preserved in `.cache/task-a/solar-probe.json` and [A's evidence](geometry-energy-evidence.md). The original City Atlas solar source is used because its explicit semantic parent IDs allow verification without a centroid/address guess. HSY assumptions and metrics are not transferred to it.

## Deterministic joins and source versions

The prepared release contains **8,909 unique building identities**. Six buildings occur twice in renderer partition lists because their geometry spans split batches; identical original identities count once. Contradictory GMLID, national ID, RATU or UUID across split batches fail preparation.

A declared GMLID must match that original GMLID. A contradictory declared VTJ-PRT is a conflict and cannot fall back to a different building. Duplicate GMLID source rows or repeated national identities across distinct source objects remain ambiguous; neither can produce usable records. Missing identifiers are preserved as unresolved identities. Coordinates only select model rows within the geographic scope; they never prove a join. Solar uses the original class-26 parent GMLID and checks the original Atlas UUID/VTJ-PRT crosswalk where available. Contradictory Atlas versions are excluded. No manual mappings or reviewed spatial associations were required.

Original conflicting rows remain in checksum-keyed `.cache/task-d/modeled-<source checksum>-<geometry identity checksum>.json`; solar raw tables and the original Atlas workbook remain alongside their content checksums. Reports preserve each row's original IDs and its candidates. Older valid published generations remain available. Different semantic identifiers are not merged merely because their geometry overlaps.

| Verified source version | SHA-256 |
| --- | --- |
| Modeled XLSX; retrieved 2026-10-08T10:51:57.732Z | `944e2029355ccae0c590226731dfba266b46ea5d4c35c96e083aaa5f949710b3` |
| Original Atlas identity XLSX; retrieved 2026-10-08T10:51:53.185Z | `189554eca2a960a271c2c4c86176c3c7828e2cf4a28f4a1b5c041197b9533a7b` |
| Selected solar configuration, manifests and raw tile versions; latest retrieval 2026-10-08T14:01:52.289Z | `7e9722393f621db32c4e99f4db285f708b768fd69c6fc173d810ce39776fb599` |
| Release semantic tileset | `059578f562215babc3052e28b9c2c3ec1a18105909f929c36d36f73debac872d` |
| Release unique identity set, ordered `[id,gmlId,vtjPrt]` | `be697038426bfadb6bd41895352c95c62e006fc5c2d82033bbdf19016ccaee75` |

The three static energy/solar versions are pinned. An unreviewed source checksum fails refresh with an actionable diagnostic; it cannot silently change unit assumptions or export vintage. Revalidate the actual replacement source and identity conflicts before deliberately updating the verified checksum. Nuuka membership refresh uses declared national identifiers and retains its new provenance; it does not allocate a shared total.

## Coverage and denominators

Counts are original source building/member rows, not seven copies for seven modeled scenarios. `recordsWithinScope` equals exact + reviewed + unmatched + ambiguous + conflicting. Covered means a proved association with a supported non-null record, or proved property membership for Nuuka.

| Dataset preparation scope | Total source rows | Within scope | Exact | Reviewed | Unmatched | Ambiguous | Conflicting | Buildings covered / release |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Modeled workbook; whole source counted, release identities or source model coordinates retained | 46,641 | 5,397 | 4,949 | 0 | 286 | 112 | 50 | 4,949 / 8,909 (55.55%) |
| Original solar; complete parent rows in 12 district-intersecting tiles | 772 | 772 | 695 | 0 | 69 | 0 | 8 | 695 / 8,909 (7.80%) |
| Nuuka Leijonakortteli; three declared property members | 3 | 3 | 2 | 0 | 1 | 0 | 0 | 2 / 8,909 (0.02%) |

Model scope excludes 41,244 source rows outside the release identifier/geographic scope. Coordinates do not make the 286 unmatched rows attachable. Coverage outside the selected solar tiles is **unqueried**, not evidence that no solar source data exists there. The 12 tiles intersect `[24.944,60.164,24.958,60.174]` and include boundary neighbors; all 772 original parent records are accounted for. Raw compressed downloads total 15,297,265 bytes; decompressed tile bytes total 51,451,926. The source provides additional surface rows, but the count above is original building parents.

The source-member denominator for Nuuka is 3, with 2 exact associations (66.67%) and 1 unresolved member. This proves a multi-building measurement boundary, not two independent building meters. The original third member, Bockin talo, has an empty national code and remains `location:1761 K30, Leijonakortteli, 999920 2 Bockin talo`. Server readings keep one property total/day. They do not participate in building-level demand/solar scales.

## Original association checks

The [small attributable source fixture](../tests/fixtures/energy-static-original.json) contains five current original building records, annual workbook excerpts including a conflict, four unmodified solar parent records, and the original Nuuka property response. It records source URLs, checksums, retrieval times and CC BY 4.0 attribution. Labels below help identify the examples; they do not establish joins.

| Building | Original GMLID; current national ID | Verified original association |
| --- | --- | --- |
| City Hall | `BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e`; `103027184J` | Nuuka property `091-001-0030-0001` explicitly declares this member; modeled data row 9645 agrees on both IDs, original 2020 annual heat/DHW 59,114 kWh. Solar is absent in the selected source records. |
| Hellenius/Burtz | `BID_1b6c3f66-d6e5-4d79-b595-b0ae2cfd013b`; `103027185K` | Second explicit member of the same shared Nuuka property; modeled row 2477 agrees, original annual demand 2,421,375 kWh; solar parent in `15/37310/5430.b3dm` supplies 8,320,888.281814322 kWh radiation. A's older 159-building geometry had three candidates for this national ID; the current release has one. The differing versions remain documented. |
| Cathedral | `BID_4d58c091-9185-42fd-a8be-78f1f6eb891f`; `103027179C` | Modeled row 3420 agrees on both IDs, 1,664,832 kWh annual heat/DHW; original solar parent in the same tile supplies 4,304,491.6873486955 kWh annual radiation. |
| Helenankatu 4 | `BID_17840114-cda9-47b6-af4a-8b3720a2d7e4`; `103017634F` | Modeled row 3809 agrees, 500,403 kWh annual demand; original solar parent supplies 1,242,798.4745984767 kWh annual radiation. |
| National Library | `BID_cf43c58b-5f52-4da0-9e2a-2cb440430d86`; `103036769R` | Solar parent plus original Atlas national crosswalk agree; annual radiation 2,600,290.1051776432 kWh. Modeled row 9303 instead declares `103036770S`; its 1,411,460 value is withheld as a version conflict, not silently attached. |

No value is supplied for source-unmatched or ambiguous candidates. Checked-in fixture tests verify these five distinct identities and the shared property; synthetic mutations exercise ambiguity, conflicts, nulls, bounds and failed refresh.

## Preparation and publication

Run `rtk npm run energy:prepare` after preparing the city assets. Ordinary preparation reuses A's original XLSX/property caches and the first solar download cache; it does not fetch static solar data per building selection or user energy request. A missing cache may be downloaded once, with bounded time/bytes. `rtk npm run energy:prepare -- --refresh` performs an explicit operator refresh into a new raw source cache, preserving A's originals. Static annual sources are reviewed monthly or when the provider announces a new export; they do not need daily downloads. The catalog's required `cityGeneratedAt` must exactly equal the active city manifest generation time; prepare energy again after **every** city preparation, even when the upstream tileset checksum is unchanged. The runtime also checks the semantic source version and refuses incompatible city/catalog generations. Nuuka daily readings are independently retrieved and cached by the bounded server service.

Required preparation assets are:

- The active `static/data/city/manifest.json` and its building metadata lists, preserving all 8,909 unique release IDs.
- A's original `.cache/task-a/modeled.xlsx`, `.cache/task-a/atlas.xlsx`, and `.cache/task-a/nuuka-property.json`, or a separately reviewed replacement version; metadata sidecars retain retrieval times and checksums.
- `.cache/task-d/solar/tiles/` with the selected original solar configuration, root/subtree manifests and 12 legacy tiles; `.cache/task-d/solar/solar-source-checksums.json` records every version.

Preparation validates actual XLSX inflation (250 MB), string identifiers, headers and a 12,000 retained-row limit; all workbook rows are counted even when not retained. The existing 500-row A limit remains the default for probes. Solar allows at most 12 manifests, 40 selected tiles, 32 MB per tile, 16 MB batch JSON, 220 MB decompressed tile bytes and 2,500 building parents. Gzip decoding is bounded independently; checksums describe the preserved original compressed bytes. The original provider layout is supported deliberately; a schema change fails visibly.

The active publication point is **`static/data/energy-manifest.json`**, referring to immutable `energy/<generation>/energy.json` with byte count and SHA-256. Write and validate the whole catalog first, then atomically replace the manifest. Failure retains the previous valid asset/generation time and updates `refresh.status=failed`, attempt time and diagnostic; `energy-refresh-status.json` also records a first failed preparation without inventing a catalog. Old valid generations are retained. Production requires the manifest and its referenced asset plus the server's writable dated Nuuka cache; raw XLSX/solar sources are preparation-only. Copy assets into a production build after preparation; do not rebuild static sources during HTTP requests.

The cached successful preparation at **2026-10-08T14:11:31.993Z** (attempt start 14:11:28.264Z) produced 34,643 annual modeled records, 695 solar records, and one shared property. Catalog size is **16,750,206 bytes**, SHA-256 `0af9561d9b7ab1fd710b1427837b45228a7ae7f4e77d5d121e77a0a85c95a6ad`; generation time follows source retrieval. Full catalog delivery must be lazy/bounded rather than added to initial server-rendered page data.

Focused preparation/legacy energy checks on 8 October passed **13/13** offline tests, including deterministic ordering, exact and conflicting identities, national-ID reuse, multi-building membership, missing values, original legacy solar decoding, >500-row release retention with complete source counts, source-version rejection, split-batch denominator and failure retention. Type checking passed with zero errors/warnings. Full application/build/browser acceptance is recorded separately in [D results](milestone-results/D.md).

Limitations: solar preparation covers the stated district tiles, meteorological reference year and exact optional solar-run settings are unknown, and source models are indicative historical calculations. No modeled allocation, panel-capacity/yield estimate or physical-height/energy survey is claimed.


## Expanded release compatibility (9 October 2026)

The catalog generated at **2026-10-09T17:51:26.604Z** matches city generation **2026-10-09T17:42:21.702Z** and its **22,686 unique buildings**. The original 8,909 building identities remain unchanged and the semantic source index checksum is unchanged. Modeled and Atlas workbook checksum pins, source units, scenario assumptions, identity-conflict exclusions and measured property boundaries are preserved.

The verified modeled workbook still contains **46,641** source rows. Wider release coordinates and identifiers retain **13,043** rows: **12,032** exact matches, **677** unmatched, **250** ambiguous and **84** conflicting. The catalog contains **84,224** annual scenario records. Solar sampling retains the same **12** district-intersecting source tiles and **772** building parents, yielding **695** exact associations; no wider solar source coverage is inferred. The Nuuka property retains two exact declared member matches and one unresolved member.

The new catalog is **39,405,989 bytes**. Its necessary preparation budgets are 30,000 retained workbook rows, 100,000 energy records, and 48MiB per catalog; ZIP inflation, source checksum, record validation, safe-path, body checksum, geometry-generation and atomic publication checks remain enforced. A regression accepts catalogs beyond the former 50,000-record limit while rejecting malformed records and catalogs beyond the new bound. The earlier sections remain dated evidence for the original central release.
