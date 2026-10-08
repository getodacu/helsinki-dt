<script lang="ts">
  import { compatibleEnergyHistory, energyChartSegments, formatEnergyDate } from '#lib/energy-display.ts';
  import { label } from '#lib/inspection.ts';
  import type { EnergyRecord } from '#lib/types.ts';
  let { records }: { records: EnergyRecord[] } = $props();
  let cursor = $state<number | null>(null);
  let history = $derived(compatibleEnergyHistory(records));
  let finite = $derived(history.filter(record => record.value !== null && Number.isFinite(record.value)));
  let first = $derived(history.length ? Date.parse(history[0].period.start) : 0);
  let last = $derived(history.length ? Date.parse(history.at(-1)!.period.end) : 1);
  let maximum = $derived(finite.length ? Math.max(1, ...finite.map(record => record.value!)) : 1);
  let point = $derived(cursor === null ? null : history[Math.min(cursor, history.length - 1)]);
  let segments = $derived(energyChartSegments(history));
  const x = (record: EnergyRecord) => 43 + (Date.parse(record.period.start) - first) / Math.max(1, last - first) * 215;
  const y = (record: EnergyRecord) => 95 - record.value! / maximum * 68;
  const day = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'UTC' : 'Europe/Helsinki', day: 'numeric', month: 'short' }).format(new Date(value));
</script>
<div class="history-section">
  <div class="history-title"><h4>Daily measured consumption</h4><span>PROPERTY</span></div>
  <p class="panel-note">{label(history[0]?.metric ?? 'electricity_consumption')} ({history[0]?.unit ?? 'kWh'}) · day, Europe/Helsinki. Null readings and missing days remain gaps.</p>
  {#if finite.length}
    <svg class="history-chart" viewBox="0 0 290 130" role="img" aria-label={`Daily measured property consumption in ${history[0].unit}`}>
      <title>Daily measured property consumption</title><desc>Horizontal axis: day in Europe/Helsinki. Vertical axis: {history[0].unit}. Missing values and missing daily intervals break the line.</desc>
      <line x1="43" y1="100" x2="258" y2="100" class="chart-axis" /><line x1="43" y1="24" x2="43" y2="100" class="chart-axis" />
      <text x="38" y="30" text-anchor="end">{maximum.toLocaleString('en-GB', { maximumFractionDigits: 1 })}</text><text x="38" y="96" text-anchor="end">0</text>
      {#each segments as segment, index (index)}
        {#if segment.length > 1}<polyline points={segment.map(record => `${x(record)},${y(record)}`).join(' ')} class="chart-line" />{:else if segment[0]}<circle cx={x(segment[0])} cy={y(segment[0])} r="2.4" class="chart-point" />{/if}
      {/each}
      {#if point}<line x1={x(point)} y1="22" x2={x(point)} y2="100" class="chart-cursor" />{#if point.value !== null}<circle cx={x(point)} cy={y(point)} r="4" class="chart-point" />{/if}{/if}
      <text x="43" y="120">{day(history[0].period.start)}</text><text x="258" y="120" text-anchor="end">{day(history.at(-1)!.period.start)}</text>
    </svg>
    <label class="history-cursor">Inspect a measured day<input type="range" min="0" max={Math.max(0, history.length - 1)} value={cursor ?? history.length - 1} oninput={event => cursor = Number(event.currentTarget.value)} aria-valuetext={point ? `${day(point.period.start)}: ${point.value ?? 'Missing'} ${point.value !== null ? point.unit : ''}` : 'Move to inspect a day'} disabled={history.length < 2} /></label>
    {#if point}<p class="history-reading">Measured day: <strong>{point.value ?? 'Missing'} {point.value !== null ? point.unit : ''}</strong><br />{formatEnergyDate(point.period.start)} – {formatEnergyDate(point.period.end)}<br /><span>Property boundary · {point.sourceId}</span></p><button class="text-button" onclick={() => cursor = null}>Clear energy history cursor</button>{/if}
  {:else}<p class="notice">No valid measured values in this month. Missing consumption is unknown.</p>{/if}
  <p class="panel-note history-independence">Transit remains live with its own report times. This energy month and cursor do not replay traffic.</p>
</div>
