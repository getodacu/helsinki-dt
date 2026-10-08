import { readFile } from 'node:fs/promises';
import { fromArrayBuffer } from 'geotiff';
import { cachedDownload } from './geometry.ts';
import { CITY_CACHE } from './city-buildings.ts';
import { PROJECTED_ORIGIN, gk25ToScene } from '../src/lib/geo.ts';
import { sampleTerrainHeight, type CityBase, type TerrainGrid } from '../src/lib/city-assets.ts';

const WFS = 'https://kartta.hel.fi/ws/geoserver/avoindata/wfs';
// ponytail: 20m sampling omits tiny coastal details; increase resolution when street-level terrain becomes required.
export const TERRAIN_URL = 'https://kartta.hel.fi/ws/geoserver/avoindata/wcs?service=WCS&version=1.0.0&request=GetCoverage&coverage=avoindata:Korkeusmalli_2021_1m&crs=EPSG:3879&bbox=25494300,6669000,25502300,6675900&width=400&height=345&format=GeoTIFF';
const query = (layers: string, count: number) => WFS + '?service=WFS&version=1.0.0&request=GetFeature&typeName=' + layers
  + '&outputFormat=application/json&srsName=EPSG:3879&bbox=24.90,60.135,25.04,60.195,EPSG:4326&maxFeatures=' + count;
export const LAND_URL = query('avoindata:Maavesi_manner,avoindata:Maavesi_saaret', 1000);
export const ROADS_URL = query('avoindata:YLRE_Katu_ja_viherosat_ajorata_alue', 10000);
export const RAILS_URL = query('avoindata:Seutukartta_liikenne_juna_rata,avoindata:Seutukartta_liikenne_metro_rata', 2000);
type Polygon = number[][][];
interface FeatureCollection {
  type: string; totalFeatures: number; features: { geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> }[];
  crs: { properties: { name: string } };
}
function parseFeatures(text: string): FeatureCollection {
  const value = JSON.parse(text) as FeatureCollection;
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > 10000
    || !Number.isInteger(value.totalFeatures) || value.totalFeatures !== value.features.length
    || value.crs?.properties?.name !== 'urn:ogc:def:crs:EPSG::3879') throw new Error('Incomplete or invalid municipal geometry');
  return value;
}
function polygons(document: FeatureCollection): Polygon[] {
  return document.features.flatMap(feature => {
    if (feature.geometry.type === 'Polygon') return [feature.geometry.coordinates as Polygon];
    if (feature.geometry.type === 'MultiPolygon') return feature.geometry.coordinates as Polygon[];
    throw new Error('Expected municipal polygons');
  }).map(polygon => polygon.map(ring => ring.map(point => {
    if (!Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)
      || point[0] < 25400000 || point[0] > 25600000 || point[1] < 6600000 || point[1] > 6750000) throw new Error('Invalid projected municipal coordinate');
    const [x, , z] = gk25ToScene(point[0], point[1], 0);
    return [x, z];
  })));
}

/** Scanline parity preserves interior holes and separate islands without inventing land. */
export function rasterLandMask(land: Polygon[], grid: Omit<TerrainGrid, 'elevations'>): boolean[] {
  const mask = Array<boolean>(grid.width * grid.height).fill(false);
  for (const polygon of land) {
    let minZ = Infinity, maxZ = -Infinity;
    for (const ring of polygon) for (const point of ring) { minZ = Math.min(minZ, point[1]); maxZ = Math.max(maxZ, point[1]); }
    const startRow = Math.max(0, Math.ceil((minZ - grid.origin[1]) / grid.step[1]));
    const endRow = Math.min(grid.height - 1, Math.floor((maxZ - grid.origin[1]) / grid.step[1]));
    for (let row = startRow; row <= endRow; row++) {
      const z = grid.origin[1] + row * grid.step[1], crossings: number[] = [];
      for (const ring of polygon) for (let index = 0; index < ring.length; index++) {
        const a = ring[index], b = ring[(index + 1) % ring.length];
        if ((a[1] > z) !== (b[1] > z)) crossings.push(a[0] + (z - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      crossings.sort((a, b) => a - b);
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        const left = Math.max(0, Math.ceil((crossings[index] - grid.origin[0]) / grid.step[0]));
        const right = Math.min(grid.width - 1, Math.floor((crossings[index + 1] - grid.origin[0]) / grid.step[0]));
        for (let column = left; column <= right; column++) mask[row * grid.width + column] = true;
      }
    }
  }
  return mask;
}

export async function decodeTerrain(bytes: Uint8Array) {
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  if (await tiff.getImageCount() !== 1) throw new Error('Expected one elevation raster');
  const image = await tiff.getImage(), width = image.getWidth(), height = image.getHeight();
  const [west, south, east, north] = image.getBoundingBox();
  const origin = image.getOrigin();
  if (width !== 400 || height !== 345 || width * height > 1_000_000 || image.getSamplesPerPixel() !== 1
    || image.getGeoKeys()?.ProjectedCSTypeGeoKey !== 3879 || !image.pixelIsArea()
    || origin[0] !== west || origin[1] !== north
    || [west, south, east, north].some((value, axis) => Math.abs(value - [25494300, 6669000, 25502300, 6675900][axis]) > 0.01)) {
    throw new Error('Unexpected terrain dimensions, orientation, CRS or extent');
  }
  const dx = (east - west) / width, dz = (north - south) / height;
  const [x, , z] = gk25ToScene(west + dx / 2, north - dz / 2, 0);
  const samples = await image.readRasters({ samples: [0], interleave: true });
  const noData = image.getGDALNoData();
  const elevations = Array.from(samples as Float32Array, value => {
    if (!Number.isFinite(value) || value === noData) return null;
    if (value < -30 || value > 300) throw new Error('Terrain height outside bounded Helsinki range');
    return Math.round(value * 100) / 100;
  });
  return { width, height, origin: [x, z] as [number, number], step: [dx, dz] as [number, number], elevations };
}

function clippedSegment(a: number[], b: number[], bounds: number[]): number[][] | null {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  let start = 0, end = 1;
  const p = [-dx, dx, -dz, dz], q = [a[0] - bounds[0], bounds[2] - a[0], a[1] - bounds[1], bounds[3] - a[1]];
  for (let index = 0; index < 4; index++) {
    if (p[index] === 0) { if (q[index] < 0) return null; continue; }
    const ratio = q[index] / p[index];
    if (p[index] < 0) start = Math.max(start, ratio); else end = Math.min(end, ratio);
    if (start > end) return null;
  }
  return [[a[0] + start * dx, a[1] + start * dz], [a[0] + end * dx, a[1] + end * dz]];
}
function contextPaths(lines: number[][][], terrain: TerrainGrid, bounds: number[], coastline = false) {
  const paths: number[][] = [];
  for (const line of lines) {
    let path: number[] = [];
    const finish = () => { if (path.length >= 6) paths.push(path); path = []; };
    for (let index = 1; index < line.length; index++) {
      const segment = clippedSegment(line[index - 1], line[index], bounds);
      if (!segment) { finish(); continue; }
      const [a, b] = segment, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.max(1, Math.ceil(length / 20));
      for (let step = 0; step <= count; step++) {
        const x = a[0] + (b[0] - a[0]) * step / count, z = a[1] + (b[1] - a[1]) * step / count;
        const y = coastline ? 0 : sampleTerrainHeight(terrain, x, z);
        if (y == null) { finish(); continue; }
        const last = path.length - 3;
        if (last >= 0 && Math.hypot(path[last] - x, path[last + 2] - z) < 2) continue;
        path.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100);
      }
    }
    finish();
  }
  return paths;
}

export async function prepareCityBase() {
  const downloads = await Promise.all([
    cachedDownload(TERRAIN_URL, CITY_CACHE + '/terrain.tif', 4_000_000),
    cachedDownload(LAND_URL, CITY_CACHE + '/land.json', 12_000_000),
    cachedDownload(ROADS_URL, CITY_CACHE + '/roads.json', 24_000_000),
    cachedDownload(RAILS_URL, CITY_CACHE + '/rails.json', 2_000_000)
  ]);
  const landDocument = parseFeatures(await readFile(CITY_CACHE + '/land.json', 'utf8'));
  const roadDocument = parseFeatures(await readFile(CITY_CACHE + '/roads.json', 'utf8'));
  const railDocument = parseFeatures(await readFile(CITY_CACHE + '/rails.json', 'utf8'));
  const terrain = await decodeTerrain(await readFile(CITY_CACHE + '/terrain.tif'));
  const land = polygons(landDocument), mask = rasterLandMask(land, terrain);
  let sourceUnknown = 0, landSamples = 0;
  terrain.elevations = terrain.elevations.map((value, index) => {
    if (!mask[index]) return null;
    landSamples++;
    if (value == null) sourceUnknown++;
    return value;
  });
  const bounds: [number, number, number, number] = [terrain.origin[0], terrain.origin[1],
    terrain.origin[0] + terrain.step[0] * (terrain.width - 1), terrain.origin[1] + terrain.step[1] * (terrain.height - 1)];
  const railLines = railDocument.features.flatMap(feature => {
    const coordinates = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates as number[][]]
      : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates as number[][][] : [];
    return coordinates.map(line => line.map(point => {
      const [x, , z] = gk25ToScene(point[0], point[1], 0); return [x, z];
    }));
  });
  const base: CityBase = { terrain, landMask: mask, waterLevel: 0, bounds,
    shorelines: contextPaths(land.flat(), terrain, bounds, true),
    roads: contextPaths(polygons({ ...roadDocument, features: roadDocument.features.filter(feature =>
      feature.properties?.yllapidon_taso === 'I' || feature.properties?.yllapidon_taso === 'II') }).flat(), terrain, bounds),
    rails: contextPaths(railLines, terrain, bounds) };
  return { base, downloads, counts: { landFeatures: landDocument.features.length, roadFeatures: roadDocument.features.length,
    railFeatures: railDocument.features.length, landSamples, unknownLandSamples: sourceUnknown } };
}
