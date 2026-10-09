import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { buildingAddress, buildingName, searchText } from '../src/lib/inspection.ts';
import { buildingEnergyTheme, energyThemeOptions } from '../src/lib/energy-display.ts';
import { RYHTI_THEMES, ryhtiCategory, ryhtiTheme } from '../src/lib/ryhti-display.ts';
import { validBuilding, type CityManifest } from '../src/lib/city-assets.ts';
import type { Building, SampleManifest } from '../src/lib/types.ts';
import type { EnergyCatalogState, EnergyAssociation } from '../src/lib/energy-types.ts';
import type { RyhtiCatalogState } from '../src/lib/ryhti-types.ts';
import type { EntityCatalog, EntityTheme } from '../src/lib/entity-types.ts';

export const entityHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface EntityInput {
  generation: string; city: CityManifest; cityManifestSha256: string; buildings: Building[];
  energy: EnergyCatalogState; ryhti: RyhtiCatalogState; foundation: SampleManifest | null;
}
function byBuilding<T>(rows: T[], ids: (row: T) => string[]) {
  const result = new Map<string, T[]>();
  for (const row of rows) for (const id of new Set(ids(row))) {
    const list = result.get(id) ?? []; list.push(row); result.set(id, list);
  }
  return result;
}

/** Offline only: validate and materialize bounded read responses before publication. */
export function buildEntityDatabase(path: string, input: EntityInput): EntityCatalog {
  const { city, energy, ryhti } = input;
  const buildings = new Map<string, Building>();
  for (const building of input.buildings) {
    if (!validBuilding(building, building.chunkRef, city) || !city.chunks.some(chunk => chunk.id === building.chunkRef)) throw new Error('Invalid entity building');
    const previous = buildings.get(building.id);
    if (previous && JSON.stringify({ ...previous, chunkRef: '' }) !== JSON.stringify({ ...building, chunkRef: '' })) throw new Error('Conflicting building identity: ' + building.id);
    if (!previous) buildings.set(building.id, building);
  }
  if (!buildings.size || buildings.size > 50_000) throw new Error('Invalid entity count');
  const catalog: EntityCatalog = {
    version: 1, status: 'ready', message: null, generation: input.generation, generatedAt: new Date().toISOString(), cityGeneratedAt: city.generatedAt,
    cityManifestSha256: input.cityManifestSha256, buildingCount: buildings.size, foundation: input.foundation,
    energy: { ...energy, catalog: energy.catalog ? { ...energy.catalog, energy: [], solar: [], properties: [],
      reports: energy.catalog.reports.map(report => ({ ...report, associations: [] })) } : null },
    ryhti: { ...ryhti, catalog: ryhti.catalog ? { ...ryhti.catalog, buildings: [] } : null }, themes: []
  };
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE buildings (id TEXT PRIMARY KEY, search_text TEXT NOT NULL, data TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE identifiers (value TEXT NOT NULL, building_id TEXT NOT NULL REFERENCES buildings(id), PRIMARY KEY(value,building_id));
      CREATE VIRTUAL TABLE building_search USING fts5(text, tokenize='trigram');
      CREATE TABLE chunks (id TEXT PRIMARY KEY);
      CREATE TABLE building_chunks (chunk_id TEXT NOT NULL REFERENCES chunks(id), building_id TEXT NOT NULL REFERENCES buildings(id), PRIMARY KEY(chunk_id,building_id));
      CREATE TABLE theme_values (theme TEXT NOT NULL, building_id TEXT NOT NULL REFERENCES buildings(id), colour TEXT NOT NULL, category TEXT, PRIMARY KEY(theme,building_id));
      CREATE INDEX theme_categories ON theme_values(theme,category,building_id);
      BEGIN IMMEDIATE;`);
    const insert = db.prepare('INSERT INTO buildings(id,search_text,data,detail) VALUES(?,?,?,?)');
    const identifier = db.prepare('INSERT OR IGNORE INTO identifiers VALUES(?,?)');
    const fts = db.prepare('INSERT INTO building_search(rowid,text) VALUES(?,?)');
    const members = db.prepare('INSERT OR IGNORE INTO building_chunks VALUES(?,?)');
    const chunks = db.prepare('INSERT INTO chunks VALUES(?)');
    for (const chunk of city.chunks) chunks.run(chunk.id);
    const modeled = byBuilding(energy.catalog?.energy ?? [], row => row.matchedBuildingIds);
    const solar = byBuilding(energy.catalog?.solar ?? [], row => row.matchedBuildingIds);
    const properties = byBuilding(energy.catalog?.properties ?? [], row => row.matchedBuildingIds);
    const associations = (energy.catalog?.reports ?? []).map(report => byBuilding<EnergyAssociation>(report.associations,
      row => [...row.buildingIds, ...row.candidates]));
    const ryhtiById = new Map(ryhti.catalog?.buildings.map(row => [row.buildingId, row]) ?? []);
    for (const building of buildings.values()) {
      const ids = [building.id, building.gmlId, building.vtjPrt, building.ratu, building.uuid].filter((id): id is string => !!id);
      const text = searchText([buildingName(building), buildingAddress(building), ...ids].filter(Boolean).join(' '));
      const detail = JSON.stringify({ energy: modeled.get(building.id) ?? [], solar: solar.get(building.id) ?? [],
        properties: properties.get(building.id) ?? [], associations: associations.map(rows => rows.get(building.id) ?? []),
        ryhti: ryhtiById.get(building.id) ?? null });
      if (Buffer.byteLength(detail) > 1_000_000 || Buffer.byteLength(JSON.stringify(building)) > 32_000) throw new Error('Entity detail exceeds response bound: ' + building.id);
      const row = insert.run(building.id, text, JSON.stringify(building), detail);
      fts.run(row.lastInsertRowid, text);
      for (const id of ids) identifier.run(searchText(id), building.id);
    }
    for (const building of input.buildings) members.run(building.chunkRef, building.id);
    const colour = db.prepare('INSERT INTO theme_values VALUES(?,?,?,?)');
    for (const option of energyThemeOptions(energy.catalog)) {
      const result = buildingEnergyTheme(energy.catalog, option, new Set(buildings.keys()));
      const key = 'energy:' + entityHash(option.key).slice(0, 24);
      const theme: EntityTheme = { key, energy: { ...option, key }, minimum: result.minimum, maximum: result.maximum, count: result.count, categories: [] };
      catalog.themes.push(theme);
      for (const [id, value] of result.colours) colour.run(key, id, value, null);
    }
    if (ryhti.catalog) for (const option of RYHTI_THEMES) {
      const result = ryhtiTheme(ryhti.catalog, option.key);
      catalog.themes.push({ key: option.key, energy: null, minimum: null, maximum: null, count: result.colours.size, categories: result.categories });
      for (const [id, value] of result.colours) {
        if (!buildings.has(id)) throw new Error('Ryhti references an unknown building');
        colour.run(option.key, id, value, ryhtiCategory(ryhtiById.get(id)!, option.key));
      }
    }
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('catalog', JSON.stringify(catalog));
    db.exec("INSERT INTO building_search(building_search) VALUES('optimize'); COMMIT; PRAGMA optimize;");
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Invalid entity database');
    return catalog;
  } finally { db.close(); }
}
