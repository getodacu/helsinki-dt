# Helsinki Lens operations

Run one Node 24 process with npm 11, from the extracted release or source project root. No upstream credentials are required. The release is intended for Linux/macOS with relative symlinks preserved. Normal HTTP serving needs outbound HTTPS to FMI, Nuuka and Digitraffic, TLS MQTT to `mqtt.hsl.fi:8883`, and TLS WebSocket MQTT to `meri.digitraffic.fi:443`; data preparation also downloads the documented City of Helsinki/HSL sources and the pinned Java converter. Provider outages remain visible in the application.

## Prepare, build and package

Use a source checkout with the npm lockfile, Node 24/npm 11, Java 17+ and `unzip`. Generated data is ignored by Git. A checkout alone has no prepared city or energy catalog. Preparation downloads are bounded and their original retrieval dates/checksums are retained in `.cache/`.

```sh
npm ci
npm run data:prepare
npm run city:prepare
npm run energy:prepare
npm run ryhti:prepare # Optional building register and permit enrichment
npm run routes:prepare
npm run rail:prepare
npm run entities:prepare
npm run check
npm test
npm run build
npm run release:package
```

`data:prepare` publishes a usable foundation or retains the previous generation on failure. Exit 2 means a sample was published with historical open A gates: read the diagnostic rather than treating it as a successful complete release. D resolved energy/solar using its separate verified catalog; the foundation's original gate evidence stays historical. Exit 1 means preparation failed. Check each command before continuing; do not deploy partial or mismatched output.

After **every** `city:prepare`, run `energy:prepare`, even when the semantic tileset checksum is unchanged. Energy binds to the exact city generation, source checksum and vintage. Changing only the city disables mismatched energy values/themes. Run `routes:prepare` after the GTFS archive is ready. Run `entities:prepare` after the foundation, city, energy and optional Ryhti sources are ready, then rebuild the production application after every static refresh.

The packager reads the existing build; it never starts a concurrent build. It validates every active foundation/city/energy checksum, city/energy compatibility, prepared route index and equality with the built HTTP assets. It creates `.cache/task-e/releases/helsinki-lens-<version>-<content-hash>/`; an optional output parent is accepted with `npm run release:package -- /absolute/output/path`. Existing output is not overwritten. `release.json` records all release file checksums, active asset checksums and preparation times. The content hash includes the build, lockfile, notices and documentation; rebuilding or changing those creates a distinct release.

The directory contains the active private SQLite generation and manifest in `server/data/entities/`, `build/`, `package.json`, `package-lock.json`, `.env.example`, `README.md`, `.nvmrc`, `docs/`, `THIRD_PARTY_NOTICES.md` and `release.json`. `static/data` points to `../build/client/data`; the runtime readers and HTTP server therefore use the same asset versions without duplicating data. Preserve this link when transferring: `COPYFILE_DISABLE=1 tar -czf <release-id>.tar.gz -C <release-parent> <release-id>` does so; `COPYFILE_DISABLE=1` suppresses macOS metadata companion files and is harmless on Linux. Keep the active foundation generation, city base/chunk/metadata generation, route index, energy catalog/manifest and optional refresh diagnostic together. The adapter's complete static file table is produced during build, so exclude unused old generations **before** the final build rather than pruning built files. Prior generations can be archived outside `static/` for rollback.

No `.env`, credentials, raw preparation downloads, `.cache/energy/runtime`, `node_modules` or another workspace's files are bundled. Dependency notices use exact installed locked production package versions and original LICENSE/NOTICE files, with package declarations and README notices when the package lacks a standalone license file. Installing dependencies retains their original package notices. City of Helsinki/Helsinki 3D, Energy and Climate Atlas/Nuuka, HSL/Digitransit, FMI and HSY notices, retrieval dates, source versions and explicitly unknown vintages remain in the shipped manifests/source drawer. The UI uses system fonts and procedural illustrative vehicles; no third-party font or photographic vehicle image is distributed.

## Install and start

Extract into a new release directory, change to its root, and run:

```sh
npm ci --omit=dev
cp .env.example .env
mkdir -p .cache/energy/runtime
npm start
```

`npm start` checks Node/npm through `node --import ./scripts/check-requirements.mjs --env-file-if-exists=.env build/index.js`; the requirements checker is included in the release bundle. The build requires locked production dependencies but no Java or source downloads at runtime. The runtime bundle cannot run preparation/build/test commands; use the source checkout for those. The process must read `build/`, the lockfile and `static/data` plus `server/data/entities/`, and write `.cache/energy/runtime/`. Keep its working directory at the release root; relative server paths resolve there.

| Environment | Meaning |
| --- | --- |
| `HOST` | Bind address; adapter default `0.0.0.0`. The example uses `127.0.0.1` for a local reverse proxy. |
| `PORT` | TCP port; default `3000`. |
| `NODE_ENV` | Set `production` for the released Node process. |
| `SHUTDOWN_TIMEOUT` | Adapter graceful SIGTERM/SIGINT timeout in seconds; default/example `30`. |
| `PROTOCOL_HEADER` | Behind a trusted proxy, set to `x-forwarded-proto` and have the proxy replace that header. Leave unset for direct HTTP. |
| `CITY_MAP_CACHE_DIR` | Persistent municipal cache; default `.cache/city-map`. One process owns a directory. |
| `CITY_MAP_CACHE_MAX_BYTES` | Municipal metadata + binary budget in bytes; default `8589934592` (8 GiB). |
| `CITY_MAP_CACHE_MAX_ENTRIES` | Municipal asset-entry budget; default `16384`. |
| `CITY_MAP_CACHE_MAX_PENDING` | Maximum distinct pending municipal requests (active + queued); default `36`. |
| `CITY_MAP_CACHE_MAX_QUEUED` | Maximum queued municipal requests; default `32`. |

Environment variables supplied by the process manager override values in `.env`. The project defines no API-key variables. The installed adapter's origin/proxy contract was checked against adapter-node **6.0.0**, `src/handler.js:19` and `src/index.js:10` in its pinned source; it derives the request host from forwarded headers or Host and has no runtime `ORIGIN` variable in this version. Keep the Node port private behind a proxy and accept forwarded headers only from that proxy.

Municipal cache limits accept positive safe integers; invalid values fall back to defaults. Calibrate storage and request budgets for the intended host/workload. The durable budget covers municipal metadata and binary files only, excluding temporary files, sibling caches and photograph directories. Eviction uses least-recent in-memory access; restart rebuilds the disk inventory rather than preserving access recency. Valid stale bytes survive failed refreshes. Quota inability or disk failure stops automatic warming, while foreground requests can still use validated downloaded bytes uncached.

Keep `CITY_MAP_CACHE_DIR` persistent across releases and writable by the application user. To warm it from a prepared source checkout, **stop the app first**, run `CITY_MAP_CACHE_DIR=/srv/helsinki/shared/city-map npm run city:cache`, then restart with that same absolute directory. Add `-- --refresh` to retrieve again without first deleting valid cache files; omit it to resume. The CLI and app must not write the same directory concurrently; concurrent workers require separate directories. A bounded cache can evict earlier coverage during full-area warming. Keep matching prepared assets, operator environment and user files intact; no additional preparation or provisioning step is needed for these limits.

The public `/api/city-asset` proxy admits prepared aerial cells and validated discovered/cached municipal models and indexes, not arbitrary municipal URLs. Overload, cancellation and other asset failures return a generic HTTP 503 with `Retry-After: 60`; do not treat these as permission to bypass the proxy.

## Systemd on alpha

For the prepared source checkout at `/home/radu/projects/helsinki-dt`, use [helsinki-lens.service](../deploy/helsinki-lens.service). It runs as `radu` with `/usr/local/bin/node`, starts at boot and restarts on failure. Its loopback port `3011` matches the deployed environment. Systemd supplies the production/proxy settings; Node loads any other settings from the existing `.env`. The 45-second stop timeout allows the adapter's 30-second graceful shutdown.

From that source checkout, build before installing the service:

```sh
npm run build
sudo install -m 644 deploy/helsinki-lens.service /etc/systemd/system/helsinki-lens.service
sudo systemd-analyze verify /etc/systemd/system/helsinki-lens.service
sudo systemctl daemon-reload
sudo systemctl enable --now helsinki-lens.service
curl --fail --max-time 5 http://127.0.0.1:3011/ >/dev/null
```

Point the Cloudflare Tunnel public hostname `helsinki.ai.ro` to `http://127.0.0.1:3011` on alpha. Preserve the public `Host` header and forward `X-Forwarded-Proto: https`. Apply the SSE requirements below to `/api/traffic/stream`.

After rebuilding, use `sudo systemctl restart helsinki-lens.service`. Inspect state with `systemctl status helsinki-lens.service` and logs with `journalctl -u helsinki-lens.service -n 50 --no-pager`. Keep the prepared datasets, private entity database and runtime caches in place during restarts.

## Reverse proxy and SSE

Use one worker/process for the application. Each browser shares the process's demand-driven HSL and marine MQTT connections; a cluster or several replicas would create independent feeds. HSL reconnect backoff is 1–30 seconds; marine reconnects use 15/30/60-second delays plus jitter. The final browser departure releases feeds after a 30-second grace. HSL/rail positions are stale at 30 seconds and removed at 120 seconds; marine positions use the source-specific age policy in [data contracts](data-contracts.md). Hidden tabs close their SSE connection and resume from a full current snapshot. The per-client SSE queue is capped at 8 MiB; slow clients disconnect and recover from a snapshot. No invented positions replace disconnected reports.

An nginx location for the long-lived stream:

```nginx
location = /api/traffic/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

The upstream sends a heartbeat every 15 seconds and `X-Accel-Buffering: no`. Preserve `Content-Type: text/event-stream`; disable proxy/CDN buffering, response caching and compression on this location. Configure any outer load balancer idle timeout above the heartbeat interval, preferably at least 60 seconds. Slow-client queues are bounded; dropped clients reconnect for a fresh snapshot. General application/static locations can buffer normally. The Node adapter serves its build-time Brotli/gzip static variants. `/api/energy/catalog` negotiates gzip and caches compressed bytes for the same validated state; preserve `Vary: Accept-Encoding` and avoid recompressing responses already carrying `Content-Encoding`.

## Health, logging and failure recovery

Check **process health** with `curl --fail --max-time 5 http://127.0.0.1:3000/ >/dev/null` from the host, plus the process manager's exit state and memory. The root HTML response does not require upstream sources to be live. Source outage is not a reason for a restart loop.

Check **source health** separately: `GET /api/traffic` returns connection status and dated positions, including independent `sources.hsl`, `sources.rail` and `sources.marine` state; `GET /api/observations` returns source status plus actual measurement/retrieval times; `GET /api/route` returns prepared labels/validity or an unavailable reason; `GET /api/energy/catalog` returns ready/stale/unavailable state with dated provenance. These endpoints may return HTTP 200 for an honest source outage. `/api/traffic` also acquires demand for the shared live feeds, so a monitoring poll changes their otherwise idle lifetime. Do not equate a transport HTTP 200 with fresh data. Inspect the status and dates shown in the product or JSON.

Map loading opens the complete rendered semantic coverage first; optional aerial/textured and vehicle-model detail refine afterward. Semantic **ready** and visible aerial/textured **complete** are separate states. Partial semantic coverage and optional-detail errors remain nonblocking, explicitly labelled and retryable; available buildings remain selectable. The initial transport snapshot can arrive before map readiness; recurring SSE begins when the coarse map opens, or after terminal renderer/assets failure enables the metadata fallback. The six native zoom/rotate/tilt buttons support Tab and Enter/Space alongside existing WASD, pointer and follow controls.

Capture stdout/stderr using the existing process manager or shell redirection and retain restart timestamps/release IDs. There is no project-specific logfile path or account required. For manual inspection, `npm start > /absolute/operator/logs/helsinki.log 2>&1` captures startup/uncaught errors. Rotate logs through the host's standard tooling. Track source outages, cache write errors, request latency, memory and restart count separately. The application does not log upstream credentials; do not add raw payload or environment dumps to operational logs.

### Marine feed and bounded verification

The marine source is healthy only when its own status and recent MQTT/REST timestamps support that conclusion. A quiet local fleet is valid; after two minutes without a valid source message/update the feed marks marine stale and starts bounded recovery. While MQTT is unavailable, position snapshots are retried no more than once per minute. Moving/unknown-status vessels age out at ten minutes; the anchored/moored exception ages out at thirty minutes only with valid speed at or below 0.5 knots. Report time, local receipt time, metadata time and source connection time are distinct. A successful metadata lookup never refreshes position freshness.

Run bounded source checks from a source checkout, not the production bundle:

```sh
node scripts/verify-marine.ts --integrated --seconds=120
node scripts/verify-marine.ts --integrated --fixture --peak=40 --seconds=5
```

The first command observes real Digitraffic MQTT/REST through the shared HSL/rail/marine traffic service and two in-process SSE readers. The second uses an explicitly synthetic fixture at twice the supplied observed AIS peak. The verifier also accepts `--max-bytes`, `--max-messages`, `--interrupt-at` and `--interrupt-for`; its default real observation is capped at 30 minutes. Reports go to ignored `.cache/task-f/` unless `--output` selects another local path. They record bounded summaries and never persist national raw AIS messages. In-process SSE latency is not browser/network latency; use browser evidence for that separately. A live window with zero local ships does not establish an empty harbour. See [Task F results](milestone-results/F.md) for dated runs, scope and unresolved acceptance items.

Weather/AQ caches are bounded in memory and refreshed on demand (weather eligible every five minutes, AQ fifteen, metadata daily); a restart resets these caches and reacquires real observations. Each FMI response is bounded to 2 MiB/30 seconds; failures retain dated valid values while the process lives. Observation age and source connectivity remain distinct.

Measured energy has a writable, atomic, checksum-validated raw cache at `.cache/energy/runtime/`, bounded to 64 files and 64 in-memory entries. Success is eligible for refresh after six hours and failure after one minute. Requests use catalog-listed properties, previous twelve completed months, four concurrent requests, 24 starts/minute and at most 256 KiB/15 seconds/366 daily rows. Identical requests coalesce. The provider's publication cadence is unknown. A restart revalidates preserved raw files; a new month or city/source/membership fingerprint starts a new lookup. Corrupt raw files are ignored, then a bounded real refresh is attempted. Do not erase valid caches as a routine restart step.

Property electricity inspection separately reports loading, current, stale, empty, unavailable and request failure. Retained readings preserve their original retrieval time; last-attempt time and source/error context remain separate. Missing readings are not zero, partial recorded usage is not an unqualified complete-month total, and shared-property consumption is never divided into per-building values.

For failed city/energy preparation, read `.cache/task-b/` or `.cache/task-d/` diagnostics and the dated energy refresh status. Failed publication retains the previous validated generation; incomplete or checksum-mismatched files must not be activated. Missing chunks affect only their coverage and show an explicit loading failure. Restore from the matching saved release if a deployed static file is corrupt. Network recovery resumes real source refresh without substituting fixture data.

## Refresh, restart and rollback

Prepare a new release from the source checkout while the current release continues serving. Normal static-source preparation reuses checksum-verified raw caches. `npm run energy:prepare -- --refresh` explicitly downloads a new energy source version; review source schema/checksum/unit/join changes before activation. Pinned annual workbook versions may intentionally reject new provider exports until their adapters/evidence are reviewed. Review annual sources monthly or after provider export announcements. Solar coverage is the selected historical district export; unqueried areas and unknown model options/reference weather year remain visible.

To refresh route context, run `npm run data:probe -- --source transit`, then `npm run routes:prepare`. The transit probe has a one-hour GTFS ZIP cache and requires a usable real HFP report; inspect its diagnostic and archive retrieval/validity. A later probe retrieves again once that cache is older than an hour. Runtime route matching never scans/downloads the full archive. Do not publish an expired index as current merely because preparation ran today.

For a city refresh, run `npm run city:prepare` then **immediately** `npm run energy:prepare` (or its reviewed `--refresh` variant), then matching `ryhti:prepare` when Ryhti is published and `entities:prepare`, followed by checks, `npm run build`, `npm run release:package` and a clean-directory smoke. Any foundation/route/energy/static change also needs a build. Do not run two builds/preparations into the same output directories at once.

Keep runtime caches in a persistent directory across release changes. For example, create `/srv/helsinki/shared/energy-runtime` owned by the application user and, before first start of each new release:

```sh
mkdir -p .cache/energy
ln -s /srv/helsinki/shared/energy-runtime .cache/energy/runtime
```

Use this link instead of creating a fresh `runtime` directory. Alternatively, stop the old process and copy its entire valid runtime cache to the new root before starting. Preserve the operator environment outside the artifact or copy it privately; never add it to the bundle. Stop the current single process with SIGTERM, allow up to its shutdown timeout, switch the existing process manager's working directory to the new release root, and start exactly one replacement. SSE clients reconnect and recover from a snapshot. Check process health first, then dated source states and a building energy lookup.

Rollback uses the previous **whole release**, including its matching build, city and energy manifests. Stop the current process, restore the previous working directory/environment, reuse the persistent cache location and start one process. Changed fingerprints safely reject incompatible cache files. Recheck process/source health. Keep the previous release until the new one passes verification; no public deployment or uptime is claimed by a local package check.

## Measured resources

The clean local package check completed at **2026-10-08T15:18:57.651Z** on macOS with Node **24.19.0**/npm **11.17.0**, using `/private/tmp/helsinki-release-e-final-runtime-drelhbgq` independently of Ocean Lens. Locked `npm ci --omit=dev` installed 303 packages (the final isolated install reused the exact registry tarballs from the earlier clean network install, with a fresh `node_modules`) and reported zero vulnerabilities. The exact Node startup command from `npm start` served root HTML, active city assets, prepared routes, ready gzip energy catalog and a complete 30-day September measured-property series before and after graceful restart. Both exits were zero. The final runtime also returned empty HTTP 406 responses for requests excluding every supported encoding, before and after restart. Its 71-file server inventory matches the active production soak; all 40 executable JavaScript files match by path, size and checksum. This candidate uses the final compiled application; the final report/archive includes completed verification with the same executable/assets. The real raw cache retrieval remained **2026-10-08T14:13:18.564Z**, and both cache-file hashes remained unchanged. Initial sandbox network/bind failures were retried with authorized local/network access; they were not application defects.

| Measurement | Observed value / scope |
| --- | --- |
| Checked release payload | 138,791,387 logical bytes; 1,252 hashed files and 369 active data assets. Documentation-only final packaging changes this size/hash. |
| Release allocated disk | 155,240 KiB from `du -sk`, before dependency installation. |
| Installed runtime dependencies | 166,948 KiB allocated. |
| Extracted installation total | 305,732 KiB allocated, including dependencies and copied raw cache; relative data symlink avoids duplicate assets. |
| Preserved raw cache | 2 files, 107,486 logical bytes, 112 KiB allocated, hash-identical before/after restart. |
| Node RSS after catalog/routes/series | 394,704 KiB first start; 392,240 KiB after restart. Short single-client endpoint workload; complete fleet/scene soak is separate. |
| Full 30-minute production soak | Two stable SSE clients / one real MQTT upstream, 1,800.085 seconds; 31 samples: heap 77.4–191.9 MB, RSS 426.4–611.8 MB; end RSS 498.7 MB. Zero reconnect/capacity drops; idle state cleared. See E results for times and memory floors. |
| Catalog response | 843,087 gzip bytes, ready state; original catalog payload is 16.75 MB. |

Actual package/clean-install/start/restart evidence is saved in ignored `.cache/task-e/package*.json` and logs, with final results in [E results](milestone-results/E.md). These measurements describe the recorded local workload, not a production capacity guarantee. The runtime-cache payload bound is at most 64 × 256 KiB (16 MiB) plus filesystem overhead; it is a configured bound, not measured disk usage. Preparation caches/raw source downloads are separate and are not needed on the serving host. Retain room for the current and previous whole releases, locked runtime dependencies, logs and the persistent cache. Use the recorded full-soak measurements as local evidence; measure the intended host and workload before choosing production capacity.


## Ryhti snapshots

After `city:prepare`, run `npm run ryhti:prepare`, `npm run entities:prepare`, and rebuild the server. Use `--refresh` when reviewing a new upstream snapshot; ordinary preparation reuses verified cached sources. Preserve `.cache/ryhti/` to avoid repeated source requests. The catalog is optional, but an existing published catalog must pass checksum, city compatibility and build parity checks during release packaging.

Keep `static/data/ryhti-manifest.json`, its referenced `ryhti/<generation>/catalog.json`, and any `ryhti-refresh-status.json` together. Publication changes the manifest atomically. Failed refreshes retain the previous dated catalog; a changed city disables that catalog until re-prepared. The API and Sources & status report these states. Roll back the city and Ryhti snapshot together. No scheduler or server-side Ryhti refresh runs automatically.

Before sustained use, request Syke's application identifier and follow its supplied usage instructions. Public one-off probes require no API key. Do not confuse the operator application identifier with a permanent building identifier.

## SQLite entity database

`npm run entities:prepare` reads validated prepared sources locally and publishes `server/data/entities/<generation>.sqlite`, then atomically replaces its `manifest.json`. Run it after foundation/city/energy/Ryhti changes. Failed imports preserve the previous database; published but incompatible optional catalogs must be re-prepared before importing. The database stays outside the web root. Runtime connections are read-only and verify each new database checksum with a bounded stream. Keep the database directory alongside the matching build and source manifests; the release packager includes only the active SQLite generation and rejects mismatched source generations. Roll back the whole release together.

`GET /api/catalog/status` verifies database/city compatibility and exposes dated source states without transferring full catalogs. A failed source refresh marks the indexed data stale. New source data awaiting import is labelled explicitly. A missing/incompatible database returns 503 and never triggers a browser download of the full catalogs. After publishing a new database, generation-pinned calls return 409 until the caller refreshes status. The UI checks status every 30 seconds while visible, also refreshing on generation conflicts.

TanStack Query caches bounded search/detail/theme responses only. Search is debounced 200 ms; search and theme entries expire after 60 seconds of inactivity, selected-building details after five minutes. Theme keys use stable groups of up to 16 chunks. Generation-pinned detail/theme values remain fresh until the generation changes. These timeouts are inactivity controls, not a hard memory ceiling. SSR clients are isolated and cleared at component destruction, with no server GC timers. Geometry/GPU state and live SSE remain separate.
