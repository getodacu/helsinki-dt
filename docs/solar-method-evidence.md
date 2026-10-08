# Original Helsinki Atlas solar layer — method and export vintage

Evidence retrieved on 8 October 2026 from original City of Helsinki endpoints and primary method documentation. This addresses the original Atlas solar layer, which retains semantic building identities. HSY's separate photovoltaic suitability/yield layer is a different source; its assumptions must not be applied to these records.

## Meaning and units

The City's [solar application configuration](https://kartta.hel.fi/3d/solar/config.json) names `globalRadYear` as annual global radiation in **kWh**, and its [chart code](https://kartta.hel.fi/3d/solar/templates/custom.js) labels monthly and annual global/direct/diffuse values in kWh. These are modeled incident solar energy received by building roof and wall surfaces and aggregated to the building. They are not installed capacity in kW or photovoltaic electrical generation. Irradiation per surface area, where supplied separately, uses kWh/m²; it must never share a scale with total kWh.

No panel suitability area, installed system, efficiency conversion, live output or financial claim is derived from incident radiation. Where such fields are absent, the interface says they are absent.

## Method

The [Technical University of Munich method description](https://www.asg.ed.tum.de/en/gis/research-areas/cities-and-energy/) explicitly identifies the official Helsinki solar atlas as an application of its solar tool. It computes direct and diffuse irradiation over three-dimensional CityGML surfaces, including roof and wall orientation; shading and sky visibility can account for surrounding modeled objects and topography. Monthly and annual results can be aggregated to buildings. Its location calibration uses remote-sensing data.

The City's [17 December 2018 account of Atlas development](https://kaupunkitieto.hel.fi/fi/helsingin-energiatietojen-esittaminen-3d-kaupunkimallissa-tuo-tyokaluja-ilmastonmuutoksen-hillintaan) independently attributes the roof/wall monthly and annual solar calculation to TUM and records the Atlas launch in February 2018. The exact meteorological reference year, computation date and vegetation/terrain settings for this export are not declared in the inspected payloads; those limits stay explicit. General tool capabilities are not proof that a particular optional setting was used.

## Dated export

A live request to [the original solar tileset](https://kartta.hel.fi/3d/data/buildings_solar/tileset.json) returned `Last-Modified: Tue, 08 Aug 2017 10:58:49 GMT`. The original chart script's header is 8 August 2017; the solar application HTML is dated 5 February 2018. Therefore **2017-08-08 is the verified HTTP export modification vintage**, not a claimed weather year or simulation timestamp. Every prepared generation also retains its current retrieval time, URLs and content checksums. A later different export must be revalidated.

Small checked-in [metadata evidence](../tests/fixtures/atlas-solar-method-evidence.json) records these semantics and SHA-256 values. Full official configuration, tileset and chart code are retained in ignored `.cache/task-d-solar-*` files; the reproducible preparation captures its own matching source metadata. Exact identity associations, per-dataset counts and source records are documented in [energy/solar evidence](energy-solar-evidence.md).
