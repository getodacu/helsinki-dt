<script lang="ts">
  import { nearestObservation, type ObservationSnapshot } from '#lib/observations.ts';
  import { formatDate } from '#lib/inspection.ts';
  import { SCENE_ORIGIN } from '#lib/area.ts';
  let { snapshot, now, loading, error, onstation }: {
    snapshot: ObservationSnapshot | null; now: number; loading: boolean; error: string;
    onstation: (id: string) => void;
  } = $props();
  let readings = $derived([
    { parameter: 't2m', label: 'Temp', name: 'Temperature', station: 'Helsinki Kaisaniemi' },
    { parameter: 'ws_10min', label: 'Wind', name: 'Wind speed', station: 'Helsinki Kaisaniemi' },
    { parameter: 'NO2_PT1H_avg', label: 'NO₂', name: 'Nitrogen dioxide', station: 'Helsinki Mannerheimintie' }
  ].map(item => ({ ...item, reading: snapshot ? nearestObservation(snapshot, SCENE_ORIGIN.longitude, SCENE_ORIGIN.latitude, item.parameter, now) : null })));
</script>

<section class="sensor-readings" aria-label="Station sensor readings">
  {#each readings as item (item.parameter)}
    {@const observation = item.reading?.observation}
    {@const unit = observation?.unit === 'degC' ? '°C' : observation?.unit === 'ug/m3' ? 'µg/m³' : observation?.unit ?? ''}
    {@const state = observation ? error ? 'stale' : item.reading?.state : loading ? 'loading' : 'unavailable'}
    {@const source = snapshot?.sources.find(source => source.id === observation?.sourceId)}
    {@const description = `${item.name}: ${observation ? `${observation.value} ${unit}. Observed ${formatDate(observation.observedAt)}` : loading ? 'Loading observations' : 'Observation unavailable'}. ${observation?.stationName ?? item.station}. ${state}. ${error || item.reading?.reason || ''} ${source?.attribution ?? ''}`}
    <button class="sensor-reading" class:stale={state === 'stale'} data-parameter={item.parameter} data-state={state} aria-label={description} title={description} disabled={!observation} onclick={() => observation && onstation(observation.stationId)}>
      <span>{item.label}{#if state === 'stale'}<small>stale</small>{/if}</span>
      <strong>{observation?.value ?? '—'}{#if observation}<span>{unit}</span>{/if}</strong>
    </button>
  {/each}
</section>
