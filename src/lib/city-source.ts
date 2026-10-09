import * as THREE from 'three';
import { PROJECTED_ORIGIN, wgs84ToScene } from './geo.ts';
import type { CityBase } from './city-assets.ts';

export const TEXTURED_BUILDINGS_URL = 'https://kartta.hel.fi/3d/datasource-data/e5e7158a-52df-45a1-9be0-1be8f2828abd/tileset.json';
export const ORTHOPHOTO_LAYER = 'avoindata:Ortoilmakuva_2025_5cm';
export type Bounds = [number, number, number, number];
export interface Tile { boundingVolume: { region: number[] }; transform?: number[]; geometricError: number; content?: { uri: string }; children?: Tile[] }
export interface ModelEntry { url: string; bounds: Bounds; transform: THREE.Matrix4 }
export interface AppearanceEntry { url: string; bounds: Bounds; transform?: THREE.Matrix4 }

export function imageryUrl(bounds: Bounds) {
  const [west, south, east, north] = bounds;
  if (!bounds.every(Number.isFinite) || west >= east || south >= north) throw new Error('Invalid imagery bounds');
  const query = new URLSearchParams({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.1.1', LAYERS: ORTHOPHOTO_LAYER,
    STYLES: '', SRS: 'EPSG:3879', BBOX: [PROJECTED_ORIGIN[0] + west, PROJECTED_ORIGIN[1] - north,
      PROJECTED_ORIGIN[0] + east, PROJECTED_ORIGIN[1] - south].join(','), WIDTH: '1024', HEIGHT: '1024', FORMAT: 'image/jpeg' });
  return `https://kartta.hel.fi/ws/geoserver/avoindata/wms?${query}`;
}

export function tileLocation(tile: Tile, parent: THREE.Matrix4, source: string) {
  const region = tile.boundingVolume?.region;
  if (!Array.isArray(region) || region.length !== 6 || !region.every(Number.isFinite)
    || region[0] >= region[2] || region[1] >= region[3] || !Number.isFinite(tile.geometricError) || tile.geometricError < 0 || (tile.children && (!Array.isArray(tile.children) || tile.children.length > 512))
    || (tile.transform && (tile.transform.length !== 16 || !tile.transform.every(Number.isFinite)))) throw new Error('Invalid textured tile extent');
  const transform = parent.clone();
  if (tile.transform) transform.multiply(new THREE.Matrix4().fromArray(tile.transform));
  const corners = [[region[0], region[1]], [region[2], region[1]], [region[0], region[3]], [region[2], region[3]]]
    .map(([longitude, latitude]) => wgs84ToScene(longitude * 180 / Math.PI, latitude * 180 / Math.PI));
  const bounds: Bounds = [Math.min(...corners.map(point => point[0])), Math.min(...corners.map(point => point[2])),
    Math.max(...corners.map(point => point[0])), Math.max(...corners.map(point => point[2]))];
  let url = tile.content ? new URL(tile.content.uri, source).href : null;
  // The municipal hierarchy marks empty coverage with this exact placeholder.
  if (url === new URL('emptyContent.glb', TEXTURED_BUILDINGS_URL).href) url = null;
  if (url && (!url.startsWith(new URL('.', TEXTURED_BUILDINGS_URL).href) || !/\/\d{1,2}\/\d{1,6}\/\d{1,6}\.(json|glb)$/.test(new URL(url).pathname)
    || new URL(url).search || new URL(url).hash)) throw new Error('Unsafe textured tile path');
  return { bounds, transform, url };
}

/** The provider uses embedded glTF and uint32 string offsets for original GML IDs. */
export function texturedBuildingIds(bytes: ArrayBuffer): Set<string> {
  const view = new DataView(bytes);
  if (bytes.byteLength < 28 || bytes.byteLength > 8_000_000 || view.getUint32(0, true) !== 0x46546c67
    || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('Invalid textured glTF');
  const length = view.getUint32(12, true), binary = 28 + length;
  if (length > 2_000_000 || binary > bytes.byteLength || view.getUint32(24 + length, true) !== 0x004e4942) throw new Error('Invalid embedded textured glTF');
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
  if (document.buffers?.length !== 1 || document.buffers[0].uri || document.buffers[0].byteLength > bytes.byteLength - binary
    || !Array.isArray(document.accessors) || document.accessors.some((accessor: { count: number }) => !Number.isInteger(accessor.count) || accessor.count < 1 || accessor.count > 600_000)
    || document.images?.length > 8 || document.images?.some((image: { uri?: string }) => image.uri) || document.extensionsRequired?.some((name: string) => name !== 'KHR_texture_basisu')) throw new Error('Unsupported textured resources');
  const table = document.extensions?.EXT_structural_metadata?.propertyTables?.[0];
  const property = table?.properties?.id;
  if (!property || !Number.isInteger(table.count) || table.count < 1 || table.count > 5000 || (property.stringOffsetType && property.stringOffsetType !== 'UINT32')) throw new Error('Missing textured building identities');
  const strings = document.bufferViews?.[property.values], offsets = document.bufferViews?.[property.stringOffsets];
  for (const entry of [strings, offsets]) if (!entry || entry.buffer !== 0 || !Number.isInteger(entry.byteLength) || entry.byteLength < 0
    || !Number.isInteger(entry.byteOffset ?? 0) || (entry.byteOffset ?? 0) < 0 || binary + (entry.byteOffset ?? 0) + entry.byteLength > bytes.byteLength) throw new Error('Invalid textured metadata buffer');
  if (offsets.byteLength !== (table.count + 1) * 4) throw new Error('Invalid textured identity offsets');
  const indices = new DataView(bytes, binary + (offsets.byteOffset ?? 0), offsets.byteLength), ids = new Set<string>();
  for (let index = 0; index < table.count; index++) {
    const start = indices.getUint32(index * 4, true), end = indices.getUint32((index + 1) * 4, true);
    if (start > end || end > strings.byteLength || end - start > 200) throw new Error('Invalid textured identity');
    const id = new TextDecoder().decode(new Uint8Array(bytes, binary + (strings.byteOffset ?? 0) + start, end - start));
    if (id.startsWith('BID_')) ids.add(id);
  }
  return ids;
}

export function validateTileIndex(bytes: ArrayBuffer, source = TEXTURED_BUILDINGS_URL): Tile {
  const root = JSON.parse(new TextDecoder().decode(bytes)).root as Tile;
  let count = 0;
  const validate = (tile: Tile, depth: number) => {
    if (depth > 24 || ++count > 5000) throw new Error('Textured tile hierarchy too large');
    tileLocation(tile, new THREE.Matrix4(), source);
    for (const child of tile.children ?? []) validate(child, depth + 1);
  };
  validate(root, 0); return root;
}

export function aerialEntries(base: CityBase): AppearanceEntry[] {
  const entries: AppearanceEntry[] = [], grid = base.terrain, size = 50;
  for (let row = 0; row < grid.height - 1; row += size) for (let column = 0; column < grid.width - 1; column += size) {
    const bounds: Bounds = [grid.origin[0] + column * grid.step[0], grid.origin[1] + row * grid.step[1],
      grid.origin[0] + Math.min(column + size, grid.width - 1) * grid.step[0], grid.origin[1] + Math.min(row + size, grid.height - 1) * grid.step[1]];
    entries.push({ url: imageryUrl(bounds), bounds });
  }
  return entries;
}

/** Failed subtrees remain incomplete while other parts can finish loading. */
export async function discoverTexturedEntries(base: CityBase, readIndex: (url: string) => Promise<Tile>,
  visible: (bounds: Bounds) => boolean, threshold: (bounds: Bounds) => number, signal: AbortSignal) {
  const entries: ModelEntry[] = [], failed: string[] = [];
  const index = async (url: string, parent: THREE.Matrix4, depth: number) => {
    try { await visit(await readIndex(url), parent, url, depth); }
    catch (error) { signal.throwIfAborted(); failed.push(url); }
  };
  const visit = async (tile: Tile, parent: THREE.Matrix4, source: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 24) throw new Error('Textured tile hierarchy too deep');
    const entry = tileLocation(tile, parent, source), [west, south, east, north] = entry.bounds;
    if (west >= base.bounds[2] || east <= base.bounds[0] || south >= base.bounds[3] || north <= base.bounds[1] || !visible(entry.bounds)) return;
    if (entry.url?.endsWith('.glb') && (tile.geometricError <= threshold(entry.bounds) || !tile.children?.length)) {
      entries.push({ ...entry, url: entry.url }); return;
    }
    if (entry.url?.endsWith('.json')) await index(entry.url, entry.transform, depth + 1);
    else for (const child of tile.children ?? []) await visit(child, entry.transform, source, depth + 1);
  };
  await index(TEXTURED_BUILDINGS_URL, new THREE.Matrix4(), 0);
  return { entries, failed };
}

/** Only this prepared municipal source and bounded aerial cells can be proxied. */
export function municipalAssetUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== 'https://kartta.hel.fi' || url.hash || url.username || url.password) throw new Error('Unsafe municipal asset URL');
  const model = /^\/3d\/datasource-data\/e5e7158a-52df-45a1-9be0-1be8f2828abd\/(tileset\.json|\d{1,2}\/\d{1,6}\/\d{1,6}\.(json|glb))$/.test(url.pathname);
  if (model && !url.search) return url.href;
  if (url.pathname !== '/ws/geoserver/avoindata/wms') throw new Error('Unsafe municipal asset path');
  const expected = { SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.1.1', LAYERS: ORTHOPHOTO_LAYER, STYLES: '', SRS: 'EPSG:3879', WIDTH: '1024', HEIGHT: '1024', FORMAT: 'image/jpeg' };
  if ([...url.searchParams].length !== 10 || Object.entries(expected).some(([key, value]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value)) throw new Error('Unsafe aerial parameters');
  const bbox = url.searchParams.get('BBOX')?.split(',').map(Number);
  if (!bbox || bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]
    || bbox[2] - bbox[0] > 1000.001 || bbox[3] - bbox[1] > 1000.001
    || bbox.some((value, index) => Math.abs(value - PROJECTED_ORIGIN[index % 2]) > 10_000)) throw new Error('Unsafe aerial bounds');
  // Use the provider's working GetMap ordering; its gateway resets some sorted URLs.
  url.search = new URLSearchParams({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.1.1', LAYERS: ORTHOPHOTO_LAYER, STYLES: '', SRS: 'EPSG:3879',
    BBOX: bbox.join(','), WIDTH: '1024', HEIGHT: '1024', FORMAT: 'image/jpeg' }).toString();
  return url.href;
}
