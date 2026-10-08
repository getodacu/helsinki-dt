<script lang="ts">
  import { chartSegments } from '#lib/observations.ts';
  import { formatDate } from '#lib/inspection.ts';
  import type { Observation } from '#lib/types.ts';
  let { history, parameter, hours }: { history: Observation[]; parameter: string; hours: number } = $props();
  let cursor = $state<number | null>(null);
  let finite = $derived(history.filter(item => item.value !== null));
  let first = $derived(history.length ? Date.parse(history[0].observedAt) : 0);
  let last = $derived(history.length ? Date.parse(history.at(-1)!.observedAt) : 1);
  let minimum = $derived(finite.length ? Math.min(...finite.map(item => item.value!)) : 0);
  let maximum = $derived(finite.length ? Math.max(...finite.map(item => item.value!)) : 1);
  const x = (item: Observation) => 30 + (Date.parse(item.observedAt) - first) / Math.max(1, last - first) * 230;
  const y = (item: Observation) => 95 - (item.value! - minimum) / Math.max(1, maximum - minimum) * 68;
  let segments = $derived(chartSegments(history));
  let point = $derived(cursor === null ? null : history[Math.min(cursor, history.length - 1)]);
  const time = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
</script>
<div class="history-section">
  <div class="history-title"><h4>Recent station history</h4><span>≤{hours} HOURS</span></div>
  <p class="panel-note">{parameter} ({history.find(item => item.unit)?.unit ?? 'Unknown unit'}) · observed time, Europe/Helsinki. Null readings and missing intervals remain gaps.</p>
  {#if finite.length}
    <svg class="history-chart" viewBox="0 0 290 130" role="img" aria-label={`${parameter} station observations over the recent ${hours}-hour window`}>
      <title>{parameter} recent station observations</title><desc>Values are station measurements. Lines stop at missing readings and missing intervals.</desc>
      <line x1="30" y1="100" x2="260" y2="100" class="chart-axis" />
      <text x="4" y="30">{maximum.toFixed(1)}</text><text x="4" y="96">{minimum.toFixed(1)}</text>
      {#each segments as segment, index (index)}
        {#if segment.length > 1}<polyline points={segment.map(item => `${x(item)},${y(item)}`).join(' ')} class="chart-line" />{:else if segment[0]}<circle cx={x(segment[0])} cy={y(segment[0])} r="2.4" class="chart-point" />{/if}
      {/each}
      {#if point}<line x1={x(point)} y1="22" x2={x(point)} y2="100" class="chart-cursor" />{#if point.value !== null}<circle cx={x(point)} cy={y(point)} r="4" class="chart-point" />{/if}{/if}
      <text x="30" y="120">{time(history[0].observedAt)}</text><text x="260" y="120" text-anchor="end">{time(history.at(-1)!.observedAt)}</text>
    </svg>
    <label class="history-cursor">Inspect an observed time<input type="range" min="0" max={Math.max(0, history.length - 1)} value={cursor ?? history.length - 1} oninput={event => cursor = Number(event.currentTarget.value)} aria-valuetext={point ? `${formatDate(point.observedAt)}: ${point.value ?? 'Missing'} ${point.value !== null ? point.unit : ''}` : 'Move to inspect an observed time'} disabled={history.length < 2} /></label>
    {#if point}<p class="history-reading">Historical observation: <strong>{point.value ?? 'Missing'} {point.value !== null ? point.unit : ''}</strong><br />{formatDate(point.observedAt)}<br /><span>Quality: {point.quality ?? 'Unknown'} · aggregation: {point.aggregation ?? 'Unknown'}</span></p><button class="text-button" onclick={() => cursor = null}>Clear history cursor</button>{/if}
  {:else}<p class="notice">No valid values in this bounded history window.</p>{/if}
  <p class="panel-note history-independence">Transit remains live with its own report times. A historical cursor does not represent the vehicles shown now.</p>
</div>
