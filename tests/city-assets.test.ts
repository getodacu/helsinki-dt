import { test } from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RELEASE_BOUNDS, SCENE_ORIGIN } from '../src/lib/area.ts';
import { CityChunkLoader, loadCityBase, loadCityManifest, sampleTerrainHeight, type CityManifest, type CityBase } from '../src/lib/city-assets.ts';
import { buildingIdForTriangle } from '../src/lib/data/geometry.ts';
import { partitionCityBuildings } from '../scripts/city-buildings.ts';
import { decodeCityTile, releaseTilePaths } from '../scripts/city-tiles.ts';
import { TERRAIN_URL, LAND_URL, ROADS_URL, RAILS_URL, contextCachePath, decodeTerrain, rasterLandMask } from '../scripts/city-base.ts';
import { publishCityAssets } from '../scripts/prepare-city.ts';
import type { Building, BuildingChunk, DatasetSource } from '../src/lib/types.ts';

const geometry: BuildingChunk = { id: 'source', positions: [0, 1, 0, 2, 1, 0, 0, 1, 2, 0, 1, 0, 2, 1, 0, 0, 1, 2],
  ranges: [{ buildingId: 'original-id', firstTriangle: 0, triangleCount: 2 }], origin: { ...SCENE_ORIGIN },
  coordinateReference: 'local metres [east, elevation, -north] from EPSG:3879', verticalReference: 'N2000 metres' };
const building: Building = { id: 'original-id', gmlId: 'original-id', vtjPrt: '00123X', ratu: '001', uuid: null,
  chunkRef: 'source', longitude: SCENE_ORIGIN.longitude, latitude: SCENE_ORIGIN.latitude, attributes: {}, sourceId: 'source' };
const source: DatasetSource = { id: 'source', provider: 'Attributable test fixture', url: 'https://example.org/source', license: 'CC BY 4.0',
  attribution: 'Fixture', retrievedAt: '2026-10-08T00:00:00Z', vintage: null, units: ['m'], coverage: 'test', method: 'test',
  checksum: null, coordinateReference: 'EPSG:3879', axisOrder: 'east,north', verticalReference: 'N2000' };
const base: CityBase = { terrain: { width: 2, height: 2, origin: [0, 0], step: [1, 1], elevations: [0, 10, 20, 100] },
  shorelines: [[0, 0, 0, 1, 0, 0]], roads: [], rails: [], waterLevel: 0, bounds: [0, 0, 1, 1] };
const prepared = () => ({ chunks: partitionCityBuildings([building], geometry, 1), base, sources: [source], gaps: [] });

function assetFetcher(manifest: CityManifest, contents: Record<string, unknown>): typeof fetch {
  return (async (url: RequestInfo | URL, options?: RequestInit) => {
    options?.signal?.throwIfAborted();
    const value = String(url) === '/data/city/manifest.json' ? manifest : contents[String(url)];
    return value === undefined ? new Response('missing', { status: 404 }) : new Response(JSON.stringify(value));
  }) as typeof fetch;
}

async function fixtureManifest() {
  const root = await mkdtemp(join(tmpdir(), 'city-assets-'));
  const published = await publishCityAssets(prepared(), root);
  const values: Record<string, unknown> = {};
  for (const asset of published.assets) values[asset.path] = JSON.parse(await readFile(join(root, asset.path.replace('/data/city/', '')), 'utf8'));
  return { root, manifest: published.manifest, values };
}

test('terrain sampling exactly follows rendered triangle diagonal and preserves unknown corners', () => {
  assert.equal(sampleTerrainHeight(base.terrain, 0.25, 0.25), 7.5);
  assert.equal(sampleTerrainHeight(base.terrain, 0.75, 0.75), 57.5);
  assert.equal(sampleTerrainHeight(base.terrain, 0.5, 0.5), 15);
  assert.equal(sampleTerrainHeight(base.terrain, -1, 0), null);
  const missingBottom = { ...base.terrain, elevations: [0, 10, 20, null] };
  assert.equal(sampleTerrainHeight(missingBottom, 0.25, 0.25), 7.5);
  assert.equal(sampleTerrainHeight(missingBottom, 0.75, 0.75), null);
  const missingTop = { ...base.terrain, elevations: [null, 10, 20, 100] };
  assert.equal(sampleTerrainHeight(missingTop, 0.25, 0.25), null);
  assert.equal(sampleTerrainHeight(missingTop, 0.75, 0.75), 57.5);
});

test('municipal land mask keeps polygon holes and separate islands', () => {
  const mask = rasterLandMask([
    [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]],
    [[[5, 0], [6, 0], [6, 1], [5, 1], [5, 0]]]
  ], { width: 7, height: 5, origin: [0.5, 0.5], step: [1, 1] });
  assert.equal(mask[0], true);
  assert.equal(mask[1 * 7 + 1], false);
  assert.equal(mask[5], true);
  assert.equal(mask[6], false);
});

test('building identity and string IDs survive splitting across render batches', () => {
  const batches = partitionCityBuildings([building], geometry, 1);
  assert.equal(batches.length, 2);
  for (const batch of batches) {
    assert.equal(buildingIdForTriangle(batch.chunk, 0), 'original-id');
    assert.equal(batch.buildings[0].vtjPrt, '00123X');
    assert.equal(batch.buildings[0].chunkRef, batch.chunk.id);
  }
});

test('tiny real official semantic tile retains original IDs, metres and N2000 elevation', async () => {
  const bytes = await readFile(new URL('./fixtures/city-building-tile.b3dm', import.meta.url));
  const objects = await decodeCityTile(bytes, 'https://kartta.hel.fi/3d/datasource-data/16fc3fd5-df6d-4f48-bfd5-9aeee430a02f/15/37310/5430.b3dm');
  assert.equal(objects.length, 1);
  assert.equal(objects[0].building.id, 'BID_1997b650-5116-41fb-902d-4a39322da303');
  assert.equal(objects[0].building.vtjPrt, '103017676U');
  assert.equal(objects[0].building.ratu, '62');
  assert.equal(objects[0].positions[1], 6.91);
  assert.ok(Math.abs(objects[0].positions[0] - 143.02) < 0.01);
  assert.equal(objects[0].positions.length, 9);
  assert.equal(objects[0].building.attributes.yearOfConstruction, '1897');
  const malformed = Buffer.from(bytes); malformed.writeUInt32LE(0xffffffff, 12);
  await assert.rejects(decodeCityTile(malformed, 'https://example.org/'), /feature table/);
});

test('provider tile index rejects URLs outside its fixed semantic layout', () => {
  const region = [24.95 * Math.PI / 180, 60.16 * Math.PI / 180, 24.96 * Math.PI / 180, 60.17 * Math.PI / 180, 0, 30];
  assert.deepEqual(releaseTilePaths({ boundingVolume: { region }, content: { uri: '15/37310/5430.b3dm' } }), ['15/37310/5430.b3dm']);
  assert.throws(() => releaseTilePaths({ boundingVolume: { region }, content: { uri: '../../private.json' } }), /Unsafe/);
});

test('city loader validates triangle lookup and honors caller cancellation', async () => {
  const fixture = await fixtureManifest();
  try {
    const fetcher = assetFetcher(fixture.manifest, fixture.values);
    const manifest = await loadCityManifest(fetcher), loader = new CityChunkLoader(manifest, fetcher);
    const result = await loader.load(manifest.initialChunkIds[0]);
    assert.equal(buildingIdForTriangle(result.chunk, 0), 'original-id');
    assert.equal((await loadCityBase(manifest, fetcher)).terrain.elevations[0], 0);
    loader.unload(manifest.initialChunkIds[0]);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(loader.load(manifest.initialChunkIds[0], controller.signal), /abort/i);
    const chunk = fixture.values[manifest.chunks[0].url] as BuildingChunk;
    chunk.ranges[0].buildingId = 'unrelated-id';
    await assert.rejects(loader.load(manifest.chunks[0].id), /triangle lookup/);
    loader.dispose();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('failed city publication preserves the previous manifest and generation byte-for-byte', async () => {
  const fixture = await fixtureManifest();
  try {
    const before = await readFile(join(fixture.root, 'manifest.json'));
    const geometryPath = join(fixture.root, fixture.manifest.chunks[0].url.replace('/data/city/', ''));
    const oldGeometry = await readFile(geometryPath);
    await assert.rejects(publishCityAssets(prepared(), fixture.root, async () => { throw new Error('write failed'); }), /write failed/);
    assert.deepEqual(await readFile(join(fixture.root, 'manifest.json')), before);
    assert.deepEqual(await readFile(geometryPath), oldGeometry);
    const broken = prepared(); broken.chunks[0].chunk.ranges[0].buildingId = 'unmatched';
    await assert.rejects(publishCityAssets(broken, fixture.root), /triangle lookup/);
    assert.deepEqual(await readFile(join(fixture.root, 'manifest.json')), before);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});


test('context requests cover the release and stale URLs use separate cache files', () => {
  for (const url of [LAND_URL,ROADS_URL,RAILS_URL]) {
    assert.equal(new URL(url).searchParams.get('bbox'),RELEASE_BOUNDS.join(',')+',EPSG:4326');
    const stale=new URL(url); stale.searchParams.set('bbox','24.9,60.135,25.04,60.195,EPSG:4326');
    assert.notEqual(contextCachePath(url),contextCachePath(stale.href));
  }
  assert.equal(new URL(ROADS_URL).searchParams.get('maxFeatures'),'20000');
});

test('terrain decoder agrees with expanded WCS extent, pixel centres and NoData', async () => {
  const query=new URL(TERRAIN_URL).searchParams;
  const width=Number(query.get('width')),height=Number(query.get('height'));
  const [west,south,east,north]=query.get('bbox')!.split(',').map(Number);
  assert.equal(width,557); assert.equal(height,503);
  assert.equal((east-west)/width,20); assert.equal((north-south)/height,20);
  const values=new Float32Array(width*height).fill(12.25); values[0]=-32767;
  const raster=(overrides: Record<string,unknown>={})=>writeArrayBuffer(values,{width,height,BitsPerSample:[32],SampleFormat:[3],
    GTModelTypeGeoKey:1,GTRasterTypeGeoKey:1,ProjectedCSTypeGeoKey:3879,ModelPixelScale:[20,20,0],
    ModelTiepoint:[0,0,0,west,north,0],GDAL_NODATA:'-32767',...overrides});
  const grid=await decodeTerrain(new Uint8Array(await raster()));
  assert.equal(grid.width,width); assert.equal(grid.height,height); assert.deepEqual(grid.step,[20,20]);
  assert.equal(grid.elevations[0],null); assert.equal(grid.elevations[1],12.25);
  const { PROJECTED_ORIGIN }=await import('../src/lib/geo.ts');
  assert.deepEqual(grid.origin,[west+10-PROJECTED_ORIGIN[0],-(north-10-PROJECTED_ORIGIN[1])]);
  await assert.rejects(async()=>decodeTerrain(new Uint8Array(await raster({ProjectedCSTypeGeoKey:4326}))),/Unexpected terrain/);
  await assert.rejects(async()=>decodeTerrain(new Uint8Array(await raster({ModelTiepoint:[0,0,0,west+20,north,0]}))),/Unexpected terrain/);
  await assert.rejects(async()=>decodeTerrain(new Uint8Array(await raster({width:width-1}))),/Unexpected terrain/);
});
