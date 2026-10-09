# Helsinki Lens

Helsinki Lens is a 3D view of central Helsinki combining selectable buildings, live HSL trams, buses and ferries, scheduled routes, station weather and air quality, and verified building energy and solar records. It keeps original building identifiers, source attribution and data age visible. Displayed times use `Europe/Helsinki`.

The map covers the prepared release area, WGS84 `[24.86, 60.135, 25.06, 60.225]` in west, south, east, north order. It is a bounded city view, not a complete Finland dataset. Missing readings remain missing; prepared samples never replace live feeds during an outage.

Coverage extends through Lauttasaari, Munkkiniemi, Pasila/Käpylä and Herttoniemi while the opening view remains City Centre. The lower-left scale shows metres or kilometres at the view centre and updates with zoom and rotation. Zooming out reaches an 18 km camera distance; foreground assets still load by view.

## Contents

- [First run](#first-run)
- [How the project works](#how-the-project-works)
- [Using the view](#using-the-view)
- [Shared map cache CLI](#shared-map-cache-cli)
- [Commands and source refresh](#commands-and-source-refresh)
- [Live data and interpretation](#live-data-and-interpretation)
- [HTTP endpoints](#http-endpoints)
- [Configuration, production and releases](#configuration-production-and-releases)
- [Verification and troubleshooting](#verification-and-troubleshooting)
- [Vehicle models](#vehicle-models)
- [Source evidence and development notes](#source-evidence-and-development-notes)

## First run

Use **Node 24 and npm 11**; `.nvmrc` selects Node 24 and `package-lock.json` pins dependencies. Source preparation also requires **Java 17+ and `unzip`**. Its pinned CityGML converter is downloaded into the ignored `.cache/` directory. Blender is only needed to regenerate vehicle models, not to run the application. Use a browser with WebGL for the 3D scene.

Run all commands from the source checkout root:

```sh
npm ci
cp .env.example .env
```

Copy the environment example only if `.env` does not already exist. No upstream credentials are required. Preparation needs internet access to the documented public providers; live operation needs outbound HTTPS and TLS MQTT to `mqtt.hsl.fi:8883`.

A clean checkout does not contain generated datasets. Prepare the complete application in this order:

```sh
npm run data:prepare
npm run city:prepare
npm run energy:prepare
npm run ryhti:prepare
npm run routes:prepare
```

Inspect each command's result before continuing. `data:prepare` exit **2** means a usable foundation sample was published with explicit open source gates; inspect `.cache/task-a/latest-preparation.json` and the reported gates. Exit **1** means preparation failed and the previous published sample was retained. Historical foundation gates and the later verified energy catalog have separate evidence; see [data access](docs/data-access.md) and [energy/solar evidence](docs/energy-solar-evidence.md).

`energy:prepare` must run after **every** `city:prepare`, even when the upstream semantic tileset checksum is unchanged. The energy catalog must match the exact prepared city generation. `routes:prepare` uses the HSL GTFS ZIP downloaded by foundation preparation.

Start development:

```sh
npm run dev
```

Open the loopback address printed by Vite. Starting before preparation lets you inspect the application shell, but the map/data remain unavailable until usable assets exist. Optionally run `npm run city:cache` before browsing to prefetch all municipal model detail levels; the app otherwise warms overview coverage automatically.

## How the project works

The application uses Svelte 5/SvelteKit with the Node adapter, a Three.js renderer, and proj4 for coordinates. Exact installed versions are in `package.json` and the lockfile.

```mermaid
flowchart LR
    Sources[Public source datasets] --> Preparation[Preparation scripts]
    Preparation --> Prepared[Prepared assets in static/data]
    Prepared --> App[SvelteKit Node server]
    Municipal[Municipal imagery and textured models] --> Cache[Shared disk map cache]
    Cache --> App
    HSL[HSL live MQTT] --> App
    Observations[FMI and HSY station observations] --> App
    Nuuka[Nuuka property electricity] --> App
    App --> Browser[Svelte UI and Three.js scene]
```

Preparation converts and validates source data once, publishes immutable generations, and changes their manifest pointers only after successful publication. A failed refresh retains the previous valid generation. Raw archives, conversion tools and diagnostics live in `.cache/`; generated datasets are ignored by Git.

Browsers load prepared `/data/` geometry and metadata, then request visible municipal imagery and textured buildings through `/api/city-asset`. The Node server validates and caches these municipal assets on disk for all visitors. Browser Cache Storage is an optional additional cache; it is independent of the server cache and of GPU resources.

Each Node process shares one demand-driven HSL MQTT connection across its browsers and forwards snapshots/updates through SSE. Station observations and measured electricity use separate server services. Energy catalog loading follows scene readiness so it does not block initial map interaction. Run one application process; multiple workers would need shared live-feed coordination.

Geometry uses metres. Source ETRS-GK25/EPSG:3879 coordinates become local Three.js `[east, elevation, -north]` coordinates around longitude 24.952, latitude 60.1695, elevation 0. Heights retain the N2000 datum; projection does not perform a vertical datum conversion. See [data contracts](docs/data-contracts.md) and [coordinate controls](docs/coordinate-controls-evidence.md).

### Repository and stored data

| Location | Purpose |
| --- | --- |
| `src/routes/+page.svelte` | Application shell, data loading, selection, search and inspectors. |
| `src/lib/` and `src/lib/components/` | Scene rendering, asset loading, vehicles, shared records and UI components. |
| `src/lib/data/` | Source decoders, identity reconciliation and GTFS matching. |
| `src/lib/server/` and `src/routes/api/` | Validated upstream access, shared caches and HTTP/SSE endpoints. |
| `scripts/` | Source preparation, map caching, release packaging and explicit verification tools. |
| `tests/` | Regression tests, small attributable source fixtures and browser verification pages. |
| `assets/blender/` and `static/models/` | Editable vehicle models and checked-in GLB exports. |
| `docs/` | Source contracts, coverage/method evidence, operations and dated acceptance results. |
| `static/data/manifest.json` and `static/data/generations/` | Foundation sample pointer and immutable generations. |
| `static/data/city/` | City manifest, terrain/context, semantic geometry and building metadata. |
| `static/data/route-index.json` | Prepared route labels, trips, shapes and stop patterns. |
| `static/data/energy-manifest.json` and `static/data/energy/` | Energy catalog pointer and immutable catalogs. |
| `.cache/city-map/` | Persistent municipal imagery, tile indexes and textured model bytes; configurable. |
| `.cache/energy/runtime/` | Persistent measured-electricity cache; preserve across deployments. |
| `.cache/task-a/`, `.cache/task-b/`, `.cache/task-d/`, `.cache/task-e/` | Source downloads, preparation/verification diagnostics and release artifacts. |
| `build/` and `.svelte-kit/` | Generated production output and SvelteKit tooling output. |

`static/data/energy-refresh-status.json`, when present, records a failed energy refresh. Retain manifest pointers and their referenced generations together. Deleting raw preparation caches forces source reacquisition; deleting prepared assets leaves an unprepared application; deleting runtime caches loses reusable saved responses.

## Using the view

Hold **WASD** to pan across the ground relative to the camera heading; diagonal movement keeps the same speed. Keyboard navigation pauses in form controls, while a dialog is open, and when the window loses focus. Moving manually stops vehicle follow. Turn off **WASD navigation** in the scene controls to disable these shortcuts; it starts enabled on each page load.

Choose City Centre, South Harbour, Suomenlinna or the Senate district energy preset, then use the scene controls to navigate. Toggle buildings, terrain, roads, imagery, transit modes and station layers. Search covers available building metadata/addresses, vehicles and prepared route labels; search and scene picking use the same selection contract. Escape clears selection, and compact layouts expose separate controls and inspection sheets.

Selecting a building opens its source identifiers and compatible energy/solar records. Selection and hover tint the displayed building, with selection taking precedence. Selecting a vehicle shows its real report age, deviation and exact scheduled journey when available; following ends when you interact with the camera. Station inspectors show a recent six-hour history without changing current traffic into historical playback. **Sources & status** explains dates, coverage, attribution and gaps. Search/inspection provide a metadata fallback when WebGL is unavailable.

### Map appearance and loading

The default **Aerial imagery & textures** layer uses the municipal 2025 orthophoto and textured LoD2 buildings also used by [Helsinki 3D](https://kartta.hel.fi/3d/). Aerial images follow prepared terrain and sea datum; building transforms preserve calibrated coordinates. Disable imagery for the plain geographic model. Energy themes use compatible semantic building colors, and missing values remain neutral.

The renderer discovers assets for the visible area and changes model detail with the camera distance. Selecting a building requests finer nearby detail. Complete local replacements appear while unrelated downloads continue, and offscreen objects release GPU resources. Downloads have deadlines, byte limits and bounded concurrency; the old fixed 24-imagery/48-model caps no longer apply. The prepared 20 m terrain still limits coastline precision.

Map readiness includes discovery, enabled visible assets, texture decoding and a rendered frame. Missing parts retry with bounded backoff while settled available data remains usable. KTX2 texture decoding uses the Basis transcoder bundled with the pinned Three.js dependency and served locally by Vite.

## Shared map cache CLI

The `city:cache` command warms or rebuilds the **server** cache across the entire prepared area, independent of the current camera or any visitor's browser cache. Prepare city assets first, or keep an existing valid prepared city generation. The command validates prepared geometry/metadata; it does not regenerate city data, energy, routes or live feeds.

| Command | Behavior |
| --- | --- |
| `npm run city:cache` | Download missing aerial cells, tile indexes and models at every detail level across the enlarged prepared area; reuse valid saved assets. |
| `npm run city:cache -- --refresh` | Fetch full-area aerial/index/model coverage again, including coarse models and detailed descendants. |
| `npm run city:cache -- --all-levels` | Compatibility alias for the default full-area cache command. |
| `npm run city:cache -- --all-levels --refresh` | Compatibility alias for `--refresh`. |

To rebuild every zoom level using the server's persistent cache directory, run from the source checkout:

```sh
CITY_MAP_CACHE_DIR=/srv/helsinki/shared/city-map npm run city:cache -- --all-levels --refresh
```

Use the **same absolute directory** in the running app's environment or `.env`:

```dotenv
CITY_MAP_CACHE_DIR=/srv/helsinki/shared/city-map
```

Give the command and application user read/write access to that directory and preserve it across deployments. Without this setting, both use `.cache/city-map` relative to their working directory. Running the CLI in another checkout with the default directory does not rebuild the deployment's cache; point it at the shared directory or transfer its completed cache to the serving host. Use a prepared city matching the deployment's area/generation.

To resume after interruption or source failure, omit `--refresh`:

```sh
CITY_MAP_CACHE_DIR=/srv/helsinki/shared/city-map npm run city:cache -- --all-levels
```

The CLI traverses nested indexes by default, keeps coarse models needed when zooming out, downloads detailed descendants needed when zooming in, excludes out-of-area branches using the current prepared map bounds, and deduplicates asset URLs. `--all-levels` remains accepted for compatibility. Automatic warming in the app still selects overview coverage at 10 m geometric error or finer. `--refresh` requests municipal bytes again without deleting the cache first; failed upstream downloads retain previously saved assets.

Progress uses `discovering`, `loading`, then `complete`, `partial` or `stopped`. A complete run exits **0**; incomplete discovery/downloads, invalid prepared assets, unsupported arguments or storage failure exit nonzero. After fixing connectivity, space or permissions, resume without `--refresh`. Full-detail disk usage and download duration have not been measured and exceed overview caching.

Saved municipal bytes become eligible for revalidation after 30 days, with older validated bytes available during source outages. Automatic warming starts after the first usable view and retains overview behavior. Server upstream work permits four requests, at most two for area warming, with foreground work taking priority. Disk failure stops warming while foreground loading remains operational. `/api/city-cache` reports the running app's warmer, not the separate CLI process's progress. The CLI requires the source checkout and is not shipped as a runnable script in release bundles.

## Commands and source refresh

| Command | Purpose and arguments |
| --- | --- |
| `npm run dev` | Loopback development server; reads `.env` and serves current prepared assets. |
| `npm run data:probe -- --source observations` | Focused source access check; accepts `all`, `geometry`, `energy`, `transit` or `observations`. Without arguments, probes all. |
| `npm run data:prepare` | Publish a validated foundation sample; no source/URL arguments. |
| `npm run city:prepare` | Prepare licensed terrain, context, semantic building geometry and metadata. |
| `npm run energy:prepare` | Publish an energy catalog compatible with the current city. `-- --refresh` retrieves a new source version for review. |
| `npm run routes:prepare` | Build the route index from `.cache/task-a/hsl-gtfs.zip`; optional positional arguments are archive path and output path. |
| `npm run city:cache` | Warm the municipal asset cache; see flag combinations above. |
| `npm run check` | SvelteKit sync, TypeScript and Svelte diagnostics. |
| `npm test` | Node regression tests using local fixtures. |
| `npm run build` | Build the production application and prepared static assets into `build/`. |
| `npm start` | Run the built Node server using `.env`. |
| `npm run preview` | Loopback Vite preview of the build; use `npm start` for the deployed Node service. |
| `npm run release:package` | Validate/package an existing build; optional positional argument selects an output parent. |

Probes write `.cache/task-a/probe-<source>.json` and use exit 2 when a checked gate is not passing. They may download and cache sources; they are not a publication command. Normal preparation reuses verified raw caches, so rerunning it does not necessarily retrieve a newer upstream version.

After refreshing city data, immediately prepare matching energy, then check/test/build again. Production static assets require a new build; development reads updated prepared files directly. Do not run simultaneous preparations/builds into the same outputs. Review annual source updates monthly or when providers announce exports; energy preparation intentionally checks known source versions and may reject changed schemas/checksums until reviewed.

For route refresh:

```sh
npm run data:probe -- --source transit
npm run routes:prepare
```

The transit probe reuses its GTFS archive for one hour and also requires a usable real HFP report. Inspect archive retrieval time and feed validity; preparation time does not make an expired feed current. Journey matching reads the prepared index rather than downloading/scanning GTFS on each request.

## Live data and interpretation

### Traffic and scheduled routes

Browsers share one MQTT connection; mode filters do not create separate upstream subscriptions. When all clients close, it is released after a 30-second grace period. Reconnect delays range from 1 to 30 seconds. SSE sends named `snapshot` and `update` events, including removals and feed state; reconnecting clients receive a full snapshot. Hidden tabs close their SSE connection and stop rendering, then recover when shown.

Positions become stale after **30 seconds** and leave the displayed fleet after **120 seconds**, measured from the provider report time. New metadata does not refresh position age. A selected removed vehicle retains an explanation. The app's on-time display band is ±60 seconds; exact HFP deviation remains visible.

Routes are scheduled context. Matching requires complete owner/operator, vehicle, route, direction, service date and start-time identity, including GTFS calendar/DST handling. Missing, expired or ambiguous matches show no guessed route. Raw vehicle positions are never snapped to scheduled shapes.

### Weather and air quality

Weather uses Kaisaniemi station **100971**; air quality uses Mannerheimintie station **100742** through FMI/HSY. Requests cover a fixed recent six-hour window. The process shares requests and becomes eligible to refresh weather every five minutes and air quality every fifteen minutes. These intervals are not claims about provider publication cadence.

Each value keeps its actual observed time, provider unit, aggregation and quality. A nearby station is bounded context, not a citywide pollution heatmap or evidence that weather caused a vehicle delay. Dated observations remain visible during provider failures while the process retains them.

### Building energy and solar

The inspector separates **measured property electricity**, **modeled building demand**, and **incident solar energy on modeled roof/wall surfaces**. Exact source identifiers establish links; address/nearest-point guesses are not used. Shared-property consumption is stored once and is never divided into building consumption or used for building colors. Solar irradiation is not installed photovoltaic capacity or electrical output.

The static catalog loads once after scene readiness; `/api/energy/catalog` negotiates gzip. Daily measured requests accept only catalog-listed properties and the previous twelve completed calendar months. Without a month selection, the service chooses the latest completed month with finite readings for every day; incomplete months retain null gaps and no unqualified total.

Successful measured requests are eligible for refresh after six hours, failures after one minute. Identical lookups coalesce; limits are four concurrent requests, 24 starts/minute, and 256 KiB/15 seconds/366 daily rows per upstream response. Its checksum-validated raw cache has at most 64 disk entries and 64 memory entries at `.cache/energy/runtime`. New month or city/source/membership versions start a new lookup. Provider publication cadence is unknown.

Coverage is incomplete by design. The dated 8 October 2026 release evidence records 8,909 unique buildings, modeled demand for 4,949, solar for 695 in twelve selected district tiles, and one measured property with two exact building matches and one unresolved member. Other solar areas remain unqueried; unknown reference weather year and model settings stay labelled. See [energy/solar evidence](docs/energy-solar-evidence.md), [solar method](docs/solar-method-evidence.md) and [release results](docs/milestone-results/E.md) for measured coverage and performance rather than treating them as live guarantees.

## HTTP endpoints

| Endpoint | Contract |
| --- | --- |
| `GET /api/city-asset?url=...` | Validated municipal asset proxy/cache; only approved model paths and bounded aerial requests are accepted. |
| `GET /api/city-cache` | Runtime warmer progress and storage issue; partial warming may trigger a retry. |
| `POST /api/city-cache` | Start/resume automatic overview warming. |
| `GET /api/traffic` | Current vehicle snapshot and dated feed status. |
| `GET /api/traffic/stream` | SSE snapshots, updates, removals, status and 15-second heartbeat. |
| `GET /api/observations` | Fixed station/six-hour observation snapshot; no query parameters. |
| `GET /api/route` | Prepared route catalog and source validity. |
| `GET /api/route?...` | Exact journey lookup using `ownerOperatorId`, `vehicleId`, `routeId`, `directionId`, `serviceDate` and `startTime`. |
| `GET /api/energy/catalog` | Validated catalog with city compatibility/source status and gzip negotiation. |
| `GET /api/energy?property=...&month=YYYY-MM` | Measured series for a prepared property; `month` is optional. |

Source-status responses can be HTTP 200 while showing unavailable or dated data. Check the JSON status and report/observation times as well as HTTP/process health. Polling `/api/traffic` itself creates MQTT demand.

## Configuration, production and releases

`dev`, `preview`, `start` and `city:cache` load `.env` through Node's `--env-file-if-exists`. Process-manager environment values override `.env`. The other commands use their documented fixed sources/paths; the project has no API-key variables.

| Variable | Purpose |
| --- | --- |
| `HOST` | Production bind address; `.env.example` sets `127.0.0.1` for a local proxy. |
| `PORT` | Node server port; example/default `3000`. |
| `NODE_ENV` | Example sets `production`. |
| `SHUTDOWN_TIMEOUT` | Graceful shutdown timeout in seconds; example `30`. |
| `PROTOCOL_HEADER` | Set `x-forwarded-proto` only behind a trusted proxy that replaces the header. |
| `CITY_MAP_CACHE_DIR` | Persistent map cache shared by the CLI and app; default `.cache/city-map`. |

To build and run from a prepared source checkout:

```sh
npm run check
npm test
npm run build
npm start
```

Keep the process working directory at the project or extracted release root so file readers resolve the correct data. Give it access to prepared assets and write permission for both runtime cache directories.

For a transferable release, run `npm run release:package` after building. It checks active source checksums, city/energy compatibility, route availability and equality between prepared data and `build/client/data`. Output lives under `.cache/task-e/releases/helsinki-lens-<version>-<content-hash>/`; `release.json` records file and data checksums. Archive unused old generations before the final build, since the build's static inventory and packaged files must stay consistent.

The bundle includes `build/`, npm manifests/lockfile, `.nvmrc`, `.env.example`, dependency notices and documentation. It contains a relative `static/data` symlink to `build/client/data`; preserve it when copying or archiving. It excludes `.env`, credentials, `node_modules`, raw downloads and runtime caches. It serves prepared assets and cannot run source preparation, rebuilds, tests or the cache CLI.

From the extracted release root:

```sh
npm ci --omit=dev
cp .env.example .env
mkdir -p .cache/energy/runtime
npm start
```

Before starting a new release, configure the same persistent `CITY_MAP_CACHE_DIR` and retain `.cache/energy/runtime`, either with the existing shared-directory symlink or by copying its valid cache while the process is stopped. Stop the old single process with SIGTERM, switch to the complete matching new release, and start one replacement. Rollback restores the previous whole release and its environment, retaining runtime caches.

A reverse proxy must leave `/api/traffic/stream` unbuffered and uncached, preserve `Content-Type: text/event-stream`, avoid SSE compression, and allow connections longer than the 15-second heartbeat. For nginx use `proxy_buffering off`, `proxy_cache off`, and `proxy_read_timeout` of at least 60 seconds. The service sends `X-Accel-Buffering: no`. Full proxy configuration, logs, health checks, cache-preserving restarts and rollback are in [operations](docs/operations.md). Public hosting/TLS and distributed scaling are separate from the dated local release verification.

## Verification and troubleshooting

`npm run check` checks TypeScript/Svelte; `npm test` exercises source validation, coordinates, identity matching, cache repair, retry behavior and prepared-data publication with local fixtures. These ordinary tests do not require municipal services to be online. The map-cache tests include all-level traversal, nested/duplicate references, full-area bounds, refresh/resume, retained saved bytes during outages, storage failure and CLI exit status.

For browser/GPU checks:

```sh
npx vite --config tests/city-depth.config.ts
```

Open `http://127.0.0.1:5175/tests/city-depth.html`: it must report `PASS` for 144 camera positions. On the same server, `/tests/building-highlight.html` checks 108 views for tint coverage, selection/hover precedence, clearing and occlusion. Both use local renderer fixtures. Vehicle verification is described below.

Explicit live verifications are separate from regression tests. `node scripts/verify-traffic.ts` runs a 30-minute HSL soak plus idle cleanup and writes `.cache/task-b/` diagnostics. After recording a real peak, `node scripts/verify-traffic.ts --fixture --peak=<recorded-peak> --seconds=300` runs a labelled offline workload at twice that population. Recorded release/browser performance and known device exceptions are in [release results](docs/milestone-results/E.md).

| Symptom | Check/action |
| --- | --- |
| Empty/unprepared application or unavailable map | Prepare foundation and city assets; inspect manifests and `.cache/task-a/`/`.cache/task-b/` diagnostics. |
| Preparation exits 2 | Inspect reported gates; do not treat a partially evidenced source sample as a fully passing release. |
| Map cache exits `partial` | Inspect reported missing URLs and connectivity; resume without `--refresh`; the CLI includes all model detail levels by default. |
| Map cache exits `stopped` | Check disk space and directory permissions; retain saved assets and rerun after fixing storage. |
| CLI succeeds but deployment downloads assets again | Confirm CLI and app use the same persistent cache directory and matching prepared area. |
| Energy/themes unavailable after city refresh | Run `energy:prepare` for the new city, then rebuild/repackage production static assets. |
| Route missing or expired | Inspect full journey identity and feed validity, refresh the transit archive/index, then rebuild production. |
| Live traffic disconnected or dated | Check outbound TLS MQTT and SSE/proxy handling; compare provider report times. Missing feeds do not create substitute vehicles. |
| Station readings missing or old | Check FMI access and source status/observed timestamps; refresh timing cannot create unpublished readings. |
| Production serves old or missing static data | Build after preparation and preserve the complete release data/symlink; run from its root. |
| WebGL unavailable | Use metadata search/inspection; the 3D view needs browser/GPU WebGL support. |

Do not clear valid caches as a routine restart or source-outage remedy. Use [operations](docs/operations.md) for recovery of corrupt deployed static assets and source-versus-process health.

## Vehicle models

Bus, articulated tram and double-ended ferry exteriors are original Helsinki-inspired Blender models. The editable source is `assets/blender/helsinki-transit.blend`; enable one collection at a time. Self-contained GLB exports in `static/models/` are checked in and ship with the normal SvelteKit build. No external textures, model downloads or new runtime dependencies are needed.

Models use metres, with glTF -Z forward and +Y up. Tyres contact Y=0; the ferry hull extends below its Y=0 waterline. Approximate lengths are 12 m, 27.6 m and 36 m. These are representative exteriors; HSL position reports do not identify the exact physical fleet variant. Opaque tinted windows avoid transparency sorting across instanced vehicles. Each model shares three material batches across the entire fleet. Route banners use prepared GTFS labels, retain route IDs when a label is unavailable, and prioritize selected/hovered vehicles when banners overlap. At most 80 non-overlapping banners are displayed; all vehicles remain available through search.

After updating from an older checkout, run `npm run routes:prepare` to include HSL’s extended bus types in the route labels.

Regenerate both source and exports with Blender 5.2:

```sh
blender --background --python scripts/build-vehicle-models.py
```

The generator checks geometry and byte budgets and contact/waterline bounds. To inspect the exported assets without live services, run `npx vite --config tests/vehicles.config.ts` and open `http://127.0.0.1:5176/tests/vehicles.html`. It includes a 20 m reference building, individual model views, clickable route banners, stale indicators and an explicit 450-vehicle fixture workload.

## Source evidence and development notes

Original IDs remain strings, including leading zeroes. Ambiguous joins stay unresolved, missing readings stay null, and observed/report time is separate from retrieval/receipt time. Licensed prepared data keeps provider attribution and source versions. Fixtures and simulated load workloads are explicitly identified; the normal application uses actual live reports.

Use these references when changing adapters, coordinates or deployment behavior:

- [Data access and source gates](docs/data-access.md), [data contracts](docs/data-contracts.md), and [city source evidence](docs/city-source-evidence.md).
- [Transit/environment evidence](docs/transit-environment-evidence.md), [geometry/energy evidence](docs/geometry-energy-evidence.md), and [coordinate controls](docs/coordinate-controls-evidence.md).
- [Energy/solar sources](docs/energy-solar-evidence.md) and [solar method/export](docs/solar-method-evidence.md).
- [Operations](docs/operations.md) and dated milestone results: [foundation](docs/milestone-results/A.md), [city/traffic](docs/milestone-results/B.md), [inspection](docs/milestone-results/C.md), [energy](docs/milestone-results/D.md), [release](docs/milestone-results/E.md).
- [Implementation plan](docs/implementation-plan.md) and the milestone specifications in `docs/milestones/` for the original acceptance criteria.

ExcelJS's UUID override is scoped to 11.1.1 for GHSA-w5hq-g745-h8pq; its workbook write/read regression covers the existing CommonJS usage. Keep the lockfile and installed versions aligned when changing dependencies. Capacity, source availability and browser behavior beyond the recorded verification remain workload/device dependent; full-detail municipal cache size is still unmeasured.

## Ryhti building register

`npm run ryhti:prepare` prepares open Syke / Ryhti building and permit records for the current city's retained VTJ-PRT identifiers. Run it after city preparation and before the production build. Normal preparation reuses checksum-verified source snapshots; `npm run ryhti:prepare -- --refresh` retrieves both collections again. A failed run retains the previous publication and records its failure. A city-generation mismatch makes enrichment unavailable until preparation runs again.

The inspector shows completed-building register facts separately from municipal geometry attributes, with a list of linked permits. Completion date is not asserted to be the original construction year. Permits can describe historical work; their proposed attributes never overwrite completed-building facts. Exact ambiguous or conflicting associations are withheld. Missing identifiers do not trigger address or proximity matching.

Building colors include Use, Heating method, Heating energy source and Permit action status. Selecting a legend category highlights its buildings and narrows building search; other buildings remain dimmed and pickable. Changing color mode clears this selection. Multiple permit statuses remain explicitly mixed. No linked permit records is not evidence of no construction. Sources & status shows coverage, attribution and snapshot dates.

`GET /api/ryhti/catalog` accepts no parameters, validates the immutable catalog and city-manifest checksum, and reports ready/stale/unavailable. It supports gzip and loads after scene readiness. Existing installations without a Ryhti snapshot remain operational. Release packaging verifies optional Ryhti assets when present. No runtime upstream requests or automatic refresh are added.

The [Ryhti source evidence](docs/ryhti-evidence.md) records measured coverage, limitations and code-list provenance. Syke requires an application identifier for long-term API use; the operator should request it from Syke GIS support as described in the [official instructions](https://ryhti.syke.fi/en/front-page/services/instructions-for-using-open-interfaces-in-the-ryhti-system/). No application identifier has been requested by this integration.
