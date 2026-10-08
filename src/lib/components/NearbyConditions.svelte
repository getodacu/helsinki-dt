<script lang="ts">
  import { nearestObservation, OBSERVATION_PARAMETERS, type ObservationSnapshot } from '#lib/observations.ts';
  import { formatDate } from '#lib/inspection.ts';
  let { snapshot, longitude, latitude, parameters, now, loading, error, scope, onsources, onstation }: {
    snapshot: ObservationSnapshot | null; longitude: number | null; latitude: number | null; parameters: string[];
    now: number; loading: boolean; error: string; scope: string; onsources: () => void; onstation: (id: string) => void;
  } = $props();
  let readings = $derived(parameters.map(parameter => ({ parameter, label: OBSERVATION_PARAMETERS.find(item => item.id === parameter)?.label ?? parameter,
    nearest: snapshot && longitude !== null && latitude !== null ? nearestObservation(snapshot, longitude, latitude, parameter, now) : null })));
  const distance = (metres: number | null) => metres === null ? 'Distance unknown' : metres < 1000 ? `${Math.round(metres)} m away` : `${(metres / 1000).toFixed(1)} km away`;
</script>
<div class="context-heading"><p class="panel-note">{scope}. Regional station context; readings are not measurements at this location.</p></div>
{#if loading && !snapshot}<p class="panel-note context-message" role="status">Loading shared observations…</p>{/if}
{#if error}<p class="notice" role="status">{error}{snapshot ? ' · dated observations retained' : ''}</p>{/if}
<div class="observation-cards">
  {#each readings as reading (reading.parameter)}
    {@const observation = reading.nearest?.observation}
    <article class="observation-card" data-parameter={reading.parameter}>
      <div class="reading-heading"><span>{reading.label}</span><strong>{observation?.value ?? '—'}<small> {observation?.unit ?? 'Unknown unit'}</small></strong></div>
      <span class="reading-state">{reading.nearest?.state ?? (loading ? 'loading' : 'unavailable')}</span>
      {#if observation}
        <button class="station-link" onclick={() => onstation(observation.stationId)}>{observation.stationName} ↗</button>
        <p class="panel-note">{distance(reading.nearest?.distanceMetres ?? null)} · station observation</p>
        <details><summary>Time, quality & source</summary><dl class="properties">
          <div><dt>Observed</dt><dd>{formatDate(observation.observedAt)}</dd></div>
          <div><dt>Received</dt><dd>{formatDate(observation.receivedAt)}</dd></div>
          <div><dt>Unit</dt><dd>{observation.unit}</dd></div>
          <div><dt>Quality</dt><dd>{observation.quality ?? 'Unknown — not supplied'}</dd></div>
          <div><dt>Aggregation</dt><dd>{observation.aggregation ?? 'Unknown — not supplied'}</dd></div>
          <div><dt>Scope</dt><dd>Station {observation.stationId}</dd></div>
        </dl><button class="text-button" onclick={onsources}>{observation.sourceId} · source & status ↗</button></details>
      {/if}
      {#if reading.nearest?.reason}<p class="panel-note missing-reason">{reading.nearest.reason}</p>{:else if !reading.nearest && !loading}<p class="panel-note missing-reason">{longitude === null || latitude === null ? 'Selected position is unknown.' : 'Observation source unavailable.'}</p>{/if}
    </article>
  {:else}<p class="panel-note context-message">Choose a parameter in Layers to see nearby conditions.</p>{/each}
</div>
<p class="panel-note context-footnote">Weather and reported delay are shown side by side. This does not establish causation.</p>
