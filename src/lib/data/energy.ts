import type { Building, EnergyRecord } from '../types.ts';

export interface IdentifierMatch {
  status: 'exact' | 'missing' | 'ambiguous' | 'conflict';
  buildingIds: string[];
  candidates: string[];
}

/** A conflicting declared GMLID must not silently fall back to a different national identifier. */
export function matchBuildingIdentity(buildings: Building[], gmlId: string | null, vtjPrt: string | null): IdentifierMatch {
  const candidates = gmlId ? buildings.filter(building => building.gmlId === gmlId)
    : vtjPrt ? buildings.filter(building => building.vtjPrt === vtjPrt) : [];
  if (!candidates.length) return { status: 'missing', buildingIds: [], candidates: [] };
  if (candidates.length > 1) return { status: 'ambiguous', buildingIds: [], candidates: candidates.map(b => b.id).sort() };
  if (vtjPrt && candidates[0].vtjPrt && candidates[0].vtjPrt !== vtjPrt) {
    return { status: 'conflict', buildingIds: [], candidates: [candidates[0].id] };
  }
  return { status: 'exact', buildingIds: [candidates[0].id], candidates: [candidates[0].id] };
}

export interface NuukaProperty {
  locationName: string;
  propertyCode: string;
  buildings: { locationName: string; buildingCode: string; longitude: string; latitude: string }[];
}
export interface NuukaRow {
  timestamp: string;
  reportingGroup: string;
  locationName: string;
  value: number | null;
  unit: string;
}

export function decodeNuukaProperty(payload: unknown, expectedCode: string): NuukaProperty {
  if (!Array.isArray(payload) || payload.length !== 1) throw new Error('Expected one Nuuka property');
  const property = payload[0] as NuukaProperty;
  if (!property || property.propertyCode !== expectedCode || typeof property.locationName !== 'string'
    || !Array.isArray(property.buildings) || property.buildings.length > 100
    || property.buildings.some(building => !building || typeof building.locationName !== 'string'
      || typeof building.buildingCode !== 'string' || typeof building.longitude !== 'string'
      || typeof building.latitude !== 'string' || !Number.isFinite(Number(building.longitude))
      || !Number.isFinite(Number(building.latitude)))) throw new Error('Malformed Nuuka property metadata');
  return property;
}

export function normalizeNuukaEnergy(payload: unknown, property: NuukaProperty, buildings: Building[]) {
  if (!Array.isArray(payload) || payload.length > 31) throw new Error('Nuuka daily sample exceeds row limit');
  const matches = property.buildings.map(member => ({ sourceId: member.buildingCode || 'location:' + member.locationName,
    ...matchBuildingIdentity(buildings, null, member.buildingCode || null) }));
  const matchedBuildingIds = [...new Set(matches.flatMap(match => match.buildingIds))].sort();
  const unmatchedSourceIds = matches.filter(match => match.status !== 'exact').map(match => match.sourceId).sort();
  const records: EnergyRecord[] = [];
  const seen = new Set<string>();
  for (const value of payload) {
    const row = value as NuukaRow;
    if (!row || typeof row.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.timestamp)
      || row.reportingGroup !== 'Electricity' || row.locationName !== property.locationName || row.unit !== 'kWh'
      || !(row.value === null || typeof row.value === 'number' && Number.isFinite(row.value))) {
      throw new Error('Malformed Nuuka energy row or unverified unit/scope');
    }
    const day = row.timestamp.slice(0, 10);
    const next = new Date(day + 'T00:00:00Z');
    if (!Number.isFinite(next.getTime()) || next.toISOString().slice(0, 10) !== day) throw new Error('Invalid Nuuka date');
    next.setUTCDate(next.getUTCDate() + 1);
    const id = 'nuuka:' + property.propertyCode + ':Electricity:' + day;
    if (seen.has(id)) throw new Error('Duplicate Nuuka property/day energy row');
    seen.add(id);
    records.push({ id, scope: 'property', scopeId: property.propertyCode, matchedBuildingIds: [...matchedBuildingIds],
      unmatchedSourceIds: [...unmatchedSourceIds], metric: 'electricity_consumption',
      period: { start: day, end: next.toISOString().slice(0, 10) }, value: row.value, unit: row.unit,
      method: 'measured', scenario: null, sourceId: 'helsinki-nuuka' });
  }
  return { records, matches, hasMeasuredAssociation: records.some(record =>
    record.value !== null && Number.isFinite(record.value) && record.matchedBuildingIds.length > 0) };
}
