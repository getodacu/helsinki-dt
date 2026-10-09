# Marine decoder fixtures

Small unmodified excerpts from the read-only probes documented in
[the marine feasibility report](../../../docs/digitraffic-marine-feasibility.md), 9 October 2026.
Data: Fintraffic / Digitraffic, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
No source payload was synthesized. Tests explicitly mutate copies for invalid values, motion,
clock boundaries and revisions; those mutations are synthetic and are not observed vessel reports.

| File | Source | Capture / reference |
| --- | --- | --- |
| `rest-location.json` | `https://meri.digitraffic.fi/api/ais/v1/locations?latitude=60.18&longitude=25.0&radius=15` | HTTP Date `2026-10-09T19:56:17Z` |
| `rest-metadata.json` | `https://meri.digitraffic.fi/api/ais/v1/vessels` | HTTP Date `2026-10-09T19:56:55Z`; exact MMSI match to the location excerpt |
| `mqtt-location.json` | `wss://meri.digitraffic.fi:443/mqtt`, topic included in fixture | `2026-10-09T19:57:54.346Z`–`19:58:24.391Z` |
| `mqtt-metadata.json` | Same broker, topic included in fixture | Same bounded 30-second session |
| `mqtt-status.json` | Same broker, `vessels-v2/status` | Same bounded 30-second session |

The MQTT position excerpt is outside the product's Helsinki bounds; validation and geographic
filtering are separate. REST timestamps retain milliseconds, MQTT position/status time is seconds,
and both metadata sources retain milliseconds.
