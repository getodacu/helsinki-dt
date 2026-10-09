# Task B spatial source and asset evidence

Evidence date: **8 October 2026**. The final prepared generation was published at **2026-10-08T12:10:39.077Z**. Static data remains a dated source snapshot. Continuous vehicle reports belong to the separate live traffic feed.

## Outcome and source choice

The release bounds `[24.90, 60.135, 25.04, 60.195]` now contain **8,909 actual semantic buildings**, including the centre, harbour and Suomenlinna corridor. The prepared meshes contain **984,240 source triangles** in **177 spatial batches**. No footprint extrusion or invented building height was added. A spatial sample south of latitude 60.16 and east of longitude 24.975 contains **493 real island-area buildings**.

A's 2019 CityGML archive covers only the eastern centre and northern harbour. Its current source directory contains that one archive. The CityDB WFS returned HTTP 503 during B's discovery; the official Helsinki page describes four-square-kilometre CityGML sheets but currently supplies no actual sheet download link. B therefore uses the official viewer's **untextured semantic LoD2 tiles**, which retain original GMLIDs and building attributes. The source is directly configured by the City's [Helsinki 3D viewer](https://kartta.hel.fi/3d/) and covered by the [official Helsinki 3D model terms](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d). This resolves the building coverage gap without switching renderers or changing A's outputs.

The exact index is [the municipal semantic tileset](https://kartta.hel.fi/3d/datasource-data/16fc3fd5-df6d-4f48-bfd5-9aeee430a02f/tileset.json). Its index version is `291269823412`, SHA-256 `059578f562215babc3052e28b9c2c3ec1a18105909f929c36d36f73debac872d`. **245** level-15 tiles intersect the release, totaling **108,052,160 bytes**. The index was retrieved at 11:53:45.574Z; source tiles were retrieved from 11:53:45.926Z through 11:56:03.285Z. Individual URLs, original retrieval times and checksums remain in ignored `.cache/task-b/semantic-source-checksums.json`; its ordered URL/checksum aggregate is `ce1e2b540134ef14d54973468270af85b1cc6c56382d4d41c417c677baff6e64`. A specific acquisition vintage is not asserted for the continuously maintained tile set.

## Distributed layers and terms

All five distributed sources were verified as **CC BY 4.0**, using the City/HRI dataset metadata and the original provider attribution. The script rechecks cached license metadata before publication; unverified licensing prevents publication.

| Layer | Actual source | Treatment and attribution |
| --- | --- | --- |
| Semantic buildings | Official Helsinki 3D untextured LoD2 b3dm tiles | City of Helsinki, Helsinki 3D, CC BY 4.0. Original `id` becomes both stable internal ID and GMLID; `VTJ_PRT`, `RATU`, address, use, construction year and other supplied attributes remain available. Empty VTJ and provider RATU `0` become null normalized identifiers, with original attributes retained. UUID is absent and stays null. |
| Terrain | WCS `avoindata:Korkeusmalli_2021_1m` | City of Helsinki, Kaupunkimittauspalvelut, CC BY 4.0; [elevation metadata](https://hri.fi/data/en_GB/dataset/helsingin-korkeusmalli). Native server coverage is 1m; the published grid samples at 20m. HRI's abstract still mentions a 50cm layer; B records the actually advertised and downloaded 1m coverage. Heights are N2000. |
| Mainland/islands/shoreline | WFS `Maavesi_manner`, `Maavesi_saaret` | City of Helsinki, land and water areas, CC BY 4.0; [metadata](https://hri.fi/data/en_GB/dataset/helsingin-maa-ja-vesialueet). 262 complete features supply the land mask and 368 clipped shoreline paths. Provider polygons exclude small piers and bridges and are described as experimental. |
| Road context | WFS `YLRE_Katu_ja_viherosat_ajorata_alue` | City of Helsinki, register of public areas YLRE, CC BY 4.0; [metadata](https://hri.fi/data/en_GB/dataset/helsingin-kaupungin-yleisten-alueiden-rekisteri). The source contains 8,341 carriageway polygons; B retains maintenance classes I/II for major and collector roads, uses their actual edges and drapes them on terrain. No street-furniture line layer is misrepresented as a road centreline. |
| Rail context | WFS `Seutukartta_liikenne_juna_rata`, `Seutukartta_liikenne_metro_rata` | HSY and Helsinki region municipalities, Seutukartta, CC BY 4.0; [metadata](https://hri.fi/data/en_GB/dataset/seutukartta). Three complete source features become seven clipped paths. General regional train/metro geometry is context; metro lines do not claim surveyed tunnel elevation. |

Each manifest source includes URL, attribution, actual UTC retrieval time, source vintage or null, units, CRS, axis order, vertical reference, checksum and transformation method. Base sources were retrieved at 11:47:22Z. The original payload hashes are:

| Source | Original bytes | SHA-256 |
| --- | ---: | --- |
| Terrain GeoTIFF | 563,605 | `c3bc326d5ba15d5f42881124762a50bf675cc719a05c5a6f7c04736fac900ff3` |
| Mainland/islands GeoJSON | 6,470,858 | `cfe06109cffbe1bbef14e998762ad9bbe9f9c78a86f90118a2c87bfba8facacd` |
| Carriageway GeoJSON | 17,144,242 | `818d71ea6e3a908cddd0be231a9847ae3531ad7e2d47d362d5054049a7618299` |
| Train/metro GeoJSON | 10,893 | `0c93636bb391052ee7ee50ce2c7198c3f5c934ea49ee43fd221d109dcc75c169` |

## Coordinates, terrain and water

The origin remains `{ longitude:24.952, latitude:60.1695, elevation:0 }`. Scene coordinates are local metres `[east, elevation, -north]`; all geometry uses the same ETRS-GK25 horizontal conversion from A. The b3dm wrapper undoes glTF's Y-up orientation, applies the node matrix and `RTC_CENTER`, recovers geographic location and the source's encoded height, then uses the existing local projection. It does **not** apply an invented geoid offset. Official Helsinki model metadata declares ETRS-GK25/N2000; the recovered numeric heights are crosschecked against A's original CityGML heights below.

The GeoTIFF has one float32 band, CRS 3879, north-up affine transformation, `PixelIsArea`, `NoData=-32767`, requested bounds `[25494300,6669000,25502300,6675900]`, and dimensions **400×345**. Sampling uses the centres of its 20m pixels. **68,682** samples are inside official land polygons, with **zero unknown land samples** in this source window; missing or invalid samples would remain null. The measured land elevations range from **−4.92 to 44.58m N2000**. Scanline polygon parity preserves holes and separate islands.

The shared `sampleTerrainHeight` follows the same triangle diagonal as the mesh (`[a,c,b]` and `[b,c,d]`), using barycentric interpolation. It returns null whenever the particular triangle needs an unknown sample. Ground vehicles therefore follow the rendered ground rather than an assumed GPS altitude.

Sea level **0m N2000** is a documented display datum, not a live tide measurement. `CityBase.landMask` is independent of height and prevents that surface from covering real land below zero. Shoreline horizontal paths come from the real polygons and display at that datum. Terrain and sea sampling at 20m can omit very small coastal features; all supplied shoreline paths remain real, but this is not a surveyed quay-edge terrain mesh. Inland water detail, bathymetry and tram-track geometry are outside this base. Road/rail paths are clipped, short duplicate vertices removed, and missing draped heights cause a segment to be omitted.

## Control locations and identity evidence

Five independent official Service Map locations fall **inside the respective actual mesh extent (0m extent distance)**. Harbour and island associations are supported by the exact source address and building use, not only by nearest location. The new control responses were retrieved at 12:05:40.557Z and 12:05:40.853Z; their response checksums and metadata are in `tests/fixtures/city-coordinate-controls.json`.

| Control | Official location longitude,latitude | Original GMLID | VTJ-PRT / RATU |
| --- | --- | --- | --- |
| City Hall | 24.952913,60.168037 | `BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e` | `103027184J` / `216` |
| Cathedral | 24.952229,60.170345 | `BID_4d58c091-9185-42fd-a8be-78f1f6eb891f` | `103027179C` / `211` |
| National Library | 24.950335,60.170370 | `BID_cf43c58b-5f52-4da0-9e2a-2cb440430d86` | `103036769R` / `330` |
| [Katajanokka Terminal](https://api.hel.fi/servicemap/v2/search/?input=Katajanokan%20terminaali&lang=fi), Service Map 9229, Katajanokanlaituri 8 | 24.968521,60.163994 | `BID_02c650c9-e65a-482f-82c0-28be11b17763` | `103132648L` / `1639` |
| [Suomenlinna church](https://api.hel.fi/servicemap/v2/search/?input=Suomenlinnan%20kirkko&lang=fi), Service Map 43172, Suomenlinna C43 | 24.986294,60.147766 | `BID_38894eec-560e-4e69-8c74-fa2a3a42a456` | `102317380M` / `40705` |

**110 same-ID buildings** agree with both original CityGML N2000 height extrema within 2cm. City Hall's extrema are exactly 1.90–20.63m and National Library's 12.27–40.25m after rounding. All three Senate control roofs agree with the old source. Cathedral's upper extremum remains 72.33m, but its current tile includes geometry down to 9.93m while the 2019 archive envelope starts at 13.438m. This source geometry difference is retained and disclosed; it is not hidden by moving either model. These checks establish datum/axis preservation, not an independent absolute-height survey.

`scripts/check-city-assets.ts` verified **355 generated assets** against manifest-side SHA-256 and byte counts and performed **ten actual Three.js raycasts** in ten spatial batches, each resolving its expected original building ID. Their exact IDs, chunk IDs, triangle ordinals, metadata and control results are saved in ignored `.cache/task-b/city-checks.json`. An offline regression separately verifies the same building identity survives splitting across render batches.

The tiny fixture `tests/fixtures/city-building-tile.b3dm` contains one actual triangle from official tile `15/37310/5430.b3dm`, using source building `BID_1997b650-5116-41fb-902d-4a39322da303` (Rauhankatu 13, VTJ-PRT `103017676U`, RATU `62`). Original float32 positions, node transform, RTC centre and selected source attributes are retained; unrelated buildings/primitives are removed and the semantic batch index is remapped to zero. The result is 1.3KB, attributable to City of Helsinki/Helsinki 3D under CC BY 4.0. The regression recovers the real 6.91m N2000 vertex and the original ID. Synthetic terrain/partition cases in the test file remain explicitly test-only.

## Asset loading, limits and publication

Building tiles are assigned to 500m metric cells by actual mesh-extent centres. Each batch is capped at **30,000 triangles**; a larger building spans batches without losing identity. Prepared non-indexed positions are rounded to **0.01m**, with original semantic strings preserved. Each batch contains a contiguous triangle-to-building range table and a metadata JSON file; the largest combined batch is **2,078,865 bytes**. Four nearest initial batches require **5,797,062 bytes**. The base grid, land mask and context require **3,573,417 bytes**. The entire prepared area, including all batches and indexes, requires **74,346,368 bytes**, but the browser loads by view/distance. Actual connection/frame measurements are recorded in B's milestone report; byte counts alone do not prove its 5-second target.

The manifest pointer is `static/data/city/manifest.json`, with immutable files under `static/data/city/generations/<uuid>/`. The loader checks the origin, safe relative generation paths, finite coordinates, source attribution, metadata and complete identity ranges. Requests combine caller cancellation with a 30s timeout and enforce body byte limits. Its cache supports explicit unloading/disposal.

Preparation reuses A's bounded download/checksum cache helper and coordinate helpers. The fixed tile wrapper accepts only the observed embedded, untextured source layout and delegates glTF decoding to installed Three; it is not a general 3D Tiles implementation. Limits include 600 intersecting tiles, 8MB per tile, 350MB total tile input, depth 12, bounded semantic/vertex/triangle counts, no external glTF resources, and rejection of unsafe paths or repeated source identities. WFS counts must equal advertised complete counts. Preparation stages and validates **every** new manifest/base/chunk through the browser loader before renaming the manifest pointer. A failed download, conversion, validation or write retains the previous generation byte-for-byte. It retains three successful generations; older cleanup is best effort after successful publication. Static source cache files are dated snapshots: clear the corresponding `.cache/task-b` files when deliberately refreshing the source.

The new exact dependency `geotiff@3.0.5` is needed because the official WCS publishes numeric heights as GeoTIFF and image formats would discard them. Its installed source resolved through `opensrc path geotiff --cwd ...` to `/Users/radu/.opensrc/repos/github.com/geotiffjs/geotiff.js/3.0.5`. Numeric NoData handling is in `src/geotiffimage.js:940`; affine bounding extents in `src/geotiffimage.js:1037`. B uses those affine extents and verified north-up origin for pixel placement. Existing `three@0.186.1` resolved to `/Users/radu/.opensrc/repos/github.com/mrdoob/three.js/0.186.1`; `examples/jsm/loaders/GLTFLoader.js:4925` confirms custom `_BATCHID` becomes `_batchid`. Original public APIs decode the glTF geometry and perform raycasts. No other dependency was added.

## Reproduction and checks

From the repo with its pinned Node/npm dependencies installed:

```sh
npm run city:prepare
node scripts/check-city-assets.ts
node --test tests/city-assets.test.ts
npm run check
npm test
```

The live preparation completed successfully and was repeated from checksum-verified caches. The current source coverage has no unresolved spatial-source gate (`gaps:[]`). `check-city-assets` uses A's cached original geometry for cross-source height comparisons, as B follows A's core gate. Seven new offline tests cover triangle sampling and missing heights, islands/holes, split identities, real semantic decoding, unsafe tile paths, bounded/cancelled loading, corrupt lookup rejection, and failed publication. The final integrated suite passes **70/70** tests, and type checking reports zero errors/warnings. [Task B results](milestone-results/B.md) records the production build, browser performance, recovery and workload checks.

Large source files, converters and generated spatial outputs remain ignored. A's manifest and generations were preserved. No deployment, texture download, independent elevation survey, automatic source refresh, generic CityGML/3D Tiles engine or detailed underground/tram-track reconstruction was added.

## Reference map appearance (9 October 2026)

The official viewer's `app.config.json` points to `configs/c4f95e20-bb50-44ec-b175-c6724b354d68.json`. Its active startup layers include `avoindata:Ortoilmakuva_2025_5cm` on the municipal WMS and textured LoD2 tiles at `https://kartta.hel.fi/3d/datasource-data/e5e7158a-52df-45a1-9be0-1be8f2828abd/tileset.json` (observed tileset version `303357262605`). The app serves these public layers through its bounded server disk cache, with City of Helsinki attribution. The imagery is dated 2025; the building acquisition date remains unspecified. This appearance layer does not refresh the prepared geometry or change energy catalog compatibility.

Unlike the prepared untextured b3dm source, the textured source uses 3D Tiles 1.1 external JSON subtrees, accumulated ECEF transforms and embedded glTF with Basis KTX2 images. Original IDs come from `EXT_structural_metadata` uint32 string offsets. The app bounds source paths, hierarchy depth, byte sizes, vertices, metadata rows, simultaneous requests and resident tiles, converts the supplied Y-up geometry to the existing local projection, and hides only prepared building ranges with an exactly matching loaded source ID. Hidden ranges remain raycast selectable; selecting any energy theme restores all prepared geometry. Tile failures retain the plain model, and changing views or disposing the scene releases texture/geometry resources.

Installed `three@0.186.1` was resolved with `opensrc path three --cwd /Users/radu/Projects/helsinki-dt` to `/Users/radu/.opensrc/repos/github.com/mrdoob/three.js/0.186.1`. `src/objects/Mesh.js:369` traverses material groups during raycasting without excluding invisible materials; this permits semantic picking of texture-covered ranges. `examples/jsm/loaders/GLTFLoader.js:1544` delegates KTX2 images to the supplied loader. `examples/jsm/loaders/KTX2Loader.js:295` loads its bundled Basis decoder by default; Vite emits these dependency assets locally, without copied decoder files, a renderer replacement or a new npm dependency.

`tests/fixtures/textured-building-identities.glb` contains only two original ID strings extracted from textured source tile `16/37310/18968.glb`, with a minimal metadata wrapper; no source textures or geometry are redistributed. The IDs are `BID_730f6007-d7b7-487c-9381-cd32aae1e296` and `BID_77021cac-6094-4163-81d3-a30f94e27b3a`. Source attribution: City of Helsinki / Helsinki 3D, CC BY 4.0.

## Complete views and persistent cache (9 October 2026)

Visible semantic geometry, aerial cells and foreground textured models are selected from the camera frustum without the previous tile-count limits. Readiness waits for discovery, decoding/attachment and a rendered frame; disabled layers do not delay it. Failed source parts retry quietly while available surfaces remain usable. Replacement textured surfaces commit together, and offscreen GPU resources are released independently of saved bytes.

`npm run city:cache` downloads and validates the prepared area's municipal appearance once into `.cache/city-map`; runtime warming uses the same implementation. Geometry/metadata are already prepared on disk. A complete live run reported **362/362** prepared parts, with no unresolved downloads. The official index's exact `emptyContent.glb` marker means no coverage and is skipped. WMS requests retain the provider's working GetMap parameter ordering: one observed reordered URL consistently reset the connection, while the equivalent normal request succeeded. Regression checks preserve both cases without widening allowed source paths.

Server files are bounded, checksum-verified and atomically published, retained across restarts and revalidated after 30 days with saved data retained during outages. Explicit `--refresh` retrieves them again. Fixed source/path/query restrictions, timeouts and a shared four-request queue (two background) remain enforced. Persistent caching requires writable disk space and a cache directory retained across deployments; it is not included in the release bundle automatically. The browser caches requested assets separately and pauses its requests while hidden. Server area warming is independent of a visitor's tab and creates no GPU objects.
