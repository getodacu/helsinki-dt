import { matchBuildingIdentity } from './energy.ts';
import { RYHTI_FIELDS, RYHTI_PERMIT_FIELDS, type RyhtiRecord, type RyhtiProperties, type RyhtiCatalog, type RyhtiBuilding } from '../ryhti-types.ts';
import type { Building, DatasetSource } from '../types.ts';

export const RYHTI_MAX_BYTES = 64_000_000;
export function ryhtiObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Ryhti object');
  return value as Record<string, unknown>;
}
export const ryhtiTimestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
export const ryhtiIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 1000;
const dateFields = new Set(['completion_date', 'demolition_date', 'decision_date', 'start_date', 'expiry_date']);
export function ryhtiDate(value: string): string {
  const date = value.replace(/Z$/, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Invalid Ryhti calendar date');
  return date;
}
export function decodeRyhtiRecord(value: unknown): RyhtiRecord {
  const row = ryhtiObject(value), raw = ryhtiObject(row.properties);
  if (!text(row.id) || !row.id || !ryhtiIdentifier(raw.permanent_building_identifier)) throw new Error('Invalid Ryhti identity');
  const properties: Record<string, string | number | null> = { permanent_building_identifier: raw.permanent_building_identifier };
  for (const key of new Set([...Object.keys(RYHTI_FIELDS), ...Object.keys(RYHTI_PERMIT_FIELDS), 'modified_timestamp_utc'])) {
    const value = raw[key] === '' || raw[key] === undefined ? null : raw[key];
    if (value !== null) {
      if (key === 'number_of_storeys') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) throw new Error('Invalid Ryhti floor count');
      } else {
        if (!text(value)) throw new Error('Invalid Ryhti attribute: ' + key);
        if (dateFields.has(key)) ryhtiDate(value);
        if (key === 'modified_timestamp_utc' && !ryhtiTimestamp(value)) throw new Error('Invalid Ryhti modification date');
      }
    }
    properties[key] = value as string | number | null;
  }
  return { id: row.id, properties: properties as RyhtiProperties };
}
export function uniqueRyhtiRecords(records: RyhtiRecord[]): RyhtiRecord[] {
  const unique = new Map<string, RyhtiRecord>();
  for (const row of records) {
    const previous = unique.get(row.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Conflicting Ryhti feature: ' + row.id);
    unique.set(row.id, row);
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function prepareRyhtiCatalog(buildings: Building[], completedRows: RyhtiRecord[], permitRows: RyhtiRecord[],
  city: { generatedAt: string; sha256: string }, sources: DatasetSource[], generatedAt = new Date().toISOString()): RyhtiCatalog {
  const completed = uniqueRyhtiRecords(completedRows), permits = uniqueRyhtiRecords(permitRows);
  const byPrt = (rows: RyhtiRecord[]) => {
    const map = new Map<string, RyhtiRecord[]>();
    for (const row of rows) { const id = row.properties.permanent_building_identifier; map.set(id, [...(map.get(id) ?? []), row]); }
    return map;
  };
  const completedByPrt = byPrt(completed), permitsByPrt = byPrt(permits);
  const matches = new Map([...new Set(buildings.flatMap(b => b.vtjPrt ? [b.vtjPrt] : []))]
    .map(id => [id, matchBuildingIdentity(buildings, null, id)]));
  const entries = buildings.map((building): RyhtiBuilding => {
    const vtjPrt = building.vtjPrt, identity = vtjPrt ? matches.get(vtjPrt) : null;
    const rows = vtjPrt ? completedByPrt.get(vtjPrt) ?? [] : [];
    const linkedPermits = vtjPrt ? permitsByPrt.get(vtjPrt) ?? [] : [];
    const match = !identity ? 'missing' : identity.status !== 'exact' ? identity.status
      : rows.length > 1 ? 'conflict' : rows.length || linkedPermits.length ? 'exact' : 'missing';
    return { buildingId: building.id, vtjPrt, match, completed: match === 'exact' ? rows[0] ?? null : null,
      permits: match === 'exact' ? linkedPermits.sort((a, b) => (b.properties.decision_date ?? '').localeCompare(a.properties.decision_date ?? '') || a.id.localeCompare(b.id)) : [] };
  });
  return { version: 1, generatedAt, cityGeneratedAt: city.generatedAt, cityManifestSha256: city.sha256, sources, buildings: entries,
    coverage: { totalBuildings: buildings.length, queriedIdentifiers: matches.size, missingIdentifiers: buildings.filter(b => !b.vtjPrt).length,
      completedBuildings: entries.filter(b => b.completed).length, permitBuildings: entries.filter(b => b.permits.length).length,
      ambiguousBuildings: entries.filter(b => b.match === 'ambiguous').length, conflictingBuildings: entries.filter(b => b.match === 'conflict').length,
      completedSourceRecords: completed.length, permitSourceRecords: permits.length } };
}
export function validateRyhtiCatalog(value: unknown): RyhtiCatalog {
  const catalog = ryhtiObject(value);
  if (catalog.version !== 1 || !ryhtiTimestamp(catalog.generatedAt) || !ryhtiTimestamp(catalog.cityGeneratedAt)
    || typeof catalog.cityManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(catalog.cityManifestSha256)
    || !Array.isArray(catalog.buildings) || catalog.buildings.length > 50000
    || !Array.isArray(catalog.sources) || catalog.sources.length !== 2) throw new Error('Invalid Ryhti catalog');
  for (const item of catalog.sources) {
    const source = ryhtiObject(item);
    if (!['ryhti-completed', 'ryhti-permits'].includes(String(source.id)) || !text(source.provider) || !text(source.attribution)
      || !text(source.url) || !source.url.startsWith('https://paikkatiedot.ymparisto.fi/') || source.license !== 'CC BY 4.0'
      || !['coverage', 'method'].every(key => text(source[key]))
      || !['vintage', 'coordinateReference', 'axisOrder', 'verticalReference'].every(key => source[key] === null || text(source[key]))
      || !Array.isArray(source.units) || source.units.length > 20 || !source.units.every(text)
      || !ryhtiTimestamp(source.retrievedAt) || !text(source.checksum) || !/^[a-f0-9]{64}$/.test(source.checksum)) throw new Error('Invalid Ryhti source');
  }
  if (new Set(catalog.sources.map(source => source.id)).size !== 2) throw new Error('Duplicate Ryhti sources');
  const ids = new Set<string>(), nationalIds = new Map<string, number>(); let permits = 0;
  for (const item of catalog.buildings) {
    const row = ryhtiObject(item);
    if (typeof row.vtjPrt === 'string') nationalIds.set(row.vtjPrt, (nationalIds.get(row.vtjPrt) ?? 0) + 1);
  }
  for (const item of catalog.buildings) {
    const row = ryhtiObject(item);
    if (!text(row.buildingId) || !row.buildingId || ids.has(row.buildingId) || !(row.vtjPrt === null || ryhtiIdentifier(row.vtjPrt))
      || !['exact', 'missing', 'ambiguous', 'conflict'].includes(String(row.match))
      || !Array.isArray(row.permits) || row.permits.length > 1000 || row.completed === undefined
      || (row.match !== 'exact' && (row.completed !== null || row.permits.length))) throw new Error('Invalid Ryhti building join');
    ids.add(row.buildingId); permits += row.permits.length;
    if (permits > 100000) throw new Error('Too many Ryhti permits');
    const records = [...(row.completed === null ? [] : [row.completed]), ...row.permits];
    if (row.match === 'exact' && (!records.length || nationalIds.get(String(row.vtjPrt)) !== 1)) throw new Error('Unproved Ryhti exact join');
    const recordIds = new Set<string>();
    for (const record of records) {
      const decoded = decodeRyhtiRecord(record);
      const original = ryhtiObject(ryhtiObject(record).properties);
      if (Object.keys(decoded.properties).some(key => !(key in original))) throw new Error('Incomplete Ryhti catalog record');
      if (decoded.properties.permanent_building_identifier !== row.vtjPrt || recordIds.has(decoded.id)) throw new Error('Invalid Ryhti record association');
      recordIds.add(decoded.id);
    }
  }
  const result = value as RyhtiCatalog, coverage = ryhtiObject(catalog.coverage);
  for (const key of ['totalBuildings', 'queriedIdentifiers', 'missingIdentifiers', 'completedBuildings', 'permitBuildings', 'ambiguousBuildings', 'conflictingBuildings', 'completedSourceRecords', 'permitSourceRecords']) {
    if (!Number.isSafeInteger(coverage[key]) || (coverage[key] as number) < 0 || (coverage[key] as number) > 100000) throw new Error('Invalid Ryhti coverage');
  }
  if (coverage.totalBuildings !== ids.size || coverage.completedBuildings !== result.buildings.filter(b => b.completed).length
    || coverage.permitBuildings !== result.buildings.filter(b => b.permits.length).length
    || coverage.missingIdentifiers !== result.buildings.filter(b => !b.vtjPrt).length
    || coverage.queriedIdentifiers !== new Set(result.buildings.flatMap(b => b.vtjPrt ? [b.vtjPrt] : [])).size
    || coverage.ambiguousBuildings !== result.buildings.filter(b => b.match === 'ambiguous').length
    || coverage.conflictingBuildings !== result.buildings.filter(b => b.match === 'conflict').length) throw new Error('Ryhti coverage mismatch');
  return result;
}
