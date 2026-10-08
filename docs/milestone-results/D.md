# Task D — Building energy and solar potential results

**Status: Complete — all eight acceptance criteria pass.**  
**Evidence date:** 8 October 2026.  
**Final production smoke:** 2026-10-08T14:35:24.218Z.

D adds verified building energy and solar records to the completed C selection journey. The existing checkout and uncommitted A/B/C work are preserved. E has not started; there was no deployment, staging, commit, reset or cleanup. Ocean Lens was read-only throughout.

## Acceptance results

| Acceptance item | Result | Evidence |
| --- | --- | --- |
| Actual measured consumption, modeled demand and solar potential in the release area | **Pass** | Actual Leijonakortteli daily electricity, City Hall annual modeled demand, and Cathedral incident solar radiation; five original associations below. |
| Metric/unit, period/scenario, method, scope and source for every value | **Pass** | Inspector sections and source details distinguish measured property electricity, original annual model scenarios, and modeled roof/wall radiation. Source export/retrieval dates remain separate. |
| Shared property consumption counted once at property scope | **Pass** | One meter boundary has three declared members, two exact matches and one unresolved member. Its total is linked to both verified buildings, never allocated, and excluded from building color scales. |
| Missing/ambiguous associations remain absent | **Pass** | Actual absent and ambiguous buildings show no invented chart/value. National Library's conflicting model row is withheld. A synthetic two-property association also yields no measured chart. |
| Chart gaps and compatible periods/units; qualified totals | **Pass** | Default is the latest completed month with every day finite. Actual September/August selection passes; a labeled fixture with 10 September missing produces exactly two SVG line segments and no month total. Model selectors use seven original annual periods/scenarios. |
| Solar clearly modeled, with no installed/live implication | **Pass** | Annual incoming roof/wall radiation is labeled modeled potential in kWh, with unknown weather/run settings explicit. No panel area, capacity, PV output or savings are derived. |
| Truthful thematic legend, neutral no-data and coverage | **Pass** | Exclusive demand/solar modes show current period, unit, limits and unique denominator. Demand covers 4,949/8,909 buildings; solar covers 695/8,909. Color/reset regressions exercise actual Three.js attributes. |
| Failed refresh retains dated valid data/cache with visible warning | **Pass** | Static publication and raw measured cache are atomic and checksum validated. Failed source refresh/restart retains compatible dated readings; stale/cold catalog fixtures show explicit warnings. Changed city generation/source identity fails closed. |

## Source evidence and representative associations

[Energy and solar source evidence](../energy-solar-evidence.md) records original URLs, units, methods, join rules, source checksums and original row/tile locations. [Solar method/export evidence](../solar-method-evidence.md) distinguishes proven metadata from unknown settings. A's previously blocked modeled-unit and solar-association gates are resolved for D's release catalog; A's earlier smaller sample and its ambiguity results remain historical evidence.

The modeled workbook export is **2020-10-21**, retrieved **2026-10-08T10:51:57.732Z**, SHA-256 `944e2029355ccae0c590226731dfba266b46ea5d4c35c96e083aaa5f949710b3`. The City's original chart divides the same fields by 1,000 to display MWh; the model authors' paper independently confirms kWh. The model uses SimStadt, CityGML typologies, DIN V 18599 balances and FMI climate reference data. Cooling is excluded. The actual workbook supplies SQ 2020 and CC 2025, 2030, 2035, 2040, 2045 and 2050; these future climate scenarios remain separate from observations.

Solar uses original class-26 Atlas building parents and the original identifier crosswalk. The export's HTTP modification date is **2017-08-08T10:58:49Z**. Its supplied annual aggregate is total incoming global radiation on modeled roof/wall surfaces in kWh. The meteorological reference year, calculation date and optional run settings remain unknown. The HSY candidate's lack of stable building IDs is documented; it was not nearest-matched to the city.

All modeled values in the table refer to original **SQ 2020 annual heating/domestic-hot-water demand, kWh**. Solar values are original **annual incident roof/wall radiation, kWh**, with the historical export vintage above.

| Actual building and national ID | Original GMLID | Original association and value |
| --- | --- | --- |
| City Hall — `103027184J` | `BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e` | Exact member of shared property `091-001-0030-0001`; annual model **59,114**. Its original monthly model fields are “non calculated”, so no monthly model chart is invented. Solar absent. |
| Hellenius/Burtz — `103027185K` | `BID_1b6c3f66-d6e5-4d79-b595-b0ae2cfd013b` | Second exact member of the same property; model **2,421,375**; solar **8,320,888.281814322**. A's 159-building sample had three national-ID candidates; the current city has one. |
| Cathedral — `103027179C` | `BID_4d58c091-9185-42fd-a8be-78f1f6eb891f` | Model **1,664,832**; solar **4,304,491.6873486955**. |
| Helenankatu 4 — `103017634F` | `BID_17840114-cda9-47b6-af4a-8b3720a2d7e4` | Model **500,403**; solar **1,242,798.4745984767**. |
| National Library — `103036769R` | `BID_cf43c58b-5f52-4da0-9e2a-2cb440430d86` | Solar **2,600,290.1051776432**. Model row instead declares `103036770S`; its **1,411,460** value is withheld as an identity/version conflict. |

Nuuka's actual `1761 K30, Leijonakortteli` property contains these two verified members and an unresolved Bock member with an empty national code. At source retrieval **2026-10-08T14:13:18.564Z**, September 2026 has 30 complete daily electricity readings totaling **173,390.333 kWh** at property scope. August totals **175,670.63 kWh**; the browser requested that alternate month from the live endpoint. Twelve complete months are available. Daily source calendar labels have no offset; the app does not invent meter clock boundaries.

## Preparation, versions and join coverage

The active catalog was prepared **2026-10-08T14:11:31.993Z**, following attempt start **14:11:28.264Z**, and is bound to city generation **2026-10-08T12:10:39.077Z**. The city contains 8,915 renderer metadata entries but **8,909 unique building identities**, including six split-batch duplicates counted once.

| Dataset | Total source records | Records within preparation scope | Exact | Reviewed | Missing | Ambiguous | Conflict | Buildings covered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Modeled workbook | 46,641 | 5,397 | 4,949 | 0 | 286 | 112 | 50 | 4,949 |
| Solar selected tiles | 772 | 772 | 695 | 0 | 69 | 0 | 8 | 695 |
| Nuuka declared members | 3 | 3 | 2 | 0 | 1 | 0 | 0 | 2 |

Solar scope is twelve original tiles intersecting district bounds `[24.944,60.164,24.958,60.174]`, totaling 51,451,926 decompressed bytes. These counts describe selected tile records; other release tiles remain **unqueried**, not proven absent. Coordinates select preparation scope and never prove an association. Original GML/national identifiers, duplicates and conflicts determine usable joins.

The immutable active asset is `static/data/energy/a5cb74a5-a12d-4036-9f5f-3346d802bb07/energy.json`: **16,750,206 bytes**, SHA-256 `0af9561d9b7ab1fd710b1427837b45228a7ae7f4e77d5d121e77a0a85c95a6ad`, containing **34,643 original annual modeled records**, **695 solar records** and **one shared property**. Semantic city source checksum is `059578f562215babc3052e28b9c2c3ec1a18105909f929c36d36f73debac872d`. Catalog publication validates a complete immutable asset before replacing `energy-manifest.json`; failed preparation retains the previous generation and publishes dated failure diagnostics.

## Verification

Baseline before D: **95/95 tests passed**. Final suite: **133/133 passed, zero failures or skipped tests**. `npm run check` returned **zero errors and zero warnings**. The production build passed; its existing 500 kB client-bundle advisory remains. Official Svelte checks found zero component issues. Focused preparation/legacy checks passed 13/13 and service checks 23/23. Independent review reported **no remaining D blockers**.

Regressions cover exact/duplicate/conflicting joins; the five original associations; one-to-many boundaries; reused IDs and absent provenance; changed city generation even with unchanged tileset checksum; compatible recovery; null intervals and qualified totals; coalescing/rate/time/size/schema limits; bounded durable cache/checksums/restart/outage retention; atomic static failure; and actual Three.js thematic colors/reset. No dependency was added for D.

Production browser verification on 8 October 2026 separated real-source checks from explicitly labeled fixtures:

| Check | Verified at UTC | Result and evidence |
| --- | --- | --- |
| Actual C + D journey | 14:18:42.048 | **Pass.** Real HSL tram `0040/00075`, exact trip `1001_20261007_To_1_1653`, 18 stops; real stations, building selection, September/August energy, seven model years, both themes, Energy preset. HSL reports continue while station/day history is selected. [Log](../../.cache/task-d/helsinki-d-production-live.log) |
| Labeled C + D gap/outage fixture | 14:19:15.747 | **Pass.** Exact 14-stop route, station and energy null segments/cursors, shared 3/2/1 boundary and retained stale dates. [Log](../../.cache/task-d/helsinki-d-fixture-journey.log) |
| Actual absent/ambiguous and labeled compatibility cases | 14:21:30.368 | **Pass.** Actual absent `103247730X`, ambiguous `103556849H` / original `modeled:data:10030`; synthetic multiple properties, stale catalog and incompatible city. [Log](../../.cache/task-d/helsinki-d-edge-cases.log) |
| Mobile 390 × 844, reduced motion | 14:21:30.007 | **Pass.** Keyboard building/day/month controls, actual alternate month and 2050 model, inspector/source/layer/scene sheets, theme/preset; no horizontal overflow. [Log](../../.cache/task-d/helsinki-d-mobile.log) |
| Labeled cold unavailable catalog | 14:22:16.146 | **Pass.** Explicit warning, zero energy charts, neutral buildings and no invented theme options. [Log](../../.cache/task-d/helsinki-d-cold-catalog.log) |
| Final rebuilt production smoke | 14:35:24.218 | **Pass.** Current catalog generation/record counts, actual complete September property total, corrected six-hour/one-minute source wording, City Hall/Cathedral values, themes and Energy camera. [Log](../../.cache/task-d/helsinki-d-final-smoke.log) |

Representative screenshots: [actual shared property](../../output/playwright/task-d-production-property.png), [final Cathedral/solar](../../output/playwright/task-d-final-production.png), [fixture gap](../../output/playwright/task-d-gap-property.png), [actual absence](../../output/playwright/task-d-absent-actual.png), [actual ambiguity](../../output/playwright/task-d-ambiguous-actual.png), [mobile energy](../../output/playwright/task-d-mobile-energy.png), [mobile legend](../../output/playwright/task-d-mobile-theme.png), and [cold catalog](../../output/playwright/task-d-cold-catalog.png). Logs, screenshots, large downloads and generated assets are ignored local evidence; the small original-record fixtures and source reports are reproducible repository evidence.

Performance was measured at **14:20:30.743Z** on Chrome 154 / Apple M4 Max, 16 cores, 64 GB, with 20 Mbps download/upload, 50 ms latency and browser cache disabled. The city became interactive in **1,476 ms**; the complete catalog was parsed and themes usable in **8,914 ms**. Its request took **7,821.5 ms** and returned **16,750,291 uncompressed API bytes**, including the state wrapper. [Performance log](../../.cache/task-d/helsinki-d-catalog-performance.log). The earlier live journey's catalog timing measures response headers only and is not a completion measurement. Real fleet size was 219; sampled scene FPS was 137–240. This is D evidence, not completion of E's release/performance matrix.

## Changed files

D reaches the static preparation, runtime service, inspector, scene, tests, fixtures and operating documentation. The file comparison against the saved D starting snapshot found no deleted starting files; the final detailed list is in [changed files](../../.cache/task-d/changed-files.json).

- Preparation: `scripts/prepare-energy.ts`, `scripts/energy-solar.ts`, `scripts/energy-workbooks.ts`, `src/lib/data/energy-static.ts`.
- Service/contracts: `src/lib/energy-types.ts`, `src/lib/energy-display.ts`, `src/lib/server/energy.ts`, `src/lib/server/energy-catalog.ts`, `src/routes/api/energy/+server.ts`, `src/routes/api/energy/catalog/+server.ts`.
- UI/scene: `src/lib/components/BuildingEnergy.svelte`, `src/lib/components/EnergyHistory.svelte`, `src/lib/components/CityScene.svelte`, `src/lib/scene.ts`, `src/routes/+page.svelte`.
- Regression evidence: `tests/energy-preparation.test.ts`, `tests/energy-service.test.ts`, `tests/energy-display.test.ts`, `tests/scene.test.ts`; `tests/fixtures/energy-static-original.json`, `nuuka-september-2026.json`, `atlas-solar-method-evidence.json`.
- Configuration/docs: `package.json` adds `energy:prepare`; `.gitignore` excludes generated energy assets; README adds usage/cache/assets/performance; energy/solar evidence, this report and D checklist; historical D-resolution addenda in A results, access and geometry/energy evidence.

## E handoff

E receives D's completed feature, evidence, attribution and operating requirements. E's checklist is unchanged and has not been executed.

| Production requirement | Files / behavior |
| --- | --- |
| Foundation assets | `static/data/manifest.json` and every referenced immutable file under `static/data/generations/`. Keep A's dated probe/gate evidence historical. |
| Current semantic city | `static/data/city/manifest.json`; referenced geometry and building metadata chunks, plus `base.json`, under `static/data/city/generations/b39efe3f-ab77-459a-887f-04c90af3ef91/`. Production must keep geometry and metadata from one valid generation. |
| Route context | `static/data/route-index.json`, retaining its prepared GTFS source version and validity. |
| Energy catalog | `static/data/energy-manifest.json`, the referenced `energy/<generation>/energy.json`, and `static/data/energy-refresh-status.json` when present. Publish a validated whole catalog, then its manifest atomically. |
| Application | Rebuilt Node adapter `build/`, installed locked runtime dependencies, one process, project root as working directory. Build after any production static-asset refresh. |
| Writable measured cache | `.cache/energy/runtime/`, at most 64 atomic checksum-validated raw cache files and 64 memory entries. Successful lookups cache six hours; failed lookups retry after one minute; changed completed-month or city/source/membership version triggers a new lookup. |
| Runtime request bounds | Fixed Nuuka endpoint; catalog property whitelist; previous twelve completed months; at most 366 daily rows, 256 KiB and 15 seconds per upstream response; four concurrent requests and 24 starts per minute; identical requests coalesced. |
| Preparation-only material | Original `.cache/task-a/modeled.xlsx`, `atlas.xlsx`, `nuuka-property.json` and metadata sidecars; `.cache/task-d/solar/` original configuration/manifests/tiles/checksums and parsed model cache. These are not required for normal HTTP serving. |

After **every** `city:prepare`, run `energy:prepare`, even if the upstream city tileset checksum is unchanged. A catalog requires the exact city generation plus compatible semantic source checksum/vintage, and measured cache fingerprints include city/source/membership versions. Missing provenance or a mismatch disables energy values/themes; a merely stale but compatible dataset retains dated values with a warning.

Ordinary `npm run energy:prepare` reuses checksum-verified raw caches. Use `npm run energy:prepare -- --refresh` for an explicit operator source refresh, then review versions/joins, rebuild and verify. Review static annual sources monthly or upon provider export announcements. Runtime measured refresh timing is an application cache policy; upstream publication cadence is unknown. A failed preparation updates visible dated diagnostics without activating partial output; retained valid generations need no destructive cleanup for D.

Preserve City of Helsinki / Helsinki 3D / Energy and Climate Atlas / Nuuka attribution and source dates in the catalog and source drawer; current source records cite CC BY 4.0. Keep HSL, FMI and HSY attribution from the B/C assets. Read the linked source/solar method reports before changing metrics or assumptions.

Material limits: the lazy catalog is **16.75 MB** and took about **nine seconds** to become usable under the measured network; compression/chunking is an E consideration. Solar covers a selected historical district export, with unknown weather/reference-year and optional run settings. Original model scenarios are indicative historical calculations, not measured consumption or a physical survey. No shared-meter allocation, retrofit optimizer, PV yield/capacity, financial model, live solar generation or carbon model was added. Final release verification, deployment and production uptime remain E work.
