# Milestone E Release readiness

**Status:** Complete — verified local release 8 October 2026; [results](../milestone-results/E.md)  
**Depends on:** B, C, and D acceptance gates  
**Task:** Verify the complete Helsinki Lens experience, prepare reproducible production operation, and document release evidence. Follow [the implementation plan](../implementation-plan.md).

## Outcome

A production build can be installed and operated with documented data preparation, source attribution, resource requirements, and failure behavior. Users can complete the central journey with pointer or keyboard on the supported viewports.

## Implementation steps

1. Review the whole journey and resolve inconsistent loading, empty, stale, unavailable, and unknown states. Ensure selection, follow mode, source drawers, filters, charts, and camera presets interact consistently. Retain original source timing and coverage labels throughout.
2. Complete keyboard navigation, focus handling for drawers/dialogs, readable labels, contrast, touch targets, and reduced motion. Provide a searchable/list-based alternative for essential 3D picking. When WebGL is unavailable, preserve accessible data/search where feasible and explain the rendering limitation.
3. Validate responsive layout on a desktop viewport and narrow mobile portrait/landscape views. Exercise current Chromium, Firefox, and Safari where available; document actual versions and any untested browser. Prevent control overlap and selection panels obscuring all meaningful scene content.
4. Run the relevant deterministic integration tests and production build. Add only tests needed for uncovered critical behavior. Keep endpoint smoke tests separate so provider outages do not make routine regression tests nondeterministic.
5. Re-run B's performance workloads with all layers and inspectors available. Check large building chunks, dense vehicle views, repeated selections, disabled layers, and tab backgrounding. Run a 30-minute production-build soak with stable client counts and inspect memory, reconnects, and queue limits.
6. Exercise failures deliberately: HSL disconnect, FMI timeout/malformed response, energy outage, missing chunk, cache corruption, process restart, and network recovery. Preserve valid last-known data with dates, expire vehicles correctly, and surface useful status without exposing raw sensitive payloads.
7. Document the production Node command, environment variables, static assets, writable cache locations, single-process assumption, SSE proxy buffering/timeout settings, refresh commands, logs, restart procedure, and rollback. Separate process health from individual source health so an upstream outage does not create a restart loop.
8. Verify that no Ocean Lens branding, analytics configuration, credentials, maritime source descriptions, or obsolete geometry remain. Review attribution against the actual shipped datasets, models, fonts, and imagery. Include acquisition/vintage details and required notices in the product.
9. Prepare a versioned release bundle or documented build artifact including matching asset manifests. Validate installation into a clean local/staging directory and a restart with preserved caches. Document disk/memory needs from measurements, not estimates presented as facts.
10. Record a final live smoke check during relevant transport service: mode samples, environmental source dates, energy availability, and source connection states. Capture representative screenshots and a concise walkthrough. Public deployment is a separate action unless a destination and deployment request have been supplied; in that case verify the deployed URL and rollback as part of that authorized work.

## Deliverables

- Verified production package with matching generated assets and attribution.
- `README.md` for installation, preparation, run commands, and product limitations.
- `docs/operations.md` for feed/cache behavior, refresh, proxy setup, monitoring, recovery, and rollback.
- `docs/milestone-results/E.md` with checks, browser matrix, performance results, source times, and remaining release blockers.

## Acceptance checklist

- [x] The tram → delay → conditions → building → energy/solar journey succeeds in the production build.
- [x] The same essential journey is possible by keyboard, with visible focus, usable dialogs, and reduced-motion behavior.
- [x] Desktop and narrow-screen layouts are usable; tested browsers and any exceptions are recorded.
- [x] Type checking, meaningful regression/integration tests, and production build pass.
- [x] B's performance targets are rechecked with the final assets and workloads; failures are resolved or recorded as explicit unresolved targets.
- [x] Provider interruptions, stale data, invalid payloads, cache failure, process restart, and recovery behave as specified.
- [x] Installation and startup work from documented instructions with explicit credentials/data prerequisites and no dependence on another workspace's untracked files.
- [x] Publicly distributed assets have source attribution and documented applicable terms; credentials remain server-only.
- [x] No unrequested analytics or unrelated Ocean Lens configuration is shipped.
- [x] All required earlier milestone gates are resolved. Remaining coverage limits are visible in the product and release notes.
- [x] Release readiness and actual deployment are reported separately; a public deployment is claimed only if directly verified.

## Verification and final handoff

Use the final asset manifest and a fixed fixture dataset for reproducible end-to-end checks. Record live smoke outcomes separately, including service hours and observation age. Give the next operator exact preparation/start/refresh/recovery commands and the location of writable caches. The final handoff states what was shipped, how it was checked, and which source coverage limits users will encounter.

## Scope boundary

Do not add accounts, historical replay, predictive models, automated deployment infrastructure, or distributed scaling as release polish. Resolve defects in the agreed experience and leave larger additions as separate future tasks.
