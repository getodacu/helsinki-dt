<script lang="ts">
  import EnergyHistory from './EnergyHistory.svelte';
  import { exactBuildingEnergy, propertyIsShared, formatEnergyDate } from '#lib/energy-display.ts';
  import { buildingName, formatDate, label } from '#lib/inspection.ts';
  import type { Building } from '#lib/types.ts';
  import type { EnergyCatalogState, MeasuredEnergySeries } from '#lib/energy-types.ts';
  let { building, catalogState, loadingCatalog, buildings, onmember, onsources }:
    { building: Building; catalogState: EnergyCatalogState; loadingCatalog: boolean; buildings: Building[]; onmember: (id: string) => void; onsources: () => void } = $props();
  let catalog = $derived(catalogState.catalog);
  let properties = $derived(catalog?.properties.filter(property => property.matchedBuildingIds.includes(building.id)) ?? []);
  let property = $derived(properties.length === 1 ? properties[0] : null);
  let modeled = $derived(catalog?.energy.filter(record => record.method === 'modeled' && exactBuildingEnergy(record) && record.matchedBuildingIds[0] === building.id) ?? []);
  let solar = $derived(catalog?.solar.filter(record => record.matchedBuildingIds.length === 1 && record.matchedBuildingIds[0] === building.id) ?? []);
  let unresolved = $derived(catalog?.reports.flatMap(report => report.associations.filter(association => ['ambiguous', 'conflict'].includes(association.status)
    && [...association.buildingIds, ...association.candidates].includes(building.id)).map(association => ({ ...association, dataset: report.sourceId }))) ?? []);
  let modelId = $state('');
  let model = $derived(modeled.find(record => record.id === modelId) ?? modeled[0] ?? null);
  let month = $state('');
  let measured = $state.raw<MeasuredEnergySeries | null>(null);
  let loading = $state(false);
  let error = $state('');
  let selectedMonth = $derived(month || (measured ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit' }).format(new Date(measured.period.start)) : ''));
  const source = (id: string) => catalog?.sources.find(item => item.id === id);
  const value = (number: number | null) => number === null ? 'Unknown' : number.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  const memberName = (id: string) => { const member = buildings.find(item => item.id === id); return member ? buildingName(member) : id; };
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
  <h4>Energy & solar records</h4>
  {#if loadingCatalog}<p class="notice" role="status">Loading the prepared energy and solar catalog…</p>{:else if catalogState.status !== 'ready'}<p class="notice" role="status">{catalogState.status === 'stale' ? 'Dated prepared catalog retained' : 'Energy catalog unavailable'} · {catalogState.message}</p>{/if}
  {#if !catalog}<p class="panel-note">{loadingCatalog ? 'Coverage is not yet known while the catalog loads.' : 'No verified energy or solar catalog is available for this selection.'}</p>{:else}
    {#each unresolved as association, index (index)}<p class="notice">{label(association.status)} association in {association.dataset}. No value or theme is attached through this association.</p>{/each}
    <div class="energy-block" data-energy-scope={property ? 'property' : properties.length > 1 ? 'ambiguous' : 'absent'}>
      <h4>Measured electricity consumption</h4>
      {#if properties.length > 1}<p class="notice">Multiple property associations are present. The measurement boundary is ambiguous; no consumption chart is shown.</p>
      {:else if property}
        <p class="panel-note"><strong>{property.name}</strong> · Nuuka property {property.id}</p>
        {#if propertyIsShared(property)}<p class="notice">Shared property total. This meter boundary covers {property.memberSourceIds.length} declared building members: {property.matchedBuildingIds.length} verified matches and {property.unmatchedSourceIds.length} unresolved members. The same total is shown once for this property; it is not allocated to this building or used for building colors.</p>{:else}<p class="panel-note">Measured at the property boundary. No building-level allocation is supplied.</p>{/if}
        <details><summary>Property members and original identifiers</summary>
          <ul class="member-list">{#each property.matchedBuildingIds as id (id)}<li><button class="text-button" onclick={() => onmember(id)}>{memberName(id)}</button></li>{/each}</ul>
          <p class="panel-note">Declared VTJ-PRT members: {property.memberSourceIds.join(', ') || 'Unknown'}</p>
          {#if property.unmatchedSourceIds.length}<p class="notice">Unmatched declared members: {property.unmatchedSourceIds.join(', ')}. Their consumption remains within the property total.</p>{/if}
        </details>
        {#if loading}<p class="notice" role="status">Loading the {month || 'latest complete available'} month of daily property readings…</p>{/if}
        {#if error}<p class="notice" role="status">{error}</p>{/if}
        {#if measured}
          <p class="notice" role="status">{label(measured.status)} · {measured.message ?? (measured.complete ? 'Complete month of daily measured readings.' : 'Partial month. A full monthly total is unavailable.')}</p>
          {#if measured.availableMonths.length}<label class="filter-label">Energy month<select value={selectedMonth} onchange={event => month = event.currentTarget.value}>{#each measured.availableMonths as available (available)}<option value={available}>{available} · {measured.availableCompleteMonths.includes(available) ? 'complete' : 'partial'}</option>{/each}</select></label>{/if}
          <dl class="properties"><div><dt>Period</dt><dd>{formatEnergyDate(measured.period.start)} – {formatEnergyDate(measured.period.end)}<small>Europe/Helsinki · end exclusive</small></dd></div><div><dt>Metric</dt><dd>{label(measured.metric)}</dd></div><div><dt>Method / scope</dt><dd>Measured · property · daily</dd></div><div><dt>Month total</dt><dd>{measured.complete && measured.total !== null ? `${value(measured.total)} ${measured.unit}` : 'Unknown — incomplete month'}</dd></div><div><dt>Retrieved</dt><dd>{formatDate(measured.retrievedAt)}</dd></div><div><dt>Last check</dt><dd>{formatDate(measured.lastAttemptAt)}</dd></div><div><dt>Source</dt><dd>{measured.source?.provider ?? 'Nuuka'}<small>{measured.source?.id ?? 'Unknown source reference'}</small></dd></div></dl>
          {#if measured.records.length}{#key `${property.id}/${selectedMonth}`}<EnergyHistory records={measured.records} />{/key}{/if}
          {#if measured.source}<a class="source-link" href={measured.source.url} target="_blank" rel="noreferrer">Measured source reference ↗</a>{/if}
        {/if}
      {:else}<p class="panel-note">No verified municipal property association for this building. No measured consumption is inferred.</p>{/if}
    </div>
    <div class="energy-block" data-modeled-records={modeled.length}>
      <h4>Modeled demand</h4>
      {#if model}
        {#if modeled.length > 1}<label class="filter-label">Modeled metric / period<select value={model.id} onchange={event => modelId = event.currentTarget.value}>{#each modeled as record (record.id)}<option value={record.id}>{label(record.metric)} · {record.unit} · {record.scenario ?? 'scenario unspecified'} · {record.period.start.slice(0, 10)}</option>{/each}</select></label>{/if}
        <p class="energy-value">{value(model.value)} {model.value !== null ? model.unit : ''}</p>
        <dl class="properties"><div><dt>Metric / unit</dt><dd>{label(model.metric)} · {model.unit}</dd></div><div><dt>Method / scope</dt><dd>Modeled · building</dd></div><div><dt>Period</dt><dd>{formatEnergyDate(model.period.start)} – {formatEnergyDate(model.period.end)}<small>End exclusive</small></dd></div><div><dt>Scenario</dt><dd>{model.scenario ?? 'Unknown — not supplied'}</dd></div><div><dt>Source / vintage</dt><dd>{source(model.sourceId)?.provider ?? model.sourceId}<small>{source(model.sourceId)?.vintage ?? 'Unknown vintage'}</small></dd></div></dl>
        <p class="panel-note">Model assumptions: {source(model.sourceId)?.method ?? 'Unknown — not supplied.'}</p>
        {#if source(model.sourceId)}<a class="source-link" href={source(model.sourceId)!.url} target="_blank" rel="noreferrer">Modeled demand source ↗</a>{/if}
      {:else}<p class="panel-note">No exact building-level modeled demand record for this building.</p>{/if}
    </div>
    <div class="energy-block" data-solar-records={solar.length}>
      <h4>Modeled solar potential</h4><p class="panel-note">Reference model potential. These records do not establish installed panels or current production.</p>
      {#each solar as record (record.id)}
        <div class="solar-record"><p class="energy-value">{value(record.value)} {record.value !== null ? record.unit : ''}</p>
          <dl class="properties"><div><dt>Metric / unit</dt><dd>{label(record.metric)} · {record.unit}</dd></div><div><dt>Method / scope</dt><dd>Modeled potential · {record.scope}</dd></div><div><dt>Calculation</dt><dd>{record.calculationPeriod}</dd></div><div><dt>Vintage</dt><dd>{record.vintage ?? 'Unknown — not supplied'}</dd></div><div><dt>Source</dt><dd>{source(record.sourceId)?.provider ?? record.sourceId}</dd></div></dl>
          <p class="panel-note">Assumptions: {record.assumptions.join(' ') || source(record.sourceId)?.method || 'Unknown — not supplied.'}</p>
          {#if source(record.sourceId)}<a class="source-link" href={source(record.sourceId)!.url} target="_blank" rel="noreferrer">Solar potential source ↗</a>{/if}
        </div>
      {:else}<p class="panel-note">No exact building-level solar potential record for this building.</p>{/each}
    </div>
    <button class="text-button" onclick={onsources}>Energy source metadata & join coverage</button>
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
