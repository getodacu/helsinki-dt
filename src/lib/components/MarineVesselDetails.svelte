<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Vehicle } from '#lib/types.ts';
  import { KNOTS_TO_METRES_PER_SECOND, marineTypeLabel, marineNavigationLabel, type MarineStatus } from '#lib/marine.ts';
  import { trafficIsStale, trafficShouldRemove } from '#lib/traffic.ts';
  import { vehicleLabel } from '#lib/rail.ts';
  let { follow, vehicle, source, now, removed = false }: { follow?: Snippet; vehicle: Vehicle; source?: MarineStatus; now: number; removed?: boolean } = $props();
  let marine = $derived(vehicle.marine);
  let expired = $derived(removed || trafficShouldRemove(vehicle, now));
  let positionError = $derived(source && 'positionError' in source ? source.positionError : source?.error);
  const age = (at: string | null | undefined) => at ? `${Math.max(0, Math.floor((now - Date.parse(at)) / 1000))} s ago` : 'Unknown';
  const degrees = (value: number | null | undefined) => value == null ? 'Unknown' : `${value.toFixed(1)}°`;
</script>

<div data-marine-inspector={marine?.mmsi ?? vehicle.vehicleId}>
  <span class="eyebrow">FINTRAFFIC / AIS SHIP</span><h3>{vehicleLabel(vehicle)}</h3>
  {#if expired}<p class="notice">This ship report left the current coverage or expired. Its last reported identity and dated position remain here.</p>
  {:else if trafficIsStale(vehicle, now)}<p class="notice">Stale position. Held at the last accepted coordinates.</p>{/if}
  <dl class="properties">
    <div><dt>Type</dt><dd>{marineTypeLabel(marine?.shipType ?? null)}</dd></div>
    <div><dt>Navigation</dt><dd>{marineNavigationLabel(marine?.navigationStatus ?? null)}</dd></div>
    <div><dt>MMSI</dt><dd>{marine?.mmsi ?? vehicle.vehicleId}</dd></div>
    <div><dt>IMO</dt><dd>{marine?.imo ?? 'Unknown'}</dd></div>
    <div><dt>Call sign</dt><dd>{marine?.callSign ?? 'Unknown'}</dd></div>
    <div><dt>Speed</dt><dd>{vehicle.speedMetresPerSecond === null ? 'Unknown' : `${(vehicle.speedMetresPerSecond / KNOTS_TO_METRES_PER_SECOND).toFixed(1)} kn`}</dd></div>
  </dl>
  {@render follow?.()}
  <dl class="properties">
    <div><dt>Course over ground</dt><dd>{degrees(marine?.courseOverGroundDegrees)}</dd></div>
    <div><dt>True heading</dt><dd>{degrees(vehicle.headingDegrees)}</dd></div>
    <div><dt>Position reported</dt><dd>{age(vehicle.reportedAt)}</dd></div>
  </dl>
  {#if positionError}<p class="notice">Position source: {positionError}</p>{/if}
  {#if source?.metadataError}<p class="panel-note">Metadata unavailable: {source.metadataError}</p>{/if}
</div>
