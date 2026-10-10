<script lang="ts">
  import { browser } from '$app/env';
  import { createQuery } from '@tanstack/svelte-query';
  import { fetchEntity } from '#lib/entity-query.ts';
  import { buildingName } from '#lib/inspection.ts';
  import type { Building } from '#lib/types.ts';
  import type { EntityPhoto } from '#lib/entity-types.ts';
  let { building, generation }: { building: Building; generation: string } = $props();
  let failedUrl = $state('');
  const query = createQuery(() => {
    const id = building.id, version = generation;
    return { queryKey: ['building-photo', version, id], enabled: browser && !!version && !!(building.vtjPrt || building.ratu),
      staleTime: 5 * 60_000, gcTime: 10 * 60_000, retry: 1, retryDelay: 2000,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchEntity<EntityPhoto>(`/api/entities/building/${encodeURIComponent(id)}/photo?${new URLSearchParams({ generation: version })}`, signal, version) };
  });
</script>

{#if query.data?.generation === generation && query.data.buildingId === building.id && query.data.photo && query.data.photo.url !== failedUrl}
  {@const photo = query.data.photo}
  <figure class="building-photo">
    <a href={photo.pageUrl} target="_blank" rel="noreferrer" aria-label="View building photo and credits on Wikimedia Commons">
      <img src={`/api/entities/building/${encodeURIComponent(building.id)}/photo/image?${new URLSearchParams({ generation })}`} alt={`Photograph of ${buildingName(building)}`} width="960" height="640" decoding="async" referrerpolicy="no-referrer" onerror={() => failedUrl = photo.url} />
    </a>
    <figcaption>Photo: {photo.author} · <a href={photo.licenseUrl} target="_blank" rel="noreferrer">{photo.license}</a> · <a href={photo.pageUrl} target="_blank" rel="noreferrer">Wikimedia Commons ↗</a></figcaption>
  </figure>
{/if}

<style>
  .building-photo { margin: 0 0 12px; }
  img { display: block; width: 100%; height: auto; aspect-ratio: 3 / 2; object-fit: contain; background: #091e29; border-radius: 2px; }
  figcaption { margin-top: 5px; font-size: 10px; line-height: 1.4; color: var(--muted); overflow-wrap: anywhere; }
  a { color: inherit; }
  figcaption a { text-decoration: underline; text-underline-offset: 2px; }
</style>
