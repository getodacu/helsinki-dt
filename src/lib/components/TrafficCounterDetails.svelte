<script lang="ts">
  import { tick, untrack } from 'svelte';
  import TrafficCountHistory from './TrafficCountHistory.svelte';
  import { MEASUREMENT_RECENT_MS, MEASUREMENT_REFRESH_MS, MEASUREMENT_MODES, summarizeTrafficCounts,
    colocatedCounters, type TrafficCounter, type TrafficCounterDetail, type TrafficCounterSummary, type MeasurementMode } from '#lib/traffic-measurements.ts';
  let { counter, counters, mode, now, enabled, summaries, panel }: { counter: TrafficCounter; counters: TrafficCounter[];
    mode: MeasurementMode; now: number; enabled: boolean; summaries: TrafficCounterSummary[]; panel: string | null } = $props();
  let counterId = $derived(counter.id);
  let detail = $state.raw<TrafficCounterDetail | null>(null);
  let loading = $state(true);
  let error = $state('');
  let history = $derived(detail?.counts.filter(row => row.mode === mode && Date.parse(row.observedAt) > now - MEASUREMENT_RECENT_MS && Date.parse(row.observedAt) <= now) ?? []);
  let summary = $derived(summarizeTrafficCounts(history, now, !!error || detail?.state === 'partial')[0]);
  let latest = $derived(summary?.latest);
  let maximum = $derived(summary?.maximum);
  let latestRows = $derived(detail?.measurements.filter(row => row.mode === mode && row.observedAt === latest?.observedAt) ?? []);
  let siblings = $derived(colocatedCounters(counters, counter));
  let siblingSummaries = $derived(new Map(summaries.filter(row => row.mode === mode).map(row => [row.counterId, row])));
  const compactDate = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const perHour = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value).toLocaleString()} / h`;
  async function loadCounter(id: string, request: AbortController): Promise<TrafficCounterDetail> {
    const response = await fetch(`/api/traffic-measurements/counters/${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(75_000)]) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `Counter unavailable (${response.status})`);
    if (value.counter?.id !== id || !Array.isArray(value.measurements) || !Array.isArray(value.counts) || !Array.isArray(value.summaries)) throw new Error('Invalid counter history');
    return value;
  }
  let histogram = $state<{ counter: TrafficCounter; trigger: HTMLButtonElement; x: number; y: number } | null>(null);
  let popup = $state<HTMLDivElement>();
  let popupDetail = $state.raw<TrafficCounterDetail | null>(null);
  let popupError = $state('');
  let popupLoading = $state(false);
  let popupHistory = $derived(popupDetail?.counts.filter(row => row.mode === mode && Date.parse(row.observedAt) > now - MEASUREMENT_RECENT_MS && Date.parse(row.observedAt) <= now) ?? []);
  function closeHistogram(restoreFocus = false) {
    const trigger = histogram?.trigger;
    if (popup?.matches(':popover-open')) popup.hidePopover();
    histogram = null;
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  function openHistogram(event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }, item: TrafficCounter) {
    if (histogram?.counter.id === item.id) { closeHistogram(event.detail === 0); return; }
    const bounds = event.currentTarget.getBoundingClientRect();
    histogram = { counter: item, trigger: event.currentTarget, x: event.detail ? event.clientX : bounds.left, y: event.detail ? event.clientY : bounds.top + bounds.height / 2 };
  }
  function showHistogram(element: HTMLDivElement) {
    element.showPopover();
    const bounds = element.getBoundingClientRect(), anchor = histogram!;
    const left = anchor.x - bounds.width - 8;
    element.style.left = `${Math.max(8, Math.min(left >= 8 ? left : anchor.x + 8, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(anchor.y - bounds.height / 2, window.innerHeight - bounds.height - 8))}px`;
    element.focus({ preventScroll: true });
    const dismiss = () => closeHistogram();
    anchor.trigger.closest('.inspector')?.addEventListener('scroll', dismiss);
    window.addEventListener('resize', dismiss);
    return { destroy() { anchor.trigger.closest('.inspector')?.removeEventListener('scroll', dismiss); window.removeEventListener('resize', dismiss); } };
  }
  $effect(() => { counterId; mode; enabled; panel; untrack(() => closeHistogram()); });
  $effect(() => {
    const selected = histogram;
    if (!selected) return;
    const request = new AbortController();
    const retained = untrack(() => detail?.counter.id === selected.counter.id ? detail : null);
    popupDetail = retained; popupError = untrack(() => retained ? error : ''); popupLoading = !retained;
    const focusChart = () => { if (document.activeElement === popup) popup?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true }); };
    if (retained) void tick().then(focusChart);
    else void loadCounter(selected.counter.id, request).then(value => {
      if (!request.signal.aborted) popupDetail = value;
    }).catch(failure => {
      if (!request.signal.aborted) popupError = failure instanceof Error ? failure.message : 'Counter history unavailable';
    }).finally(() => {
      if (!request.signal.aborted) { popupLoading = false; void tick().then(focusChart); }
    });
    return () => request.abort();
  });
  let modeLabel = $derived(MEASUREMENT_MODES.find(item => item.key === mode)?.label ?? mode);
  $effect(() => {
    const id = counterId, active = enabled;
    let disposed = false, request: AbortController | null = null;
    untrack(() => { if (detail?.counter.id !== id) { detail = null; error = ''; } loading = active && !detail; });
    if (!active) return;
    async function refresh() {
      if (disposed || document.hidden || request) return;
      const attempt = new AbortController(); request = attempt;
      try {
        const value = await loadCounter(id, attempt);
        if (!disposed && !attempt.signal.aborted) { detail = value; error = ''; }
      } catch (failure) { if (!disposed && !attempt.signal.aborted) error = failure instanceof Error ? failure.message : 'Counter history unavailable'; }
      finally { if (request === attempt) { request = null; if (!disposed) loading = false; } }
    }
    const visibility = () => { if (document.hidden) { request?.abort(); request = null; } else void refresh(); };
    void refresh(); const timer = setInterval(() => void refresh(), MEASUREMENT_REFRESH_MS);
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; request?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  });
</script>
<span class="eyebrow">TRAFFIC MEASUREMENT / {modeLabel.toUpperCase()}</span>
{#if loading}<p class="notice" role="status">Loading measurements…</p>{/if}
{#if error || detail?.error}<p class="notice" role="status">{error || detail?.error}{#if detail} · retained readings{/if}</p>{/if}
{#if !enabled}<p class="panel-note">Traffic measurements paused while the layer is disabled.</p>{/if}
{#if detail}
  <div class="traffic-reading"><strong>{latest?.value === null || !latest ? 'Unknown' : latest.value.toLocaleString()}</strong><span>{latest ? `in ${latest.durationSeconds / 60} ${latest.durationSeconds === 60 ? 'minute' : 'minutes'}` : 'No reading for this mode'}</span><span class="hourly-reading">{perHour(latest?.hourlyEquivalent)}</span></div>
  <dl class="properties traffic-properties">
    <div><dt>Measured</dt><dd>{latest ? compactDate(latest.observedAt) : 'Unknown'}</dd></div>
    <div><dt>{summary?.partial ? 'Observed max · partial' : 'Maximum'} · 24 h</dt><dd>{perHour(maximum?.hourlyEquivalent)}{#if maximum}<small>{maximum.value} / {maximum.durationSeconds / 60} min</small>{/if}</dd></div>
  </dl>
  {#if latestRows.some(row => row.type === 'count')}
    <h4>Direction / class</h4>
    <div class="traffic-breakdown"><table aria-label="Traffic measurement breakdown"><thead><tr><th>Direction / class</th><th>Count</th><th>km/h</th></tr></thead><tbody>
      {#each latestRows.filter(row => row.type === 'count') as row, index (index)}
        <tr><td>{row.direction || 'Unspecified direction'}<small>{row.vehicleClass || 'Unknown class'}</small></td><td>{row.value ?? 'Missing'}</td><td>{latestRows.find(speed => speed.type === 'speed' && speed.unit === 'km/h' && speed.direction === row.direction && speed.vehicleClass === row.vehicleClass && speed.durationSeconds === row.durationSeconds)?.value ?? '—'}</td></tr>
      {/each}
    </tbody></table></div>
  {/if}
{/if}
<section class="counter-summaries" aria-label="Counters at this location">
  <h4>Counters at this location</h4>
  <div class="traffic-breakdown"><table><thead><tr><th>Counter</th><th>Latest</th><th>/ h</th><th>Max · 24 h</th></tr></thead><tbody>
    {#each siblings as item (item.id)}
      {@const reading = siblingSummaries.get(item.id)}
      <tr class:current={item.id === counter.id}>
        <td><button type="button" class="counter-history-trigger" aria-label={`Show last 24 hours for ${item.source} counter ${item.upstreamId}`} aria-haspopup="dialog" aria-expanded={histogram?.counter.id === item.id} onclick={event => openHistogram(event, item)}>{item.source}<small>counter {item.upstreamId}</small></button></td>
        <td>{reading ? `${reading.latest.value} / ${reading.latest.durationSeconds / 60} min` : '—'}{#if reading}<small>{compactDate(reading.latest.observedAt)}</small>{/if}</td>
        <td>{reading ? Math.round(reading.latest.hourlyEquivalent!).toLocaleString() : '—'}</td>
        <td>{reading ? Math.round(reading.maximum.hourlyEquivalent!).toLocaleString() : '—'}{#if reading?.partial}<small>Partial</small>{/if}</td>
      </tr>
    {/each}
  </tbody></table></div>
</section>
{#if histogram}
  {#key histogram}
    <div class="traffic-history-popup" bind:this={popup} popover="auto" role="dialog" aria-modal="false" aria-label={`${histogram.counter.source} counter ${histogram.counter.upstreamId} · last 24 hours`} tabindex="-1" use:showHistogram
      ontoggle={event => { if (event.newState === 'closed' && event.currentTarget === popup) histogram = null; }}
      onkeydown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeHistogram(true); } else if (event.key !== 'Tab') event.stopPropagation(); }}>
      <header><strong>{histogram.counter.source} · counter {histogram.counter.upstreamId}</strong><button type="button" aria-label="Close traffic history" onclick={() => closeHistogram(true)}>×</button></header>
      {#if popupLoading}<p class="panel-note" role="status">Loading history…</p>
      {:else if popupError && !popupDetail}<p class="panel-note" role="status">{popupError}</p>
      {:else if popupDetail}
        {#if popupError || popupDetail.error || popupDetail.state === 'partial'}<p class="partial-history" role="status">Partial history{#if popupError || popupDetail.error} · {popupError || popupDetail.error}{/if}</p>{/if}
        <TrafficCountHistory history={popupHistory} window={popupDetail.window} />
      {/if}
    </div>
  {/key}
{/if}
<style>
  .traffic-reading { display: flex; align-items: baseline; gap: 6px; margin: 8px 0 4px; }
  .traffic-reading strong { color: #ef4444; font-size: 22px; font-weight: 500; }
  .traffic-reading span { color: var(--muted); font-size: 11px; }
  .traffic-reading .hourly-reading { margin-left: auto; color: var(--text); }
  .traffic-properties { margin: 4px 0 10px; }
  .traffic-properties > div { padding: 4px 0; font-size: 11px; }
  .traffic-properties dt { flex-basis: auto; }
  h4 { font-size: 11px; font-weight: 500; margin: 10px 0 4px; }
  .traffic-breakdown { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { text-align: left; padding: 5px 4px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { color: var(--muted); font-size: 10px; font-weight: 500; }
  td small { display: block; color: var(--muted); font-size: 10px; }
  .counter-summaries { margin-top: 12px; }
  .counter-history-trigger { min-height: 44px; padding: 3px 0; color: var(--text); background: transparent; font: inherit; text-align: left; }
  .counter-history-trigger:hover, .counter-history-trigger[aria-expanded=true] { color: #ef4444; }
  .counter-history-trigger:focus-visible { outline: 2px solid #ef4444; outline-offset: 2px; }
  .current { background: #ffffff03; }
  .traffic-history-popup { position: fixed; inset: auto; margin: 0; padding: 8px 10px; width: min(300px, calc(100vw - 16px)); height: 190px; max-height: calc(100dvh - 16px); overflow: auto; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 4px 14px #00101e44; }
  .traffic-history-popup::backdrop { background: transparent; }
  .traffic-history-popup header { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 2px; }
  .traffic-history-popup header strong { min-width: 0; font-size: 11px; font-weight: 500; }
  .traffic-history-popup header button { width: 24px; height: 24px; flex-shrink: 0; padding: 0; color: var(--muted); background: transparent; font-size: 20px; }
  .partial-history { color: var(--muted); font-size: 10px; line-height: 1.3; margin: 2px 0; }
</style>
