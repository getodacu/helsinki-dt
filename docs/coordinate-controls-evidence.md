# Senate Square coordinate controls

Retrieved from the City of Helsinki Service Map API on 2026-10-08 at 11:00:52 UTC. Each response is a GeoJSON Point in longitude, latitude order (WGS84 / EPSG:4326). The fixture records the official Service Map result name and point; the `gmlId` associates that independently sourced place with the matching building candidate in the Helsinki 3D sample.

| Control | Service Map result | Official address | Longitude, latitude | Building GMLID |
| --- | ---: | --- | --- | --- |
| Helsinki City Hall | 28473 | Pohjoisesplanadi 11–13 | 24.952913, 60.168037 | `BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e` |
| Helsinki Cathedral | 43181 | Unioninkatu 29 | 24.952229, 60.170345 | `BID_4d58c091-9185-42fd-a8be-78f1f6eb891f` |
| National Library of Finland | 21242 | Unioninkatu 36 | 24.950335, 60.170370 | `BID_cf43c58b-5f52-4da0-9e2a-2cb440430d86` |

The API query URLs are stored with each record in [`tests/fixtures/coordinate-controls.json`](../tests/fixtures/coordinate-controls.json). The Service Map coordinates are representative service/place points, not promised building centroids. In particular, City Hall's point is about 34 m south of the sample geometry center, while the Cathedral and Library points are each within about 5 m of their geometry centers. Validate a control point against its building footprint (allowing a point at an entrance) rather than requiring centroid equality.

Official City sources document the Service Map and Helsinki 3D/geospatial services: [Helsinki Service Map dataset metadata](https://kartta.hel.fi/paikkatietohakemisto/pth/?id=92), [Helsinki 3D city model metadata](https://kartta.hel.fi/paikkatietohakemisto/pth/?id=306), and [City of Helsinki open geographic data](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/make-better-use-of-geospatial-data/open-geographic-data). The city identifies ETRS-GK25 (EPSG:3879) as its maintained horizontal CRS and N2000 as its height system; the Service Map API supplies the independent WGS84 controls used here.
