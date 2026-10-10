<script lang="ts">
  import { modeledDemandSegments, humanizeEnergyUsage, formatEnergyRecord } from '#lib/energy-display.ts';
  import type { EnergyRecord } from '#lib/types.ts';
  let { records, selectedId }: { records: EnergyRecord[]; selectedId: string } = $props();
  const years = [2020, 2025, 2030, 2035, 2040, 2045, 2050];
  let selected = $derived(records.find(record => record.id === selectedId));
  let segments = $derived(selected ? modeledDemandSegments(records, selected) : []);
  let points = $derived(segments.flat());
  let maximum = $derived(Math.max(0, ...points.map(record => record.value!)) || 1);
  let active = $derived(points.find(record => record.id === selectedId));
  const year = (record: EnergyRecord) => Number(record.period.start.slice(0, 4));
  const x = (year: number) => 54 + (year - 2020) / 30 * 241;
  const y = (record: EnergyRecord) => 110 - record.value! / maximum * 78;
  let axis = $derived(humanizeEnergyUsage(maximum));
  let tooltipId = $state('');
</script>

<div class="demand-chart">
  {#if points.length}
    <svg class="history-chart" viewBox="0 0 320 145" role="group" aria-label={`Modeled annual heating and hot-water demand, 2020–2050, in ${axis.unit} per year`}>
      <title>Modeled heating and hot-water demand, 2020–2050</title>
      <desc>Horizontal axis: scenario year. Vertical axis: annual demand in {axis.unit} per year. Points show the supplied five-year estimates; missing estimates break the line. The latest completed model year is highlighted. Hover or focus a year to read its value.</desc>
      <line x1="54" y1="110" x2="295" y2="110" class="chart-axis" />
      <line x1="54" y1="28" x2="54" y2="110" class="chart-axis" />
      <text x="45" y="36" text-anchor="end">{axis.value}</text><text x="45" y="113" text-anchor="end">0</text>
      {#each segments as segment, index (index)}
        {#if segment.length > 1}<polyline points={segment.map(record => `${x(year(record))},${y(record)}`).join(' ')} class="chart-line" />{/if}
      {/each}
      {#if active}<line x1={x(year(active))} y1="28" x2={x(year(active))} y2="110" class="chart-cursor" />{/if}
      {#each points as record (record.id)}
        {@const value = `${year(record)} · ${formatEnergyRecord(record).value}`}
        <!-- Keyboard focus exposes the chart value tooltip. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <g class="demand-point" tabindex="0" role="img" aria-label={`${value} · ${record.scenario}`}
          onpointerenter={() => tooltipId = record.id} onpointerleave={() => tooltipId = ''}
          onfocus={() => tooltipId = record.id} onblur={() => tooltipId = ''}>
          <rect x={x(year(record)) - 20} y="28" width="40" height="82" fill="transparent" />
          <circle cx={x(year(record))} cy={y(record)} r={record.id === selectedId ? 4 : 2.5} class="chart-point" class:selected-point={record.id === selectedId} />
          <g class="chart-tooltip" class:visible={tooltipId === record.id} transform={`translate(${Math.max(8, Math.min(156, x(year(record)) - 78))},${y(record) - 28})`}>
            <rect width="156" height="22" rx="3" />
            <text x="78" y="15" text-anchor="middle">{value}</text>
          </g>
        </g>
      {/each}
      {#each years as year (year)}<text x={x(year)} y="134" text-anchor="middle">{year}</text>{/each}
    </svg>
  {:else}<p class="notice">No comparable demand projections are available.</p>{/if}
</div>

<style>
  .demand-chart { margin-top: 4px; }
  .history-chart text { font-size: 12px; }
  .selected-point { stroke: #eaf0ef; stroke-width: 1.5; }
  .demand-point { outline: none; }
  .demand-point:focus-visible circle { stroke: #eaf0ef; stroke-width: 2; }
  .chart-tooltip { visibility: hidden; pointer-events: none; }
  .chart-tooltip.visible { visibility: visible; }
  .chart-tooltip rect { fill: #102733; stroke: var(--border); }
  .chart-tooltip text { fill: #eaf0ef; }
</style>
