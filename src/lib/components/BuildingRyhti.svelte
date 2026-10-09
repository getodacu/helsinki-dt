<script lang="ts">
  import type { RyhtiBuilding, RyhtiCatalogState } from '#lib/ryhti-types.ts';
  import { RYHTI_FIELDS, RYHTI_PERMIT_FIELDS } from '#lib/ryhti-types.ts';
  import { knownValue } from '#lib/inspection.ts';
  import { ryhtiValue } from '#lib/ryhti-display.ts';
  let { entry, state, loading }: { entry: RyhtiBuilding | undefined; state: RyhtiCatalogState; loading: boolean } = $props();
  const fields = (names: Record<string, string>, properties: Record<string, string | number | null>) => Object.entries(names)
    .filter(([key]) => !key.endsWith('_identifier'))
    .map(([key, name]) => ({ key, name, value: ryhtiValue(properties[key]) }))
    .filter(field => knownValue(field.value));
  let registerFields = $derived(state.catalog && entry?.completed ? fields(RYHTI_FIELDS, entry.completed.properties) : []);
  let permits = $derived(state.catalog ? entry?.permits.map(permit => ({ ...permit, fields: fields(RYHTI_PERMIT_FIELDS, permit.properties),
    summary: [ryhtiValue(permit.properties.construction_action_type), ryhtiValue(permit.properties.decision_date)].filter(knownValue).join(' · ') || 'Permit'
  })).filter(permit => permit.fields.length) ?? [] : []);
</script>

{#if loading || registerFields.length || permits.length}
  <section aria-label="Building details and permits" class="ryhti-register">
    {#if loading || registerFields.length}<h4>Building details</h4>{/if}
    {#if loading}<p class="notice" role="status">Loading…</p>{:else if state.status === 'stale'}<p class="notice" role="status">Stale</p>{/if}
    {#if registerFields.length}
      <dl class="properties">{#each registerFields as field (field.key)}<div><dt>{field.name}</dt><dd>{field.value}</dd></div>{/each}</dl>
    {/if}
    {#if permits.length}
      <h4>Permits · {permits.length}</h4>
      {#each permits as permit (permit.id)}
        <details><summary>{permit.summary}</summary>
          <dl class="properties">{#each permit.fields as field (field.key)}<div><dt>{field.name}</dt><dd>{field.value}</dd></div>{/each}</dl>
        </details>
      {/each}
    {/if}
  </section>
{/if}

<style>
  .ryhti-register { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; }
  h4 { font-size: 12px; font-weight: 500; margin: 14px 0 8px; }
</style>
