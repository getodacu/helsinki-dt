<script lang="ts">
  import { browser } from '$app/env';
  import { createQuery } from '@tanstack/svelte-query';
  import { fetchEntity } from '#lib/entity-query.ts';
  import { buildingName } from '#lib/inspection.ts';
  import BuildingModelPreview from './BuildingModelPreview.svelte';
  import ConsoleIcon from './ConsoleIcon.svelte';
  import { TEXTURED_BUILDINGS_URL } from '#lib/city-source.ts';
  import type { Building } from '#lib/types.ts';
  import type { EntityPhoto } from '#lib/entity-types.ts';
  import type { CityBase } from '#lib/city-assets.ts';
  import type { CityAssetCache } from '#lib/city-cache.ts';
  let { building, generation, base, cache }: { building: Building; generation: string; base?: CityBase; cache?: CityAssetCache } = $props();
  let modelAvailable = $state(false);
  let failedUrl = $state(''), viewerOpen = $state(false), view = $state<'photo' | 'model'>('photo');
  const query = createQuery(() => {
    const id = building.id, version = generation;
    return { queryKey: ['building-photo', version, id], enabled: browser && !!version && !!(building.vtjPrt || building.ratu),
      staleTime: 5 * 60_000, gcTime: 10 * 60_000, retry: 1, retryDelay: 2000,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchEntity<EntityPhoto>(`/api/entities/building/${encodeURIComponent(id)}/photo?${new URLSearchParams({ generation: version })}`, signal, version) };
  });
  const imageUrl = $derived(`/api/entities/building/${encodeURIComponent(building.id)}/photo/image?${new URLSearchParams({ generation })}`);
  function showViewer(dialog: HTMLDialogElement) {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return { destroy() { dialog.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); } };
  }
</script>

{#if query.data?.generation === generation && query.data.buildingId === building.id && query.data.photo && query.data.photo.url !== failedUrl}
  {@const photo = query.data.photo}
  <figure class="building-photo">
    <button class="photo-button" aria-label={`Enlarge photograph of ${buildingName(building)}`} onclick={() => { view = 'photo'; modelAvailable = false; viewerOpen = true; }}>
      <img src={imageUrl} alt={`Photograph of ${buildingName(building)}`} width="960" height="640" decoding="async" referrerpolicy="no-referrer" onerror={() => failedUrl = photo.url} />
    </button>
  </figure>
  {#if viewerOpen}
    <dialog class="building-viewer" aria-label={`${buildingName(building)} — building media`} use:showViewer onclose={() => viewerOpen = false}
      onkeydown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
      onpointerdown={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) viewerOpen = false;
      }}>
      <header><h2>{buildingName(building)}</h2><button class="close-button" aria-label="Close building viewer" onclick={() => viewerOpen = false}>×</button></header>
      <nav aria-label="Building media">
        <button aria-pressed={view === 'photo'} onclick={() => view = 'photo'}><ConsoleIcon name="imagery" />Photo</button>
        {#if modelAvailable}<button aria-pressed={view === 'model'} onclick={() => view = 'model'}><ConsoleIcon name="buildings" />3D model</button>{/if}
      </nav>
      {#if view === 'photo'}
        <img class="enlarged-photo" src={imageUrl} alt={`Photograph of ${buildingName(building)}`} referrerpolicy="no-referrer" />
        <footer>Photo: {photo.author} · <a href={photo.licenseUrl} target="_blank" rel="noreferrer">{photo.license}</a> · <a href={photo.pageUrl} target="_blank" rel="noreferrer">Source & credits ↗</a></footer>
      {/if}
      {#if base}
        <BuildingModelPreview {building} {base} {cache} visible={view === 'model'} onavailable={available => { modelAvailable = available; if (!available) view = 'photo'; }} />
        {#if view === 'model'}<footer><a href={TEXTURED_BUILDINGS_URL} target="_blank" rel="noreferrer">City of Helsinki · Helsinki 3D</a> · CC BY 4.0</footer>{/if}
      {/if}
    </dialog>
  {/if}
{/if}

<style>
  .building-photo { margin: 0; }
  .photo-button { display: block; width: 100%; padding: 0; border: 0; border-radius: 0; background: #091e29; cursor: zoom-in; }
  .photo-button img { display: block; width: 100%; height: auto; }
  .photo-button:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
  a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
  .building-viewer { inset: 0; margin: auto; padding: 0; width: min(960px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); color: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 16px 80px #0009; overflow: auto; }
  .building-viewer::backdrop { background: #00121cbb; }
  header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--surface); border-bottom: 1px solid var(--border); }
  h2 { margin: 0; flex: 1; font-size: 14px; line-height: 1.35; }
  .close-button { min-height: 44px; min-width: 44px; border: 1px solid var(--border); background: var(--accent-wash); color: var(--text); font-size: 20px; border-radius: var(--radius); }
  nav { display: flex; gap: 2px; padding: 3px 8px 0; border-bottom: 1px solid #334951; }
  nav button { display: inline-flex; align-items: center; gap: 5px; padding: 6px 9px; min-height: 44px; font-size: 13px; color: #adc4c7; background: transparent; border-radius: 0; border-bottom: 2px solid transparent; }
  nav button[aria-pressed=true] { color: #b2efce; border-color: #8cddbc; }
  nav :global(svg) { width: 14px; height: 14px; }
  button:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
  .enlarged-photo { display: block; width: 100%; max-height: 65dvh; object-fit: contain; background: #091e29; }
  footer { padding: 10px 12px; font-size: 11px; line-height: 1.5; color: var(--muted); }
  @media (max-width: 600px) { .building-viewer { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } .close-button { min-height: 36px; min-width: 36px; } nav button { min-height: 36px; } }
</style>
