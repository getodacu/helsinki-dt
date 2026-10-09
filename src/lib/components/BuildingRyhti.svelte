<script lang="ts">
  import type { RyhtiBuilding, RyhtiCatalogState } from '#lib/ryhti-types.ts';
  import { RYHTI_FIELDS, RYHTI_PERMIT_FIELDS } from '#lib/ryhti-types.ts';
  import { ryhtiValue } from '#lib/ryhti-display.ts';
  import { formatDate } from '#lib/inspection.ts';
  let { entry, state, loading }: { entry: RyhtiBuilding | undefined; state: RyhtiCatalogState; loading: boolean } = $props();
</script>

<section aria-label="Ryhti register" class="ryhti-register">
  <h4>Ryhti register</h4>
  <p class="panel-note">{loading ? 'Loading prepared Ryhti records…' : state.status === 'unavailable' ? 'Ryhti catalog unavailable.' : `Snapshot prepared ${formatDate(state.catalog?.generatedAt)}.`} {state.message ?? ''}</p>
  {#if state.catalog && entry}
    <p class="panel-note">VTJ-PRT association · {entry.vtjPrt ?? 'Identifier not supplied'} · {entry.match}</p>
    {#if entry.completed}
      <dl class="properties">
        {#each Object.entries(RYHTI_FIELDS) as [key, name] (key)}
          <div><dt>{name}</dt><dd>{ryhtiValue(entry.completed.properties[key as keyof typeof RYHTI_FIELDS])}</dd></div>
        {/each}
        <div><dt>Source modified</dt><dd>{formatDate(entry.completed.properties.modified_timestamp_utc)}</dd></div>
        <div><dt>Ryhti feature ID</dt><dd>{entry.completed.id}</dd></div>
      </dl>
      <p class="panel-note">Register completion date; municipal construction attributes are shown separately above.</p>
      <details><summary>Original Ryhti attributes and code URIs</summary><dl class="properties">
        {#each Object.entries(entry.completed.properties) as [key, value] (key)}<div><dt>{key}</dt><dd>{value ?? 'Unknown'}</dd></div>{/each}
      </dl></details>
    {:else}<p class="notice">{entry.match === 'ambiguous' || entry.match === 'conflict' ? 'Unresolved identity or conflicting records; enrichment withheld.' : 'No exact completed-building record available.'}</p>{/if}
    <h4>Linked permit records · {entry.permits.length}</h4>
    <p class="panel-note">Includes historical work. Reported permit status does not establish current construction activity; proposed attributes do not replace completed-building facts.</p>
    {#each entry.permits as permit (permit.id)}
      <details class="source-record"><summary>{permit.properties.permanent_permit_identifier ?? permit.properties.dvv_permit_identifier ?? permit.id} · {ryhtiValue(permit.properties.decision_date)}</summary>
        <dl class="properties">{#each Object.entries(RYHTI_PERMIT_FIELDS) as [key, name] (key)}<div><dt>{name}</dt><dd>{ryhtiValue(permit.properties[key as keyof typeof RYHTI_PERMIT_FIELDS])}</dd></div>{/each}
          <div><dt>Source modified</dt><dd>{formatDate(permit.properties.modified_timestamp_utc)}</dd></div><div><dt>Feature ID</dt><dd>{permit.id}</dd></div>
        </dl>
        <details><summary>Original permit attributes and code URIs</summary><dl class="properties">{#each Object.entries(permit.properties) as [key, value] (key)}<div><dt>{key}</dt><dd>{value ?? 'Unknown'}</dd></div>{/each}</dl></details>
      </details>
    {:else}<p class="panel-note">{entry.match === 'ambiguous' || entry.match === 'conflict' || !entry.vtjPrt ? 'Permit association unavailable.' : 'No linked permit records in this snapshot.'}</p>{/each}
  {/if}
  <a class="source-link" href="https://ryhti.syke.fi/en/front-page/services/" target="_blank" rel="noreferrer">Syke / Ryhti · CC BY 4.0 ↗</a>
</section>

<style>
  .ryhti-register { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; }
  h4 { font-size: 12px; font-weight: 500; margin: 14px 0 8px; }
</style>
