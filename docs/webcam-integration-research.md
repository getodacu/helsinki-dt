# Helsinki webcam integration research

Research date: **10 October 2026**. Scope: cameras useful in Helsinki Lens, their technical interfaces, reuse conditions, freshness, and the smallest integration. This is research only; no application code changed.

## Assessment

**Yes. Start with the six Digitraffic road-weather cameras inside the current scene.** They have a documented API, coordinates, JPEG images, capture timestamps, anonymous access and a clear CC BY 4.0 reuse license. Add South Harbour as an optional provider-hosted video player after checking playback in the deployed site. Helsinki Shipyard's panorama is the strongest additional scenic option, through an approved PANOMAX embed or partner arrangement.

Snapshots and video should be presented differently: Digitraffic images normally update every ten minutes; a video player supplies a stream but has separate privacy, branding and provider dependencies. Public viewing establishes availability, not permission to copy or redistribute footage. [Digitraffic camera documentation](https://www.digitraffic.fi/en/road-traffic/#weather-cameras), [Fintraffic license](https://www.digitraffic.fi/en/terms-of-service/), [YouTube player documentation](https://developers.google.com/youtube/player_parameters)

## Source comparison

| Source | Verified offering and coverage | Integration and access | Rights / unresolved questions | Recommendation |
|---|---|---|---|---|
| Fintraffic / Digitraffic | Road-weather JPEG snapshots; six stations inside the release scene, 78 in a larger test bounding box. Coordinates and per-preset timestamps. | Public REST metadata/data and image URLs; no API key. About 10-minute updates, thumbnails and 24-hour history. | CC BY 4.0 with Fintraffic attribution and license link. | **First choice:** scene markers and an image viewer. |
| Port of Helsinki | Six published views: South Harbour, West Harbour, West LT1, West LT2, West parking area, Vuosaari. South/LT1/LT2 pages use CamStreamer video embeds; other three use JPEG snapshots. | Provider player for video; HTML-discovered images for snapshots. No camera API or exact camera coordinate catalogue verified; official snapshots refresh every 60 seconds. | YouTube-supported player embedding is distinct from media reuse. No open license for Port snapshots found. | **Second choice:** South Harbour player; request permission before snapshot proxy/cache reuse. |
| Helsinki Shipyard / PANOMAX | Official Hietalahti panorama shows waterfront activity and city scenery. | Operator links and embeds PANOMAX. PANOMAX offers owner-controlled embed codes and approved-partner API access. | Partner approval controls keys/use; no blanket open-data license. Exact local cadence and pose unverified. | **Good scenic addition** through operator approval. |
| Baltic Live Cam / Klaus K Hotel | Provider advertises live video over central Helsinki, Swedish Theatre and Esplanadi. | Provider-hosted player; no public integration API/key contract verified. | No reuse/embedding grant established from the reviewed operator pages. | Link initially; ask provider for an approved embed. |
| SkylineWebcams Helsinki | Provider advertises a Helsinki live camera and nearby Port views. | Supported sharing links, proprietary player. | Terms forbid copying frames/video without written authorization; sharing allowed only through supplied links. | Link or negotiate; avoid scraping/proxying. |
| VuosaariWebcam / W2-S | North, west and southwest views from Cirrus; outside current scene. West view is a JPEG with a published update time and 24-hour history. | Public operator pages, no documented machine API or guaranteed interval found. | Copyright notice; no redistribution license found. | Optional outside-scene link; unsuitable for first release. |
| University of Helsinki Exactum | Official page describes a west-facing Physicum rooftop camera across Kumpula, once per minute. | A direct JPEG exists, but its HTTP modification date is from 2018. | No camera reuse license found; present liveness doubtful. | **Exclude as live** until operator confirms it works. |
| Windy Webcams API | Aggregated camera metadata, current/archive images and timelapse players; overlaps original feeds. | Registered API key; free limited images, required links; Professional currently €9,990/year. | Contractual attribution, no redistribution, no exposed key; no particular camera availability guarantee. | Fallback discovery/approved player service; unnecessary for the six direct open cameras. |

The first-party sources supporting the comparison are the [Digitraffic road API docs](https://www.digitraffic.fi/en/road-traffic/), [Port webcam selector](https://www.portofhelsinki.fi/en/about-us/port-of-helsinki/web-camera-south-harbour/), [Helsinki Shipyard camera page](https://helsinkishipyard.fi/fi/helsinki/), [PANOMAX distribution offering](https://www.panomax.com/en/content-distribution), [Baltic Live Cam Helsinki page](https://balticlivecam.com/cameras/finland/helsinki/helsinki-view-klaus-k-hotel/), [SkylineWebcams terms](https://www.skylinewebcams.com/en/terms-of-use.html), [Vuosaari operator](https://www.vuosaariwebcam.com/), [Exactum operator](https://www.cs.helsinki.fi/Exactum-kamera/), and [Windy pricing](https://api.windy.com/webcams/pricing).

## Digitraffic: verified local coverage

The live catalogue was fetched at **2026-10-10 17:31:56 UTC** (20:31:56 in Helsinki/Bucharest). It contained **812 national station records**. Filtering coordinates locally against the app's release bounds, **[24.86, 60.135, 25.06, 60.225]**, yielded six. The expanded box **[24.55, 60.10, 25.25, 60.40]** yielded 78 records; this is a rectangular coverage count, not a Helsinki administrative count. [Live catalogue](https://tie.digitraffic.fi/api/weathercam/v1/stations)

Catalogue, detailed metadata and data calls used no API key or Authorization header and returned HTTP 200, confirming anonymous access during the probe. Detailed calls completed at 17:32:28–30 UTC. All six were collecting, with preset inCollection=true, collectionInterval=600 seconds and 1280×720 resolution. The state field was null, including in detailed records: requiring state=ACTIVE would incorrectly exclude these observed cameras. [Weathercam API contract](https://tie.digitraffic.fi/swagger/)

| Station / location | Longitude, latitude | Preset | Reported image time, UTC on 10 Oct | Direct image |
|---|---|---|---|---|
| C01587 — Kivihaka mast | 24.898843, 60.207997 | C0158700 | 17:23:27 | [JPEG](https://weathercam.digitraffic.fi/C0158700.jpg) |
| C01590 — Kivihaka / Ilmala | 24.907594, 60.208315 | C0159000 | 17:31:03 | [JPEG](https://weathercam.digitraffic.fi/C0159000.jpg) |
| C01674 — Ruoholahti | 24.910959, 60.165910 | C0167400 | 17:31:09 | [JPEG](https://weathercam.digitraffic.fi/C0167400.jpg) |
| C01675 — Lauttasaari | 24.865320, 60.162290 | C0167500 | 17:22:32 | [JPEG](https://weathercam.digitraffic.fi/C0167500.jpg) |
| C01680 — Kivihaka west | 24.896018, 60.208150 | C0168000 | 17:26:19 | [JPEG](https://weathercam.digitraffic.fi/C0168000.jpg) |
| C01706 — Munkkiniemi | 24.864164, 60.202314 | C0170602 | 17:31:25 | [JPEG](https://weathercam.digitraffic.fi/C0170602.jpg) |

All six are outside the initial city-centre viewport, DISTRICT_BOUNDS=[24.944, 60.164, 24.958, 60.174], while remaining inside RELEASE_BOUNDS. They add road/weather context as users explore the map; South Harbour would provide the stronger downtown scenic view. No release-bound expansion is required for the six cameras.

Times are per-preset measuredTime from the station data endpoints, not catalogue modification times. For example, [Ruoholahti metadata](https://tie.digitraffic.fi/api/weathercam/v1/stations/C01674) and [Ruoholahti data](https://tie.digitraffic.fi/api/weathercam/v1/stations/C01674/data) are separate resources.

All six image HEAD requests returned HTTP 200 with image/jpeg at approximately 17:33:18 UTC; sizes were 142–282 KB. Images advertised Access-Control-Allow-Origin: * and exposed ETag. A repeated Ruoholahti HEAD with If-None-Match returned **304**, confirming conditional access works. This verifies reachable files and headers, not visual image quality.

There can be a metadata/image race: Lauttasaari's earlier data call reported 17:22:32, while the subsequent image header indicated 17:32:30. Ruoholahti's HTTP Last-Modified was 17:31:29, distinct from measuredTime=17:31:09. Keep capture time and retrieval time separate; do not label catalogue dataUpdatedTime or HTTP modification time as the exact camera exposure time.

### API and operating contract

- Catalogue: /api/weathercam/v1/stations; detailed station: /stations/{id}; capture status/time: /stations/{id}/data.
- Image URL comes from preset metadata. A thumbnail is available with ?thumbnail=true; history endpoints return links for the last 24 hours.
- The station catalogue has no bounding-box parameters in the inspected OpenAPI: filter GeoJSON points locally.
- There is no documented streaming-video endpoint in this weathercam contract. These are periodic images. [Road camera documentation](https://www.digitraffic.fi/en/road-traffic/#weather-cameras), [live OpenAPI](https://tie.digitraffic.fi/swagger/openapi.json)

Send HTTPS requests with compression for JSON and an identifiable, non-personal Digitraffic-User header. Missing compression was independently confirmed to produce HTTP 406. Images are exempt from the compression requirement. Do not send Authorization: the official instructions warn it causes weathercam failures. The default image limit without the identification header is 60 requests/minute/IP; identified quota increases are not quantified. Use ETag/If-None-Match and back off on 429/errors. [Fintraffic API instructions](https://www.digitraffic.fi/en/support/instructions/)

A reproducible metadata check:

~~~sh
curl --compressed \
  -H 'Digitraffic-User: HelsinkiLens/Webcams 1.0' \
  https://tie.digitraffic.fi/api/weathercam/v1/stations/C01674
~~~

Fintraffic's CC BY 4.0 terms allow commercial distribution and modification with source credit, a license link and modification disclosure; preserve notices and relevant limitations. Suggested credit: **“Camera image: Fintraffic / Digitraffic, CC BY 4.0.”** Add “cropped” or other transformation disclosure if applicable. [Fintraffic terms](https://www.digitraffic.fi/en/terms-of-service/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Availability is operational, not guaranteed by an HTTP 200. Fintraffic's status history includes a camera/data update interruption on 1 October 2026 and maintenance notices. Display capture age and a stale state; retain the last good image with its time through an outage. [Camera status history](https://status.digitraffic.fi/affected/road/api/weathercam/v1/stations/data/)

### Map placement limits

These coordinates are sufficient for camera markers. Five presets report UNKNOWN direction; Munkkiniemi reports DECREASING_DIRECTION, a road-direction label, not verified optical azimuth. No calibrated camera position/height, field of view or lens pose was established. The GeoJSON third coordinate is not validated as camera mast height. Do not project the images onto buildings or display a calibrated camera frustum from this metadata alone. [Detailed Munkkiniemi metadata](https://tie.digitraffic.fi/api/weathercam/v1/stations/C01706)

## Port and scenic cameras: practical caveats

### Port of Helsinki

The official HTML was checked on 10 October with a normal browser User-Agent; an initial generic HTTP client received 403. South Harbour uses a consent-gated CamStreamer embed, as do LT1/LT2. The other official pages expose the following JPEG paths:

| Official view | Verified page asset / player | Freshness evidence |
|---|---|---|
| [South Harbour](https://www.portofhelsinki.fi/en/about-us/port-of-helsinki/web-camera-south-harbour/) | CamStreamer embed; the MFA also embeds Port YouTube video CvOB-Is_yYU. | YouTube oEmbed HTTP 200 returned title and author “Port of Helsinki”; modal playback verified in Chromium on 10 October 2026. |
| [West Harbour](https://www.portofhelsinki.fi/en/about-us/port-of-helsinki/web-camera-west-harbour/) | /webcams/Lansisatama.jpg | Cache-busted HEAD 200 JPEG; file updated 10 Oct 2026 18:26:00 UTC. |
| [West parking](https://www.portofhelsinki.fi/en/about-us/port-of-helsinki/web-camera-west-harbour-p-area/) | /webcams/lansisatama_p_alue.jpg | Cache-busted HEAD 200 JPEG; file updated 10 Oct 2026 18:26:00 UTC. |
| [Vuosaari Harbour](https://www.portofhelsinki.fi/en/about-us/port-of-helsinki/web-camera-vuosaari-harbour/) | /webcams/vuosa00001.jpg | Cache-busted HEAD 200 JPEG; file updated 10 Oct 2026 18:26:00 UTC. |

A follow-up check at approximately **18:26–18:30 UTC on 10 October 2026** corrected the initial freshness finding. Bare JPEG URLs return old CDN copies with Cache-Control max-age=691200 (eight days). The [Port’s official webcam script](https://www.portofhelsinki.fi/wp-content/plugins/karhu-js-blocks/build/heros/hero-webcam/hero-webcam.js?ver=8946cdcdfac71eb7dde0) appends Unix seconds as a query immediately and every **60 seconds**. Following that mechanism returned current files for all three snapshots, with Last-Modified 18:26:00 UTC and CDN MISS. This is an image-file update time, not a verified camera exposure time. No CORS response headers were observed, so direct browser images cannot supply readable source timestamps. No snapshot redistribution grant or exact lens coordinates were found.

Use the Port’s permanent CamStreamer URLs, which track the current stream: South Harbour `/embed/3ae88840a60d5a4/S-28179`, LT1 `/embed/ma52UptmU7U6CRr1ex5jmifyNuHAdoBG5cmVWA5n/S-28179`, and LT2 `/embed/kWuatAApKSPHkY3E6R4PFZnpuSCJIhHZ1qnzza8I/S-28179`, all under `https://camstreamer.com`. The provider documents `cookie=off&autoplay=0` for [privacy-enhanced embedding](https://support.camstreamer.com/hc/en-us/articles/11470956538781-How-to-embed-YouTube-videos-without-cookies). These URLs currently redirect to YouTube-nocookie players for Port of Helsinki videos; use `strict-origin-when-cross-origin` referrer policy and preserve player controls. Official Port HTML pages have `X-Frame-Options: SAMEORIGIN`, so frame the player rather than the entire Port page. [Permanent player documentation](https://camstreamer.com/blog/yt-integration)

Representative harbour POIs are South Harbour at longitude 24.958939, latitude 60.160694 ([City of Helsinki service map](https://api.hel.fi/servicemap/v2/unit/21343/)) and West Terminal 2 at longitude 24.9151515, latitude 60.1503136 ([Port’s official location link](https://www.portofhelsinki.fi/en/passengers/passenger-terminals/west-terminal-2/)). These are harbour access locations, not exact camera positions. Vuosaari is outside the current map bounds and can remain selectable in the viewer without a map marker.

Implementation verification on **10 October 2026 at approximately 18:49–18:52 UTC** confirmed all three video players with advancing playback and all three cache-busted JPEGs in the browser. The viewer mounts only the selected camera, refreshes snapshots every minute while visible, retains the previous image and its load time after failed refreshes, and removes players/timers on switching, closing or hiding the page. Desktop/mobile centering, keyboard access, focus restoration and inspector preservation passed the browser self-check. Snapshot load time is displayed separately from the unknown capture time.

The [Finnish Ministry for Foreign Affairs' webcam page](https://finland.fi/facts-stats-and-info/webcam/) supplies a privacy-enhanced YouTube iframe for the same South Harbour view, including Market Square/Allas surroundings. It is an example of provider embedding, not a second camera inventory. “Allas Live” is the concert venue; no independent Allas camera/API was verified from [Allas' current site](https://www.allaspool.fi/en/).

Use an owner-enabled, supported YouTube/CamStreamer player when embedding is permitted; a CC license is not required merely to use that approved player mechanism. Preserve provider controls/branding, load on demand, and offer an external link if playback fails. Raw video extraction, snapshot capture and cached redistribution have different permission requirements. Google documents the iframe flow and prohibits audiovisual download/cache without its approval. [YouTube embed docs](https://developers.google.com/youtube/player_parameters), [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies), [CamStreamer gallery policy](https://camstreamer.com/privacy-policy)

### Other scenic and institutional sources

- **Shipyard:** the operator explicitly publishes its Hietalahti panorama. PANOMAX advertises approved-partner distribution with owner-controlled access, keys and rate limits. Obtain its approved embed/API for this camera; generic product capability does not prove this installation's cadence or video support. PANOMAX's general imprint restricts unauthorized copying/framing. [Shipyard](https://helsinkishipyard.fi/fi/helsinki/), [distribution](https://www.panomax.com/en/content-distribution), [imprint](https://www.panomax.com/en/imprint)
- **Klaus K:** Baltic Live Cam describes central-city live video. The reviewed pages provide no reusable camera-coordinate/API contract or third-party embedding grant. Ask for the provider's embed and conditions. [Camera operator page](https://balticlivecam.com/cameras/finland/helsinki/helsinki-view-klaus-k-hotel/), [business offering](https://balticlivecam.com/business/)
- **SkylineWebcams:** use the operator's sharing links; its terms expressly restrict copying frames and streams and require written authorization for other reuse. No public API or refresh guarantee was verified. [Provider terms](https://www.skylinewebcams.com/en/terms-of-use.html)
- **Exactum:** the advertised one-minute JPEG at /u/tkt_cam/exactum.jpg returned HEAD 200, but Last-Modified was **14 December 2018 10:16:05 UTC**. Treat the page's cadence as historical documentation, not verified current operation. Precise coordinates and reuse conditions need operator confirmation. [University page](https://www.cs.helsinki.fi/Exactum-kamera/)
- **VuosaariWebcam:** the Cirrus west view, two other directions and copyright notice are verified. Its public page and archive do not establish an API, authorized republishing or a guaranteed interval. Vuosaari also requires scene coverage expansion. [Operator](https://www.vuosaariwebcam.com/)
- **City / Suomenlinna / utility:** no documented open Helsinki municipal/HSY/Helen webcam API was identified in this search. Helsinki Channel supplies broadcasts/videos, which does not establish a continuous geolocated camera feed. The historically referenced Suomenlinna /webcam/ address returned **404**. This is a search result, not proof that no private or new camera exists. [Helsinki Channel official service listing](https://www.suomi.fi/services/eservice/helsinki-channel-website-city-of-helsinki-culture-and-leisure-division/850b2a8d-0ed5-4760-9e86-c5814f1c3147), [Suomenlinna current site](https://suomenlinna.fi/en/)

Windy is an approved aggregation route, not an open-data replacement. Its contract requires visible linked attribution, guards the API key, prohibits redistribution and significant continuous scanning, and does not guarantee particular cameras. Free image URLs expire after 15 minutes; Professional URLs after 24 hours. A registered-key coverage trial was not performed. [Windy terms](https://account.windy.com/agreements/windy-api-webcams-terms-of-use), [pricing](https://api.windy.com/webcams/pricing), [documentation](https://api.windy.com/webcams/docs)

## Smallest integration for this repository

The following is proposed scope, based on the current codebase inspection by the coordinating agent; no code was changed.

1. Add a distinct camera catalogue/API/cache, following the fixed-source pending-request/cache pattern in src/lib/server/observations.ts. Keep cameras separate from numeric measurement observations.
2. Filter to existing RELEASE_BOUNDS, expose station/preset IDs, labels, coordinates, source, capture time and availability. Validate upstream records and allowlist weathercam.digitraffic.fi; accept IDs, not arbitrary proxy URLs.
3. Show six ground markers and one selected-image panel. Reuse scene projection/selection and the image/credit/dialog patterns in BuildingPhoto.svelte. Load the selected full image on demand; thumbnails can serve discovery.
4. Reuse byte caps, timeouts and cache patterns from src/lib/server/building-photo.ts and io.ts. However, the generic request helper rejects non-2xx, including 304: conditional fetching needs explicit 304 handling.
5. Cache metadata infrequently and respect the ten-minute image cadence. Show measuredTime and stale/error states; do not renew capture time after a failed request or successful 304.
6. Add focused checks for bounds, preset validation, 304 reuse, stale capture times and provider failure. No runtime dependency is needed for JPEG display.
7. Add South Harbour through a separate, user-opened supported player after verifying live playback, embedding permission/status and deployed browser policy. Keep an external operator link available.

Avoid a video relay, archive, arbitrary URL proxy, computer-vision features and calibrated image overlays in the first version. The useful core is **six geolocated, timestamped snapshots plus an optional harbour player**.

## What remains unverified

- Image contents/visibility, recurring availability, night/weather usefulness and multi-day uptime were not visually or longitudinally tested.
- Port, PANOMAX, Baltic and other video playback was not tested in the deployed browser; HTML/oEmbed success is insufficient.
- No operator was contacted, no key/paid plan was created, and no additional reuse license was negotiated.
- Raw probe files were temporary local evidence; counts and freshness should be rechecked at implementation because cameras and players can change.
