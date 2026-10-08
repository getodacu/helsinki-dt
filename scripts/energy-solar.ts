import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DISTRICT_BOUNDS } from '../src/lib/area.ts';
import { requireSourceVersion, type SolarBuilding } from '../src/lib/data/energy-static.ts';
import { cachedDownload } from './geometry.ts';

export const SOLAR_TILESET_URL = 'https://kartta.hel.fi/3d/data/buildings_solar/tileset.json';
export const SOLAR_CONFIG_URL = 'https://kartta.hel.fi/3d/solar/config.json';
const SOLAR_ROOT = new URL('./', SOLAR_TILESET_URL).href;
interface SolarTile { boundingVolume: { region: number[] }; children?: SolarTile[]; content?: { url: string }; transform?: unknown }

function intersects(tile: SolarTile) {
  const region = tile.boundingVolume?.region;
  if (!Array.isArray(region) || region.length !== 6 || !region.every(Number.isFinite) || tile.transform) throw new Error('Unsupported solar extent');
  const [west, south, east, north] = region.map(value => value * 180 / Math.PI);
  return west <= DISTRICT_BOUNDS[2] && east >= DISTRICT_BOUNDS[0] && south <= DISTRICT_BOUNDS[3] && north >= DISTRICT_BOUNDS[1];
}

/** Original 2017 provider format: 20-byte legacy b3dm header, followed by batch JSON. Geometry is unused. */
export function decodeSolarTile(buffer: Buffer, tile: string): SolarBuilding[] {
  if (buffer.length < 24 || buffer.length > 32_000_000 || buffer.toString('ascii', 0, 4) !== 'b3dm'
    || buffer.readUInt32LE(4) !== 1 || buffer.readUInt32LE(8) !== buffer.length) throw new Error('Invalid bounded solar b3dm');
  const batchBytes = buffer.readUInt32LE(16);
  if (batchBytes > 16_000_000 || batchBytes < 2 || 20 + batchBytes >= buffer.length || buffer[20] !== 123) throw new Error('Unsupported legacy solar batch table');
  const table = JSON.parse(buffer.toString('utf8', 20, 20 + batchBytes));
  const { id, parentPosition, classId, attributes } = table;
  if (![id, parentPosition, classId, attributes].every(Array.isArray) || id.length > 25_000
    || [parentPosition, classId, attributes].some(values => values.length !== id.length)
    || id.some((value: unknown) => typeof value !== 'string' || !value || value.length > 256)
    || parentPosition.some((value: unknown) => !Number.isInteger(value) || Number(value) < -1 || Number(value) >= id.length)
    || classId.some((value: unknown) => !Number.isInteger(value))) throw new Error('Invalid solar parent identities');
  const rows: SolarBuilding[] = [];
  for (let index = 0; index < id.length; index++) {
    if (classId[index] !== 26) continue;
    if (parentPosition[index] !== -1 || !/^BID_[0-9a-f-]{36}$/.test(id[index])) throw new Error('Unsupported solar building parent');
    const values = attributes[index];
    if (!values || typeof values !== 'object' || Array.isArray(values) || !('globalRadYear' in values)) throw new Error('Solar parent annual metric missing');
    const value = values.globalRadYear;
    if (value !== null && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new Error('Invalid solar parent radiation');
    rows.push({ sourceId: 'solar:' + id[index], gmlId: id[index], vtjPrt: null, globalRadYear: value, tile });
  }
  if (!rows.length) throw new Error('No original solar building parents');
  return rows;
}

export async function prepareSolarSource(cache: string) {
  await mkdir(cache + '/tiles', { recursive: true });
  const checksums: { url: string; sha256: string; bytes: number; retrievedAt: string }[] = [];
  const load = async (url: string, limit: number) => {
    if (url !== SOLAR_CONFIG_URL && !url.startsWith(SOLAR_ROOT)) throw new Error('Unsafe solar source URL');
    const name = url === SOLAR_CONFIG_URL ? 'solar-config.json' : url.slice(SOLAR_ROOT.length).replaceAll('/', '_');
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Unsafe solar cache name');
    const path = cache + '/tiles/' + name;
    const metadata = await cachedDownload(url, path, limit);
    checksums.push({ url, sha256: metadata.sha256, bytes: metadata.bytes, retrievedAt: metadata.retrievedAt });
    const bytes = await readFile(path);
    return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: limit }) : bytes;
  };
  const configuration = JSON.parse((await load(SOLAR_CONFIG_URL, 2_000_000)).toString());
  const layer = configuration.layers?.find((layer: { url: string }) => layer.url === SOLAR_ROOT.slice(0, -1));
  if (!layer || !JSON.stringify(configuration).includes('Global Radiation (Year) [kWh]')) throw new Error('Solar source or annual kWh semantics changed');
  const document = JSON.parse((await load(SOLAR_TILESET_URL, 2_000_000)).toString());
  const paths = new Set<string>();
  let manifests = 0;
  const visit = async (tile: SolarTile, base: string, depth: number) => {
    if (depth > 6 || !intersects(tile)) return;
    if (tile.content) {
      const url = new URL(tile.content.url, base).href;
      if (!url.startsWith(SOLAR_ROOT) || !/^\d{2}\/\d{1,6}\/\d{1,6}\.(?:json|b3dm)$/.test(url.slice(SOLAR_ROOT.length))) throw new Error('Unsupported solar content path');
      if (url.endsWith('.json')) {
        if (++manifests > 12) throw new Error('Solar manifest bound exceeded');
        const subtree = JSON.parse((await load(url, 2_000_000)).toString());
        await visit(subtree.root, url, depth + 1);
      } else paths.add(url);
    }
    for (const child of tile.children ?? []) await visit(child, base, depth + 1);
  };
  await visit(document.root, SOLAR_TILESET_URL, 0);
  if (!paths.size || paths.size > 40) throw new Error('District solar tile bound exceeded');
  const rows: SolarBuilding[] = [];
  let totalBytes = 0;
  for (const url of [...paths].sort()) {
    const bytes = await load(url, 32_000_000);
    if ((totalBytes += bytes.length) > 220_000_000) throw new Error('District solar download bound exceeded');
    rows.push(...decodeSolarTile(bytes, url.slice(SOLAR_ROOT.length)));
    if (rows.length > 2500) throw new Error('District solar building bound exceeded');
    console.log(`Prepared ${rows.length} solar building parents from ${checksums.filter(row => row.url.endsWith('.b3dm')).length}/${paths.size} district tiles`);
  }
  const checksum = createHash('sha256').update(JSON.stringify(checksums.map(row => [row.url, row.sha256]))).digest('hex');
  requireSourceVersion(checksum, '7e9722393f621db32c4e99f4db285f708b768fd69c6fc173d810ce39776fb599', 'Original district solar export');
  await writeFile(cache + '/solar-source-checksums.json', JSON.stringify(checksums, null, 2));
  return { rows, tileCount: paths.size, checksums, checksum,
    retrievedAt: checksums.reduce((latest, row) => row.retrievedAt > latest ? row.retrievedAt : latest, ''), totalBytes };
}
