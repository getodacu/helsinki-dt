import type { Building, SampleManifest } from './types.ts';
import type { BuildingPhoto } from './building-photo.ts';
import type { EnergyCatalogState } from './energy-types.ts';
import type { RyhtiCatalogState } from './ryhti-types.ts';
import type { EnergyThemeOption } from './energy-display.ts';

export interface EntityTheme {
  key: string;
  energy: EnergyThemeOption | null;
  minimum: number | null;
  maximum: number | null;
  count: number;
  categories: { key: string; label: string; colour: string; count: number }[];
}
export interface EntityCatalog {
  version: 1;
  status: 'ready' | 'stale';
  message: string | null;
  generation: string;
  generatedAt: string;
  cityGeneratedAt: string;
  cityManifestSha256: string;
  buildingCount: number;
  energy: EnergyCatalogState;
  ryhti: RyhtiCatalogState;
  themes: EntityTheme[];
  foundation: SampleManifest | null;
}
export interface EntitySearch {
  generation: string;
  buildings: Building[];
  nextCursor: string | null;
}
export interface EntityDetail {
  generation: string;
  building: Building;
  members: Building[];
  energy: EnergyCatalogState;
  ryhti: RyhtiCatalogState;
}
export interface EntityThemeValues {
  generation: string;
  key: string;
  values: [buildingId: string, colour: string, category: string | null][];
}

export interface EntityPhoto {
  generation: string;
  buildingId: string;
  photo: BuildingPhoto | null;
}
