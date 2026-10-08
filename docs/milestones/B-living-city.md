# Milestone B Living city

**Status:** Complete — 8 October 2026  
**Depends on:** A core data gate; resolve any outstanding ferry coverage before completing this task  
**Task:** Render the scoped Helsinki city and moving HSL transport with dependable selection, source status, and performance. Follow [the implementation plan](../implementation-plan.md).

## Outcome

Open the application to a recognizable central Helsinki scene, orbit the camera, select a real building, and watch real trams, buses, and ferries move. A disconnected feed must visibly stop being live.

## Implementation steps

1. Extend A's asset preparation to the initial release area using semantic buildings, suitable terrain, shoreline/water, and a restrained road/rail context. Verify each added base layer's terms. Preserve islands and distinguish the sea surface from ground elevation. Use flat metric buildings without distortion; omit unknown elevations rather than pretending they were surveyed.
2. Implement the scene lifecycle, camera controls, responsive resize, and resource disposal. Use a local metric origin and validated coordinate conversion. Chunk and batch buildings to control transfer and draw calls, while keeping an ID lookup for selection. Load the first district promptly and additional chunks by view/distance.
3. Add building hover/selection, outline/highlight, and a basic identity panel. Geometry picking must resolve the original building consistently, including buildings split across render batches. Retain selected identity while chunks change; clear selection explicitly if the object leaves available scope.
4. Create lightweight instanced tram, bus, and ferry representations with mode colours and legible scale. Vehicles remain at reported coordinates. Ground vehicles follow the rendered terrain; ferries follow the water surface. Record any display scale exaggeration. Detail models are optional and must not delay functionality.
5. Implement one demand-driven MQTT connection per server process, bounded subscriptions, normalized latest-vehicle state, reconnect backoff, idle shutdown, and invalid/out-of-order report rejection. Apply A's verified identity rules. Update position age only from position reports.
6. Add a traffic snapshot and SSE stream. Coalesce changes at approximately one-second intervals, include removals/status, and provide a full snapshot when reconnecting so clients recover without a replay log. Limit slow-client buffering and clean up disconnected clients. Send heartbeats and document proxy requirements.
7. Interpolate between received positions with a short bounded buffer. Never continue extrapolating movement after reports stop. Snap across implausible jumps or long gaps, rather than drawing a vehicle through buildings. Respect reduced motion. Vehicle follow mode can be canceled by user camera interaction.
8. Implement mode toggles and camera presets for City Centre, Harbour, and Suomenlinna. Filter visible objects without creating a new upstream subscription per browser. Suspend unnecessary browser work when hidden and resume from a current snapshot.
9. Measure initial load, memory trend, frame rate, draw calls, asset sizes, and update latency on a documented baseline. Optimize the measured bottleneck through chunking/batching before changing renderers.

## Initial operational policy

Start with a 30-second stale threshold and a 120-second removal threshold for vehicle positions, evaluated from report time in both server and browser. A's cadence measurements may justify mode-specific thresholds; record any change and its reason. Stale vehicles hold position and show their last report time. Removing a selected vehicle leaves an explanation rather than an unexplained empty inspector. All thresholds are application policies, not provider guarantees.

## Deliverables

- City scene, spatial asset loader, building identity selection, and three camera presets.
- HSL adapter, singleton feed lifecycle, snapshot/SSE endpoints, and instanced fleet renderer.
- Visible source connection and stale-report states.
- `docs/milestone-results/B.md` with performance baseline and real mode-coverage evidence.

## Acceptance checklist

- [x] Initial city geometry includes the centre, harbour, and intended ferry corridor, with successful control-point alignment.
- [x] Selecting at least ten sampled buildings returns their correct IDs and available basic attributes.
- [x] Live tram, bus, and HSL ferry reports render during sampled service, with mode filters and accurate last-report times. An unsampled mode is documented as an open feature.
- [x] Smooth movement uses received reports only; reduced-motion users receive non-animated position changes.
- [x] Two browser clients share one upstream connection; closing the last client eventually releases it.
- [x] Feed interruption, resumption, browser reconnection, tab hiding, and stale/removal thresholds work without simulated replacements or duplicate vehicles.
- [x] The representative district reaches the shared initial-load, frame-rate, and controlled update-latency targets, or the unmet target remains open with measurements.
- [x] A 30-minute soak under the representative fleet and a separate twice-peak fixture workload show no unbounded memory or client queue growth.

Acceptance evidence, the final performance baseline and the C handoff are recorded in [Task B results](../milestone-results/B.md).

## Verification

Test malformed and duplicate messages, zero/missing coordinates, invalid timestamps, operator identity collisions, stale metadata updates, vehicle removals, and out-of-order delivery. Use deterministic timers for reconnect and expiry behavior. Test multiple SSE subscribers and slow/disconnected clients. Verify picking across geometry batches and disposal on navigation. Keep synthetic load visibly confined to tests.

Manually inspect dense streets, waterfront terrain, and the ferry corridor. Log provider report age separately from internal transport latency so a delayed source is not mistaken for a slow browser.

## Scope boundary and handoff

Do not add weather surfaces, detailed energy inspectors, route planning, or replay. Pass C the selected-feature contract, cancellation rules, source status model, stable scene callbacks, and measured asset budgets. The existing scene and feed remain the shared foundation for later tasks.
