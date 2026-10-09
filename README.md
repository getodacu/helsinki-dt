# Helsinki Lens

Helsinki Lens combines selectable semantic buildings with live HSL trams, buses and ferries, scheduled route context, station weather and air quality, and verified building energy and solar records. The scene preserves source attribution, original building identifiers and explicit data age. Displayed times use `Europe/Helsinki`.

## Run

Use Node 24 and npm 11. Source preparation also requires Java 17+ and `unzip`; the pinned converter is downloaded into the ignored cache. The repository contains one npm lockfile.

```sh
npm ci
npm run dev
```

Open the local address printed by the development server. No upstream credentials are required. Static city geometry is prepared on the server; a shared server MQTT connection supplies live traffic through server-sent events (SSE). Each browser reads prepared `/data/` assets and `/api/traffic` endpoints.

## Map appearance

The default **Aerial imagery & textures** layer uses the same municipal sources as [Helsinki 3D](https://kartta.hel.fi/3d/): the 2025 orthophoto and textured LoD2 buildings. Images follow the prepared terrain and sea datum; building transforms preserve the calibrated local coordinates. Turn this layer off for the plain geographic model. Energy metrics replace facade textures with the existing semantic colors; search, building identities and live traffic continue to use the prepared datasets.

The browser requests these public city services directly, so imagery requires internet access. Missing tiles retain the prepared model and display a warning. Requests have deadlines and byte limits; the view keeps at most 24 aerial tiles and 48 building tiles, with four asset requests plus one hierarchy request in flight. Detail is bounded, and the 20m prepared terrain still limits coastline precision. KTX2 textures use the Basis transcoder bundled with the pinned Three.js version, emitted and served locally by Vite. No credentials or additional dependency are needed.

## Vehicle models

Bus, articulated tram and double-ended ferry exteriors are original Helsinki-inspired Blender models. The editable source is `assets/blender/helsinki-transit.blend`; enable one collection at a time. Self-contained GLB exports in `static/models/` are checked in and ship with the normal SvelteKit build. No external textures, model downloads or new runtime dependencies are needed.

Models use metres, with glTF -Z forward and +Y up. Tyres contact Y=0; the ferry hull extends below its Y=0 waterline. Approximate lengths are 12 m, 27.6 m and 36 m. These are representative exteriors; HSL position reports do not identify the exact physical fleet variant. Opaque tinted windows avoid transparency sorting across instanced vehicles. Each model shares three material batches across the entire fleet. Route banners use prepared GTFS labels, retain route IDs when a label is unavailable, and prioritize selected/hovered vehicles when banners overlap. At most 80 non-overlapping banners are displayed; all vehicles remain available through search.

After updating from an older checkout, run `npm run routes:prepare` to include HSL’s extended bus types in the route labels.

Regenerate both source and exports with Blender 5.2:

```sh
blender --background --python scripts/build-vehicle-models.py
```

The generator checks geometry and byte budgets and contact/waterline bounds. To inspect the exported assets without live services, run `npx vite --config tests/vehicles.config.ts` and open `http://127.0.0.1:5176/tests/vehicles.html`. It includes a 20 m reference building, individual model views, clickable route banners, stale indicators and an explicit 450-vehicle fixture workload.

## Source preparation

```sh
npm run data:probe -- --source observations
npm run data:prepare
npm run city:prepare
npm run energy:prepare
npm run ryhti:prepare
npm run routes:prepare
```

Probing checks live source access independently of preparation. Preparation publishes a validated generation under `static/data/generations/` and atomically updates `static/data/manifest.json`. Failed preparation retains the previously published generation. Generated generations and manifests are intentionally ignored by Git; a clean checkout stays unprepared until `npm run data:prepare` succeeds. The UI shows an empty state until a sample exists and an error if a published sample cannot be decoded. Exit 2 means a usable sample was published with explicit open source gates; exit 1 means preparation or refresh failed. Inspect the reported gates. A failed source refresh retains the previous dated sample, and its diagnostic is saved under `.cache/task-a`.

Downloaded archives and processing intermediates belong in the ignored `.cache/` directory. Fixtures used by ordinary regression tests are tiny, attributable source samples; regression tests do not require third-party services to be online. See [access findings](docs/data-access.md), [contracts](docs/data-contracts.md) and [Task A results](docs/milestone-results/A.md) for source evidence and unresolved gates.

## Shared map cache

Municipal aerial imagery and textured models are served through `/api/city-asset` and saved on the server under `.cache/city-map`. Files survive app restarts and are reused by every visitor. Keep this directory across deployments, or set `CITY_MAP_CACHE_DIR` to a persistent writable directory in `.env`.

```sh
npm run city:cache
npm run city:cache -- --refresh
```

The first command downloads missing assets for the complete prepared area: all aerial cells and textured coverage at overview detail (10 metres geometric error or finer). Prepared geometry and metadata already live on disk and are validated by the command. Repeating it resumes interrupted downloads and reuses saved files. `--refresh` deliberately retrieves the municipal assets again. Source preparation commands require this checkout; copy the cache directory to the deployment or use its runtime area warming.

Saved municipal bytes revalidate after 30 days; older validated files remain usable during upstream outages. The server warms the same area after the first usable map view, without transferring offscreen models to each browser or allocating offscreen GPU objects. Four upstream requests are allowed, at most two for area warming; new foreground requests take priority. Disk failures stop warming and leave foreground loading operational. The CLI exits nonzero if any prepared part is still missing.

The loader waits for discovery, every enabled visible asset, texture decoding and a rendered frame. Missing source parts retry quietly with bounded backoff; settled available data stays usable without repeated error banners. Browser Cache Storage remains a smaller cache of requested assets and is optional; server caching continues if browser storage is unavailable. Energy and live feeds do not enter the map cache.

## Verify and build

```sh
npm run check
npm test
npm run build
npm start
```

For the GPU depth regression, run `npx vite --config tests/city-depth.config.ts` and open `http://127.0.0.1:5175/tests/city-depth.html`. It must show `PASS`: 144 camera positions at overview and shallow angles keep aerial imagery above the base surface. It uses the actual city renderer and overlay without upstream data.

Prepare the foundation sample, city assets, matching energy catalog and route index before the production build. Run `energy:prepare` after **every** `city:prepare`. After refreshing prepared assets, rebuild the production server so it includes the current sample; the development server reads updated assets directly.

The production Node server defaults to port 3000; copy `.env.example` to `.env` for a loopback-only local start. Run from the project or extracted release root. No upstream credentials are required. This task does not deploy the application.

`npm run release:package` creates a versioned directory under `.cache/task-e/releases/` after checking source checksums, exact city/energy compatibility, and matching data inside `build/`. It includes the Node build, npm lockfile, `.nvmrc`, dependency notices and operating/source documentation. `static/data` is a relative symlink to `build/client/data`, so the runtime file readers and HTTP static server use the same assets. Retained build assets are copied as built; archive unused generations before the final build if preparing a public bundle. No `.env`, credentials, `node_modules`, raw downloads or runtime cache is bundled.

Install an extracted bundle on Linux or macOS with Node 24/npm 11:

```sh
npm ci --omit=dev
cp .env.example .env
mkdir -p .cache/energy/runtime
npm start
```

The runtime bundle serves already prepared assets; source refresh/build commands require this source checkout. Preserve the relative symlink when archiving or copying. See [operations](docs/operations.md) for exact refresh ordering, proxy/SSE configuration, process versus source health, logs, cache-preserving restart and rollback. [E results](docs/milestone-results/E.md) records actual release checks and remaining targets.

The pinned stack follows the local Ocean Lens reference: Svelte 5.57.1, SvelteKit 3.0.0, Node adapter 6.0.0, Vite 8.3.2, TypeScript 6.0.3, Three.js 0.186.1 and proj4 2.22.0. Task B adds the interactive city renderer and live traffic endpoints. Task C adds inspection, keyboard search, exact GTFS route context and station observations. Task D adds measured property electricity, modeled building demand and incident solar potential. Task E verifies release readiness.

ExcelJS's UUID dependency is scoped to 11.1.1 to address GHSA-w5hq-g745-h8pq. Its CommonJS `v4()` calls remain compatible; a workbook write/read regression check covers this override.

## Live traffic operations

The Node application runs as one process. Browsers share one demand-driven MQTT connection to HSL; mode filters do not create separate upstream subscriptions. Closing all clients releases the connection after a 30-second grace period. Reconnect delays increase from 1 to 30 seconds. `GET /api/traffic` provides a current snapshot; `GET /api/traffic/stream` sends named `snapshot` and `update` events, including removals and feed status. A reconnect receives a full snapshot.

Positions become stale after 30 seconds and leave the fleet after 120 seconds, measured from the provider report timestamp. A selected removed vehicle keeps an explanation. Metadata cannot refresh its position age. Disconnected traffic stays visibly dated; the application never replaces it with sample vehicles. Hidden tabs stop rendering and close their SSE connection, then recover from a current snapshot when shown.

A reverse proxy must pass SSE without response buffering or caching, preserve `Content-Type: text/event-stream`, and allow connections longer than the 15-second heartbeat interval. For nginx, use `proxy_buffering off`, `proxy_cache off`, and a `proxy_read_timeout` of at least 60 seconds on `/api/traffic/stream`; the endpoint also sends `X-Accel-Buffering: no`. Slow clients have bounded queues and reconnect for a full snapshot if disconnected. Multi-process hosting requires shared feed coordination and is outside this release.

City preparation publishes a separate generation under `static/data/city/` and retains the previous valid generation after a failed refresh. Source terms, coverage and known base-layer gaps are recorded in [city source evidence](docs/city-source-evidence.md). See [Task B results](docs/milestone-results/B.md) for the measured workload and acceptance evidence.

For the bounded Task B feed soak, run `node scripts/verify-traffic.ts` (30 minutes of real HSL traffic plus idle cleanup). Once it records a peak, run `node scripts/verify-traffic.ts --fixture --peak=<recorded-peak> --seconds=300` for a separate offline workload with twice that many attributable fixture identities. Synthetic identities/timestamps exist only in this explicitly labelled test. Diagnostics are saved in `.cache/task-b/`.

## Inspection and observations

Local search covers vehicles, prepared route labels, and all available building metadata, including source addresses. Search and scene picking share the same selection contract. The application defines the on-time display band as ±60 seconds; exact HFP deviation remains visible. Current traffic keeps its own report time when viewing station history.

`GET /api/observations` serves a fixed recent six-hour window from the A-verified Kaisaniemi weather station (100971) and Mannerheimintie air-quality station (100742). It accepts no query parameters. The server shares refreshes between clients, checks weather every five minutes and air quality every fifteen minutes, and retains dated observations during failures. These checks do not describe the provider’s publication frequency. Each reading preserves its actual time, unit, aggregation and quality. Environmental context is a nearby station reading, with distance and explicit bounded coverage; there is no pollution heatmap or causal weather/delay claim.

`npm run routes:prepare` reads A’s downloaded `.cache/task-a/hsl-gtfs.zip` and atomically publishes the bounded, ignored `static/data/route-index.json`. Optional positional arguments select another GTFS archive and output path. Refresh the source archive through `npm run data:probe -- --source transit` before preparing a newer index; archive caching and source dates remain visible. Runtime route requests read the prepared index, without downloading or scanning the full archive. `GET /api/route` lists prepared route labels. A journey query requires the complete owner/operator, vehicle, route, direction, service date and start time identity. Missing, ambiguous, expired or unavailable matches show no guessed shape. Routes are context only; raw positions are never snapped to them.

The route index must remain at `static/data/route-index.json` beside the running Node application. Keep the working directory at the project root. Rebuild after refreshing production static assets. [Task C results](docs/milestone-results/C.md) records the station source dates, exact route evidence and browser verification; the completed D report records energy and solar gate resolution.

## Building energy and solar

`npm run energy:prepare` verifies exact source identities against the prepared city, prepares the Atlas demand workbook and original Atlas solar layer, and publishes a dated catalog atomically. No address or nearest-point allocation is inferred. Read [energy/solar source evidence](docs/energy-solar-evidence.md) and [solar method/export evidence](docs/solar-method-evidence.md) before changing source adapters. Refresh and cache details, precise coverage, and release asset requirements are recorded in [Task D results](docs/milestone-results/D.md).

The building inspector distinguishes daily measured electricity at a municipal property boundary from modeled building demand and incident solar energy on modeled roof/wall surfaces. Shared property consumption is linked to verified members once and never divided or used for building colors. Building color modes use a single compatible source, metric, unit, period and scenario; missing values remain neutral. Solar irradiation is not installed photovoltaic capacity or electricity output.

The static catalog loads after the scene becomes interactive. Daily energy requests use fixed Nuuka endpoints and only catalog-listed properties. The default selects the latest completed calendar month with a finite reading for every day; partial months remain available with null gaps and no unqualified month total. Current traffic continues independently of energy date selection. Provider failures retain dated valid data with warnings.

Successful measured-energy requests are cached for six hours; failed requests retry after one minute. A new completed month or changed city/source/membership version starts a new lookup. The one-process service coalesces identical requests and limits upstream traffic to four concurrent requests and 24 starts per minute, each at most 256 KiB / 15 seconds / 366 daily rows. Its checksum-validated raw cache is written atomically under `.cache/energy/runtime`, with at most 64 files and 64 memory entries. Give the production process write access to that directory and run it from the project root. Provider publication cadence is unknown.

After **every** city preparation, run `npm run energy:prepare`, even when the upstream tileset checksum is unchanged: the energy catalog must match the city generation, semantic source checksum and vintage. Normal preparation reuses verified source caches; `npm run energy:prepare -- --refresh` explicitly retrieves a new source version for review. Review static annual datasets monthly or when a provider announces a new export. Rebuild after preparing static assets. Preserve `static/data/energy-manifest.json`, its referenced immutable catalog, and any `energy-refresh-status.json` alongside the foundation/city/route assets listed in the [D handoff](docs/milestone-results/D.md#e-handoff).

The current energy catalog is 16.75 MB uncompressed and fetched once after scene readiness. The catalog API negotiates gzip and reuses compression for the same validated catalog; SSE remains uncompressed. In the final E production check at 20 Mbps / 50 ms latency with browser cache disabled, the scene became interactive in 1.455 seconds and the complete gzip catalog became usable in 1.988 seconds; internal receipt-to-browser p95 was 935 ms. Solar covers 695/8,909 release buildings in twelve selected district tiles; coverage elsewhere is unqueried. Its meteorological reference year and optional run settings are unknown and stay explicitly labelled. These source coverage limits remain visible; consult E results for final release measurements and browser exceptions. Public deployment is separate.

## Ryhti building register

`npm run ryhti:prepare` prepares open Syke / Ryhti building and permit records for the current city's retained VTJ-PRT identifiers. Run it after city preparation and before the production build. Normal preparation reuses checksum-verified source snapshots; `npm run ryhti:prepare -- --refresh` retrieves both collections again. A failed run retains the previous publication and records its failure. A city-generation mismatch makes enrichment unavailable until preparation runs again.

The inspector shows completed-building register facts separately from municipal geometry attributes, with a list of linked permits. Completion date is not asserted to be the original construction year. Permits can describe historical work; their proposed attributes never overwrite completed-building facts. Exact ambiguous or conflicting associations are withheld. Missing identifiers do not trigger address or proximity matching.

Building colors include Use, Heating method, Heating energy source and Permit action status. Selecting a legend category highlights its buildings and narrows building search; other buildings remain dimmed and pickable. Changing color mode clears this selection. Multiple permit statuses remain explicitly mixed. No linked permit records is not evidence of no construction. Sources & status shows coverage, attribution and snapshot dates.

`GET /api/ryhti/catalog` accepts no parameters, validates the immutable catalog and city-manifest checksum, and reports ready/stale/unavailable. It supports gzip and loads after scene readiness. Existing installations without a Ryhti snapshot remain operational. Release packaging verifies optional Ryhti assets when present. No runtime upstream requests or automatic refresh are added.

The [Ryhti source evidence](docs/ryhti-evidence.md) records measured coverage, limitations and code-list provenance. Syke requires an application identifier for long-term API use; the operator should request it from Syke GIS support as described in the [official instructions](https://ryhti.syke.fi/en/front-page/services/instructions-for-using-open-interfaces-in-the-ryhti-system/). No application identifier has been requested by this integration.
