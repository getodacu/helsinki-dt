<script lang="ts">
  import { chartSegments, nearestHistoryIndex } from '#lib/observations.ts';
  import { formatDate } from '#lib/inspection.ts';
  import type { Observation } from '#lib/types.ts';
  let { history, parameter, hours }: { history: Observation[]; parameter: string; hours: number } = $props();
  let cursor = $state<number | null>(null);
  let finite = $derived(history.filter(item => item.value !== null && Number.isFinite(item.value)));
  let latest = $derived(finite.at(-1));
  let first = $derived(history.length ? Date.parse(history[0].observedAt) : 0);
  let last = $derived(history.length ? Date.parse(history.at(-1)!.observedAt) : 1);
  let minimum = $derived(finite.length ? Math.min(...finite.map(item => item.value!)) : 0);
  let maximum = $derived(finite.length ? Math.max(...finite.map(item => item.value!)) : 1);
  const x = (item: Observation) => 30 + (Date.parse(item.observedAt) - first) / Math.max(1, last - first) * 230;
  const y = (item: Observation) => 95 - (item.value! - minimum) / Math.max(1, maximum - minimum) * 68;
  let segments = $derived(chartSegments(history));
  let point = $derived(cursor === null ? null : history[Math.min(cursor, history.length - 1)]);
  const unit = (value?: string) => value === 'degC' ? '°C' : value ?? '';
  const reading = (item?: Observation | null) => item && item.value !== null && Number.isFinite(item.value) ? `${item.value} ${unit(item.unit)}` : 'Missing';
  const time = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const inspectPointer = (event: PointerEvent & { currentTarget: EventTarget & HTMLDivElement }) => {
    const matrix = event.currentTarget.querySelector('svg')?.getScreenCTM();
    if (!matrix) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    cursor = position.x < 30 || position.x > 260 || position.y < 22 || position.y > 100
      ? null : nearestHistoryIndex(history, first + (position.x - 30) / 230 * (last - first));
  };
  const inspectKey = (event: KeyboardEvent) => {
    const current = cursor ?? history.length - 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') cursor = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') cursor = Math.min(history.length - 1, current + 1);
    else if (event.key === 'Home') cursor = 0;
    else if (event.key === 'End') cursor = history.length - 1;
    else if (event.key === 'Escape' && cursor !== null) cursor = null;
    else return;
    event.preventDefault(); event.stopPropagation();
  };
</script>
<section class="history-section station-sensor" aria-label={parameter}>
  <div class="history-title"><h4>{parameter}</h4><span>≤{hours} HOURS</span></div>
  <div class="latest-reading"><strong>{latest ? reading(latest) : 'Unknown'}</strong>{#if latest && latest !== history.at(-1)}<span>Last valid</span>{/if}</div>
  {#if history.length}
    <div class="station-chart" role="slider" tabindex="0" aria-label={`${parameter} observation history`} aria-valuemin={0} aria-valuemax={history.length - 1} aria-valuenow={Math.min(cursor ?? history.length - 1, history.length - 1)} aria-valuetext={`${formatDate(point?.observedAt ?? history.at(-1)?.observedAt)}: ${reading(point ?? history.at(-1))}`}
      onpointermove={event => { if (event.pointerType !== 'touch') inspectPointer(event); }} onpointerleave={event => { if (event.pointerType !== 'touch') cursor = null; }}
      onpointerup={event => { if (event.pointerType === 'touch') { event.currentTarget.focus({ preventScroll: true }); inspectPointer(event); } }}
      onfocus={() => cursor ??= history.length - 1} onblur={() => cursor = null} onkeydown={inspectKey}>
      <svg class="history-chart" viewBox="0 0 290 130" role="img" aria-label={`${parameter} station observations over the recent ${hours}-hour window`}>
        <title>{parameter} recent station observations</title><desc>Values are station measurements. Lines stop at missing readings and missing intervals.</desc>
        <line x1="30" y1="100" x2="260" y2="100" class="chart-axis" />
        {#if finite.length}
          <text x="4" y="30">{maximum.toFixed(1)}</text><text x="4" y="96">{minimum.toFixed(1)}</text>
        {:else}<text x="145" y="65" text-anchor="middle">No valid values in this history window.</text>{/if}
        {#each segments as segment, index (index)}
          {#if segment.length > 1}<polyline points={segment.map(item => `${x(item)},${y(item)}`).join(' ')} class="chart-line" />{:else if segment[0]}<circle cx={x(segment[0])} cy={y(segment[0])} r="2.4" class="chart-point" />{/if}
        {/each}
        {#if point}<line x1={x(point)} y1="22" x2={x(point)} y2="100" class="chart-cursor" />{#if point.value !== null && Number.isFinite(point.value)}<circle cx={x(point)} cy={y(point)} r="4" class="chart-point" />{/if}{/if}
        <text x="30" y="120">{time(history[0].observedAt)}</text><text x="260" y="120" text-anchor="end">{time(history.at(-1)!.observedAt)}</text>
      </svg>
      {#if point}<div class="station-tooltip" role="tooltip" style:left={`clamp(90px, ${x(point) / 290 * 100}%, calc(100% - 90px))`}><strong>{reading(point)}</strong><span>{formatDate(point.observedAt)}<br />Europe/Helsinki</span></div>{/if}
    </div>
  {:else}<p class="panel-note">No valid values in this history window.</p>{/if}
  <dl class="properties sensor-properties"><div><dt>Received</dt><dd>{formatDate(latest?.receivedAt)}</dd></div><div><dt>Aggregation</dt><dd>{latest?.aggregation ?? 'Unknown — not supplied'}</dd></div></dl>
</section>

<style>
  .latest-reading { display: flex; align-items: baseline; gap: 8px; }
  .latest-reading strong { font-size: 20px; font-weight: 500; color: var(--teal); }
  .latest-reading span { font-size: 10px; color: var(--muted); }
  .station-chart { position: relative; max-width: 400px; margin-inline: auto; user-select: none; }
  .station-chart:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .history-chart { max-height: none; }
  .station-tooltip { position: absolute; z-index: 2; top: 6px; width: 180px; max-width: 100%; padding: 7px 10px; transform: translateX(-50%); pointer-events: none; color: #eaf0ef; background: #071c27; border: 1px solid #547b79; border-radius: 4px; box-shadow: 0 4px 12px #00101e66; font-size: 10px; line-height: 1.5; }
  .station-tooltip strong, .station-tooltip span { display: block; }
  .station-tooltip strong { font-size: 14px; font-weight: 500; }
  .station-tooltip span { color: var(--muted); }
  .sensor-properties { margin-bottom: 8px; }
</style>
