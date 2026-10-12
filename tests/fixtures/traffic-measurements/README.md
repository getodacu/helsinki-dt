# Traffic measurement fixtures

Read-only captures from the City of Helsinki LIDO-TIKU API, 11 October 2026.
Data: City of Helsinki, https://lidotiku.api.hel.fi/api/, CC BY 4.0.
Payloads are unchanged apart from JSON indentation. Tests mutate copies explicitly.

- `sources.json`: `/api/metadata/sources/?language=en`
- `hel-counters.json`: `/api/counters/?source=HEL%20LAM&page_size=1000`
- `eco-counters.json`: `/api/counters/?source=EcoCounter&page_size=1000`
- `hel-observations.json`: `/api/observations/?counter=6373&start_date=2026-10-10&end_date=2026-10-10&page_size=10`
- `eco-latest.json`: `/api/observations/?counter=100008546&page_size=1`

The EcoCounter capture demonstrates that observations exist even when the
catalog reports null observation dates and `dataReceived: false`. Observation
pages contain provider pagination URLs; tests must not fetch those URLs.
