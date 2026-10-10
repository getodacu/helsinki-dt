<script lang="ts">
  import { untrack } from 'svelte';
  import type { SceneStation } from '../scene.ts';
  import type { Vehicle } from '../types.ts';
  import { railDelay, type RailDeparture, type RailResult } from '../rail.ts';
  import { delayLabel, formatDate } from '../inspection.ts';
  let { station, vehicles, ontrain }: { station: SceneStation; vehicles: Vehicle[]; ontrain: (vehicle: Vehicle) => void } = $props();
  let board = $state.raw<RailResult<RailDeparture[]> | null>(null);
  let loading = $state(true), error = $state('');
  let code = $derived(station.id.replace(/^rail:/, ''));
  $effect(() => {
    const stationCode = code;
    untrack(() => { board = null; loading = true; error = ''; });
    let disposed = false, request: AbortController | null = null;
    async function refresh() {
      if (disposed || document.hidden || request) return;
      const attempt = new AbortController(); request = attempt;
      try {
        const response = await fetch(`/api/rail/stations/${encodeURIComponent(stationCode)}/departures`, { cache: 'no-store', signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(20_000)]) });
        if (!response.ok) throw new Error(`Station board unavailable (${response.status})`);
        const value = await response.json() as RailResult<RailDeparture[]>;
        if (!['ready', 'stale', 'unavailable'].includes(value.state) || (value.data !== null && !Array.isArray(value.data))) throw new Error('Invalid station board');
        if (!disposed && !attempt.signal.aborted) { board = value; error = ''; }
      } catch (failure) { if (!disposed && !attempt.signal.aborted) error = failure instanceof Error ? failure.message : 'Departure board unavailable'; }
      finally { if (request === attempt) request = null; if (!disposed) loading = false; }
    }
    const visibility = () => { if (document.hidden) { request?.abort(); request = null; } else void refresh(); };
    void refresh(); const timer = setInterval(() => void refresh(), 30_000);
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; request?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  });
</script>

<span class="eyebrow">RAILWAY STATION / {code}</span><h3>{station.name}</h3>
<h4>Passenger departures · Helsinki time</h4>
{#if loading}<p class="notice" role="status">Loading departures…</p>{/if}
{#if error || board?.error}<p class="notice" role="status">{board?.data ? 'Showing the last available board. ' : ''}{error || board?.error}</p>{/if}
<div class="rail-board">
  {#each board?.data ?? [] as departure (`${departure.id}/${departure.event.scheduledAt}`)}
    {@const train = vehicles.find(vehicle => vehicle.id === departure.id)}
    <article class:cancelled={departure.summary.cancelled || departure.event.cancelled}>
      <div class="departure-heading"><strong>{departure.summary.label}</strong><span>{departure.summary.destination ?? 'Destination unavailable'}</span></div>
      <dl class="properties">
        <div><dt>Scheduled</dt><dd>{formatDate(departure.event.scheduledAt)}</dd></div>
        <div><dt>Estimated</dt><dd>{departure.event.estimatedAt ? formatDate(departure.event.estimatedAt) : 'No estimate'}</dd></div>
        <div><dt>Platform</dt><dd>{departure.event.platform ?? 'Not supplied'}</dd></div>
        <div><dt>Status</dt><dd>{departure.summary.cancelled || departure.event.cancelled ? 'Cancelled' : delayLabel(railDelay(departure.event))}</dd></div>
      </dl>
      {#if train}<button class="text-button" onclick={() => ontrain(train)}>Show {departure.summary.label} on map ↗</button>{:else}<small>No live position</small>{/if}
    </article>
  {:else}{#if !loading && board?.state === 'ready'}<p class="panel-note">No upcoming passenger departures reported.</p>{/if}{/each}
</div>
<p class="panel-note">Checked {formatDate(board?.retrievedAt)}</p>
<style>
  .rail-board { display: grid; gap: 8px; }
  article { border: 1px solid var(--border, #35505d); border-left: 3px solid #b29bd8; padding: 8px; border-radius: 2px; }
  article.cancelled { border-left-color: #df998e; }
  .departure-heading { display: flex; gap: 10px; align-items: baseline; }
  .departure-heading strong { color: #d2bdf4; white-space: nowrap; }
  .departure-heading span { font-size: 12px; overflow-wrap: anywhere; min-width: 0; }
  article small { color: var(--muted); }
</style>
