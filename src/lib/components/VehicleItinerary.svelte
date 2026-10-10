<script lang="ts">
  import { itineraryStopLabel, itineraryTime, type VehicleItinerary } from '#lib/itinerary.ts';
  import { MODE_COLOURS } from '#lib/live-fleet.ts';
  let { itinerary, loading = false, error = '' }: { itinerary: VehicleItinerary; loading?: boolean; error?: string } = $props();
</script>

<section class="vehicle-itinerary" aria-label="Journey itinerary" style:--route-colour={MODE_COLOURS[itinerary.mode]}>
  <h4>Itinerary <span>{itinerary.stops.length ? `${itinerary.stops.length} stops` : ''}</span></h4>
  {#if loading && !itinerary.stops.length}<p class="panel-note">Loading itinerary…</p>
  {:else if !itinerary.stops.length}<p class="panel-note">{error || itinerary.reason || 'No stops available.'}</p>{/if}
  {#if itinerary.stops.length}
    <p class="itinerary-note">Minutes from now · Helsinki time</p>
    {#if itinerary.stale}<p class="notice">Updates stale or paused · arrival countdowns unavailable.</p>{/if}
    {#if itinerary.reason}<p class="panel-note">{itinerary.reason}</p>{/if}
    {#if error}<p class="panel-note">Refresh unavailable · {error}</p>{/if}
    <ol class="itinerary-stops">
      {#each itinerary.stops as stop, index (stop.key)}
        <li class:visited={stop.state === 'visited' || stop.state === 'elapsed'} class:next={stop.state === 'next'} class:current={stop.state === 'current'} class:cancelled={stop.state === 'cancelled'} aria-current={stop.state === 'next' || stop.state === 'current' ? 'step' : undefined}>
          <span class="itinerary-dot" aria-hidden="true"></span>
          <div class="itinerary-station">
            <strong>{stop.name}</strong>
            <small>{index === 0 ? 'Departure' : index === itinerary.stops.length - 1 ? 'Destination' : ''}{stop.platform ? `${index === 0 || index === itinerary.stops.length - 1 ? ' · ' : ''}Platform ${stop.platform}` : ''}</small>
            <small>{stop.actualAt ? 'Actual' : stop.estimated ? 'Estimated' : 'Scheduled'} {itineraryTime(stop.actualAt ?? stop.expectedAt)}</small>
          </div>
          <span class="itinerary-arrival">{itineraryStopLabel(stop)}</span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .vehicle-itinerary { margin: 18px 0; padding-top: 16px; border-top: 1px solid var(--border); }
  h4 { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; font-weight: 500; margin: 0; }
  h4 span, .itinerary-note { color: var(--muted); font-size: 10px; font-weight: 400; }
  .itinerary-note { margin: 7px 0 16px; }
  .itinerary-stops { list-style: none; padding: 0; margin: 0; }
  li { position: relative; display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 9px; padding: 0 0 20px; color: var(--text); }
  li:not(:last-child)::before { content: ''; position: absolute; left: 8px; top: 11px; bottom: -1px; width: 2px; background: var(--route-colour); }
  li.visited { color: #91a5ac; }
  li.visited::before { background: #647d88; }
  .itinerary-dot { position: relative; z-index: 1; width: 12px; height: 12px; margin: 3px 2px 0; border: 2px solid var(--route-colour); border-radius: 50%; background: #102732; }
  .visited .itinerary-dot { border-color: #78909a; background: #78909a; }
  .next .itinerary-dot, .current .itinerary-dot { background: var(--route-colour); box-shadow: 0 0 0 3px #102732, 0 0 0 5px var(--route-colour); }
  .itinerary-station strong { display: block; font-size: 12px; line-height: 1.5; font-weight: 500; overflow-wrap: anywhere; }
  .itinerary-station small { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; }
  .itinerary-station small:empty { display: none; }
  .itinerary-arrival { max-width: 95px; padding-top: 2px; font-size: 10px; line-height: 1.6; text-align: right; }
  .next .itinerary-arrival, .current .itinerary-arrival { color: var(--route-colour); font-weight: 500; }
  .cancelled { color: #dfba8e; }
  .cancelled .itinerary-dot { border-color: #dfba8e; }
  li:last-child { padding-bottom: 0; }
</style>
