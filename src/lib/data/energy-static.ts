import type { Building, EnergyRecord, SolarRecord } from '../types.ts';
import type { EnergyAssociation, EnergyProperty, JoinReport } from '../energy-types.ts';
import { matchBuildingIdentity, type NuukaProperty } from './energy.ts';

export const MODEL_SOURCE = 'helsinki-modeled-demand';
export const SOLAR_SOURCE = 'helsinki-atlas-solar';
export const MODEL_YEARS = [2020, 2025, 2030, 2035, 2040, 2045, 2050] as const;
export const SOLAR_VINTAGE = '2017-08-08 export (HTTP Last-Modified; calculation/weather year unknown)';
export const SOLAR_ASSUMPTIONS = [
  'Modeled incoming direct and diffuse radiation on CityGML roof and wall surfaces; building aggregate.',
  'The source tool supports shading from modeled surroundings and terrain; exact per-run weather, terrain and vegetation configuration is not published.',
  'Annual reference calculation; weather year and calculation date unknown. Export last modified 2017-08-08.',
  'Incoming radiation in kWh, not panel capacity, electrical generation, installed panels or live production. Suitable panel area and PV yield are unavailable.'
];
export function requireSourceVersion(actual: string, verified: string, source: string) {
  if (actual !== verified) throw new Error(source + ': unreviewed source version; verify units, assumptions and identity compatibility before updating the checksum');
}
export interface SourceIdentity { sourceId: string; gmlId: string | null; vtjPrt: string | null }
export interface ModeledRow extends SourceIdentity { values: Record<string, string | number | null> }
export interface SolarBuilding extends SourceIdentity { globalRadYear: number | null; tile: string }

/** Split renderer batches repeat an identity; incompatible semantic versions must fail preparation. */
export function uniqueBuildings(buildings: Building[]): Building[] {
  const unique = new Map<string, Building>();
  for (const building of buildings) {
    const previous = unique.get(building.id);
    if (previous && ['gmlId', 'vtjPrt', 'ratu', 'uuid'].some(key => previous[key as keyof Building] !== building[key as keyof Building])) {
      throw new Error('Conflicting city identity across chunks: ' + building.id);
    }
    unique.set(building.id, building);
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function joinIdentities(rows: SourceIdentity[], buildings: Building[]): EnergyAssociation[] {
  const grouped = new Map<string, SourceIdentity[]>(), nationals = new Map<string, SourceIdentity[]>();
  for (const row of rows) {
    const key = row.gmlId ?? row.vtjPrt;
    if (key) grouped.set(key, [...(grouped.get(key) ?? []), row]);
    if (row.vtjPrt) nationals.set(row.vtjPrt, [...(nationals.get(row.vtjPrt) ?? []), row]);
  }
  return rows.map(row => {
    const match = matchBuildingIdentity(buildings, row.gmlId, row.vtjPrt);
    const duplicates = grouped.get(row.gmlId ?? row.vtjPrt ?? '') ?? [];
    const conflicting = duplicates.some(other => row.gmlId && other.gmlId && row.gmlId !== other.gmlId
      || row.vtjPrt && other.vtjPrt && row.vtjPrt !== other.vtjPrt);
    const reusedNational = row.vtjPrt && (nationals.get(row.vtjPrt)?.length ?? 0) > 1;
    const status = conflicting ? 'conflict' : (duplicates.length > 1 || reusedNational) && match.status === 'exact' ? 'ambiguous' : match.status;
    return { ...row, status, buildingIds: status === 'exact' ? match.buildingIds : [], candidates: match.candidates };
  }).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export function joinReport(sourceId: string, sourceVintage: string | null, totalSourceRecords: number,
  associations: EnergyAssociation[], covered: string[], releaseBuildingCount: number, notes: string[]): JoinReport {
  const counts = (status: EnergyAssociation['status']) => associations.filter(row => row.status === status).length;
  return { sourceId, sourceVintage, totalSourceRecords, recordsWithinScope: associations.length,
    exactMatches: counts('exact'), reviewedMatches: counts('reviewed'), unmatchedRecords: counts('missing'),
    ambiguousRecords: counts('ambiguous'), conflictingRecords: counts('conflict'), buildingsCovered: new Set(covered).size,
    denominator: `${releaseBuildingCount} unique release buildings; source counts are original source rows within the declared preparation scope`,
    associations, notes };
}

export function prepareModeled(rows: ModeledRow[], buildings: Building[]) {
  const associations = joinIdentities(rows.map(({ sourceId, gmlId, vtjPrt }) => ({ sourceId, gmlId, vtjPrt })), buildings);
  const byId = new Map(associations.map(row => [row.sourceId, row]));
  const energy: EnergyRecord[] = [];
  for (const row of [...rows].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    const association = byId.get(row.sourceId)!;
    if (association.status !== 'exact') continue;
    for (const year of MODEL_YEARS) {
      const prefix = year === 2020 ? 'SQ' : 'CC', field = `${prefix}_${year}_Total_Yearly_Heat_DHW_demand`;
      if (!(field in row.values)) throw new Error('Modeled annual field missing: ' + field);
      const raw = row.values[field];
      if (raw !== null && raw !== 'non calculated' && !(typeof raw === 'number' && Number.isFinite(raw) && raw >= 0)) {
        throw new Error('Invalid modeled annual demand: ' + field);
      }
      energy.push({ id: `${row.sourceId}:${field}`, scope: 'building', scopeId: row.gmlId ?? row.vtjPrt!,
        matchedBuildingIds: [...association.buildingIds], unmatchedSourceIds: [], metric: 'heat_dhw_demand',
        period: { start: `${year}-01-01`, end: `${year + 1}-01-01` }, value: typeof raw === 'number' ? raw : null,
        unit: 'kWh', method: 'modeled', scenario: year === 2020 ? '2020 baseline (SQ)' : 'Climate change (CC)', sourceId: MODEL_SOURCE });
    }
  }
  return { energy, associations };
}

export function prepareSolar(rows: SolarBuilding[], buildings: Building[]) {
  const associations = joinIdentities(rows.map(({ sourceId, gmlId, vtjPrt }) => ({ sourceId, gmlId, vtjPrt })), buildings);
  const byId = new Map(associations.map(row => [row.sourceId, row]));
  const solar: SolarRecord[] = [];
  for (const row of [...rows].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    const match = byId.get(row.sourceId)!;
    if (match.status !== 'exact') continue;
    if (row.globalRadYear !== null && (!Number.isFinite(row.globalRadYear) || row.globalRadYear < 0)) throw new Error('Invalid annual solar radiation');
    solar.push({ id: `${row.sourceId}:globalRadYear`, scope: 'building', scopeId: row.gmlId!, matchedBuildingIds: [...match.buildingIds],
      metric: 'global_solar_radiation', value: row.globalRadYear, unit: 'kWh', calculationPeriod: 'annual reference calculation (weather year unknown)',
      vintage: SOLAR_VINTAGE, assumptions: [...SOLAR_ASSUMPTIONS], sourceId: SOLAR_SOURCE });
  }
  return { solar, associations };
}

export function prepareProperty(property: NuukaProperty, buildings: Building[]) {
  const rows = property.buildings.map(member => ({ sourceId: member.buildingCode || 'location:' + member.locationName,
    gmlId: null, vtjPrt: member.buildingCode || null }));
  const associations = joinIdentities(rows, buildings);
  const result: EnergyProperty = { id: property.propertyCode, name: property.locationName,
    memberSourceIds: rows.map(row => row.sourceId).sort(), matchedBuildingIds: [...new Set(associations.flatMap(row => row.buildingIds))].sort(),
    unmatchedSourceIds: associations.filter(row => row.status !== 'exact').map(row => row.sourceId).sort(), shared: rows.length > 1 };
  return { property: result, associations };
}
