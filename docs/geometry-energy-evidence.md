# Task A geometry and energy evidence

> **D resolution — 8 October 2026:** [Original D source evidence](energy-solar-evidence.md) resolves the modeled-unit and solar-association gates for the current 8,909-building release. It verifies five original associations, preserves the shared property boundary and withholds conflicting versions. [D results](milestone-results/D.md) contains the completed verification and handoff. The 159-building sample, its old three-candidate ambiguity, unresolved HSY candidate and blocked findings below remain A's historical observations.

Live source work was performed on 8 October 2026. Detailed request timestamps, checksums, byte counts and results are in the prepared source manifest/evidence, with larger raw and parsed files kept under ignored `.cache/task-a/`.

## Geometry and coordinate gates: pass

The [published Helsinki archive](https://3d.hel.ninja/data/citygml/Helsinki3D_CityGML_Kalasatama_20190326.zip) downloaded anonymously. It is 23,546,638 bytes compressed and contains one 268,161,653-byte GML member. The streamed source has 3,011 city-object records. Senate Square's saved bounds select 167 building records by projected envelope centre, representing 160 distinct GMLIDs. Seven repeated records carry compatible identities across LoDs.

Archive SHA-256: `ef6a787068b82642e5a0be5e20268e137075bb41fdbf0ec88619ad79926e2299`.

The pinned [citygml-tools 2.5.0 release](https://github.com/citygml4j/citygml-tools/releases/tag/v2.5.0) was evaluated with Java 26.0.2.1. Its distribution SHA-256 is `bb2949fbc6c3ec44ec85c25a0bcdfe9accde9cbdb9e26ec773889779694710b1`. Official command help established the actual options:

```sh
.cache/citygml-tools/citygml-tools-2.5.0/citygml-tools to-cityjson   --epsg=3879 --compute-extent --cityjson-version=2.0   --vertex-precision=3 --output=.cache/task-a .cache/task-a/senate-square.gml
```

The scoped input removes 153 appearance records whose JPEGs are absent from the published ZIP. It retains source semantic attributes, assigns temporary per-record converter keys, and corrects the source's `urn:ogc:drf:crs:EPSG::3879` typo to `urn:ogc:def:crs:EPSG::3879` for conversion. The original declaration remains in each building's source attributes. Temporary converter keys map back to the original GMLID; compatible duplicate records merge, with differing attribute values preserved in explicit conflict fields. Conflicting national/municipal/UUID identities receive distinct stable internal identifiers.

The output is **159 unique renderable buildings, all using usable LoD2 geometry, and 44,853 non-indexed triangles**. One building, `BID_841fb76c-53b7-4a51-a92f-c72d7c6ceafc`, is excluded because its available surfaces are degenerate. Rejected identity and reason are preserved in preparation evidence. Each triangle range maps directly to a stable building ID and a real Three.js Raycaster regression proves that a hit resolves correctly.

Source tuples are easting, northing, N2000 elevation even though the official EPSG axis-order declaration differs. The local frame is `[east − originEast, N2000height, −(north − originNorth)]`; origin is 24.952°E, 60.1695°N, elevation 0 m. A GRS80 transverse Mercator projection uses central meridian 25°, scale 1, false easting 25,500,000 m. UTF-8 decoding preserves Finnish attributes across stream boundaries. RATU uses the actual `Rakennustunnus_(RATU)` attribute.

Three independent [City of Helsinki Service Map controls](coordinate-controls-evidence.md) pass against actual converted mesh bounds, with 0 m distance to each building extent and identical source/rendered N2000 extrema:

| Identifiable location | Independent WGS84 longitude, latitude | GMLID | Source/rendered N2000 min/max |
| --- | --- | --- | --- |
| Helsinki City Hall | 24.952913, 60.168037 | BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e | 1.900 / 20.630 m |
| Helsinki Cathedral | 24.952229, 60.170345 | BID_4d58c091-9185-42fd-a8be-78f1f6eb891f | 13.438 / 72.330 m |
| National Library | 24.950335, 60.170370 | BID_cf43c58b-5f52-4da0-9e2a-2cb440430d86 | 12.270 / 40.250 m |

A service point can describe an entrance, so the check compares the point with the actual mesh extent within 30 m; it does not require equality with the geometry centroid. These checks verify horizontal alignment and preservation of the declared vertical datum. They are not an independent survey of absolute heights. City Hall's source `GroundLevel=-12.1` attribute remains unchanged; it is not used to shift its actual 1.9–20.63 m geometry or to place vehicles.

Helsinki's city information model is attributed to the City of Helsinki under CC BY 4.0, as documented by the [Helsinki 3D source page](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d).

## Measured energy gate: pass

The anonymous [Nuuka property lookup](https://helsinki-openapi.nuuka.cloud/api/v1.0/Property/Search?SearchString=1761&SearchFromRecord=LocationName) identifies `1761 K30, Leijonakortteli`, property `091-001-0030-0001`, and three declared building members:

| Source member | Association with the 159-building sample | Result |
| --- | --- | --- |
| City Hall, VTJ-PRT 103027184J | Exact GMLID BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e, RATU 216 | Exact |
| Hellenius/Burtz, VTJ-PRT 103027185K | Three distinct original GMLIDs, including two overlapping objects | Ambiguous; none silently selected |
| Bockin talo | Empty national building code | Missing; location label retained as unresolved source identity |

The ambiguous GMLIDs are `BID_1b6c3f66-d6e5-4d79-b595-b0ae2cfd013b`, `BID_508bfef0-6aaf-476b-8daa-1669665405c0` and `BID_f2b6e1f2-9a20-45ee-8e84-ac1a457470ed`. They remain separate geometry records rather than collapsing different original identifiers.

The bounded [daily electricity query](https://helsinki-openapi.nuuka.cloud/api/v1.0/EnergyData/Daily/ListByProperty?Record=PropertyCode&SearchString=091-001-0030-0001&ReportingGroup=Electricity&StartTime=2026-10-06&EndTime=2026-10-07) returned:

| Source local day | Property electricity |
| --- | --- |
| 2026-10-06 | 6088.751 kWh |
| 2026-10-07 | 4323.735000000001 kWh |

The [actual Swagger contract](https://helsinki-openapi.nuuka.cloud/swagger/Nuuka%20Open%20API/swagger.json) explicitly says a BuildingCode lookup returns consumption from the property to which the building belongs. Accordingly, normalized records retain **property scope**, one total per property/day and the exact member association; they do not allocate or duplicate the property total onto each building. City Hall's membership proves a measured-energy association, not a City Hall-only meter reading.

One of three declared members matches uniquely, 33.3%; one is ambiguous and one missing. City Hall represents 1/159 sample buildings with an evidenced unique measured property association, 0.6%. Source timestamps have no timezone suffix. The records retain daily period labels and do not fabricate UTC midnight observation times. All-null source rows preserve null and cannot pass the measured gate.

The [HRI municipal energy dataset](https://hri.fi/data/en_GB/dataset/helsingin-kaupungin-palvelukiinteistojen-energiankulutustietoja) supplies the City of Helsinki attribution and CC BY 4.0 terms.

## Atlas workbooks and modeled energy gate: blocked

All three published workbooks downloaded and parsed with bounded streaming XLSX reads. Only rows matching district identifiers plus the modeled metadata sheet are retained.

| Workbook | Download / inflated bytes | Source data rows | District matching rows |
| --- | --- | --- | --- |
| [data_atlas.xlsx](https://www.hel.fi/hel2/tietokeskus/data/helsinki/kaupunginkanslia/3D-malli/data_atlas.xlsx) | 8,050,709 / 40,923,643 | 77,249 | 152 exact; 95.6% of sample, 7 sample buildings without a row |
| [HEKA measured 2015–2018](https://www.hel.fi/hel2/tietokeskus/data/helsinki/kaupunginkanslia/3D-malli/HEKA_Bldgs_Measured_Consumptions_2015_2016_2017_2018.xlsx) | 360,824 / 1,462,778 | 1,937 | 0; no Senate sample association |
| [Heating demand and climate change 2020-10-21](https://www.hel.fi/hel2/tietokeskus/data/helsinki/kaupunginkanslia/3D-malli/Helsinki_Buildings_Heating_Energy_Demand_Climate_Change_20201021.xlsx) | 31,131,188 / 191,554,880 | 46,641 | 118 exact, 9 identifier conflicts; 74.2% exact coverage, 32 sample buildings without a retained row |

The modeled workbook's City Hall row 9645 supplies both exact GMLID and VTJ-PRT, and `SQ_2020_Total_Yearly_Heat_DHW_demand=59114`. Both its header and metadata describe yearly heating and domestic-hot-water energy demand without declaring its energy unit. The row is retained as evidence, with `unit=null`, and excluded from normalized distributable energy records. Its 2020–2050 scenario years and 2020-10-21 file vintage remain separate from the 2026 retrieval.

An exact GMLID with a contradictory national identifier is a conflict, not a reason to fall back to an alternative join. The nine model conflicts are therefore excluded. The basic Atlas workbook has certificate, measured-consumption and building metadata fields but no solar potential field. HEKA headers declare MWh, kWh and m³ for historical measured metrics but have no matching Senate sample records.

The next action is to obtain authoritative model energy-unit documentation, then normalize the already evidenced exact association. Numerical magnitude is not evidence of units.

## Solar gate: blocked

The anonymous [HSY schema](https://kartta.hsy.fi/geoserver/wfs?service=WFS&version=2.0.0&request=DescribeFeatureType&typeNames=ilmasto_ja_energia:rakennukset_aurinkosahkopotentiaali) declares only `ogc_fid`, `geom`, `panel_ala` and `elec_kwh_v`. A bbox query over the Senate district returned five requested real features and advertised 331 matching features. Geometry is GeoJSON longitude/latitude in EPSG:4326.

The fields contain real numeric panel-area and electricity-potential values but no GMLID, VTJ-PRT or RATU. Source `ogc_fid` values are preserved; service-generated `fid` strings are not treated as stable building IDs. The response does not establish model vintage or assumptions. No unevidenced nearest-building guess is attached to the prepared data, so normalized solar remains an empty array and this gate remains blocked.

The next action is an evidenced manual/spatial association for one building plus authoritative unit, vintage and assumptions metadata from the [HSY solar dataset](https://hri.fi/data/fi/dataset/paakaupunkiseudun-aurinkosahkopotentiaali).

## Implementation, bounds and focused checks

The geometry and energy adapters export `prepareGeometry()` and `probeEnergy(buildings)` for the root preparation/probe commands. Both return typed records, DatasetSource metadata, ProbeEvidence and independent GateResult objects. Raw downloads and inspection summaries remain ignored; root publication owns the final atomic manifest.

Bounds are 30 MB compressed and 280 MB actually inflated for the CityGML ZIP, 16 MiB for an individual XML frame, 500 retained district records, 60 seconds/512 MiB for the converter, 20 MiB for converted district JSON, and 100 ZIP entries/250 MB actually inflated/16 MB shared strings/100,000 rows/500 retained rows per workbook. Nuuka permits at most 31 daily rows in this probe; HTTP time and byte limits apply. Immutable archive and converter checksums are pinned; cached workbook summaries key on content checksum and sample building identities.

Installed dependency sources resolved through `opensrc path --cwd`:

- Three.js 0.186.1, `src/extras/ShapeUtils.js:50`, confirms triangulation indices refer to flattened contour/hole vertices and strips duplicated closing points.
- ExcelJS 4.4.0, `lib/stream/xlsx/workbook-reader.js:77` and `:303`, explains streamed ZIP processing and its dependency on workbook/relation/shared-string entry order. The inspected provider files work; unsupported reordering fails visibly rather than mutating the dependency.
- yauzl 3.4.0 validates entry sizes; actual inflated bytes are also counted before XLSX parsing and during GML streaming.

Thirteen focused geometry/energy regression tests pass: source identity, LoD reconciliation/fallback, identifier conflicts, coordinate axes/N2000 heights, three independent location controls, polygon holes, actual Raycaster picking, deterministic joins, property totals, null values/all-null gate, malformed dates/units/duplicates, bounded workbook streaming and malformed ZIP rejection. Type checking passed with zero errors/warnings.

Full application build/startup and two combined publication runs are verified by the root task. Continuous transit subscriptions, the finished renderer and energy/solar UI remain in later milestones. Absolute survey heights and an independently validated solar crosswalk remain unverified.
