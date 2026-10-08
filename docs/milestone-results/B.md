# Task B — Living city results

**Status: Complete.**  
**Evidence date:** 8 October 2026.

## Acceptance results

| Acceptance item | Result | Evidence |
| --- | --- | --- |
| Centre, harbour and ferry corridor geometry; control alignment | **Pass** | Official 245-tile semantic source published 8,909 buildings / 984,240 triangles in 177 batches, including 493 island-area buildings. Five independent controls pass; 110 shared buildings preserve both original N2000 extrema within 2 cm. |
| Ten building selections preserve IDs and attributes | **Pass** | Ten actual browser keyboard selections checked against source GMLID, VTJ-PRT/RATU and available attributes; ten published geometry raycasts also pass. |
| Real tram, bus and HSL ferry reports; filters and timestamps | **Pass** | Actual 30-minute HSL sample received all three modes; browser mode filters remove/add matching objects without changing subscriptions. Last report times remain provider timestamps displayed in Helsinki time. |
| Received-only movement and reduced motion | **Pass** | Regression tests cover bounded positions, heading interpolation, jumps/gaps, duplicate/out-of-order input, stale hard stop and no extrapolation; browser reduced-motion preference verified. |
| Two browser clients share one upstream; final client idle shutdown | **Pass** | Two independent live browser contexts rendered the same fleet through one measured MQTT socket. After both closed, that socket disappeared after the 30-second grace. Deterministic and 30-minute two-client SSE checks also pass. |
| Interruption, reconnect, hiding, stale/removal without replacements | **Pass** | Production-process interruption and full-snapshot recovery passed; controlled browser visibility stopped SSE/animation and resumed with a fresh snapshot. A labelled offline fixture verified 31-second stale hold and 121-second removal with selected identity retained. Native OS minimization remains unverified under automation. |
| Load, FPS and controlled update latency targets | **Pass** | Cache-disabled production Chrome, 20 Mbps / 50 ms latency: interactive in 1,423 ms; ten FPS samples 228–240; p95 receipt-to-browser latency 949 ms across 2,176 updates. |
| Thirty-minute representative soak and separate twice-peak workload | **Pass** | Thirty-minute real sample passed with a peak of 236 vehicles; a separate five-minute, 472-identity fixture soak passed bounded state, reader agreement and final idle cleanup. The separate doubled-fleet browser workload rendered 466 vehicles and explicitly omitted six with unknown terrain height. |

## Baseline and measurement method

The local baseline is an Apple M2 Ultra Mac Studio with 24 CPU cores and 64 GB memory, Darwin 25.6.0, Node 24.19.0 and npm 11.17.0. Browser verification uses headed Chrome 154.0.8037.99 at 1440 × 1000. Initial-load measurements use disabled HTTP cache and a controlled 20 Mbps connection; they describe this hardware and network setting, not provider latency.

The bounded verification script `scripts/verify-traffic.ts` records one minute of memory and feed diagnostics at each interval during an actual 30-minute HSL connection. Two readers continuously parse SSE snapshots/updates and compare current vehicle state. A third reader deliberately leaves its stream unread to exercise queue bounds. The script asserts latest-state bounds, one upstream connection, equivalent active readers and timer/connection release after the last reader closes. Its latency histogram has fixed memory and 100 ms buckets; provider report age is recorded separately from internal receipt-to-reader latency.

Large local diagnostic outputs remain in ignored `.cache/task-b/`; screenshots and browser traces remain in ignored `output/playwright/`. Final evidence and reproducible commands are summarized here. No deployment is part of this task.

## Operational policy

Traffic positions become stale after 30 seconds and are removed after 120 seconds, based on `reportedAt`. A metadata update or duplicate report cannot make an old position fresh. HSL owner/operator and vehicle IDs remain strings. Latest state and browser queues are bounded; mode filters share the upstream feed.

The traffic API consists of `GET /api/traffic` and `GET /api/traffic/stream`. SSE sends a full `snapshot` on connection and upstream recovery, coalesced `update` events at approximately one second, explicit removals and connection status, plus 15-second heartbeat comments. Proxies must disable buffering/caching and keep a timeout longer than the heartbeat interval. The application initially requires one Node process.

## Production browser measurements

Measured against the local production Node server at `http://127.0.0.1:4181/`, with Chrome network emulation set to 2,500,000 bytes/second download and upload (20 Mbps), 50 ms network latency and disabled HTTP cache. The interactive measurement runs from navigation until `main[data-scene-ready="true"]`, when real building geometry and selection are available. More spatial chunks continue loading according to the view; initial interaction does not require all 177 batches.

| Metric | Result |
| --- | ---: |
| First interactive geometry | 1,423 ms |
| Ten frame-rate samples after readiness | 228, 228, 240, 240, 240, 240, 240, 240, 240, 240 FPS |
| Draw calls / renderer geometries | 20 / 20 |
| Loaded building batches | 12 |
| Rendered triangles | 487,418–487,430 |
| Placed live vehicles | 225–226 |
| Ground vehicles omitted for unknown terrain | 0–1 |
| Resource transfer after the observation window | 2,491,106 bytes, plus 6,902 navigation bytes |
| Encoded resource bodies | 2,478,806 bytes |
| Decoded resources after the observation window | 19,127,861 bytes |
| Server receipt → browser SSE update, 2,176 vehicle updates | p50 598 ms, p95 949 ms, maximum 1,073 ms |
| Provider report → server receipt, separate p95 | 168 ms |
| Browser JS heap at readiness / end of 20-second measurement | 66,245,835 / 93,446,585 bytes |

An earlier run of the corrected geometry reached interaction in 965 ms with 1,048 ms p95 update latency and heap decreasing from 83,661,389 to 69,212,696 bytes; the table above is the authoritative final production run, and these short heap samples do not establish a long-term browser memory trend.

The corrected asset generation is **2026-10-08T12:10:39.077Z**. Its initial four-batch geometry is **5,797,062 bytes** before compression, the base asset is **3,573,417 bytes**, and the complete published generation is **74,346,368 bytes**. HTTP compression materially reduces transfer. The application keeps a maximum of twelve loaded spatial batches. These measurements are a documented high-performance desktop baseline; they do not establish frame rates on other hardware or a production proxy.

Two independent browser contexts concurrently rendered the same 229 placed vehicles, at 240 and 219 FPS respectively. Direct socket inspection of their isolated Node server showed one HSL MQTT connection. After both contexts closed, direct socket inspection confirmed that the MQTT socket was released after the 30-second idle grace; only the local HTTP listener remained.

## Thirty-minute real feed soak

The real sample ran from **2026-10-08T11:40:42.472Z** through 30 minutes of traffic, then completed idle shutdown at **12:11:12.542Z**. Peak received fleet: **236**. Both active SSE clients received **1,801** matching snapshot/update frames and ended with identical current state. The deliberately unread third client was released when its bounded stream queue filled. Final diagnostics show zero upstream connections, subscribers, consumers, vehicles, identities, pending changes/removals and timers. No synthetic traffic appeared in this run.

| Mode | Coalesced vehicle reports delivered to the measured reader | First / last provider report UTC |
| --- | ---: | --- |
| Tram | 118,596 | 11:40:43.092 / 12:10:41.755 |
| Bus | 247,403 | 11:40:44.251 / 12:10:41.250 |
| Ferry | 566 | 11:40:45.000 / 12:10:38.000 |

These are delivered position reports, not distinct vehicle counts. The feed consumed 902,776 MQTT messages / 270,930,805 bytes including the idle grace, accepted 445,693 newer in-scope/scope-exit reports, deduplicated 394,600 and rejected 719 invalid/expired reports. Source messages outside the area without an existing identity are ignored. There were zero capacity drops. Maximum pending changes were 223 vehicles / 2 removals, below the 1,000-identity limit.

Server heap fluctuated with garbage collection between 19.7 and 72.9 MB and finished the traffic window at 21.7 MB; its floor did not grow over the run. RSS warmed from 125.0 to about 240 MB and then ranged 240.7–246.5 MB. Bounded identity/current-position/queue counts stayed stable. Internal receipt-to-SSE-reader latency was p95 in the 900–999 ms bucket, maximum 1,002 ms; provider age was measured separately. This is evidence for the tested 30-minute workload, not a claim about indefinite uptime.

## Doubled-fleet fixture soak

The independent doubled-fleet workload used **472** identities (2 × the real peak of 236), one-second explicitly offline fixture reports, two active SSE readers and one unread reader. It began at **2026-10-08T12:12:11.695Z**, ran for five minutes, and completed idle cleanup at **12:17:41.815Z**. The feed accepted **141,128 reports**; both active readers received **300** matching frames. There were no rejections or capacity drops, and final diagnostics show zero connections, subscribers, consumers, vehicles, identities, pending changes/removals and timers.

Internal receipt-to-reader latency was p95 in the **1,000–1,099 ms** bucket, maximum **1,006 ms**. Server heap ranged **15.8–48.3 MB** and ended at **35.0 MB**; RSS was approximately **236 MB**. The separate browser workload below verifies rendering of the doubled fleet.

The ignored local evidence files are `.cache/task-b/live-soak.json` and `.cache/task-b/fixture-soak.json`. The doubled workload stays confined to the verification script and does not replace real reports in the application.

## Browser lifecycle and doubled-fleet verification

Follow activated for a selected real vehicle and camera dragging canceled it. The actual local production process was terminated at **2026-10-08T12:28:30.755Z**. The browser showed “HSL reconnecting” and “Connection interrupted · reconnecting” while retaining **228 vehicles / 228 unique identities**. After process restart, a full snapshot recovered the connected state at **12:28:40.799Z**, with **six vehicles / six unique identities** as the new live feed naturally refilled.

Visibility was tested in an isolated browser context using real fetch and EventSource connections while controlling `document.hidden`. Before hiding there was one open stream, one snapshot request and 970 animation callbacks. Hiding closed that stream and the callback count stayed at 970 for two seconds. Resuming opened a second stream, obtained a second snapshot, resumed animation to 1,570 callbacks, and recovered **219 vehicles / 219 unique identities**. This was a controlled visibility-handler test: native window foreground/minimize automation never made `document.hidden` true, so native OS minimization was not independently verified.

A labelled offline copy of a real tram report, with a controlled browser clock, verified the freshness thresholds. At 31 seconds the position was stale and held at its last coordinates. At 121 seconds the vehicle was absent from the renderer and list, while the selected identity **0040/00448** remained in the inspector with its expiry explanation.

The doubled-fleet browser fixture used a real source snapshot from **2026-10-08T12:26:14.488Z**, copied into **472 unique identities**: 138 trams, 330 buses and four ferries. The browser rendered **466** and explicitly omitted **six ground vehicles** with unknown terrain height. Initial frame rate was 219 FPS; subsequent samples were **239, 240, 240, 240, 240, 240, 240, 240, 240, 239 FPS**. The scene used **20 draw calls, 20 geometries, 12 loaded building batches and 490,310 triangles**. Browser JS heap changed from **153,205,411 to 168,843,881 bytes** over 13 fixture events. This was a short ten-second rendering workload; the separate five-minute server fixture soak provides the bounded-state evidence.

Final City Centre, Harbour and Suomenlinna screenshots were captured and inspected. The persistent chunk-failure notice was corrected and its browser regression passed: aborting the `tile_0_0_0` geometry request kept the notice visible while that chunk was wanted; moving to Suomenlinna cleared it; returning to City Centre during the retry delay restored it. Unblocking the request and advancing the controlled clock by 31 seconds allowed the second attempt to load, leaving twelve loaded chunks and no scene error. This clock-controlled regression is lifecycle evidence, not a performance measurement. The same regression passed against the final production build.

## Verification commands and changed areas

The final code check set passed **70/70 tests**, type checking with **zero errors and zero warnings**, and one isolated production build. The build emitted the ordinary Three.js bundle-size advisory. No code changed after these checks; the final production browser regression also passed. Commands used:

```sh
npm test
npm run check
npm run build
node scripts/check-city-assets.ts
node scripts/verify-traffic.ts
node scripts/verify-traffic.ts --fixture --peak=236 --seconds=300
```

Browser checks used the `helsinki-b` Playwright CLI session against the production server on port 4181. Temporary browser scripts were kept outside the repository; the measurements and observed results are recorded above.

The changed implementation areas are `src/lib/scene.ts`, `src/lib/live-fleet.ts`, `src/lib/city-assets.ts`, `src/lib/components/CityScene.svelte` and `src/routes/+page.svelte`; the shared traffic contract, server feed/stream and traffic API routes; city preparation and verification scripts; corresponding asset, scene, fleet and traffic regression tests; generated city assets; and source/preparation/operation documentation. The static city generation retains semantic identifiers and N2000 elevations, while live traffic remains a separate current-state source.

## C handoff

`CitySceneController` exposes camera presets, layer updates, current traffic snapshots, building/vehicle selection, follow cancellation and disposal. Selection callbacks retain building identities while their geometry is unloaded, and retain removed vehicle identities with an explicit expiry state. Building and vehicle lists provide keyboard selection. Camera interaction cancels follow; reduced motion uses discrete received positions.

C can build inspection and environmental context on these callbacks and the existing source records. Ground vehicles without known terrain height remain omitted and counted; their selection ring also stays hidden. Connection status and report freshness are distinct, and prepared source vintages remain separate from live traffic timestamps. Asset loading stays bounded to twelve view-dependent batches; the traffic feed and thresholds remain shared across browser clients in one Node process.
