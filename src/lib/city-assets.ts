import { SCENE_ORIGIN } from './area.ts';
import type { Building, BuildingChunk, DatasetSource } from './types.ts';

export interface CityChunkEntry {
  id: string; url: string; buildingsUrl: string; bounds: [number, number, number, number];
  buildingCount: number; triangleCount: number; bytes: number;
}
export interface CityManifest {
  version: 1; generatedAt: string; origin: typeof SCENE_ORIGIN; bounds: number[];
  initialChunkIds: string[]; chunks: CityChunkEntry[]; baseUrl: string;
  sources: DatasetSource[]; gaps: string[];
}
export interface TerrainGrid {
  width: number; height: number; origin: [number, number]; step: [number, number];
  elevations: (number | null)[];
}
export interface CityBase {
  terrain: TerrainGrid; shorelines: number[][]; roads: number[][]; rails: number[][];
  landMask?: boolean[]; waterLevel: number; bounds: [number, number, number, number];
}
const finite = (values: unknown): values is number[] => Array.isArray(values) && values.every(Number.isFinite);
const assetPath = (value: unknown): value is string => typeof value === 'string'
  && /^\/data\/city\/generations\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json$/.test(value);

async function readAsset<T>(url: string, fetcher: typeof fetch, maxBytes: number, signal?: AbortSignal): Promise<T> {
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetcher(url, { signal: boundedSignal });
  if (!response.ok || !response.body) throw new Error(`City asset unavailable (${response.status})`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel(); throw new Error('City asset exceeds byte limit');
  }
  const reader = response.body.getReader(), pieces: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) throw new Error('City asset exceeds byte limit');
      pieces.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const contents = new Uint8Array(bytes);
  let offset = 0;
  for (const piece of pieces) { contents.set(piece, offset); offset += piece.byteLength; }
  return JSON.parse(new TextDecoder().decode(contents)) as T;
}

export async function loadCityManifest(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<CityManifest> {
  const manifest = await readAsset<CityManifest>('/data/city/manifest.json', fetcher, 2_000_000, signal);
  if (manifest.version !== 1 || !Number.isFinite(Date.parse(manifest.generatedAt))
    || !manifest.origin || Object.entries(SCENE_ORIGIN).some(([key, value]) => manifest.origin[key as keyof typeof SCENE_ORIGIN] !== value)
    || !finite(manifest.bounds) || manifest.bounds.length !== 4 || !assetPath(manifest.baseUrl)
    || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 1000
    || !Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.some(source => !source
      || typeof source.id !== 'string' || !source.id || typeof source.provider !== 'string'
      || typeof source.url !== 'string' || !source.url.startsWith('https://') || source.license !== 'CC BY 4.0'
      || typeof source.attribution !== 'string' || !Number.isFinite(Date.parse(source.retrievedAt)))
    || !Array.isArray(manifest.gaps) || manifest.gaps.some(gap => typeof gap !== 'string')
    || !Array.isArray(manifest.initialChunkIds) || manifest.initialChunkIds.some(id => typeof id !== 'string')) throw new Error('Invalid city manifest');
  const ids = new Set<string>();
  for (const entry of manifest.chunks) {
    if (!entry.id || ids.has(entry.id) || !assetPath(entry.url) || !assetPath(entry.buildingsUrl)
      || !finite(entry.bounds) || entry.bounds.length !== 4 || entry.bounds[0] > entry.bounds[2] || entry.bounds[1] > entry.bounds[3]
      || ![entry.buildingCount, entry.triangleCount, entry.bytes].every(value => Number.isInteger(value) && value > 0)
      || entry.bytes > 12_000_000) throw new Error('Invalid city chunk index');
    ids.add(entry.id);
  }
  if (manifest.initialChunkIds.some(id => !ids.has(id))) throw new Error('Unknown initial city chunk');
  return manifest;
}

export async function loadCityBase(manifest: CityManifest, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<CityBase> {
  const base = await readAsset<CityBase>(manifest.baseUrl, fetcher, 12_000_000, signal);
  const grid = base.terrain;
  if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height) || grid.width < 2 || grid.height < 2
    || grid.width * grid.height > 1_000_000 || !finite(grid.origin) || grid.origin.length !== 2
    || !finite(grid.step) || grid.step.length !== 2 || grid.step.some(value => value <= 0)
    || !Array.isArray(grid.elevations) || grid.elevations.length !== grid.width * grid.height
    || grid.elevations.some(value => value !== null && (!Number.isFinite(value) || Math.abs(value) > 300))
    || !finite(base.bounds) || base.bounds.length !== 4 || !Number.isFinite(base.waterLevel)
    || (base.landMask !== undefined && (!Array.isArray(base.landMask) || base.landMask.length !== grid.width * grid.height
      || base.landMask.some(value => typeof value !== 'boolean')))) throw new Error('Invalid city terrain');
  for (const paths of [base.shorelines, base.roads, base.rails]) {
    if (!Array.isArray(paths) || paths.some(path => !finite(path) || path.length < 6 || path.length % 3)) {
      throw new Error('Invalid city context lines');
    }
  }
  return base;
}

/** Match the renderer diagonal [a,c,b] / [b,c,d]; unknown triangle vertices stay absent. */
export function sampleTerrainHeight(grid: TerrainGrid, x: number, z: number): number | null {
  const column = (x - grid.origin[0]) / grid.step[0], row = (z - grid.origin[1]) / grid.step[1];
  if (!Number.isFinite(column) || !Number.isFinite(row) || column < 0 || row < 0
    || column > grid.width - 1 || row > grid.height - 1) return null;
  const left = Math.min(Math.floor(column), grid.width - 2), top = Math.min(Math.floor(row), grid.height - 2);
  const values = [grid.elevations[top * grid.width + left], grid.elevations[top * grid.width + left + 1],
    grid.elevations[(top + 1) * grid.width + left], grid.elevations[(top + 1) * grid.width + left + 1]];
  const [a, b, c, d] = values, u = column - left, v = row - top;
  if (u + v <= 1) return a == null || b == null || c == null ? null : a + (b - a) * u + (c - a) * v;
  return b == null || c == null || d == null ? null : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

function validBuilding(building: Building, chunkId: string, manifest: CityManifest): boolean {
  return !!building && typeof building.id === 'string' && !!building.id
    && typeof building.gmlId === 'string' && !!building.gmlId && building.chunkRef === chunkId
    && [building.vtjPrt, building.ratu, building.uuid].every(value => value == null || typeof value === 'string')
    && typeof building.sourceId === 'string' && manifest.sources.some(source => source.id === building.sourceId)
    && !!building.attributes && typeof building.attributes === 'object' && !Array.isArray(building.attributes)
    && Object.values(building.attributes).every(value => value === null || typeof value === 'string')
    && Number.isFinite(building.longitude) && Math.abs(building.longitude) <= 180
    && Number.isFinite(building.latitude) && Math.abs(building.latitude) <= 90;
}

/** Metadata only: searching the prepared area must not load every geometry batch. */
export async function loadBuildingSearchIndex(manifest: CityManifest, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  if (manifest.chunks.reduce((sum, entry) => sum + entry.buildingCount, 0) > 50_000) throw new Error('Building search index exceeds record limit');
  const buildings = new Map<string, Building>(), unavailableChunks: string[] = [];
  let bytes = 0;
  for (let offset = 0; offset < manifest.chunks.length; offset += 4) {
    signal?.throwIfAborted();
    const results = await Promise.allSettled(manifest.chunks.slice(offset, offset + 4).map(async entry => {
      const rows = await readAsset<Building[]>(entry.buildingsUrl, fetcher, 2_000_000, signal);
      if (!Array.isArray(rows) || rows.length !== entry.buildingCount || rows.some(row => !validBuilding(row, entry.id, manifest))
        || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Invalid building search identities');
      return rows;
    }));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') unavailableChunks.push(manifest.chunks[offset + index].id);
      else {
        bytes += new TextEncoder().encode(JSON.stringify(result.value)).byteLength;
        if (bytes > 20_000_000) throw new Error('Building search index exceeds byte limit');
        for (const building of result.value) if (!buildings.has(building.id)) buildings.set(building.id, building);
      }
    }
  }
  signal?.throwIfAborted();
  return { buildings: [...buildings.values()], unavailableChunks };
}

export class CityChunkLoader {
  private loaded = new Map<string, { chunk: BuildingChunk; buildings: Building[] }>();
  private manifest: CityManifest;
  private fetcher: typeof fetch;
  constructor(manifest: CityManifest, fetcher: typeof fetch = fetch) { this.manifest = manifest; this.fetcher = fetcher; }
  async load(id: string, signal?: AbortSignal) {
    if (this.loaded.has(id)) return this.loaded.get(id)!;
    const entry = this.manifest.chunks.find(chunk => chunk.id === id);
    if (!entry) throw new Error('Unknown city chunk');
    const [chunk, buildings] = await Promise.all([
      readAsset<BuildingChunk>(entry.url, this.fetcher, 12_000_000, signal),
      readAsset<Building[]>(entry.buildingsUrl, this.fetcher, 2_000_000, signal)
    ]);
    if (chunk.id !== id || !finite(chunk.positions) || chunk.positions.length !== entry.triangleCount * 9
      || !Array.isArray(chunk.ranges) || !Array.isArray(buildings) || buildings.length !== entry.buildingCount
      || !chunk.origin || Object.entries(SCENE_ORIGIN).some(([key, value]) => chunk.origin[key as keyof typeof SCENE_ORIGIN] !== value)) {
      throw new Error('Invalid city building chunk');
    }
    const ids = new Set(buildings.map(building => building.id));
    let nextTriangle = 0;
    if (ids.size !== buildings.length || buildings.some(building => !validBuilding(building, id, this.manifest))) throw new Error('Invalid city building identities');
    for (const range of chunk.ranges) {
      if (!ids.has(range.buildingId) || range.firstTriangle !== nextTriangle || !Number.isInteger(range.triangleCount)
        || range.triangleCount <= 0) throw new Error('Invalid city triangle lookup');
      nextTriangle += range.triangleCount;
    }
    if (nextTriangle !== entry.triangleCount) throw new Error('Incomplete city triangle lookup');
    signal?.throwIfAborted();
    const result = { chunk, buildings };
    this.loaded.set(id, result);
    return result;
  }
  unload(id: string) { this.loaded.delete(id); }
  dispose() { this.loaded.clear(); }
}
