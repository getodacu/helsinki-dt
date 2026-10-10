<script lang="ts">
  import { WEBCAM_REFRESH_MS, WEBCAM_STALE_MS, webcamImageUrl, type Webcam, type WebcamSnapshot } from '#lib/webcams.ts';
  let { camera, onclose }: { camera: Webcam; onclose: () => void } = $props();
  let imageUrl = $state(''), imageTime = $state<string | null>(null), error = $state(''), loading = $state(true), now = $state(Date.now());
  const stale = $derived(!!imageTime && (!!error || now - Date.parse(imageTime) > WEBCAM_STALE_MS));
  const timestamp = (time: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(time));

  function showDialog(dialog: HTMLDialogElement) {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return { destroy() { dialog.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); } };
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') event.stopPropagation();
    if (event.key !== 'Tab') return;
    const controls = (event.currentTarget as HTMLDialogElement).querySelectorAll<HTMLElement>('button, a[href]');
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  $effect(() => {
    const current = camera;
    let disposed = false, request: AbortController | null = null, lastAttempt = 0;
    imageUrl = ''; imageTime = null; error = ''; loading = true;
    async function refresh() {
      if (disposed || document.hidden || request) return;
      const attempt = new AbortController(); request = attempt; lastAttempt = Date.now(); loading = true;
      const signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(15_000)]);
      try {
        const response = await fetch(`/api/webcams/${current.id}`, { cache: 'no-store', signal });
        if (!response.ok) throw new Error('Camera source unavailable.');
        const snapshot: WebcamSnapshot = await response.json();
        if (disposed || signal.aborted) return;
        if (snapshot.stationId !== current.id || snapshot.presetId !== current.presetId || !snapshot.measuredTime || !Number.isFinite(Date.parse(snapshot.measuredTime))) throw new Error(snapshot.lastError || 'Camera image unavailable.');
        if (!imageTime || Date.parse(snapshot.measuredTime) > Date.parse(imageTime)) {
          const url = webcamImageUrl(current, snapshot.measuredTime);
          await new Promise<void>((resolve, reject) => {
            const image = new Image();
            const abort = () => { cleanup(); image.src = ''; reject(signal.reason); };
            const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', abort); };
            image.onload = () => { cleanup(); resolve(); };
            image.onerror = () => { cleanup(); reject(new Error('Camera image unavailable.')); };
            signal.addEventListener('abort', abort, { once: true });
            image.referrerPolicy = 'no-referrer'; image.src = url;
          });
          if (disposed || signal.aborted) return;
          imageUrl = url; imageTime = snapshot.measuredTime;
        }
        error = snapshot.lastError ?? '';
      } catch (failure) {
        if (!disposed && !attempt.signal.aborted) error = signal.aborted ? 'Camera request timed out.' : failure instanceof Error ? failure.message : 'Camera unavailable.';
      } finally { if (request === attempt) { request = null; if (!disposed) loading = false; } }
    }
    const visibility = () => {
      if (document.hidden) { request?.abort(); request = null; lastAttempt = 0; }
      else void refresh();
    };
    void refresh();
    const timer = setInterval(() => { now = Date.now(); if (now - lastAttempt >= WEBCAM_REFRESH_MS) void refresh(); }, 60_000);
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; request?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  });
</script>

<dialog class="webcam-modal" aria-labelledby="webcam-heading" use:showDialog onclose={onclose}
  onkeydown={handleKeydown}
  onpointerdown={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
  }}>
  <header><h2 id="webcam-heading">{camera.name} · Camera</h2><button type="button" aria-label="Close camera" onclick={event => event.currentTarget.closest('dialog')?.close()}>×</button></header>
  <div class="camera-image" aria-busy={loading}>
    {#if imageUrl}<img src={imageUrl} alt={`Digitraffic camera view at ${camera.name}`} width="1280" height="720" referrerpolicy="no-referrer" />
    {:else}<p role="status">{loading ? 'Loading camera image…' : error || 'Camera image unavailable.'}</p>{/if}
  </div>
  <footer>
    {#if imageTime}<p>Latest reported snapshot: <time datetime={imageTime}>{timestamp(imageTime)}</time> · Helsinki time</p>{/if}
    {#if stale}<p class="camera-notice" role="status">Stale image · {error ? 'Refresh failed; retaining the last loaded image.' : 'Reported snapshot is older than 30 minutes.'}</p>{/if}
    <p>Camera image: <a href="https://www.digitraffic.fi/en/road-traffic/#weather-cameras" target="_blank" rel="noreferrer">Fintraffic / Digitraffic</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></p>
  </footer>
</dialog>

<style>
  .webcam-modal { inset: 0; margin: auto; padding: 0; width: min(960px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); color: #eaf0ef; background: #102733; border: 2px solid #49636c; border-radius: 2px; box-shadow: 0 16px 80px #0009; overflow: auto; }
  .webcam-modal::backdrop { background: #00121cbb; }
  header { display: flex; align-items: center; gap: 12px; padding: 6px 12px; background: linear-gradient(90deg, #24504f, #16343e); border-bottom: 1px solid #52796d; }
  h2 { margin: 0; flex: 1; font-size: 15px; line-height: 1.4; }
  header button { min-height: 44px; min-width: 44px; border: 1px solid #65867b; background: #17353c; color: #c8ded7; font-size: 24px; border-radius: 2px; }
  .camera-image { background: #091e29; }
  .camera-image img { display: block; width: 100%; height: auto; max-height: calc(100dvh - 210px); object-fit: contain; }
  .camera-image > p { padding: 48px 16px; text-align: center; }
  footer { padding: 12px; font-size: 12px; line-height: 1.6; color: #b3c9cc; }
  footer p { margin: 0; }
  .camera-notice { color: #edba91; }
  a { color: #8cddbc; text-decoration: underline; text-underline-offset: 2px; }
</style>
