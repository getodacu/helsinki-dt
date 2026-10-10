import type { DatasetSource, EnergyRecord, SolarRecord } from './types.ts';

export interface EnergyProperty {
  id: string;
  name: string;
  memberSourceIds: string[];
  matchedBuildingIds: string[];
  unmatchedSourceIds: string[];
  shared: boolean;
}
export interface EnergyAssociation {
  sourceId: string;
  gmlId: string | null;
  vtjPrt: string | null;
  status: 'exact' | 'reviewed' | 'missing' | 'ambiguous' | 'conflict';
  buildingIds: string[];
  candidates: string[];
}
export interface JoinReport {
  sourceId: string;
  sourceVintage: string | null;
  totalSourceRecords: number;
  recordsWithinScope: number;
  exactMatches: number;
  reviewedMatches: number;
  unmatchedRecords: number;
  ambiguousRecords: number;
  conflictingRecords: number;
  buildingsCovered: number;
  denominator: string;
  associations: EnergyAssociation[];
  notes: string[];
}
export interface EnergyCatalog {
  version: 1;
  generatedAt: string;
  cityGeneratedAt: string;
  sources: DatasetSource[];
  energy: EnergyRecord[];
  solar: SolarRecord[];
  properties: EnergyProperty[];
  reports: JoinReport[];
}
export interface EnergyManifest {
  version: 1;
  generatedAt: string;
  asset: { path: string; sha256: string; bytes: number };
  refresh: { status: 'current' | 'failed'; attemptedAt: string; message: string | null };
}
export interface EnergyCatalogState {
  status: 'ready' | 'stale' | 'unavailable';
  catalog: EnergyCatalog | null;
  message: string | null;
  attemptedAt: string | null;
}
export interface MeasuredEnergySeries {
  status: 'current' | 'stale' | 'empty' | 'unavailable';
  property: EnergyProperty;
  metric: 'electricity_consumption';
  unit: 'kWh';
  method: 'measured';
  scope: 'property';
  period: { start: string; end: string };
  timezone: 'Europe/Helsinki';
  resolution: 'daily';
  records: EnergyRecord[];
  historyRecords: EnergyRecord[];
  complete: boolean;
  total: number | null;
  availableMonths: string[];
  availableCompleteMonths: string[];
  source: DatasetSource | null;
  retrievedAt: string | null;
  lastAttemptAt: string | null;
  message: string | null;
}
