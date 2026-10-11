<script lang="ts">
  import { nearestObservation, type ObservationSnapshot } from '#lib/observations.ts';
  import { formatDate } from '#lib/inspection.ts';
  import { SCENE_ORIGIN } from '#lib/area.ts';
  let { feeds, snapshot, now, loading, error, onstation }: {
    feeds: { name: string; live: boolean; state: string; lastAt?: string | null; error?: string | null }[];
    snapshot: ObservationSnapshot | null; now: number; loading: boolean; error: string;
    onstation: (id: string) => void;
  } = $props();
  let readings = $derived(['t2m', 'NO2_PT1H_avg'].map(parameter => ({
    parameter, reading: snapshot ? nearestObservation(snapshot, SCENE_ORIGIN.longitude, SCENE_ORIGIN.latitude, parameter, now) : null
  })));
</script>

<div class="overview-content">
  <span class="eyebrow">REPORTED MOVEMENT</span>
  {#each feeds as feed (feed.name)}
    <div class="overview-feed"><div><strong>{feed.name === 'AIS' ? 'Ships · AIS' : feed.name}</strong><span class:connected={feed.live} class="status-dot" aria-hidden="true"></span></div><p>{feed.state}</p><small>Last report: {formatDate(feed.lastAt)}</small>{#if feed.error}<p class="panel-note">{feed.error}</p>{/if}</div>
  {/each}
  <div class="overview-observations"><span class="eyebrow">STATION OBSERVATIONS</span>
    {#each readings as item (item.parameter)}
      {@const observation = item.reading?.observation}
      <section class="overview-reading" aria-label={item.parameter === 't2m' ? 'Kaisaniemi temperature' : 'Mannerheimintie nitrogen dioxide'}>
        <span>{item.parameter === 't2m' ? 'Temperature' : 'Nitrogen dioxide · NO₂'}</span>
        <strong>{observation ? `${observation.value} ${observation.unit === 'degC' ? '°C' : observation.unit === 'ug/m3' ? 'µg/m³' : observation.unit}` : '—'}</strong>
        <button class="station-link" disabled={!observation} onclick={() => observation && onstation(observation.stationId)}>{observation?.stationName ?? (item.parameter === 't2m' ? 'Helsinki Kaisaniemi' : 'Helsinki Mannerheimintie')}{observation ? ' ↗' : ''}</button>
        <small>{observation ? `Observed: ${formatDate(observation.observedAt)}` : loading ? 'Loading observations…' : 'Observation unavailable'}</small>
        {#if observation}<span class="reading-state">{error ? 'stale · refresh unavailable' : item.reading?.state}</span>{/if}
        {#if item.reading?.reason}<p class="panel-note">{item.reading.reason}</p>{/if}
      </section>
    {/each}
    {#if error}<p class="notice" role="status">{error}</p>{/if}
    <p class="panel-note">Each reading describes its station. These are observations, with independent source times.</p>
  </div>
</div>
