# Task E — Release readiness results

**Status: Complete — verified local production release.** Evidence date: 8 October 2026. This is a local production release; public deployment is a separate action and has not been performed.

B, C and D were reviewed in their original chats and checked acceptance reports. D resolves the current release's modeled-unit and original solar-identifier gates. A's foundation manifest and probes remain dated historical evidence, explicitly separated in the source dialog from current catalog coverage. Measured property electricity, modeled annual building demand and annual incident roof/wall solar energy are all retained.

## Acceptance results

| Required acceptance item | Result | Evidence |
| --- | --- | --- |
| Production tram → delay → conditions → building → energy/solar | Pass | Chromium/Firefox production fixtures and real Safari desktop journey; final live endpoints and source dates below. |
| Keyboard equivalent, visible focus, dialogs, reduced motion | Pass | 30 assertions per Chromium/Firefox journey; natural Tab-only entry; native modal background isolation, Escape restoration, spoken historical values and 44 px compact controls. |
| Desktop/portrait/landscape; tested browsers/exceptions | Pass with documented exceptions | 1440×900, 390×844 and 844×390 on Chromium/Firefox; real Safari desktop. Exceptions below. |
| Meaningful deterministic tests, type checking, production build | Pass | Final 140/140 tests, no failures/skips; check 0 errors/0 warnings; production build succeeds. |
| Final B performance targets and 30-minute soak | Pass | Final 1,455 ms scene, 1,988 ms catalog, 935 ms internal p95; all camera/selection/layer workloads plus exact doubled E peak and larger B fixture; full 1,800.085-second production soak and idle cleanup pass. |
| Interruptions, stale data, invalid payloads, cache, restart/recovery | Pass | Deterministic HSL/FMI/Nuuka failures and cache repair; production blocked-chunk recovery; isolated real process/cache restart. |
| Clean startup; explicit prerequisites; workspace independence | Pass | Final executable candidate clean-installed into a new temporary root; documented Node startup and endpoints pass twice. |
| Shipped attribution/terms; server-only credentials | Pass | Dataset licenses/methods/dates in manifests/source dialog; locked production dependency notices; no credentials required or bundled. |
| No analytics or unrelated Ocean Lens configuration | Pass | 1,226 build files including 770 compressed variants scanned; all 18 provider and 303 dependency notices present; system fonts/procedural symbols; no Ocean runtime/analytics/credentials carried over. |
| Earlier gates resolved; visible source limits | Pass | Current city/catalog generation, checksum and vintage match; D's exact source associations remain tested; unknown/unqueried states remain visible. |
| Release versus deployment stated separately | Pass | Local installation/package verification only. No public URL, deployment or uptime claim. |

## Changes and preservation

The source drawer now uses a native modal with keyboard focus management. A metadata selection helper preserves search/list selection for vehicles, stations and buildings when WebGL fails. Selected live vehicle metadata still updates, becomes stale and expires correctly. Compact panels preserve meaningful scene space and manage focus; station history exposes observed dates/values to the slider; portrait dialog overflow is corrected. A local SVG favicon removes the missing request. Browser stream connectivity is distinguished from retained upstream connection status.

The energy catalog negotiates gzip with Node's standard library and shares compressed bytes for one validated catalog state. The full decoded data and warning states are unchanged. Requests forbidding both available encodings receive an empty 406. Independent review found that protocol edge; the fix, tests and isolated restart check verified it before release. No dependencies were added.

The release packager validates active foundation/city/energy checksums, exact city/catalog compatibility, prepared routes and equality with built HTTP data. It packages matching build/assets, lockfile, operating instructions, example environment, screenshots/evidence and production license notices. A relative `static/data → ../build/client/data` link avoids duplicating data. The production soak uses the actual compiled traffic singleton through an ignored private loopback inspector/preload; no public diagnostic endpoint was added.

Five obsolete, unreferenced generated directories were **moved without deletion** to `.cache/task-e/archived-generations/`, preserving 190,763,751 bytes before the final build. Active assets and all A–D source work were retained. No reset, clean, staging or commit was performed. Ocean Lens was reference-only and no Task E write was issued there; no independent before/after Ocean hash baseline exists.

Runtime/UI changes: `src/routes/+page.svelte`, `src/lib/components/StationHistory.svelte`, `src/routes/api/energy/catalog/+server.ts`, `src/app.css`, `src/app.html`, `static/favicon.svg`. Verification/packaging changes: `scripts/package-release.ts`, `scripts/verify-release-soak.ts`, `tests/package-release.test.ts`, `tests/energy-catalog-http.test.ts`, `tests/energy-service.test.ts`, `tests/traffic.test.ts`, `tests/observations.test.ts`, `tests/io.test.ts`, `package.json`, `.env.example`, `.nvmrc`, `README.md`, `docs/operations.md`, this report and release evidence/screenshots. The [preservation audit](../release-evidence/final-preservation-audit.json) found no deletion among 133 baseline files and an unchanged lockfile SHA256 `a6bb9bf7409b64293f9c45ef75d4fb92c29236dafcebe38921685bafa159f516`; final documentation/evidence additions follow that inventory.

## Final assets and executable identity

| Artifact | Generation / evidence |
| --- | --- |
| Foundation | `20261008111533022-4ac4774e-dad2-443e-8e60-1c667162cd35`; generated 2026-10-08T11:15:33.022Z. |
| City | `b39efe3f-ab77-459a-887f-04c90af3ef91`; generated 2026-10-08T12:10:39.077Z. |
| Semantic source | SHA256 `059578f562215babc3052e28b9c2c3ec1a18105909f929c36d36f73debac872d`; city/catalog checksum and vintage match exactly. |
| Energy | `a5cb74a5-a12d-4036-9f5f-3346d802bb07`; generated 2026-10-08T14:11:31.993Z; 16,750,206 bytes; SHA256 `0af9561d9b7ab1fd710b1427837b45228a7ae7f4e77d5d121e77a0a85c95a6ad`. |
| Built server manifest | SHA256 `931db508884a20fce7a5064a7b155e17a6dd5335f155e57f19aeff622c641a31`. |
| Soak executable fingerprint | SHA256 `bcac391aba4a3b20145936125edb6e4163b8be833d09940793aa181964f62583` over 40 sorted executable JS paths: path + NUL + file SHA256 + newline. |

[Package/soak comparison](../release-evidence/soak-package-comparison.json) proves every executable matches by path, size and SHA256. The packaging inventory also includes sourcemaps and therefore uses a different 71-file hash convention. No runtime/build/static changes were made after this fingerprint was recorded; final packaging only adds completed documentation/evidence.

## Tests and browser matrix

Final `npm test`, `npm run check` and `npm run build` passed on Node 24.19.0/npm 11.17.0. [Build evidence](../release-evidence/final-build-checks.json) records 140 passes, zero failures/skips and zero check errors/warnings. Official Svelte MCP verification for Svelte 5.57.1 returned zero autofixer issues. Vite reports one 801.48 kB minified client module above its 500 kB advisory; the measured network/render targets pass below.

| Browser | Tested surface and evidence |
| --- | --- |
| Chromium 154.0.8037.99 | Desktop 1440×900, portrait 390×844, landscape 844×390; [30 journey assertions](../release-evidence/ui-chrome-production.json), actual final 1440×1000 performance/workloads, [16 WebGL fallback assertions](../release-evidence/ui-webgl-production.json), production chunk recovery and natural keyboard path. |
| Firefox 156.0 | Matching Playwright Firefox engine; same three viewports and [30 journey assertions](../release-evidence/ui-firefox-production.json). Native installed Firefox 123.0.1 was not tested. |
| Safari 26.6.2 (21624.5.1.11.3) | Real native desktop window, approximately 2560×1410 including browser chrome; [final live journey](../release-evidence/ui-safari-production.json). WebDriver refused because Allow remote automation is disabled; native UI was used without changing that preference. |

The Chromium/Firefox full journeys completed at 15:13:20.162Z/15:13:19.448Z on the final UI sources; the subsequent 15:15 runtime-only gzip/406 rebuild retained those UI sources. Final fallback, chunk and live/performance checks used the final executable build. Fixture reports are explicitly labelled: attributable source values with synthetic current traffic timestamps/deviation and missing-reading scenarios. They are verification inputs and are not shipped as a production traffic mode.

Visible focus, source modal Tab/Escape behavior, selection/clear-selection focus, reduced motion, spoken station/energy cursors and 44 px sheet controls passed. Muted panel text contrast is at least 6.11:1 in the audited colors; this is a targeted contrast check, not a complete WCAG certification. Screenshots confirm controls/dialogs fit without page overflow and sheets preserve scene space.

Untested: Safari narrow/mobile/WebGL-failure and automated reduced-motion cases, VoiceOver or another screen reader, physical touch devices, low-power GPUs/device matrix and a formal Safari performance baseline. Native Safari's accessibility tree does not independently expose DOM focus after Escape; the visible source-trigger ring was observed and Chromium/Firefox assert exact focus restoration. Selecting the **same already-selected identity** retains the current list scroll/focus; its inspector remains reachable by scrolling. New identity selections and the essential journey pass.

## Performance on final assets

Hardware: Apple M2 Ultra Mac Studio, 24 cores, 64 GB RAM; macOS 26.6.2 build 25G83. Chromium viewport 1440×1000. The network baseline uses 20 Mbps each direction, 50 ms latency and disabled browser cache. Metrics are local release measurements, not guarantees for other hardware or provider latency.

| Target / workload | Final observation |
| --- | --- |
| Interactive view under 5 seconds | **1,455 ms**; entire energy catalog usable at **1,988 ms**. |
| Representative district at least 30 FPS | 211–240 FPS over ten samples; 22 draws/geometries, 12 loaded chunks, 487,126–487,162 triangles; 186–189 placed vehicles, 0–2 omitted for unknown terrain. |
| Receipt → browser update p95 under 2 seconds | **935 ms**, p50 430 ms, max 1,022 ms across 1,799 updates; measured from server receipt independently of provider timestamps. Provider-report → receipt p95 is separately 173 ms. |
| Catalog transfer | 843,087 encoded body bytes / 843,387 transfer bytes / 16,750,291 decoded API JSON bytes. Original static catalog remains 16,750,206 bytes. |
| Resource sample | 4,123,225 transfer bytes, 4,056,625 encoded and 42,805,268 decoded bytes in the recorded observation window. |
| Browser heap sample | 217,388,243 → 121,892,921 bytes after warmup/sample; short observation, not a leak guarantee. |
| All camera presets and 24 selections | City Centre 216, Harbour 240, Suomenlinna 240, Energy 239, repeated selection sample 42 FPS; 12 chunks throughout. |
| All eight layers disabled/restored | Both 240 FPS; geographic layers plus trams/buses/ferries/weather/AQ all explicitly disabled and restored. |
| Doubled E fleet | **392 labelled fixture identities**, exactly 2× the final 196-vehicle live peak, all placed; ten samples at 240 FPS (initial 208), 22 draws, 12 chunks. |
| Doubled B fleet | **472 labelled fixture identities**, 470 placed/2 unknown-terrain omissions; sampled 239–240 FPS, initial 200; 22–24 draws, 12 chunks. |
| Hidden tab / recovery | Controlled `document.hidden`: RAF frame count frozen at 959 and SSE closed; resume creates new SSE and full snapshot, then frames advance; 60 listed identities are unique. OS minimization was not separately tested. |

[Baseline](../release-evidence/performance-baseline.json) completed 15:17:19.879Z, [all-feature workloads](../release-evidence/helsinki-e-workloads.json) 15:21:41.542Z, [472-identity renderer](../release-evidence/helsinki-e-double-browser.json) 15:22:23.449Z, and [visibility evidence](../release-evidence/helsinki-e-visibility.json) retain exact measurements. A five-minute two-reader doubled server fixture separately accepted 141,128 reports, released an unread reader without disrupting the active readers, dropped no capacity and returned all feed state/timers to zero after idle grace. Its 472-identity workload is twice B's 236 sampled peak and exceeds twice E's 196 peak. An exact [392-identity E fixture](../release-evidence/helsinki-e-current-double.json) separately passed at 15:48:10.625Z with all vehicles placed and 240 FPS in every sample.

### Authoritative production soak

**Pass.** [Authoritative soak summary](../release-evidence/soak-production-summary.json): real final Node HTTP build, no fixtures; **2026-10-08T15:15:48.722Z–15:45:48.807Z (1,800.085 seconds)**, with idle cleanup complete at **15:46:19.011Z**. Two stable SSE readers shared one MQTT connection. Each received 1,800 traffic frames (two snapshots/1,798 updates) plus 120 heartbeats and ended with identical 179-vehicle state. Live fleet peak was 196; sampled identity peak 217, below the tested 1,000 cap. No transport reconnects or capacity drops; max pending 183 vehicles/two removals. After the last reader closed and grace expired, upstream/subscriber/consumer/vehicle/identity/pending/timer counts were all zero.

There were **161 recorded HTTP checks, all 200**: 31 checks of each of five APIs and six static asset checks. Root startup/installation health was verified separately. FMI weather was current in 15 samples and partial in 16; AQ current in all 31. Energy retained the dated valid cache, current in 31 samples; catalog ready in all 31. Delivered source reports included 183,316 bus, 116,700 tram and 225 ferry reports. Receipt → HTTP-reader latency across 300,241 delivered reports: p95 bucket **900–999 ms**, max **1,129 ms**; this server-reader measurement is separate from the browser baseline above.

During the traffic window, 348,229 provider reports were accepted, 1,391 rejected and 382,617 duplicate timestamps observed from 779,196 received messages. Rejection counters cover schema/time/value/size/rate validation without retaining raw payloads or identifying a specific rule; duplicates are non-newer timestamps for an existing identity. Unseen out-of-area reports are ignored. Pending entries remain bounded; none of these counters substitutes invented reports.

**31 sampled memory points:** heap **77,359,136–191,898,240 bytes**, RSS **426,409,984–611,844,096 bytes**. The window ended at heap 150,499,208 / RSS 498,712,576 bytes. Later ten-minute heap floors were 140,238,504 → 140,693,752 bytes and RSS floors 546,258,944 → 549,437,440, nearly stable after warmup. These point samples describe this local half-hour workload; they do not establish indefinite uptime or particular GC phases. All **40 executable and three static manifest hashes stayed unchanged**. The two earlier interrupted attempts remain explicitly incomplete diagnostics and are excluded from this result.

## Deliberate failures and recovery

[Resilience evidence](../release-evidence/resilience-summary.json) covers 49 focused deterministic tests, all passing. Provider failures use injected responses/errors and controlled clocks; actual source health is recorded separately.

| Failure | Verified behavior |
| --- | --- |
| HSL disconnect | Original report time retained; stale after 30 s, expiry after 120 s; fresh recovery reaches both clients; last-client demand/idle timers clean up. Retry backoff stays 1–30 s. |
| Slow/overloaded traffic reader | 1 MiB reader bound releases stalled client; 1,000 identity/current/pending/removal caps and heartbeat/abort cleanup remain tested. SvelteKit 3.0.0 `packages/kit/src/exports/node/index.js:245` installed source cancels on socket close/error; line 328 respects `res.write`/`drain` backpressure. |
| FMI timeout/malformed response | Dated valid readings survive failed refresh; status remains honest; later valid refresh recovers. Real stalled-body test verifies AbortSignal timeout after headers. Fixed stations, ≤6 h, 2 MiB/30 s/5,000 records remain bounded. |
| Nuuka outage/corrupt cache | Valid dated data retained on failed refresh; bounded retry replaces it; corrupt checksum cache fails closed, repairs from valid data and survives a new service instance. 15 s/256 KiB/366 rows, four concurrent requests, 24 starts/minute and 64 entries remain tested. |
| Missing city chunk / network recovery | Production `tile_0_0_0` request deliberately blocked; visible retry status, camera-away cleanup and return/retry, then second attempt succeeds and error clears. [Chunk evidence](../release-evidence/ui-chunk-production.json). |
| WebGL failure | Explicit scene limitation; keyboard search/metadata/history/energy/solar remain usable across required viewports; follow correctly disabled; selected vehicle updates/staleness/expiry preserved. Expected deliberate graphics/network console errors are separated from zero uncaught application errors. |
| Process restart | Clean production process stopped gracefully, started again, served actual endpoints and retained both real raw-cache hashes/retrieval time. Both exits zero. |

## Clean installation, operation and package

[README](../../README.md) and [operations](../operations.md) specify preparation order, Node 24/npm 11, Java 17+/unzip for preparation, outbound HTTPS/TLS MQTT, runtime static assets, writable `.cache/energy/runtime`, one-process feed ownership, SSE proxy buffering/heartbeat/timeouts, source/process health, logs, refresh, graceful restart and whole-release rollback. No upstream API key is needed. The Node adapter 6.0.0 derives origin from Host/proxy headers; this version has no runtime ORIGIN variable.

The final compiled candidate `helsinki-lens-0.1.0-a523eab230af` clean-installed independently into `/private/tmp/helsinki-release-e-final-runtime-drelhbgq` at 15:18:57.651Z. `npm ci --omit=dev` installed 303 locked production packages, zero reported vulnerabilities, with fresh node_modules using exact registry tarballs cached by the earlier clean network install. `npm start` is `node --env-file-if-exists=.env build/index.js`. Root/assets/route/catalog/actual measured series passed before and after restart; gzip was 843,087 bytes and forbidden encodings were empty 406. Both raw cache files retained SHA256 and 14:13:18.564Z retrieval, avoiding a false fresh-source claim.

Measured candidate resources: 138,791,387 payload bytes / 1,252 hashed files / 369 active assets; allocated release 155,240 KiB, production dependencies 166,948 KiB, installed total 305,732 KiB. Cache: 107,486 bytes / 112 KiB / two files. Endpoint-workload RSS: 394,704 KiB first start, 392,240 KiB after restart. Full live soak memory is separate. Final documentation/screenshots increase artifact size; the final receipt records actual totals. The runtime cache's 16 MiB configured payload cap is a bound, not measured use. Capacity beyond this local workload is untested.

`npm run release:package` creates the immutable versioned directory under `.cache/task-e/releases/`; `COPYFILE_DISABLE=1 tar -czf <release-id>.tar.gz -C <release-parent> <release-id>` preserves the relative data symlink. The package's `release.json` contains file/data checksums; the final local receipt `.cache/task-e/final-release.json` records the directory/archive paths, archive checksum and equality to tested executables/assets. Every final manifest file is checked, and the archive preserves the contained relative data symlink. A content hash cannot be embedded in this report because the hash includes the report. No actual `.env`, credentials, preparation downloads, raw runtime caches, node_modules, obsolete generation or Ocean configuration is distributed. Screenshots below and concise verification evidence are bundled under `docs/`.

## Final live source smoke

At **2026-10-08T15:24:40.057Z (18:24 Helsinki)**, actual HSL was live: 185 vehicles (68 trams, 116 buses, one ferry), last provider position 15:24:39.665Z, one process upstream connected since 15:15:37.988Z. Fresh samples: tram `0040/00431` / route `1009`, reported 15:24:39.597Z, received 15:24:39.583Z, +94 s late (raw −94); bus `0018/00278` / `1500`, reported 15:24:39.665Z, received 15:24:39.645Z, 103 s early (raw +103); ferry `0060/00004` / `1019`, reported 15:24:32Z, received 15:24:32.956Z, deviation unknown. Small report/receipt clock offsets remain source facts. A separately selected live tram route matched exactly to `1005_20261007_To_2_1826`, 18 stops. GTFS feed version 2026-10-08 04:57:02, retrieved 10:54:54.985Z, valid 7 October–5 December.

FMI weather station 100971 was **partial**, newest t2m/wind/gust values at 15:20Z missing; requests received at 15:21:00.100Z/108Z. The UI retained dated latest valid temperature 12.2 °C, wind 6 m/s and gust 9.4 m/s; precipitation 0 mm remained a real reading. AQ station 100742 was current: NO₂ 17.6 µg/m³, observed 15:00Z, received 15:15:48.071Z. Later production-soak refreshes can change those source states; they do not rewrite this dated smoke. [Actual endpoint evidence](../release-evidence/helsinki-e-live-sources.json).

Energy was current: complete September 2026 property month, 30 measured days, 173,390.333 kWh, retrieved 14:13:18.564Z. This is validated cached availability, not a new Nuuka acquisition. Catalog was ready: 34,643 original modeled annual records and 695 solar records with exact generation match. Native final Safari separately verified actual tram `0040/00075` / route 1 / 189 s late, exact 18-stop journey, station history and building 103027184J measured/model records plus building 1030270784 solar; no synthetic data was used in that smoke.

A second [final live smoke](../release-evidence/helsinki-e-live-final.json) completed **15:45:09.938Z (18:45 Helsinki)**: HSL live, 176 vehicles (66 trams, 109 buses, one ferry), same upstream connection and exact route context. Tram `0040/00410` / 1002 was reported at 15:45:09.344Z, received 15:45:09.393Z, 299 s early; bus `0012/01824` / 4400 at 15:45:09.259Z/428Z, +60 s deviation; ferry `0060/00004` / 1019 at 15:45:03Z/03.937Z, deviation unknown. Weather was partial at 15:40Z, received 15:41Z: latest valid temperature 12.2 °C, wind 6 m/s and gust 8.8 m/s at 15:30Z; precipitation 0 mm observed 15:00Z. AQ remained 17.6 µg/m³ at 15:00Z, received 15:31Z. Property energy remained the complete dated cached September series and catalog ready; no fresh Nuuka acquisition is implied.

## Screenshots and walkthrough

The [tram](../release-screenshots/chromium-tram.png), [station history](../release-screenshots/chromium-station.png), [measured/model building](../release-screenshots/chromium-building-energy.png), [solar](../release-screenshots/chromium-solar.png), [portrait sheet](../release-screenshots/chromium-portrait-inspector.png), [landscape source dialog](../release-screenshots/firefox-landscape-sources.png) and [WebGL metadata fallback](../release-screenshots/webgl-fallback-desktop.png) use the explicitly labelled offline verification fixture. The [all-features view](../release-screenshots/performance-all-features.png) uses actual live final production sources; [392 vehicles](../release-screenshots/392-fixture.png) and [472 vehicles](../release-screenshots/472-fixture.png) are clearly labelled load fixtures. Native Safari screenshots were observed but not bundled because browser chrome contains unrelated user bookmarks.

1. Search a received tram, select it with Enter, read separately dated report/receipt and signed deviation, then follow it.
2. Select nearby Kaisaniemi or Mannerheimintie to inspect station-scoped values, quality and observed times. Use the history cursor; current transit continues independently.
3. Search `103027184J`, inspect original identifiers and the complete September shared-property series. Compare its explicitly modeled demand; the property total is not allocated to this building.
4. Search `1030270784` for modeled solar radiation. Read annual calculation/export dates and unknown weather/run settings; no measured consumption or PV generation is inferred.
5. Open Sources & status for actual coverage/terms/timestamps, traverse by Tab and close with Escape. On compact viewports use Layers & conditions / Inspect & search / Scene; search remains usable without WebGL.

## Visible limits and remaining risks

The release contains 8,909 unique building identities; 8,915 renderer metadata entries include six split duplicates. Modeled demand covers 4,949; solar 695 in twelve historical district tiles. Other solar tiles are **unqueried**. The one measured shared property declares three members: two exact matches and one unresolved; totals are never allocated. Seven original modeled scenarios span 2020–2050. Solar is incoming radiation on roofs/walls, not installed PV capacity, electrical yield or live generation. Its meteorological reference year, calculation date and optional settings remain unknown. Weather/AQ cover only two verified stations; station context does not establish causation with vehicle delay. Unknown terrain suppresses affected vehicle geometry and is counted. GTFS refresh remains preparation-only. See [D](D.md), [energy/solar evidence](../energy-solar-evidence.md) and [solar method](../solar-method-evidence.md).

No source feature is replaced by an inferred zero, invented live reading or substitute dataset. Remaining browser/device/assistive-technology exceptions and same-identity selection scroll behavior are recorded above. This package is verified for one Node process and the measured local workload; distributed scaling, public reverse-proxy/TLS deployment and long-term uptime remain outside this release verification. **No unresolved required release gate remains.** The final artifact receipt is separate from this content-hashed report; public deployment has not been performed.
