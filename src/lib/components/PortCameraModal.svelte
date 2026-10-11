<script lang="ts">
  import { PORT_CAMERAS, PORT_SNAPSHOT_REFRESH_MS, portCameraById, portCameraUrl, type PortHarbour } from '#lib/port-cameras.ts';
  let { harbour, onclose }: { harbour: PortHarbour; onclose: () => void } = $props();
  let selectedId = $state(''), visible = $state(true), loading = $state(true), error = $state('');
  let imageUrl = $state(''), loadedAt = $state<string | null>(null);
  const camera = $derived(portCameraById(selectedId) ?? portCameraById(harbour.defaultCameraId)!);
  const timestamp = (time: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(time));

  function showDialog(dialog: HTMLDialogElement) {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return { destroy() { dialog.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); } };
  }
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') event.stopPropagation();
    if (event.key !== 'Tab') return;
    const controls = (event.currentTarget as HTMLDialogElement).querySelectorAll<HTMLElement>('button, select, iframe, a[href]');
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function watchPlayer(frame: HTMLIFrameElement) {
    loading = true; error = '';
    const timer = setTimeout(() => { loading = false; error = 'Player did not load. Open the official camera page below.'; }, 15_000);
    frame.onload = () => { clearTimeout(timer); loading = false; };
    frame.onerror = () => { clearTimeout(timer); loading = false; error = 'Player unavailable. Open the official camera page below.'; };
    return { destroy() { clearTimeout(timer); frame.onload = null; frame.onerror = null; } };
  }

  $effect(() => {
    const current = camera;
    let disposed = false, cancelLoad: (() => void) | null = null, timer: ReturnType<typeof setInterval> | undefined;
    imageUrl = ''; loadedAt = null; error = ''; loading = !document.hidden; visible = !document.hidden;
    function refresh() {
      if (disposed || document.hidden || cancelLoad) return;
      loading = true;
      const image = new Image(), url = portCameraUrl(current);
      const cleanup = () => { clearTimeout(deadline); image.onload = null; image.onerror = null; cancelLoad = null; };
      const fail = () => { cleanup(); image.src = ''; if (!disposed) { loading = false; error = 'Camera snapshot unavailable.'; } };
      const deadline = setTimeout(fail, 15_000);
      cancelLoad = () => { cleanup(); image.src = ''; loading = false; };
      image.onload = () => {
        cleanup(); if (disposed) return;
        imageUrl = url; loadedAt = new Date().toISOString(); loading = false; error = '';
      };
      image.onerror = fail; image.referrerPolicy = 'strict-origin-when-cross-origin'; image.src = url;
    }
    const visibility = () => {
      visible = !document.hidden;
      cancelLoad?.(); clearInterval(timer); timer = undefined;
      if (!document.hidden && current.kind === 'snapshot') { refresh(); timer = setInterval(refresh, PORT_SNAPSHOT_REFRESH_MS); }
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; cancelLoad?.(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  });
</script>

<dialog class="port-camera-modal" aria-labelledby="port-camera-heading" use:showDialog onclose={onclose} onkeydown={handleKeydown}
  onpointerdown={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
  }}>
  <header><h2 id="port-camera-heading">Port of Helsinki · Cameras</h2><button type="button" aria-label="Close port cameras" onclick={event => event.currentTarget.closest('dialog')?.close()}>×</button></header>
  <label class="camera-chooser">Port camera
    <select value={camera.id} onchange={event => selectedId = event.currentTarget.value}>
      {#each [['south', 'South Harbour'], ['west', 'West Harbour'], ['vuosaari', 'Vuosaari Harbour']] as [group, name] (group)}
        <optgroup label={name}>{#each PORT_CAMERAS.filter(view => view.harbour === group) as view (view.id)}<option value={view.id}>{view.name}{view.harbour === 'vuosaari' ? ' (outside map area)' : ''}</option>{/each}</optgroup>
      {/each}
    </select>
  </label>
  <div class="camera-media" aria-busy={visible && loading}>
    {#if !visible}<p role="status">Camera paused while this page is hidden.</p>
    {:else if camera.kind === 'video'}
      {#key camera.id}<iframe src={portCameraUrl(camera)} title={`Port of Helsinki camera · ${camera.name}`} allow="autoplay *; encrypted-media *; picture-in-picture *" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" use:watchPlayer></iframe>{/key}
      {#if loading}<p class="player-status" role="status">Loading camera player…</p>{/if}
    {:else if imageUrl}<img src={imageUrl} alt={`Port of Helsinki camera view at ${camera.name}`} referrerpolicy="strict-origin-when-cross-origin" />
    {:else}<p role="status">{loading ? 'Loading camera snapshot…' : error || 'Camera snapshot unavailable.'}</p>{/if}
  </div>
  <footer>
    {#if camera.kind === 'snapshot'}
      {#if loadedAt}<p>Image loaded: <time datetime={loadedAt}>{timestamp(loadedAt)}</time> · Helsinki time</p>{/if}
    {/if}
    {#if error && (imageUrl || camera.kind === 'video')}<p class="camera-notice" role="status">{imageUrl ? 'Refresh failed; showing the previously loaded snapshot.' : error}</p>{/if}
    <p>Camera: <a href={camera.pageUrl} target="_blank" rel="noreferrer">Port of Helsinki · {camera.name} ↗</a></p>
  </footer>
</dialog>

<style>
  .port-camera-modal { inset: 0; margin: auto; padding: 0; width: min(960px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 16px 80px #0009; overflow: auto; }
  .port-camera-modal::backdrop { background: #00121cbb; }
  header { display: flex; align-items: center; gap: 12px; padding: 6px 12px; background: var(--surface); border-bottom: 1px solid var(--border); }
  h2 { margin: 0; flex: 1; font-size: 15px; line-height: 1.4; }
  header button { min-height: 44px; min-width: 44px; border: 1px solid var(--border); background: var(--accent-wash); color: var(--text); font-size: 24px; border-radius: var(--radius); }
  .camera-chooser { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 12px; font-size: 12px; }
  select { flex: 1; min-width: 0; min-height: 44px; padding: 6px 8px; color: inherit; background: var(--accent-wash); border: 1px solid var(--border); }
  .camera-media { position: relative; background: #091e29; }
  iframe { display: block; width: 100%; aspect-ratio: 16 / 9; max-height: calc(100dvh - 260px); border: 0; }
  img { display: block; width: 100%; height: auto; max-height: calc(100dvh - 260px); object-fit: contain; }
  .camera-media > p { padding: 48px 16px; text-align: center; }
  .camera-media > .player-status { position: absolute; inset: 0; margin: 0; display: grid; place-content: center; background: #091e29; pointer-events: none; }
  footer { padding: 12px; font-size: 12px; line-height: 1.6; color: var(--muted); }
  footer p { margin: 0; }
  .camera-notice { color: #edba91; }
  a { color: #8cddbc; text-decoration: underline; text-underline-offset: 2px; }
  button:focus-visible, select:focus-visible { outline: 2px solid #8cddbc; outline-offset: -2px; }
</style>
