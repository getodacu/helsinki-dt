# Geometry and energy fixtures

These compact fixtures support offline regression tests. They are not a substitute for live source probes.

- `building-cityhall.json`: two actual City Hall source records, semantic attributes and one real converted surface per record from the 2019 Helsinki 3D CityGML archive. Attribution: City of Helsinki, CC BY 4.0. Its provenance includes the immutable archive SHA-256 and actual download file timestamp.
- `coordinate-controls.json`: independently retrieved official Helsinki Service Map locations. See `docs/coordinate-controls-evidence.md`.
- `control-building-extents.json`: actual converted mesh extrema and source semantic attributes for the three named controls. Tests reconstruct bounding extents only; these are not building surfaces. Attribution: Helsinki 3D / City of Helsinki, CC BY 4.0.
- `nuuka-leijonakortteli.json`: real property metadata, two daily readings, and the corresponding four actual geometry identities. Attribution: City of Helsinki municipal energy / Nuuka, CC BY 4.0. Membership covers one exact, one ambiguous and one missing national identifier.
- `modeled-cityhall.json`: source row 9645 and matching metadata descriptions from the published 2020-10-21 modeled heating workbook. Attribution: City of Helsinki Energy and Climate Atlas, CC BY 4.0. The energy unit remains unknown.
- `energy-streaming.xlsx`: a synthetic parser fixture with a real City Hall identifier, a null reading and an explicitly synthetic unrelated record. Entry ordering matches verified provider workbooks. It asserts null/identity/filtering behavior; its numeric test value is not an energy observation.

Live URLs and publication terms are documented in `docs/geometry-energy-evidence.md`. Source fixture timestamps preserve actual retrieval evidence and are independent of scenario/calculation dates.
