<script lang="ts">
  import EnergyHistory from './EnergyHistory.svelte';
  import { exactBuildingEnergy, propertyIsShared, formatEnergyDate } from '#lib/energy-display.ts';
  import { buildingName, knownValue, label } from '#lib/inspection.ts';
  import type { Building } from '#lib/types.ts';
  import type { EnergyCatalogState, MeasuredEnergySeries } from '#lib/energy-types.ts';
  let { building, catalogState, loadingCatalog, buildings, onmember }:
    { building: Building; catalogState: EnergyCatalogState; loadingCatalog: boolean; buildings: Building[]; onmember: (id: string) => void } = $props();
  let catalog = $derived(catalogState.catalog);
  let properties = $derived(catalog?.properties.filter(property => property.matchedBuildingIds.includes(building.id)) ?? []);
  let property = $derived(properties.length === 1 ? properties[0] : null);
  let modeled = $derived(catalog?.energy.filter(record => record.method === 'modeled' && exactBuildingEnergy(record) && record.matchedBuildingIds[0] === building.id && record.value !== null) ?? []);
  let solar = $derived(catalog?.solar.filter(record => record.matchedBuildingIds.length === 1 && record.matchedBuildingIds[0] === building.id && record.value !== null) ?? []);
  let unresolved = $derived(catalog?.reports.flatMap(report => report.associations.filter(association => ['ambiguous', 'conflict'].includes(association.status)
    && [...association.buildingIds, ...association.candidates].includes(building.id))) ?? []);
  let modelId = $state('');
  let model = $derived(modeled.find(record => record.id === modelId) ?? modeled[0] ?? null);
  let month = $state('');
  let measured = $state.raw<MeasuredEnergySeries | null>(null);
  let loading = $state(false);
  let error = $state('');
  let selectedMonth = $derived(month || (measured ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit' }).format(new Date(measured.period.start)) : ''));
  let hasReadings = $derived(!!measured?.records.some(record => record.value !== null));
  let showProperty = $derived(!!property && !error && (loading || !!measured && measured.status !== 'unavailable'
    && (hasReadings || measured.complete && measured.total !== null || measured.availableMonths.length > 0)));
  const value = (number: number) => number.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  const memberName = (id: string) => { const member = buildings.find(item => item.id === id); return member ? buildingName(member) : 'Building'; };
  $effect(() => {
    const boundary = property, requestedMonth = month;
    measured = null; error = ''; loading = !!boundary;
    if (!boundary) return;
    const request = new AbortController();
    const params = new URLSearchParams({ property: boundary.id });
    if (requestedMonth) params.set('month', requestedMonth);
    void fetch(`/api/energy?${params}`, { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]) })
      .then(async response => {
        if (!response.ok) throw new Error(`Measured energy unavailable (${response.status}).`);
        const series = await response.json() as MeasuredEnergySeries;
        if (series.property?.id !== boundary.id || series.scope !== 'property' || series.method !== 'measured' || series.unit !== 'kWh'
          || series.metric !== 'electricity_consumption' || series.resolution !== 'daily' || !Array.isArray(series.records)
          || !Array.isArray(series.availableMonths) || !Array.isArray(series.availableCompleteMonths)
          || !Number.isFinite(Date.parse(series.period?.start)) || !Number.isFinite(Date.parse(series.period?.end))
          || series.records.some(record => record.scope !== 'property' || record.scopeId !== boundary.id || record.method !== 'measured'
            || record.unit !== series.unit || record.metric !== series.metric || (record.value !== null && !Number.isFinite(record.value)))) throw new Error('Measured energy response could not be read.');
        return series;
      }).then(series => { if (!request.signal.aborted) measured = series; })
      .catch(reason => { if (!request.signal.aborted) error = reason instanceof Error ? reason.message : 'Measured energy unavailable.'; })
      .finally(() => { if (!request.signal.aborted) loading = false; });
    return () => request.abort();
  });
</script>
  <section class="energy-section" aria-label="Building energy and solar records">
    <h4>Energy & solar</h4>
    {#if !loadingCatalog && !showProperty && !model && !solar.length}<p class="panel-note">{error || catalogState.message || 'No verified energy or solar records are available for this building.'}</p>{/if}
    {#if loadingCatalog}<p class="notice" role="status">Loading…</p>{:else if catalogState.status === 'stale'}<p class="notice" role="status">Stale</p>{/if}
    {#if unresolved.length}<p class="notice">Unresolved energy association</p>{/if}
    {#if showProperty && property}
      <div class="energy-block" data-energy-scope="property">
        <h4>{propertyIsShared(property) ? 'Shared property electricity' : 'Property electricity'}</h4>
        {#if knownValue(property.name)}<p class="panel-note"><strong>{property.name}</strong></p>{/if}
        {#if propertyIsShared(property)}<details><summary>Buildings · {property.matchedBuildingIds.length}</summary>
          <ul class="member-list">{#each property.matchedBuildingIds as id (id)}<li><button class="text-button" onclick={() => onmember(id)}>{memberName(id)}</button></li>{/each}</ul>
        </details>{/if}
        {#if loading}<p class="notice" role="status">Loading readings…</p>{/if}
        {#if measured}
          <p class="notice" role="status">{label(measured.status)} · {measured.complete ? 'Complete month' : 'Partial month'}</p>
          {#if measured.availableMonths.length}<label class="filter-label">Energy month<select value={selectedMonth} onchange={event => month = event.currentTarget.value}>{#each measured.availableMonths as available (available)}<option value={available}>{available} · {measured.availableCompleteMonths.includes(available) ? 'complete' : 'partial'}</option>{/each}</select></label>{/if}
          <dl class="properties"><div><dt>Period</dt><dd>{formatEnergyDate(measured.period.start)} – {formatEnergyDate(measured.period.end)}</dd></div>{#if measured.complete && measured.total !== null}<div><dt>Month total</dt><dd>{value(measured.total)} {measured.unit}</dd></div>{/if}</dl>
          {#if hasReadings}{#key `${property.id}/${selectedMonth}`}<EnergyHistory records={measured.records} />{/key}{/if}
        {/if}
      </div>
    {/if}
    {#if model && model.value !== null}
      <div class="energy-block" data-modeled-records={modeled.length}>
        <h4>Modeled demand</h4>
        {#if modeled.length > 1}<label class="filter-label">Metric / period<select value={model.id} onchange={event => modelId = event.currentTarget.value}>{#each modeled as record (record.id)}<option value={record.id}>{label(record.metric)} · {record.unit}{knownValue(record.scenario) ? ` · ${record.scenario}` : ''} · {record.period.start.slice(0, 10)}</option>{/each}</select></label>{/if}
        <p class="energy-value">{value(model.value)} {model.unit}</p>
        <dl class="properties"><div><dt>Metric</dt><dd>{label(model.metric)} · {model.unit}</dd></div><div><dt>Period</dt><dd>{formatEnergyDate(model.period.start)} – {formatEnergyDate(model.period.end)}</dd></div>{#if knownValue(model.scenario)}<div><dt>Scenario</dt><dd>{model.scenario}</dd></div>{/if}</dl>
      </div>
    {/if}
    {#if solar.length}
      <div class="energy-block" data-solar-records={solar.length}>
        <h4>Modeled solar potential</h4>
        {#each solar as record (record.id)}
          {#if record.value !== null}<div class="solar-record"><p class="energy-value">{value(record.value)} {record.unit}</p>
            <dl class="properties"><div><dt>Metric</dt><dd>{label(record.metric)} · {record.unit}</dd></div>{#if knownValue(record.calculationPeriod)}<div><dt>Period</dt><dd>{record.calculationPeriod}</dd></div>{/if}</dl>
          </div>{/if}
        {/each}
      </div>
    {/if}
  </section>

<style>
  .energy-section { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; }
  h4 { font-size: 12px; font-weight: 500; margin: 0 0 8px; }
  .energy-block { margin-top: 17px; border-top: 1px solid var(--border); padding-top: 15px; }
  .energy-value { color: var(--teal); font-size: 22px; margin: 12px 0; font-variant-numeric: tabular-nums; }
  .member-list { padding-left: 18px; margin: 8px 0; }
  .solar-record + .solar-record { border-top: 1px solid var(--border); padding-top: 12px; }
</style>
