import type { DatasetSource } from './types.ts';

export const RYHTI_COLLECTIONS = {
  completed: 'https://paikkatiedot.ymparisto.fi/geoserver/ryhti_building/ogc/features/v1/collections/open_building/items',
  permits: 'https://paikkatiedot.ymparisto.fi/geoserver/ryhti_permit/ogc/features/v1/collections/open_permit_building/items'
} as const;
export const RYHTI_FIELDS = {
  main_purpose: 'Use', completion_date: 'Completion date', number_of_storeys: 'Floors',
  construction_method: 'Construction method', material_of_load_bearing_structures: 'Structural material',
  facade_material: 'Facade material', heating_method: 'Heating method', heating_energy_source: 'Heating energy source',
  usage_status: 'Usage status', demolition_date: 'Demolition date'
} as const;
export const RYHTI_PERMIT_FIELDS = {
  permanent_permit_identifier: 'Permanent permit ID', dvv_permit_identifier: 'VTJ permit ID',
  construction_action_type: 'Action', status_of_construction_action: 'Reported status', decision_date: 'Decision date',
  start_date: 'Start date', completion_date: 'Completion date', expiry_date: 'Expiry date'
} as const;
export type RyhtiProperties = { permanent_building_identifier: string; modified_timestamp_utc: string | null }
  & { [K in Exclude<keyof typeof RYHTI_FIELDS | keyof typeof RYHTI_PERMIT_FIELDS, 'number_of_storeys'>]: string | null }
  & { number_of_storeys: number | null };
export interface RyhtiRecord { id: string; properties: RyhtiProperties }
export interface RyhtiBuilding {
  buildingId: string; vtjPrt: string | null; match: 'exact' | 'missing' | 'ambiguous' | 'conflict';
  completed: RyhtiRecord | null; permits: RyhtiRecord[];
}
export interface RyhtiCatalog {
  version: 1; generatedAt: string; cityGeneratedAt: string; cityManifestSha256: string;
  sources: DatasetSource[]; buildings: RyhtiBuilding[];
  coverage: { totalBuildings: number; queriedIdentifiers: number; missingIdentifiers: number;
    completedBuildings: number; permitBuildings: number; ambiguousBuildings: number; conflictingBuildings: number;
    completedSourceRecords: number; permitSourceRecords: number };
}
export interface RyhtiManifest {
  version: 1; generatedAt: string; asset: { path: string; sha256: string; bytes: number };
}
export interface RyhtiCatalogState {
  status: 'ready' | 'stale' | 'unavailable'; catalog: RyhtiCatalog | null; message: string | null; attemptedAt: string | null;
}
