<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Vehicle } from '../types.ts';
  import { railDelay, type RailJourney, type RailResult } from '../rail.ts';
  import { formatDate, delayLabel, label } from '../inspection.ts';
  import { trafficAge, trafficIsStale } from '../traffic.ts';
  let { follow, vehicle, journey, now, removed = false, loading = false, error = '' }: {
    follow?: Snippet; vehicle: Vehicle; journey: RailResult<RailJourney> | null; now: number; removed?: boolean; loading?: boolean; error?: string
  } = $props();
  let rail = $derived(journey?.data?.summary ?? vehicle.rail!);
  let event = $derived(rail.nextEvent);
  let timetableStale = $derived(rail.timetableStale || journey?.state === 'stale' || !!rail.timetableAt && now - Date.parse(rail.timetableAt) >= 60_000);
</script>

<span class="eyebrow">FINTRAFFIC / {label(rail.category).toUpperCase()}</span>
<h3>{rail.label} <span class="rail-destination">→ {rail.destination ?? 'Destination unavailable'}</span></h3>
{#if removed}<p class="notice">This train left the area or its position expired. Its last identity is retained.</p>
{:else if trafficIsStale(vehicle, now)}<p class="notice">Stale position · holding the last reported location.</p>{/if}
{#if rail.cancelled}<p class="notice">Cancelled service. A reported vehicle position does not imply passenger service.</p>{/if}
{#if timetableStale}<p class="notice">Timetable is stale. Times below are the last available estimates; current delay is unknown.</p>{/if}
{#if loading}<p class="panel-note">Loading train timetable…</p>{/if}
{#if error || journey?.error}<p class="notice">Timetable {journey?.data ? 'refresh unavailable' : 'unavailable'} · {error || journey?.error}</p>{/if}
<dl class="properties">
  <div><dt>Train / date</dt><dd>{rail.trainNumber} · {rail.departureDate ?? 'Unknown departure date'}</dd></div>
  <div><dt>Operator / type</dt><dd>{rail.operator ?? 'Unknown'} · {rail.trainType ?? 'Unknown'}</dd></div>
  <div><dt>Journey</dt><dd>{rail.origin ?? 'Unknown origin'} → {rail.destination ?? 'Unknown destination'}</dd></div>
  <div><dt>Speed</dt><dd>{vehicle.speedMetresPerSecond === null ? 'Unknown' : `${(vehicle.speedMetresPerSecond * 3.6).toFixed(0)} km/h`}</dd></div>
</dl>
{@render follow?.()}
<dl class="properties">
  <div><dt>Position reported</dt><dd>{formatDate(vehicle.reportedAt)}<small>{Math.floor(trafficAge(vehicle, now) / 1000)} s ago</small></dd></div>
  <div><dt>Position received</dt><dd>{formatDate(vehicle.receivedAt)}</dd></div>
  <div><dt>Timetable checked</dt><dd>{formatDate(journey?.retrievedAt ?? rail.timetableAt)}</dd></div>
</dl>
{#if event}
  <h4>Next stop · {event.stationName}</h4>
  <dl class="properties">
    <div><dt>Scheduled</dt><dd>{formatDate(event.scheduledAt)}</dd></div>
    <div><dt>Estimated</dt><dd>{event.estimatedAt ? formatDate(event.estimatedAt) : 'No estimate supplied'}</dd></div>
    <div><dt>Platform</dt><dd>{event.platform ?? 'Not supplied'}</dd></div>
    <div><dt>Delay at {event.stationName}</dt><dd class:late={(railDelay(event) ?? 0) > 60}>{timetableStale ? 'Unknown · timetable stale' : delayLabel(railDelay(event))}</dd></div>
  </dl>
{:else}<p class="panel-note">Next stop and delay are unavailable.</p>{/if}
{#if journey?.data?.events.length}
  <details><summary>Journey timetable · Helsinki time</summary><ol class="route-stop-list rail-timetable">
    {#each journey.data.events.filter(event => event.stopping) as row, index (`${row.stationCode}/${row.type}/${index}`)}
      <li><strong>{row.stationName} · {row.type === 'ARRIVAL' ? 'Arrival' : 'Departure'}{row.cancelled ? ' · Cancelled' : ''}</strong>
        <span>Scheduled {formatDate(row.scheduledAt)}</span>
        <span>{row.actualAt ? `Actual ${formatDate(row.actualAt)}` : row.estimatedAt ? `Estimated ${formatDate(row.estimatedAt)}` : 'Estimate unavailable'}{row.platform ? ` · Platform ${row.platform}` : ''}</span>
      </li>
    {/each}
  </ol></details>
{/if}
{#if !rail.departureDate}<p class="notice">Undated position: timetable and route cannot be linked safely.</p>{/if}
<style>.rail-destination { display: block; margin-top: 6px; color: var(--muted); font-size: 13px; font-weight: 400; } .rail-timetable { max-height: 340px; overflow: auto; }</style>
