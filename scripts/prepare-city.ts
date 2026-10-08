import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RELEASE_BOUNDS, SCENE_ORIGIN } from '../src/lib/area.ts';
import { CityChunkLoader, loadCityBase, loadCityManifest, type CityBase, type CityManifest, type CityChunkEntry } from '../src/lib/city-assets.ts';
import type { Building, BuildingChunk, DatasetSource } from '../src/lib/types.ts';
import { cachedDownload } from './geometry.ts';
import { partitionCityBuildings, CITY_CACHE } from './city-buildings.ts';
import { prepareSemanticTiles, CITY_TILESET_URL } from './city-tiles.ts';
import { prepareCityBase, TERRAIN_URL, LAND_URL, ROADS_URL, RAILS_URL } from './city-base.ts';

interface CityPreparation {
  chunks: { chunk: BuildingChunk; buildings: Building[] }[]; base: CityBase; sources: DatasetSource[]; gaps: string[];
}
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

/** Publish immutable files first; the manifest pointer changes only after every write succeeds. */
export async function publishCityAssets(prepared: CityPreparation, root = 'static/data/city', beforePublish?: () => Promise<void>) {
  if (!prepared.chunks.length || !prepared.sources.length || prepared.sources.some(source => source.license !== 'CC BY 4.0')) {
    throw new Error('Usable licensed city geometry required');
  }
  const generation = randomUUID(), staging = join(root, '.staging-' + generation), destination = join(root, 'generations', generation);
  const publicRoot = '/data/city/generations/' + generation + '/';
  const pointer = join(root, '.manifest-' + generation + '.json');
  let published = false;
  await mkdir(staging, { recursive: true });
  const entries: CityChunkEntry[] = [], assets: { path: string; bytes: number; sha256: string }[] = [];
  const save = async (name: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 12_000_000) throw new Error('Prepared city asset exceeds byte limit');
    await writeFile(join(staging, name), bytes);
    assets.push({ path: publicRoot + name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) });
    return Buffer.byteLength(bytes);
  };
  try {
    for (const { chunk, buildings } of prepared.chunks) {
      if (!/^[a-zA-Z0-9_-]+$/.test(chunk.id) || !chunk.positions.length || chunk.positions.length % 9
        || chunk.positions.some(value => !Number.isFinite(value))) throw new Error('Invalid city output geometry');
      const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let index = 0; index < chunk.positions.length; index += 3) {
        bounds[0] = Math.min(bounds[0], chunk.positions[index]); bounds[2] = Math.max(bounds[2], chunk.positions[index]);
        bounds[1] = Math.min(bounds[1], chunk.positions[index + 2]); bounds[3] = Math.max(bounds[3], chunk.positions[index + 2]);
      }
      const bytes = await save(chunk.id + '.json', chunk);
      const buildingBytes = await save(chunk.id + '_buildings.json', buildings);
      entries.push({ id: chunk.id, url: publicRoot + chunk.id + '.json', buildingsUrl: publicRoot + chunk.id + '_buildings.json',
        bounds, bytes: bytes + buildingBytes, buildingCount: buildings.length, triangleCount: chunk.positions.length / 9 });
    }
    await save('base.json', prepared.base);
    await save('checksums.json', [...assets]);
    const initialChunkIds = [...entries].sort((a, b) => {
      const distance = (entry: CityChunkEntry) => Math.hypot((entry.bounds[0] + entry.bounds[2]) / 2, (entry.bounds[1] + entry.bounds[3]) / 2);
      return distance(a) - distance(b);
    }).slice(0, 4).map(entry => entry.id);
    const manifest: CityManifest = { version: 1, generatedAt: new Date().toISOString(), bounds: [...RELEASE_BOUNDS], origin: { ...SCENE_ORIGIN },
      initialChunkIds, chunks: entries, baseUrl: publicRoot + 'base.json', sources: prepared.sources, gaps: prepared.gaps };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest));
    const stagedFetch = (async (url: RequestInfo | URL) => {
      if (String(url) === '/data/city/manifest.json') return new Response(JSON.stringify(manifest));
      const asset = assets.find(asset => asset.path === String(url));
      if (!asset) return new Response('missing', { status: 404 });
      return new Response(await readFile(join(staging, asset.path.slice(publicRoot.length))));
    }) as typeof fetch;
    await loadCityManifest(stagedFetch); await loadCityBase(manifest, stagedFetch);
    const loader = new CityChunkLoader(manifest, stagedFetch);
    for (const entry of entries) { await loader.load(entry.id); loader.unload(entry.id); }
    loader.dispose();
    await mkdir(join(root, 'generations'), { recursive: true });
    await rename(staging, destination);
    await beforePublish?.();
    await writeFile(pointer, JSON.stringify(manifest));
    await rename(pointer, join(root, 'manifest.json'));
    published = true;
    // Cleanup must never turn a successful manifest publication into a reported failure.
    try {
      const directories = await readdir(join(root, 'generations'), { withFileTypes: true });
      const generations = await Promise.all(directories.filter(directory => directory.isDirectory()).map(async directory =>
        ({ path: join(root, 'generations', directory.name), modified: (await stat(join(root, 'generations', directory.name))).mtimeMs })));
      for (const old of generations.sort((a, b) => b.modified - a.modified).slice(3)) await rm(old.path, { recursive: true, force: true });
    } catch {}
    return { manifest, assets };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (!published) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      await rm(pointer, { force: true }).catch(() => {});
    }
  }
}

async function sourceTerms() {
  const packages = ['helsingin-korkeusmalli', 'helsingin-maa-ja-vesialueet', 'helsingin-kaupungin-yleisten-alueiden-rekisteri', 'seutukartta', 'helsingin-3d-kaupunkimalli'];
  for (const name of packages) {
    const path = CITY_CACHE + '/terms-' + name + '.json';
    await cachedDownload('https://hri.fi/data/api/3/action/package_show?id=' + name, path, 200_000);
    const response = JSON.parse(await readFile(path, 'utf8'));
    if (!response.success || response.result?.license_id !== 'CC-BY-4.0') throw new Error('Source terms unverified: ' + name);
  }
}

export async function prepareCity() {
  await mkdir(CITY_CACHE, { recursive: true });
  await sourceTerms();
  const [geometry, context] = await Promise.all([prepareSemanticTiles(), prepareCityBase()]);
  const makeSource = (id: string, provider: string, url: string, metadata: { retrievedAt: string; sha256: string }, vintage: string | null,
    method: string, verticalReference: string | null): DatasetSource => ({ id, provider, url, license: 'CC BY 4.0',
    attribution: provider + ', CC BY 4.0; downloaded ' + metadata.retrievedAt, retrievedAt: metadata.retrievedAt, vintage,
    units: ['m'], coverage: 'Release bounds ' + RELEASE_BOUNDS.join(','), method, checksum: metadata.sha256,
    coordinateReference: 'EPSG:3879 ETRS-GK25', axisOrder: 'easting,northing; local east,elevation,-north', verticalReference });
  const sources = [
    makeSource('helsinki-semantic-tiles', 'City of Helsinki, Helsinki 3D', CITY_TILESET_URL, geometry.source, null,
      'Official untextured semantic LoD2 tiles; original GMLID, VTJ_PRT and RATU retained; Three 0.186.1 glTF conversion; 500m chunks, 30000-triangle batches; positions rounded to 0.01m', 'N2000 values in geocentric tile encoding; verified against original CityGML extrema'),
    makeSource('helsinki-terrain-2021', 'City of Helsinki, Kaupunkimittauspalvelut', TERRAIN_URL, context.downloads[0], '2021',
      'Official 1m WCS elevation coverage sampled at 20m, nearest neighbour; pixel-centre placement; mainland/island mask; NoData omitted', 'N2000 metres'),
    makeSource('helsinki-land-water', 'City of Helsinki, land and water areas', LAND_URL, context.downloads[1], null,
      'Real mainland/island polygon mask and shorelines; small piers/bridges excluded by provider; shoreline displayed at water datum 0m', null),
    makeSource('helsinki-roads', 'City of Helsinki, register of public areas YLRE', ROADS_URL, context.downloads[2], null,
      'Major and collector carriageway polygon edges (maintenance I/II) only; clipped to scene extent and draped on measured terrain; no road elevation fabricated', null),
    makeSource('helsinki-rails', 'HSY and Helsinki region municipalities, Seutukartta', RAILS_URL, context.downloads[3], null,
      'Regional train/metro lines only; clipped and draped on measured terrain; underground alignment is geographic context', null)
  ];
  const gaps: string[] = [];
  await writeFile(CITY_CACHE + '/semantic-source-checksums.json', JSON.stringify(geometry.checksums, null, 2));
  const published = await publishCityAssets({ chunks: partitionCityBuildings(geometry.buildings, geometry.chunk), base: context.base, sources, gaps });
  const summary = { generatedAt: published.manifest.generatedAt, buildingCount: geometry.buildings.length,
    triangleCount: geometry.chunk.positions.length / 9, chunkCount: published.manifest.chunks.length,
    sourceTileCount: geometry.tileCount, sourceTileBytes: geometry.bytes, sourceTileSetChecksum: geometry.checksum,
    ...context.counts, totalBytes: published.assets.reduce((sum, asset) => sum + asset.bytes, 0),
    initialBuildingBytes: published.manifest.chunks.filter(chunk => published.manifest.initialChunkIds.includes(chunk.id)).reduce((sum, chunk) => sum + chunk.bytes, 0),
    baseBytes: published.assets.find(asset => asset.path.endsWith('/base.json'))?.bytes, gaps };
  await writeFile(CITY_CACHE + '/city-summary.json', JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1]?.endsWith('prepare-city.ts')) {
  prepareCity().then(summary => { console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.gaps.length ? 2 : 0; })
    .catch(error => { console.error('City preparation failed; previous city manifest remains available:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
