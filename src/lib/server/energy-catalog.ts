import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { EnergyCatalog, EnergyCatalogState, EnergyManifest } from '../energy-types.ts';

export const ENERGY_CATALOG_MAX_BYTES = 48 * 1024 ** 2;
export const ENERGY_CITY_MANIFEST_MAX_BYTES = 1024 ** 2;
class GeometryVersionError extends Error {}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an energy object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, nullable = false): boolean {
  return nullable && value === null || typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
export function timestamp(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function day(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('Energy list exceeds its bound');
  return value;
}
function ids(value: unknown): boolean {
  const values = list(value, 1000);
  return values.every(value => text(value)) && new Set(values).size === values.length;
}
function validSource(value: unknown): boolean {
  const source = object(value);
  return ['id', 'provider', 'url', 'attribution', 'coverage', 'method'].every(key => text(source[key]))
    && ['license', 'vintage', 'coordinateReference', 'axisOrder', 'verticalReference'].every(key => text(source[key], true))
    && timestamp(source.retrievedAt) && ids(source.units) && (source.units as string[]).every(unit => !/^unknown$/i.test(unit))
    && (source.checksum === null || typeof source.checksum === 'string' && /^[a-f0-9]{64}$/.test(source.checksum))
    && typeof source.url === 'string' && source.url.startsWith('https://');
}
export function validateEnergyCatalog(value: unknown): EnergyCatalog {
  const catalog = object(value);
  if (catalog.version !== 1 || !timestamp(catalog.generatedAt) || !timestamp(catalog.cityGeneratedAt)) throw new Error('Unsupported or undated energy catalog');
  const sources = list(catalog.sources, 32), energy = list(catalog.energy, 100000), solar = list(catalog.solar, 50000);
  const properties = list(catalog.properties, 128), reports = list(catalog.reports, 32);
  if (!sources.every(validSource)) throw new Error('Invalid energy source provenance');
  const sourceIds = sources.map(value => object(value).id);
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error('Duplicate energy sources');
  const bySource = new Map(sources.map(value => { const source = object(value); return [source.id, source] as const; }));
  const recordIds = new Set<unknown>();
  for (const value of energy) {
    const record = object(value), period = object(record.period);
    if (!text(record.id) || recordIds.has(record.id) || !['building', 'property', 'meter'].includes(String(record.scope))
      || !text(record.scopeId) || !ids(record.matchedBuildingIds) || !ids(record.unmatchedSourceIds)
      || !text(record.metric) || !day(period.start) || !day(period.end) || period.start >= period.end
      || !(record.value === null || typeof record.value === 'number' && Number.isFinite(record.value))
      || !text(record.unit) || !bySource.get(record.sourceId)?.units || !(bySource.get(record.sourceId)!.units as unknown[]).includes(record.unit) || !['measured', 'modeled'].includes(String(record.method))
      || !text(record.scenario, true) || !sourceIds.includes(record.sourceId)) throw new Error('Invalid prepared energy record');
    if (record.scope === 'building' && !(record.matchedBuildingIds as unknown[]).includes(record.scopeId)
      || record.sourceId === 'helsinki-nuuka' && (record.scope !== 'property' || record.method !== 'measured' || record.metric !== 'electricity_consumption' || record.unit !== 'kWh' || record.scenario !== null || Date.parse(period.end as string) - Date.parse(period.start as string) !== 86400_000)) throw new Error('Unsupported energy scope or method');
    if (record.metric === 'heat_dhw_demand' && (record.method !== 'modeled' || record.scope !== 'building' || !text(record.scenario)
      || !(period.start as string).endsWith('-01-01') || period.end !== String(Number((period.start as string).slice(0, 4)) + 1).padStart(4, '0') + '-01-01')) throw new Error('Invalid annual modeled demand period or scenario');
    recordIds.add(record.id);
  }
  for (const value of solar) {
    const record = object(value);
    if (!text(record.id) || recordIds.has(record.id) || !['building', 'surface'].includes(String(record.scope))
      || !text(record.scopeId) || !ids(record.matchedBuildingIds) || !text(record.metric)
      || !(record.value === null || typeof record.value === 'number' && Number.isFinite(record.value))
      || !text(record.unit) || !bySource.get(record.sourceId)?.units || !(bySource.get(record.sourceId)!.units as unknown[]).includes(record.unit) || !text(record.calculationPeriod) || !text(record.vintage, true)
      || !list(record.assumptions, 100).every(value => text(value)) || !sourceIds.includes(record.sourceId)) throw new Error('Invalid prepared solar record');
    if (record.scope === 'building' && !(record.matchedBuildingIds as unknown[]).includes(record.scopeId)) throw new Error('Unsupported solar building scope');
    recordIds.add(record.id);
  }
  const propertyIds = new Set<unknown>();
  const byProperty = new Map<unknown, Record<string, unknown>>();
  for (const value of properties) {
    const property = object(value);
    if (typeof property.id !== 'string' || !/^\d{3}-\d{3}-\d{4}-\d{4}$/.test(property.id)
      || propertyIds.has(property.id) || !text(property.name) || !ids(property.memberSourceIds)
      || !ids(property.matchedBuildingIds) || !ids(property.unmatchedSourceIds)
      || typeof property.shared !== 'boolean' || property.shared !== (list(property.memberSourceIds, 1000).length > 1)
      || !sourceIds.includes('helsinki-nuuka')) throw new Error('Invalid measured property membership');
    propertyIds.add(property.id); byProperty.set(property.id, property);
  }
  for (const value of reports) {
    const report = object(value);
    if (['exactMatches', 'reviewedMatches', 'unmatchedRecords', 'ambiguousRecords', 'conflictingRecords'].reduce((sum, key) => sum + Number(report[key]), 0) !== report.recordsWithinScope) throw new Error('Energy join counts do not reconcile');
    if (!sourceIds.includes(report.sourceId) || !text(report.sourceVintage, true) || !text(report.denominator)
      || !['totalSourceRecords', 'recordsWithinScope', 'exactMatches', 'reviewedMatches', 'unmatchedRecords', 'ambiguousRecords', 'conflictingRecords', 'buildingsCovered']
        .every(key => Number.isSafeInteger(report[key]) && (report[key] as number) >= 0 && (report[key] as number) <= 10000000)
      || !list(report.notes, 100).every(value => text(value))) throw new Error('Invalid energy join report');
    for (const value of list(report.associations, 50000)) {
      const association = object(value);
      if (!text(association.sourceId) || !text(association.gmlId, true) || !text(association.vtjPrt, true)
        || !['exact', 'reviewed', 'missing', 'ambiguous', 'conflict'].includes(String(association.status))
        || !ids(association.buildingIds) || !ids(association.candidates)
        || (['missing', 'ambiguous', 'conflict'].includes(String(association.status)) && list(association.buildingIds, 1000).length)) throw new Error('Invalid energy join association');
    }
  }
  const proved = new Map<unknown, Set<unknown>>();
  for (const value of reports) {
    const report = object(value);
    if (proved.has(report.sourceId)) throw new Error('Duplicate energy join reports');
    const ids = new Set<unknown>();
    for (const value of report.associations as unknown[]) {
      const association = object(value);
      if (['exact', 'reviewed'].includes(String(association.status))) for (const id of association.buildingIds as unknown[]) ids.add(id);
    }
    if (ids.size !== report.buildingsCovered) throw new Error('Energy join building coverage does not reconcile');
    proved.set(report.sourceId, ids);
  }
  for (const value of [...energy, ...solar]) {
    const record = object(value);
    if ((record.matchedBuildingIds as unknown[]).some(id => !proved.get(record.sourceId)?.has(id))) throw new Error('Energy record has no proved identifier association');
    if (record.sourceId === 'helsinki-nuuka') {
      const property = byProperty.get(record.scopeId);
      if (!property || JSON.stringify(record.matchedBuildingIds) !== JSON.stringify(property.matchedBuildingIds)
        || JSON.stringify(record.unmatchedSourceIds) !== JSON.stringify(property.unmatchedSourceIds)) throw new Error('Prepared property energy does not match its declared membership');
    }
  }
  for (const property of byProperty.values()) {
    const report = reports.map(value => object(value)).find(report => report.sourceId === 'helsinki-nuuka');
    const members = (report?.associations as unknown[] | undefined ?? []).map(value => object(value)).filter(association => (property.memberSourceIds as unknown[]).includes(association.sourceId));
    const matches = new Set(members.filter(association => ['exact', 'reviewed'].includes(String(association.status))).flatMap(association => association.buildingIds as unknown[]));
    const unresolved = new Set(members.filter(association => ['missing', 'ambiguous', 'conflict'].includes(String(association.status))).map(association => association.sourceId));
    if ((property.matchedBuildingIds as unknown[]).some(id => !matches.has(id))
      || (property.unmatchedSourceIds as unknown[]).some(id => !unresolved.has(id))) throw new Error('Prepared property has no proved member association');
  }
  return value as EnergyCatalog;
}
function validateManifest(value: unknown): EnergyManifest {
  const manifest = object(value), asset = object(manifest.asset), refresh = object(manifest.refresh);
  if (manifest.version !== 1 || !timestamp(manifest.generatedAt) || !timestamp(refresh.attemptedAt)
    || !['current', 'failed'].includes(String(refresh.status)) || !text(refresh.message, true)
    || typeof asset.path !== 'string' || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.json$/.test(asset.path)
    || asset.path.split('/').some(part => part === '..' || part === '.')
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || !Number.isSafeInteger(asset.bytes) || (asset.bytes as number) <= 0 || (asset.bytes as number) > ENERGY_CATALOG_MAX_BYTES) throw new Error('Invalid energy manifest');
  return value as EnergyManifest;
}

/** A failed refresh never replaces the last validated generation. */
export class EnergyCatalogStore {
  private state: EnergyCatalogState = { status: 'unavailable', catalog: null, message: 'The prepared energy catalog is unavailable.', attemptedAt: null };
  private pending: Promise<void> | null = null;
  private checkedAt = -Infinity;
  private path: string;
  private now: () => number;
  constructor(path = resolve('static/data/energy-manifest.json'), now = Date.now) { this.path = path; this.now = now; }
  async load(): Promise<EnergyCatalogState> {
    if (this.pending) await this.pending;
    else if (this.now() - this.checkedAt >= 60000) {
      this.checkedAt = this.now();
      this.pending = (async () => {
        try {
          if ((await stat(this.path)).size > 16384) throw new Error('Energy manifest exceeds its byte bound');
          const manifest = validateManifest(JSON.parse(await readFile(this.path, 'utf8')));
          const base = await realpath(dirname(this.path));
          const path = await realpath(resolve(base, manifest.asset.path));
          if (!path.startsWith(base + sep) || (await stat(path)).size !== manifest.asset.bytes) throw new Error('Energy asset path or byte count mismatch');
          const bytes = await readFile(path);
          if (bytes.length > ENERGY_CATALOG_MAX_BYTES || bytes.length !== manifest.asset.bytes
            || createHash('sha256').update(bytes).digest('hex') !== manifest.asset.sha256) throw new Error('Energy asset checksum mismatch');
          const catalog = validateEnergyCatalog(JSON.parse(bytes.toString('utf8')));
          if (catalog.generatedAt !== manifest.generatedAt) throw new Error('Energy manifest generation mismatch');
          await this.checkGeometry(catalog);
          this.state = { status: manifest.refresh.status === 'failed' ? 'stale' : 'ready', catalog,
            message: manifest.refresh.status === 'failed' ? manifest.refresh.message ?? 'The static energy refresh failed; the dated catalog is retained.' : null,
            attemptedAt: manifest.refresh.attemptedAt };
        } catch (error) {
          if (error instanceof GeometryVersionError) this.state = { ...this.state, catalog: null };
          this.state = { ...this.state, status: this.state.catalog ? 'stale' : 'unavailable', attemptedAt: new Date(this.now()).toISOString(),
            message: 'The energy catalog refresh failed; ' + (error instanceof Error ? error.message : 'invalid prepared data') };
          if (!this.state.catalog && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            try {
              const path = resolve(dirname(this.path), 'energy-refresh-status.json');
              if ((await stat(path)).size > 16384) throw new Error('Energy status exceeds its byte bound');
              const failure = object(JSON.parse(await readFile(path, 'utf8')));
              if (failure.status === 'failed' && timestamp(failure.attemptedAt) && text(failure.message)) this.state = {
                ...this.state, attemptedAt: failure.attemptedAt as string, message: 'The first energy preparation failed; ' + failure.message };
            } catch { /* No validated diagnostic is available. */ }
          }
        }
      })().finally(() => { this.pending = null; });
      await this.pending;
    }
    if (this.state.catalog) {
      try { await this.checkGeometry(this.state.catalog); }
      catch (error) { this.state = { status: 'unavailable', catalog: null, attemptedAt: new Date(this.now()).toISOString(),
        message: error instanceof Error ? error.message : 'The energy geometry version could not be verified.' }; }
    }
    return this.state;
  }
  private async checkGeometry(catalog: EnergyCatalog) {
    const source = catalog.sources.find(source => source.id === 'helsinki-semantic-tiles');
    if (!source) throw new GeometryVersionError('Energy data is unavailable because its geometry source is not declared.');
    try {
      const path = resolve(dirname(this.path), 'city/manifest.json');
      if ((await stat(path)).size > ENERGY_CITY_MANIFEST_MAX_BYTES) throw new Error('The city manifest exceeds its byte bound');
      const bytes = await readFile(path);
      if (bytes.length > ENERGY_CITY_MANIFEST_MAX_BYTES) throw new Error('The city manifest exceeds its byte bound');
      const city = object(JSON.parse(bytes.toString('utf8')));
      const current = list(city.sources, 32).map(value => object(value)).find(value => value.id === source.id);
      if (city.version !== 1 || city.generatedAt !== catalog.cityGeneratedAt || !source.checksum || current?.checksum !== source.checksum || current?.vintage !== source.vintage) throw new Error('Geometry generation, source checksum or vintage mismatch');
    } catch (error) {
      throw new GeometryVersionError('Energy data is unavailable because its geometry version does not match the published city; ' + (error instanceof Error ? error.message : 'unverified geometry source'));
    }
  }
}
export const energyCatalogStore = new EnergyCatalogStore();
export const loadEnergyCatalog = () => energyCatalogStore.load();
