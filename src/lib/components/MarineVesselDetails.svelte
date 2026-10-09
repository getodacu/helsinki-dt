<script lang="ts">
  import type { Vehicle } from '#lib/types.ts';
  import { KNOTS_TO_METRES_PER_SECOND, marineHeading, marineTypeLabel, marineNavigationLabel, type MarineStatus } from '#lib/marine.ts';
  import { trafficIsStale, trafficShouldRemove } from '#lib/traffic.ts';
  import { formatDate, label, marineSourceLabel } from '#lib/inspection.ts';
  import { vehicleLabel } from '#lib/rail.ts';
  let { vehicle, source, connected, now, removed = false }: { vehicle: Vehicle; source?: MarineStatus; connected: boolean; now: number; removed?: boolean } = $props();
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
    <div><dt>Course over ground</dt><dd>{degrees(marine?.courseOverGroundDegrees)}</dd></div>
    <div><dt>True heading</dt><dd>{degrees(vehicle.headingDegrees)}</dd></div>
    <div><dt>Marker orientation</dt><dd>{marineHeading(vehicle) === null ? 'Unknown · no direction cue' : vehicle.headingDegrees !== null ? 'Reported true heading' : 'Course while moving'}</dd></div>
    <div><dt>Position reported</dt><dd>{formatDate(vehicle.reportedAt)}<small>{age(vehicle.reportedAt)} · {expired ? 'expired / out of coverage' : trafficIsStale(vehicle, now) ? 'stale report' : 'fresh report'}</small></dd></div>
    <div><dt>Position received</dt><dd>{formatDate(vehicle.receivedAt)}</dd></div>
    <div><dt>Metadata updated</dt><dd>{formatDate(marine?.metadataReportedAt)}<small>{age(marine?.metadataReportedAt)}</small></dd></div>
    <div><dt>Metadata received</dt><dd>{formatDate(marine?.metadataReceivedAt)}</dd></div>
    <div><dt>Marine source</dt><dd>{connected ? '' : 'Browser paused / disconnected · '}{marineSourceLabel(source)}</dd></div>
    <div><dt>Position accuracy</dt><dd>{marine?.positionAccuracy == null ? 'Unknown' : marine.positionAccuracy ? 'High reported accuracy' : 'Low reported accuracy'}</dd></div>
    <div><dt>Integrity monitoring</dt><dd>{marine?.raim == null ? 'Unknown' : marine.raim ? 'In use' : 'Not in use'}</dd></div>
    <div><dt>Position</dt><dd>{vehicle.latitude?.toFixed(5) ?? 'Unknown'}, {vehicle.longitude?.toFixed(5) ?? 'Unknown'}</dd></div>
    <div><dt>Position quality</dt><dd>{vehicle.quality.filter(flag => !flag.startsWith('metadata-')).map(label).join(', ') || 'No additional flags supplied'}</dd></div>
    <div><dt>Metadata quality</dt><dd>{vehicle.quality.filter(flag => flag.startsWith('metadata-')).map(label).join(', ') || 'No additional flags supplied'}</dd></div>
  </dl>
  {#if positionError}<p class="notice">Position source: {positionError}</p>{/if}
  {#if source?.metadataError}<p class="panel-note">Metadata unavailable: {source.metadataError}. A valid position remains usable.</p>{/if}
  <p class="panel-note">Schematic marker at the reported sea position. Display delay: 10 seconds of received reports; reduced motion shows the latest accepted position. Reports stop at the last accepted fix, with no movement prediction. Metadata updates do not refresh position age.</p>
</div>
