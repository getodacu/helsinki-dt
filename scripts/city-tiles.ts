import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Matrix4, Mesh, Vector3 } from 'three';
import proj4 from 'proj4';
import { cachedDownload } from './geometry.ts';
import { CITY_CACHE } from './city-buildings.ts';
import { RELEASE_BOUNDS, SCENE_ORIGIN, inBounds } from '../src/lib/area.ts';
import { PROJECTED_ORIGIN, gk25ToWgs84, wgs84ToScene } from '../src/lib/geo.ts';
import type { Building, BuildingChunk } from '../src/lib/types.ts';

export const CITY_TILESET_URL = 'https://kartta.hel.fi/3d/datasource-data/16fc3fd5-df6d-4f48-bfd5-9aeee430a02f/tileset.json';
// ponytail: only this provider's untextured embedded tile layout is supported; revisit if its schema changes.
const GEOCENTRIC = '+proj=geocent +ellps=WGS84 +units=m';
interface Tile {
  boundingVolume: { region: number[] }; transform?: number[];
  children?: Tile[]; content?: { uri: string };
}
export function releaseTilePaths(root: Tile): string[] {
  const paths: string[] = [];
  const visit = (tile: Tile, depth: number) => {
    const region = tile.boundingVolume?.region;
    if (depth > 12 || !Array.isArray(region) || region.length !== 6 || !region.every(Number.isFinite)
      || tile.transform) throw new Error('Unsupported official tile extent or transformation');
    const [west, south, east, north] = region.map(value => value * 180 / Math.PI);
    if (west > RELEASE_BOUNDS[2] || east < RELEASE_BOUNDS[0] || south > RELEASE_BOUNDS[3] || north < RELEASE_BOUNDS[1]) return;
    if (tile.content) {
      if (!/^15\/\d{1,6}\/\d{1,6}\.b3dm$/.test(tile.content.uri)) throw new Error('Unsafe or unsupported city tile path');
      paths.push(tile.content.uri);
    }
    for (const child of tile.children ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  if (!paths.length || paths.length > 600 || new Set(paths).size !== paths.length) throw new Error('Invalid city tile count');
  return paths;
}
interface TileBuilding { building: Building; positions: number[] }

/** Only the provider's embedded, untextured b3dm/glTF layout is accepted; Three decodes geometry. */
export async function decodeCityTile(bytes: Uint8Array, sourceUrl: string): Promise<TileBuilding[]> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 40 || buffer.length > 8_000_000 || buffer.toString('ascii', 0, 4) !== 'b3dm'
    || buffer.readUInt32LE(4) !== 1 || buffer.readUInt32LE(8) !== buffer.length) throw new Error('Invalid bounded city b3dm');
  const [featureJsonLength, featureBinaryLength, batchJsonLength, batchBinaryLength] = [12, 16, 20, 24].map(offset => buffer.readUInt32LE(offset));
  const glbOffset = 28 + featureJsonLength + featureBinaryLength + batchJsonLength + batchBinaryLength;
  if (featureJsonLength > 10000 || batchJsonLength > 2_000_000 || featureBinaryLength || batchBinaryLength
    || glbOffset + 20 > buffer.length) throw new Error('Unsupported city feature table');
  const feature = JSON.parse(buffer.subarray(28, 28 + featureJsonLength).toString('utf8'));
  const batch = JSON.parse(buffer.subarray(28 + featureJsonLength, glbOffset).toString('utf8'));
  if (!Number.isInteger(feature.BATCH_LENGTH) || feature.BATCH_LENGTH < 1 || feature.BATCH_LENGTH > 3000
    || !Array.isArray(feature.RTC_CENTER) || feature.RTC_CENTER.length !== 3 || !feature.RTC_CENTER.every(Number.isFinite)
    || !Array.isArray(batch.id) || !Array.isArray(batch.attributes) || batch.id.length !== feature.BATCH_LENGTH
    || batch.attributes.length !== feature.BATCH_LENGTH
    || batch.attributes.some((value: unknown) => !value || typeof value !== 'object' || Array.isArray(value)) || batch.id.some((id: unknown) => typeof id !== 'string' || !id || id.length > 200)) {
    throw new Error('Invalid semantic tile identities');
  }
  const glbLength = buffer.readUInt32LE(glbOffset + 8);
  if (glbLength < 20 || glbOffset + glbLength > buffer.length || buffer.length - glbOffset - glbLength > 7
    || buffer.subarray(glbOffset + glbLength).some(value => value !== 0)) throw new Error('Invalid city tile alignment padding');
  const glb = buffer.subarray(glbOffset, glbOffset + glbLength);
  if (glb.toString('ascii', 0, 4) !== 'glTF' || glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length
    || glb.readUInt32LE(16) !== 0x4e4f534a || glb.readUInt32LE(12) > 2_000_000) throw new Error('Invalid embedded city glTF');
  const document = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  if (!Array.isArray(document.buffers) || document.buffers.length !== 1 || document.buffers[0].uri
    || document.buffers[0].byteLength > glb.length || document.images?.length || document.extensionsRequired?.length
    || !Array.isArray(document.meshes) || document.meshes.some((mesh: { primitives: { mode?: number }[] }) => !Array.isArray(mesh.primitives)
      || mesh.primitives.some(primitive => primitive.mode !== undefined && primitive.mode !== 4))
    || !Array.isArray(document.accessors) || document.accessors.some((accessor: { count: number }) => !Number.isInteger(accessor.count) || accessor.count < 1 || accessor.count > 600_000)) throw new Error('City tile external resources/extensions not supported');
  const model = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '');
  model.scene.updateMatrixWorld(true);
  const rotate = new Matrix4().makeRotationX(Math.PI / 2), center = new Vector3(...feature.RTC_CENTER as [number, number, number]);
  const objects = new Map<number, number[]>();
  let triangles = 0;
  try {
    model.scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const geometry = object.geometry, positions = geometry.getAttribute('position'), ids = geometry.getAttribute('_batchid');
      const indices = geometry.getIndex();
      if (!positions || positions.itemSize !== 3 || !ids || ids.count !== positions.count || positions.count > 600_000
        || (indices?.count ?? positions.count) % 3) throw new Error('Unsupported semantic city mesh');
      const vertices = Array<number[]>(positions.count);
      for (let index = 0; index < positions.count; index++) {
        const id = ids.getX(index);
        if (!Number.isInteger(id) || id < 0 || id >= feature.BATCH_LENGTH) throw new Error('City mesh references absent building');
        const vector = new Vector3().fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).applyMatrix4(rotate).add(center);
        const [longitude, latitude, elevation] = proj4(GEOCENTRIC, 'EPSG:4326', vector.toArray());
        if (!Number.isFinite(elevation) || elevation < -30 || elevation > 300) throw new Error('Invalid encoded N2000 city height');
        vertices[index] = wgs84ToScene(longitude, latitude, elevation).map(value => Math.round(value * 100) / 100);
      }
      const count = indices?.count ?? positions.count;
      for (let index = 0; index < count; index += 3) {
        const a = indices ? indices.getX(index) : index, b = indices ? indices.getX(index + 1) : index + 1, c = indices ? indices.getX(index + 2) : index + 2;
        if (!vertices[a] || !vertices[b] || !vertices[c] || ids.getX(a) !== ids.getX(b) || ids.getX(a) !== ids.getX(c)) throw new Error('Invalid semantic city triangle');
        const id = ids.getX(a), target = objects.get(id) ?? [];
        target.push(...vertices[a], ...vertices[b], ...vertices[c]); objects.set(id, target);
        if (++triangles > 200_000) throw new Error('City tile triangle limit exceeded');
      }
    });
  } finally {
    model.scene.traverse(object => { if (object instanceof Mesh) { object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose(); } });
  }
  return [...objects].map(([index, positions]) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let offset = 0; offset < positions.length; offset++) { const axis = offset % 3; min[axis] = Math.min(min[axis], positions[offset]); max[axis] = Math.max(max[axis], positions[offset]); }
    const attributes: Record<string, string | null> = { selectedLod: '2', tileUrl: sourceUrl,
      tileGeometryMinimumElevation: String(min[1]), tileGeometryMaximumElevation: String(max[1]) };
    for (const [name, value] of Object.entries(batch.attributes[index])) attributes[name] = value == null ? null
      : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Geographic metadata is recovered from the actual triangle extent, keeping source identifiers unchanged.
    const [longitude, latitude] = gk25ToWgs84(PROJECTED_ORIGIN[0] + (min[0] + max[0]) / 2,
      PROJECTED_ORIGIN[1] - (min[2] + max[2]) / 2);
    return { building: { id: batch.id[index], gmlId: batch.id[index], vtjPrt: attributes.VTJ_PRT || null,
      ratu: attributes.RATU && attributes.RATU !== '0' ? attributes.RATU : null, uuid: null, chunkRef: 'release', longitude, latitude, attributes,
      sourceId: 'helsinki-semantic-tiles' }, positions };
  }).filter(object => inBounds(object.building.longitude, object.building.latitude, RELEASE_BOUNDS));
}

export async function prepareSemanticTiles() {
  const source = await cachedDownload(CITY_TILESET_URL, CITY_CACHE + '/semantic-tileset.json', 2_000_000);
  const document = JSON.parse(await readFile(CITY_CACHE + '/semantic-tileset.json', 'utf8'));
  const paths = releaseTilePaths(document.root), buildings: Building[] = [];
  const chunk: BuildingChunk = { id: 'release', positions: [], ranges: [], origin: { ...SCENE_ORIGIN },
    coordinateReference: 'local metres [east, elevation, -north] from EPSG:3879', verticalReference: 'N2000 metres' };
  const ids = new Map<string, Building>(), checksums: { url: string; bytes: number; sha256: string; retrievedAt: string }[] = [];
  let bytes = 0;
  for (const path of paths) {
    const url = new URL(path, CITY_TILESET_URL).href, cachePath = CITY_CACHE + '/tiles/' + path.replaceAll('/', '_');
    const metadata = await cachedDownload(url, cachePath, 8_000_000);
    bytes += metadata.bytes;
    if (bytes > 350_000_000) throw new Error('Release city tile download limit exceeded');
    checksums.push({ url, bytes: metadata.bytes, sha256: metadata.sha256, retrievedAt: metadata.retrievedAt });
    for (const object of await decodeCityTile(await readFile(cachePath), url)) {
      if (ids.has(object.building.id)) throw new Error('Building repeated across provider tiles; inspect parts before combining');
      ids.set(object.building.id, object.building); buildings.push(object.building);
      chunk.ranges.push({ buildingId: object.building.id, firstTriangle: chunk.positions.length / 9, triangleCount: object.positions.length / 9 });
      for (const value of object.positions) chunk.positions.push(value);
    }
    if (checksums.length % 25 === 0) console.log(`Prepared ${checksums.length}/${paths.length} official semantic city tiles`);
  }
  return { buildings, chunk, source, checksums, tileCount: paths.length, bytes,
    checksum: createHash('sha256').update(JSON.stringify(checksums.map(item => [item.url, item.sha256]))).digest('hex') };
}
