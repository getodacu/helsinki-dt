What this change does: The release adds native modal source focus, inspector/sheet focus and a data/search fallback when WebGL cannot start. The catalog endpoint shares gzip compression for one validated state in the documented single Node process.

## Should fix

1. **An explicitly forbidden response encoding is sent** (`src/routes/api/energy/catalog/+server.ts:17`). The identity fallback always returns HTTP 200 JSON. A valid `Accept-Encoding: identity;q=0, gzip;q=0, *;q=0` or `identity;q=0, br;q=1` request excludes identity and permits no supported representation, but the endpoint still sends an identity body. Return an empty HTTP 406 response when identity is excluded and gzip is unavailable; add one assertion. If skipped, clients that require a specific encoding receive a representation they said they cannot accept. Normal browser-generated gzip requests are unaffected.

## Checked

The edge was reproduced by importing the actual GET handler with a controlled unavailable catalog (no upstream requests). Existing `tests/energy-catalog-http.test.ts` passed 1/1; it covers gzip/wildcard quality, explicit gzip exclusion, concurrent responses, state replacement and invalid parameters, but not identity exclusion. Initial isolated production artifact gzip delivery passed with the full real ready catalog, 843,087 encoded bytes and correct Vary header.

UI code review covered native dialog showModal/close/restored trigger, Escape isolation from selection clearing, changed-selection inspector focus, clear-selection focus, mobile sheet trigger focus, skip link, search/list fallback, live fallback selected-vehicle update, reduced-motion styles and current city-workspace min-height fix. No additional concrete UI defect found. Runtime modules were not edited. Review assumes one process and ordinary browser clients, with protocol edge inputs checked separately.

## Resolution

Finding 1 was fixed in the parent gzip endpoint. Focused HTTP/packaging tests pass 2/2. The final compiled runtime candidate `a523eab230af` returned empty HTTP 406 for both reproduced headers before and after a real isolated process restart at 2026-10-08T15:18:57.651Z. Normal real-catalog gzip remained ready (843,087 encoded bytes). Its server inventory differs from the initial runtime and matches the active soak.

Verdict: Ship the reviewed changes; remaining milestone verification is tracked by the parent.
Not checked: Final browser/device focus, assistive-technology behavior and the upcoming rebuilt artifact; those remain the parent/UI verification task.
