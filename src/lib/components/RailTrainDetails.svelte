<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Vehicle } from '../types.ts';
  import { railDelay, type RailJourney, type RailResult } from '../rail.ts';
  import { formatDate, delayLabel, label } from '../inspection.ts';
  let { follow, vehicle, journey, now, loading = false, error = '' }: {
    follow?: Snippet; vehicle: Vehicle; journey: RailResult<RailJourney> | null; now: number; loading?: boolean; error?: string
  } = $props();
  let rail = $derived(journey?.data?.summary ?? vehicle.rail!);
  let event = $derived(rail.nextEvent);
  let timetableStale = $derived(rail.timetableStale || journey?.state === 'stale' || !!rail.timetableAt && now - Date.parse(rail.timetableAt) >= 60_000);
</script>

<span class="eyebrow">FINTRAFFIC / {label(rail.category).toUpperCase()}</span>
<h3>{rail.label} <span class="rail-destination">→ {rail.destination ?? 'Destination unavailable'}</span></h3>
{#if rail.cancelled}<p class="notice">Cancelled service. A reported vehicle position does not imply passenger service.</p>{/if}
{#if loading}<p class="panel-note">Loading train timetable…</p>{/if}
{#if error || journey?.error}<p class="notice">Timetable {journey?.data ? 'refresh unavailable' : 'unavailable'} · {error || journey?.error}</p>{/if}
<dl class="properties">
  <div><dt>Train</dt><dd>{rail.trainNumber}</dd></div>
  <div><dt>Speed</dt><dd>{vehicle.speedMetresPerSecond === null ? 'Unknown' : `${(vehicle.speedMetresPerSecond * 3.6).toFixed(0)} km/h`}</dd></div>
</dl>
{@render follow?.()}
<dl class="properties">
  <div><dt>Position received</dt><dd>{Math.max(0, Math.floor((now - Date.parse(vehicle.receivedAt)) / 1000))} s ago</dd></div>
</dl>
{#if event}
  <h4>Next {event.type === 'ARRIVAL' ? 'arrival' : 'departure'} · {event.stationName}</h4>
  <dl class="properties">
    <div><dt>Scheduled</dt><dd>{formatDate(event.scheduledAt)}</dd></div>
    <div><dt>Estimated</dt><dd>{event.estimatedAt ? formatDate(event.estimatedAt) : 'No estimate supplied'}</dd></div>
    <div><dt>Platform</dt><dd>{event.platform ?? 'Not supplied'}</dd></div>
    <div><dt>Delay at {event.stationName}</dt><dd class:late={(railDelay(event) ?? 0) > 60}>{timetableStale ? 'Unknown · timetable stale' : delayLabel(railDelay(event))}</dd></div>
  </dl>
{/if}
{#if !rail.departureDate}<p class="notice">Undated position: timetable and route cannot be linked safely.</p>{/if}
<style>.rail-destination { display: block; margin-top: 6px; color: var(--muted); font-size: 13px; font-weight: 400; }</style>
