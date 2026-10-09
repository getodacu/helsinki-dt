# Live rail monitoring: evidence and operating limits

Verified locally on 2026-10-09. This work adds three increments: shared live data/contracts; instanced trains with journey inspection; station boards, category controls and camera presets. Existing HSL, city and energy changes remain intact. No deployment was performed.

## Sources and live checks

Fintraffic / Digitraffic railway data, licensed CC BY 4.0: [provider documentation](https://www.digitraffic.fi/en/railway-traffic/). Keep the provider attribution and source link visible in Sources & status. Requests send `Digitraffic-User: HelsinkiLens/1.0` and `Accept-Encoding: gzip`.

| Input | Verified endpoint / interpretation |
| --- | --- |
| Positions | `https://rata.digitraffic.fi/api/v1/train-locations/latest?bbox=24.86,60.135,25.06,60.225`; JSON Point coordinates are longitude, latitude; speed is km/h. |
| Train timetable | `/api/v1/trains/YYYY-MM-DD/number`; dated train identity, category, line/type, operator and ordered timetable events. |
| Stations | `/api/v1/metadata/stations`; includes HKI, PSL and ILA. |
| Departures | `/api/v1/live-trains/station/HKI?arrived_trains=0&arriving_trains=0&departed_trains=0&departing_trains=100&include_nonstopping=false&train_categories=Commuter,Long-distance`. |
| Route archive | `https://rata.digitraffic.fi/api/v1/trains/gtfs-all.zip`; includes real shapes. |

The initial bounds query returned 15 reports. Later browser samples had roughly 12–16 usable trains. Some source reports were older than 120 seconds and were intentionally excluded. The GeoJSON alternative returned HTTP 500 during sampling; the implementation uses the working JSON endpoint.

Station coordinates verified from the provider: Helsinki (HKI) 24.941444 / 60.171356; Pasila (PSL) 24.933521 / 60.198689; Ilmala (ILA) 24.920829 / 60.207808. Seven in-area passenger stations were shown in the live catalog, alongside the two existing environmental stations.

A 20-train departure query included many past scheduled departures with no actual time, leaving only three future events after filtering. The bounded query now requests up to 100 trains and returns the first 12 qualifying passenger departures. Central and Pasila both showed 12 in the browser, including rows labelled “No live position”. Provider omissions can still yield fewer than 12; missing estimates remain unknown. The limit is a response bound, not a guarantee of complete departure coverage.

## Exact schedule matching

Archive SHA256: `e6ca3ab3b4b5037a87b66d1f1e3821c1c2d981649855e084a2684ba32e480276`.

Retrieved 2026-10-09T19:53:13.054Z; feed version 2026-10-09T01:40:39.260Z; declared validity 2026-10-02 through 2027-12-31. Final index: 1,903 train numbers, 14,575 trip patterns, 125 clipped shapes, 99 stop/platform records; 7,688,447 JSON bytes. These are prepared schedule counts, not a count of live vehicles or distinct stations.

Digitraffic's trip-ID date suffix is a timetable-period identifier, not a departure date. For example, train 8952 on October 9 matches `8952_20261014` through its active calendar; train 273 matches `273_20261212`. Matching therefore requires the exact numeric train ID and service calendar on the reported departure date, including additions/removals. More than one active candidate stays ambiguous and draws no path. Single-digit source clocks such as `6:54:00` are normalized before shared GTFS time conversion. Overnight times and both Helsinki DST transitions are covered by regression tests.

A live commuter train `digitraffic:2026-10-09:8230` resolved to `8230_20261024`, with seven in-area stop events and a visible route highlight. I, P, Z and overnight passenger examples were also checked directly against the prepared index. The line stays on the verified clipped shape; reported GPS is never moved onto it.

Refresh from the source checkout:

```sh
npm run rail:prepare
npm run check
npm test
npm run build
```

Run preparation daily and after timetable changes through the operator's existing workflow. No new automation is installed. Offline reprocessing: `npm run rail:prepare -- .cache/rail/gtfs-all.zip`. An archive's retrieval sidecar is accepted only when SHA256 matches. Publication is atomic and bounded to 64 MiB; failures preserve the previous file. Rebuild production after preparation. Release packaging validates and checksum-checks `rail-index.json` with the other prepared assets. An absent or expired index disables route context without hiding live trains.

## Runtime bounds and interpretation

- One five-second position poll per Node process, shared by traffic consumers. Polls do not overlap; failures back off from 5 to 60 seconds. Idle cleanup shares the existing 30-second grace period and aborts outstanding work.
- Each rail HTTP request has a 12-second timeout and a 4 MiB limit. Position responses and timestamp watermarks are limited to 2,000 identities. Each SSE client has an 8 MiB queue bound so a combined provider snapshot fits; slow clients are disconnected and recover from a new snapshot. Malformed nonempty snapshots are errors, not empty fleets. Duplicates and older reports cannot move a train backwards or resurrect a known exit.
- Metadata uses four concurrent requests, at most 128 queued jobs and 256 cache entries. Journeys/departures refresh at 30 seconds; the station catalog is retained for 24 hours. Cancelling a feed consumer releases its work without aborting a request still needed by an inspector.
- Metadata never changes position report/receipt time. Age policy remains stale at 30 seconds and removed at 120 seconds. Successful empty snapshots clear rail reports; failed polls retain reports until expiry. HSL and rail outages are independent in snapshots, SSE and the UI.
- Trains use a 12-second report-time display buffer, meaningful-movement bearings and bounded history. Gaps over 25 seconds, jumps over 1.5 km or implied speeds over 100 m/s snap to the new received sample instead of animating across the gap. No extrapolation. Reduced motion uses discrete reports.
- Actual and estimated times are separate from scheduled time; missing estimates are never zero delay. Delay is attached to a named timetable event. Next-stop inference is explicitly schedule-based. Stale timetable delay is unknown; last estimates remain labelled as stale in inspection.
- Horizontal coordinates are unchanged. Terrain placement is approximate and is omitted when terrain is unknown, while the train remains searchable. The original two-car GLB is representative: 44.466 m long, 11,624 triangles, 739,424 bytes, three material batches. It does not represent actual carriage formation.

## Verification

Automated checks cover position units/identity/date validation, undated reports, duplicates, ordering, exits, expiry policy, enrichment freshness, cache sharing, bounded concurrency, cancellation and queue cleanup, independent provider failures, reconnect snapshots, slow SSE clients, idle cleanup, GTFS calendar matching, missing/ambiguous shapes, clipping, shuffled stops, overnight/DST times, signed/unknown delays, platforms, cancellations and departures independent of GPS. Train geometry, raycasting, unknown terrain, category visibility and motion have dedicated checks. The existing collision-priority and crowding tests remain applicable to all modes.

The full suite passed all 243 tests after the concurrent SQLite/TanStack building-query integration; Svelte checking reported zero errors and warnings. The rail feature retains that incoming work. The final production build completed successfully in an isolated snapshot of the combined source, avoiding another concurrent build rewriting the shared output directory. The post-integration browser smoke check reconfirmed 12 Central departures, numeric live-train search, an exact route highlight, follow and cancellation by camera preset. A pre-existing ExcelJS streaming-workbook test intermittently failed with an undefined `sheets` error during concurrent production builds and passed in isolation; the workbook implementation was not changed by the rail work.

Browser checks used the actual local app and live data at Central and Pasila: station boards, live-train links, numeric search, exact route inspection/highlight, follow and camera-preset cancellation, 390×844 viewport, keyboard station selection and reduced motion. Desktop viewport was 1440×1000. A 31-second simulated `visibilitychange` interval issued no traffic/rail requests; restoring visibility reopened the snapshot, SSE and station board. Train mode/category toggles and repeated keyboard station selection were also checked. Browser artifacts are in the ignored `output/playwright/rail-*.png` directory. Dataset/source failures are exercised deterministically in tests; the providers were not deliberately disrupted.

Controlled renderer comparison used the pre-change `LiveFleet` from Git and the new class, the same 1024×768 scene with 100 simple buildings, identical camera and 450 synthetic bus/tram/ferry records, 60 warm-up frames and 300 measured frames. A third run added 20 trains.

| Run | FPS | Draw calls | Geometries | Triangles | JS heap sample |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before, 450 vehicles | 100.2 | 10 | 4 | 4,355,400 | 24.8 MB |
| After, same 450 vehicles | 99.6 | 10 | 5 | 4,355,400 | 30.5 MB |
| After, plus 20 trains | 100.3 | 13 | 5 | 4,587,880 | 26.4 MB |

CPU submission samples were 0.396 / 0.381 / 0.375 ms per frame. These results are refresh-rate limited and sequential heap samples are affected by garbage collection: they are not a claim of improved speed or a stable memory delta. The whole-city development view was also visually checked around 99–100 FPS; its varying live fleet and asset residency prevent a controlled before/after comparison. This is local renderer evidence, not a production soak or a mobile-GPU guarantee.

## Coverage limits

Live coverage is sampled, not proven complete. Passenger, freight and yard reports may be missing, undated, stale or outside the prepared area. A current position does not prove passenger service; a timetable does not prove a current position. No location is synthesized for a departure without GPS. APIs and GTFS may lag or disagree. Exact formations, track snapping, surveyed rail elevation, signals, replay and predictive motion remain deferred as planned.
