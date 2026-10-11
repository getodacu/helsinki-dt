<script lang="ts">
  import EnergyHistory from './EnergyHistory.svelte';
  import ModeledDemandChart from './ModeledDemandChart.svelte';
  import ConsoleIcon from './ConsoleIcon.svelte';
  import { exactBuildingEnergy, exactBuildingSolar, propertyIsShared, latestCompletedModeledDemand, formatEnergyRecord, humanizeEnergyUsage } from '#lib/energy-display.ts';
  import { buildingName, knownValue } from '#lib/inspection.ts';
  import type { Building, EnergyRecord } from '#lib/types.ts';
  import type { EnergyCatalogState, MeasuredEnergySeries } from '#lib/energy-types.ts';
  let { building, catalogState, loadingCatalog, buildings, onmember }:
    { building: Building; catalogState: EnergyCatalogState; loadingCatalog: boolean; buildings: Building[]; onmember: (id: string) => void } = $props();
  let catalog = $derived(catalogState.catalog);
  let properties = $derived(catalog?.properties.filter(property => property.matchedBuildingIds.includes(building.id)) ?? []);
  let property = $derived(properties.length === 1 ? properties[0] : null);
  let modeledRecords = $derived(catalog?.energy.filter(record => record.method === 'modeled' && exactBuildingEnergy(record) && record.matchedBuildingIds[0] === building.id) ?? []);
  let modeled = $derived(modeledRecords.filter(record => record.value !== null && Number.isFinite(record.value)));
  let solar = $derived(catalog?.solar.filter(record => exactBuildingSolar(record) && record.matchedBuildingIds[0] === building.id && record.value !== null && Number.isFinite(record.value)) ?? []);
  let model = $derived(latestCompletedModeledDemand(modeled));
  let measured = $state.raw<MeasuredEnergySeries | null>(null);
  let loading = $state(false);
  let historyOpen = $state(false);
  let hasReadings = $derived(!!measured?.records.some(record => record.value !== null));
  let showProperty = $derived(!!property && (loading || hasReadings));
  let recordedUsage = $derived(measured?.records.reduce((sum, record) => sum + (record.value ?? 0), 0) ?? 0);
  const monthName = (date: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(date));
  function showHistory(dialog: HTMLDialogElement) {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return { destroy() { dialog.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); } };
  }
  function historyKeys(event: KeyboardEvent & { currentTarget: HTMLDialogElement }) {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  let electricityDisplay = $derived(humanizeEnergyUsage(recordedUsage));
  const memberName = (id: string) => { const member = buildings.find(item => item.id === id); return member ? buildingName(member) : 'Building'; };
  $effect(() => {
    const boundary = property;
    // Changing buildings closes the history even when they share a property.
    building.id;
    historyOpen = false; measured = null; loading = !!boundary;
    if (!boundary) return;
    const request = new AbortController();
    const params = new URLSearchParams({ property: boundary.id });
    void fetch(`/api/energy?${params}`, { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]) })
      .then(async response => {
        if (!response.ok) throw new Error(`Measured energy unavailable (${response.status}).`);
        const series = await response.json() as MeasuredEnergySeries;
        const validRecords = (records: EnergyRecord[]) => Array.isArray(records) && records.length <= 397
          && records.every(record => record && record.scope === 'property' && record.scopeId === boundary.id && record.method === 'measured'
            && record.unit === 'kWh' && record.metric === 'electricity_consumption' && record.sourceId === 'helsinki-nuuka' && record.scenario === null
            && Number.isFinite(Date.parse(record.period?.start)) && Date.parse(record.period?.end) - Date.parse(record.period?.start) === 86_400_000
            && (record.value === null || Number.isFinite(record.value)));
        if (series.property?.id !== boundary.id || series.scope !== 'property' || series.method !== 'measured' || series.unit !== 'kWh'
          || series.metric !== 'electricity_consumption' || series.resolution !== 'daily' || series.timezone !== 'Europe/Helsinki'
          || !validRecords(series.records) || !validRecords(series.historyRecords)
          || !Array.isArray(series.availableMonths) || !Array.isArray(series.availableCompleteMonths)
          || !Number.isFinite(Date.parse(series.period?.start)) || !Number.isFinite(Date.parse(series.period?.end))) throw new Error('Measured energy response could not be read.');
        return series;
      }).then(series => { if (!request.signal.aborted) measured = series; })
      .catch(() => { if (!request.signal.aborted) measured = null; })
      .finally(() => { if (!request.signal.aborted) loading = false; });
    return () => request.abort();
  });
</script>
<div class="energy-records">
  {#if showProperty || loadingCatalog}
    <section class="energy-section demand-section" aria-label="Electricity demand" aria-busy={loading || loadingCatalog}>
      <h4 class="console-section-heading"><ConsoleIcon name="energy" />Electricity demand</h4>
      {#if showProperty && property}
        <div class="energy-block" data-energy-scope="property">
          <p class="property-label">{propertyIsShared(property) ? 'Measured shared property total' : 'Measured property total'}</p>
          {#if knownValue(property.name)}<p class="panel-note"><strong>{property.name}</strong></p>{/if}
          {#if propertyIsShared(property)}<details><summary>Buildings · {property.matchedBuildingIds.length}</summary>
            <ul class="member-list">{#each property.matchedBuildingIds as id (id)}<li><button class="text-button" onclick={() => onmember(id)}>{memberName(id)}</button></li>{/each}</ul>
          </details>{/if}
          {#if measured && hasReadings}
            <p class="energy-month">{monthName(measured.period.start)}</p>
            <p class="energy-value">{electricityDisplay.value} {electricityDisplay.unit}<small>Recorded usage</small></p>
            <EnergyHistory records={measured.records} onexpand={() => historyOpen = true} />
          {:else}<p class="energy-placeholder" aria-label="Loading electricity readings">—</p>{/if}
        </div>
      {:else}<p class="energy-placeholder" aria-label="Loading electricity demand">—</p>{/if}
    </section>
  {/if}
  {#if model || loadingCatalog}
    <section class="energy-section demand-section" aria-label="Heat/hot-water demand" aria-busy={loadingCatalog}>
      <h4 class="console-section-heading"><ConsoleIcon name="energy" />Heat/hot-water demand</h4>
    {#if model && model.value !== null}
      {@const display = formatEnergyRecord(model)}
      <div class="energy-block" data-modeled-records={modeled.length}>
        <p class="energy-value">{display.value}{#if display.dailyAverage}<small title={display.dailyAverage}>{display.dailyAverage.replace(/ average$/, '')}</small>{/if}</p>
        <ModeledDemandChart records={modeledRecords} selectedId={model.id} />
      </div>
    {:else}<p class="energy-placeholder" aria-label="Loading heat and hot-water demand">—</p>{/if}
    </section>
  {/if}
  {#if solar.length || loadingCatalog}
    <section class="energy-section solar-section" aria-label="Solar energy potential" aria-busy={loadingCatalog}>
      <h4 class="console-section-heading"><ConsoleIcon name="solar" />Solar energy potential</h4>
      <div data-solar-records={solar.length} role="group" aria-label="Modeled incoming solar radiation on roof and wall surfaces">
        {#each solar as record (record.id)}
          {#if record.value !== null}
            {@const display = formatEnergyRecord(record)}
            <div class="solar-record"><p class="energy-value">{display.value}{#if display.dailyAverage}<small title={display.dailyAverage}>{display.dailyAverage.replace(/ average$/, '')}</small>{/if}</p></div>
          {/if}
        {/each}
        {#if loadingCatalog && !solar.length}<p class="energy-placeholder" aria-label="Loading solar energy potential">—</p>{/if}
      </div>
    </section>
    {/if}
  {#if historyOpen && measured && property && hasReadings}
    <dialog class="energy-history-dialog" aria-labelledby="energy-history-heading" use:showHistory onkeydown={historyKeys} onclose={() => historyOpen = false}>
      <div class="dialog-heading"><h2 id="energy-history-heading">Electricity demand</h2><button class="icon-button" aria-label="Close electricity history" onclick={event => event.currentTarget.closest('dialog')?.close()}>×</button></div>
      <p class="property-label">{propertyIsShared(property) ? 'Measured shared property total' : 'Measured property total'} · {property.name}</p>
      <EnergyHistory records={measured.historyRecords} monthly />
    </dialog>
  {/if}
</div>

<style>
  .energy-section { --energy-accent: var(--teal); margin-top: 12px; border-top: 1px solid var(--border); border-left: 2px solid var(--energy-accent); padding: 10px 0 0 10px; }
  .solar-section { --energy-accent: #efd480; }
  .console-section-heading { color: var(--energy-accent); }
  h4 { font-size: 12px; font-weight: 500; margin: 0 0 8px; }
  .energy-block { margin-top: 8px; }
  .energy-value { display: flex; align-items: baseline; gap: 6px; color: var(--energy-accent); font-size: 12px; margin: 6px 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .energy-value small { color: var(--muted); font-size: 11px; }
  .energy-month { color: var(--muted); font-size: 12px; margin-top: 10px; }
  .property-label { color: var(--muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
  .energy-placeholder { color: var(--muted); font-size: 16px; padding: 12px 0; }
  .energy-history-dialog { margin: auto; width: min(850px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 20px; overflow: auto; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
  .energy-history-dialog::backdrop { background: #00101eb3; }
  .dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  .dialog-heading h2 { font-size: 18px; font-weight: 500; }
  .dialog-heading button { min-width: 44px; min-height: 44px; }
  @media (max-width: 780px) { .energy-history-dialog { padding: 12px; } }
  .member-list { padding-left: 18px; margin: 8px 0; }
  .solar-record + .solar-record { border-top: 1px solid var(--border); padding-top: 8px; }
</style>
