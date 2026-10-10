<script lang="ts">
  import { compatibleEnergyHistory, energyChartSegments, monthlyEnergyUsage, humanizeEnergyUsage } from '#lib/energy-display.ts';
  import type { EnergyRecord } from '#lib/types.ts';
  let { records, onexpand, monthly = false }: { records: EnergyRecord[]; onexpand?: () => void; monthly?: boolean } = $props();
  let history = $derived(compatibleEnergyHistory(records));
  let finite = $derived(history.filter(record => record.value !== null && Number.isFinite(record.value)));
  let first = $derived(history.length ? Date.parse(history[0].period.start) : 0);
  let last = $derived(history.length ? Date.parse(history.at(-1)!.period.end) : 1);
  let maximum = $derived(finite.length ? Math.max(1, ...finite.map(record => record.value!)) : 1);
  let segments = $derived(energyChartSegments(history));
  let ticks = $derived(history.length > 31
    ? [history[0], history[Math.floor(history.length / 2)], history.at(-1)!]
    : history.length ? [history[0], history.at(-1)!] : []);
  const x = (record: EnergyRecord) => 43 + (Date.parse(record.period.start) - first) / Math.max(1, last - first) * 215;
  const y = (record: EnergyRecord) => 95 - record.value! / maximum * 68;
  const dateLabel = (date: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC',
    ...(history.length > 31 ? {} : { day: 'numeric' as const }), month: 'short', year: 'numeric' }).format(new Date(date));
  let months = $derived(monthly ? monthlyEnergyUsage(records) : []);
  let monthlyMaximum = $derived.by(() => {
    const value = Math.max(1, ...months.map(month => month.value ?? 0));
    const step = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / step) * step;
  });
  const monthLabel = (month: string, full = false) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: full ? 'long' : 'short', ...(full ? { year: 'numeric' as const } : {})
  }).format(new Date(`${month}-01T00:00:00Z`));
  let chartAxis = $derived(humanizeEnergyUsage(monthly ? monthlyMaximum : maximum));
  let axisDivisor = $derived(chartAxis.unit === 'GWh' ? 1_000_000 : chartAxis.unit === 'MWh' ? 1_000 : 1);
  const axisValue = (value: number) => (value / axisDivisor).toLocaleString('en-GB', { maximumFractionDigits: 2 });
</script>
{#snippet plot()}
  <svg class="history-chart" viewBox="0 0 290 130" role="img" aria-label={`Daily measured property consumption in ${chartAxis.unit}`}>
    <title>Daily measured property consumption</title><desc>Horizontal axis: calendar dates in Europe/Helsinki. Vertical axis: {chartAxis.unit}. Missing values and missing daily intervals break the line.</desc>
    <line x1="43" y1="100" x2="258" y2="100" class="chart-axis" /><line x1="43" y1="24" x2="43" y2="100" class="chart-axis" />
    <text x="38" y="30" text-anchor="end">{chartAxis.value}</text><text x="38" y="96" text-anchor="end">0</text>
    {#each segments as segment, index (index)}
      {#if segment.length > 1}<polyline points={segment.map(record => `${x(record)},${y(record)}`).join(' ')} class="chart-line" />{:else if segment[0]}<circle cx={x(segment[0])} cy={y(segment[0])} r="2.4" class="chart-point" />{/if}
    {/each}
    {#each ticks as record, index (index)}<text x={index === ticks.length - 1 ? 258 : x(record)} y="120" text-anchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}>{dateLabel(record.period.start)}</text>{/each}
  </svg>
{/snippet}
{#if finite.length}
  <div class="history-section">
    {#if monthly}
      <div class="monthly-title"><h4>Recorded monthly usage</h4><span>{chartAxis.unit}</span></div>
      <div class="monthly-chart" role="group" aria-label={`Monthly recorded property electricity in ${chartAxis.unit}. Bars sum available daily readings; missing months remain gaps.`}>
        <div class="monthly-plot">
          {#each [1, 0.5, 0] as fraction (fraction)}
            <div class="monthly-gridline" style:bottom={`${fraction * 100}%`}><span>{axisValue(monthlyMaximum * fraction)}</span></div>
          {/each}
          <div class="monthly-columns" style:grid-template-columns={`repeat(${months.length}, minmax(0, 1fr))`}>
            {#each months as month, index (month.month)}
              {#if month.value !== null}
                {@const display = humanizeEnergyUsage(month.value)}
                <button class="month-column" aria-label={`${monthLabel(month.month, true)}: ${display.value} ${display.unit} recorded`}
                  onclick={event => event.currentTarget.focus()}>
                  <span class="month-bar" style:height={`max(2px, ${month.value / monthlyMaximum * 100}%)`}></span>
                  <span class="month-tooltip" role="tooltip" style:left={`clamp(80px, ${(index + 0.5) / months.length * 100}%, calc(100% - 80px))`}>
                    <span>{monthLabel(month.month, true)}</span><strong>{display.value} <small>{display.unit}</small></strong>
                  </span>
                </button>
              {:else}<div class="month-gap" aria-label={`${monthLabel(month.month, true)}: no readings`}><span>—</span></div>{/if}
            {/each}
          </div>
        </div>
        <div class="monthly-labels" style:grid-template-columns={`repeat(${months.length}, minmax(0, 1fr))`} aria-hidden="true">
          {#each months as month, index (month.month)}<span><span>{monthLabel(month.month)}</span><small>{index === 0 || month.month.endsWith('-01') ? month.month.slice(0, 4) : ''}</small></span>{/each}
        </div>
      </div>
    {:else}
      <div class="history-title"><h4>Daily property electricity</h4><span>{chartAxis.unit}</span></div>
      {#if onexpand}<button class="history-expand" onclick={onexpand} aria-label="View electricity history" aria-haspopup="dialog">{@render plot()}</button>{:else}{@render plot()}{/if}
    {/if}
  </div>
{/if}

<style>
  .history-expand { display: block; width: 100%; padding: 0; background: transparent; text-align: left; }
  .history-chart { max-height: none; }
  .monthly-title { display: flex; justify-content: space-between; align-items: baseline; margin: 18px 0 24px; color: var(--muted); }
  .monthly-title h4 { margin: 0; color: #d6e6e5; font-size: 12px; font-weight: 500; }
  .monthly-title > span { font-size: 10px; }
  .monthly-chart { font-variant-numeric: tabular-nums; }
  .monthly-plot { position: relative; height: 176px; margin-left: 44px; }
  .monthly-gridline { position: absolute; width: 100%; border-top: 1px solid #a4c7c51a; }
  .monthly-gridline span { position: absolute; right: calc(100% + 10px); transform: translateY(-50%); color: var(--muted); font-size: 10px; }
  .monthly-columns { position: absolute; inset: 0; display: grid; gap: 2px; }
  .month-column, .month-gap { display: flex; align-items: flex-end; justify-content: center; min-width: 0; padding: 0; border: 0; border-radius: 0; background: transparent; }
  .month-bar { display: block; width: 68%; max-width: 32px; background: #7fc8bc; border-radius: 2px 2px 0 0; }
  .month-column:hover, .month-column:focus { background: #a4d9d00a; }
  .month-column:hover .month-bar, .month-column:focus .month-bar { background: #b3ece0; }
  .month-column:focus-visible { outline: 1px solid var(--teal); outline-offset: 1px; }
  .month-tooltip { display: none; position: absolute; z-index: 1; top: 8px; width: 160px; padding: 9px 12px; transform: translateX(-50%); pointer-events: none; text-align: left; color: #eaf0ef; background: #071c27; border: 1px solid #547b79; border-radius: 4px; box-shadow: 0 4px 12px #00101e66; font-size: 11px; font-weight: 400; line-height: 1.5; }
  .month-tooltip > span, .month-tooltip > strong { display: block; }
  .month-tooltip strong { font-size: 14px; font-weight: 500; }
  .month-tooltip small { font-size: 10px; color: #b6cccb; }
  .month-column:hover .month-tooltip, .month-column:focus .month-tooltip { display: block; }
  .month-gap { color: var(--muted); font-size: 10px; }
  .monthly-labels { display: grid; gap: 2px; margin: 9px 0 0 44px; color: #b6cccb; font-size: 10px; text-align: center; }
  .monthly-labels small { display: block; min-height: 14px; margin-top: 3px; color: var(--muted); font-size: 9px; }
  @media (max-width: 480px) {
    .monthly-labels { margin-top: 14px; font-size: 9px; }
    .monthly-labels > span > span { display: block; line-height: 1; transform: rotate(-55deg); }
    .monthly-labels small { margin-top: 10px; }
    .monthly-columns, .monthly-labels { gap: 0; }
    .monthly-plot { height: 156px; }
  }
</style>
