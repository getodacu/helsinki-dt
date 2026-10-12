<script lang="ts">
  import { type TrafficCount } from '#lib/traffic-measurements.ts';
  import { formatDate } from '#lib/inspection.ts';
  let { history, window = null }: { history: TrafficCount[]; window?: { start: string; end: string } | null } = $props();
  let cursor = $state<number | null>(null);
  let finite = $derived(history.filter(row => row.complete && row.value !== null && row.hourlyEquivalent !== null && Number.isFinite(row.hourlyEquivalent)));
  let first = $derived(window ? Date.parse(window.start) : history.length ? Date.parse(history[0].observedAt) : 0);
  let last = $derived(window ? Date.parse(window.end) : history.length ? Date.parse(history.at(-1)!.observedAt) : 1);
  let maximum = $derived(Math.max(1, ...finite.map(row => row.hourlyEquivalent ?? 0)));
  let point = $derived(history[Math.min(cursor ?? history.length - 1, history.length - 1)]);
  const x = (row: TrafficCount) => 32 + (Date.parse(row.observedAt) - first) / Math.max(1, last - first) * 226;
  const y = (row: TrafficCount) => 100 - (row.hourlyEquivalent ?? 0) / maximum * 74;
  const barWidth = (row: TrafficCount) => Math.max(1, Math.min(12, row.durationSeconds * 1000 / Math.max(1, last - first) * 226 * .8));
  const reading = (row?: TrafficCount) => !row?.complete || row.value === null || row.hourlyEquivalent === null ? 'Missing' : `${row.value} / ${row.durationSeconds / 60} min (${Math.round(row.hourlyEquivalent!)} / h)`;
  const time = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const inspect = (event: PointerEvent & { currentTarget: EventTarget & HTMLDivElement }) => {
    const matrix = event.currentTarget.querySelector('svg')?.getScreenCTM();
    if (!matrix) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const timestamp = first + Math.max(0, Math.min(1, (position.x - 32) / 226)) * (last - first);
    let nearest = 0;
    for (let i = 1; i < history.length; i++) if (Math.abs(Date.parse(history[i].observedAt) - timestamp) < Math.abs(Date.parse(history[nearest].observedAt) - timestamp)) nearest = i;
    cursor = nearest;
  };
  const inspectKey = (event: KeyboardEvent) => {
    const current = Math.min(cursor ?? history.length - 1, history.length - 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') cursor = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') cursor = Math.min(history.length - 1, current + 1);
    else if (event.key === 'Home') cursor = 0;
    else if (event.key === 'End') cursor = history.length - 1;
    else return;
    event.preventDefault(); event.stopPropagation();
  };
</script>
<section class="history-section" aria-label="Traffic count history">
  <div class="history-title"><h4>Last 24 hours</h4><span>/ H · HELSINKI</span></div>
  {#if history.length}
    <div class="traffic-chart" role="slider" tabindex="0" aria-label="Traffic count history" aria-valuemin={0} aria-valuemax={history.length - 1}
      aria-valuenow={Math.min(cursor ?? history.length - 1, history.length - 1)} aria-valuetext={`${formatDate(point?.observedAt)}: ${reading(point)}`}
      onpointermove={event => { if (event.pointerType !== 'touch') inspect(event); }} onpointerleave={event => { if (document.activeElement !== event.currentTarget) cursor = null; }}
      onpointerup={event => { if (event.pointerType === 'touch') { event.currentTarget.focus({ preventScroll: true }); inspect(event); } }} onkeydown={inspectKey}>
      <svg class="history-chart" viewBox="0 0 290 130" role="img" aria-label="Hourly-equivalent traffic volume over the last 24 hours">
        <title>Traffic counts per hour equivalent</title><desc>Original intervals are preserved. Bars show hourly equivalents at measured times; missing or incomplete readings remain gaps. Zero readings appear on the baseline.</desc>
        <line x1="32" y1="100" x2="258" y2="100" class="chart-axis" />
        <text x="3" y="26">{Math.round(maximum)}</text><text x="8" y="96">0</text>
        {#each finite as row, index (index)}
          {#if row.hourlyEquivalent === 0}
            <line class="zero-reading" x1={x(row) - barWidth(row) / 2} x2={x(row) + barWidth(row) / 2} y1="100" y2="100"><title>{reading(row)}</title></line>
          {:else}
            <rect class="traffic-bar" x={x(row) - barWidth(row) / 2} y={y(row)} width={barWidth(row)} height={100 - y(row)}><title>{reading(row)}</title></rect>
          {/if}
        {/each}
        {#if point}<line x1={x(point)} y1="22" x2={x(point)} y2="100" class="chart-cursor" />{/if}
        <text x="32" y="120">{time(window?.start ?? history[0].observedAt)}</text><text x="258" y="120" text-anchor="end">{time(window?.end ?? history.at(-1)!.observedAt)}</text>
      </svg>
      <p class="panel-note" aria-live="polite">{reading(point)}<br />{formatDate(point?.observedAt)} · Europe/Helsinki</p>
    </div>
  {:else}<p class="panel-note">No complete counts for this mode in the last 24 hours.</p>{/if}
</section>
<style>
  .history-section { margin: 0; padding: 0; border: 0; }
  .history-title h4 { font-size: 11px; margin: 0; }
  .history-title span { font-size: 9px; }
  .traffic-chart { user-select: none; }
  .traffic-chart:focus-visible { outline: 2px solid #ef4444; outline-offset: 2px; }
  .traffic-chart .history-chart { margin-top: 2px; max-height: 96px; }
  .traffic-bar { fill: #ef4444; }
  .zero-reading { stroke: #ef4444; stroke-width: 2; }
  .panel-note { font-size: 10px; line-height: 1.4; margin: 2px 0 0; }
</style>
