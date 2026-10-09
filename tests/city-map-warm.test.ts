import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENE_ORIGIN } from '../src/lib/area.ts';
import type { CityBase } from '../src/lib/city-assets.ts';
import { discoverTexturedEntries, TEXTURED_BUILDINGS_URL, type Tile } from '../src/lib/city-source.ts';
import { CityMapCache } from '../src/lib/server/city-map-cache.ts';
import { warmCityArea } from '../src/lib/server/city-map-warm.ts';
import { publishCityAssets } from '../scripts/prepare-city.ts';

const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
const tile = (uri: string, geometricError: number, children?: Tile[]): Tile => ({ boundingVolume: { region }, geometricError, content: { uri }, children });
const url = (path: string) => new URL(path, TEXTURED_BUILDINGS_URL).href;
const nestedUrl = url('15/2/2.json');
const models = ['14/1/1.glb', '16/3/3.glb', '17/4/4.glb', '15/5/5.glb'].map(url);
const nested = tile('../../16/3/3.glb', 2, [tile('../../17/4/4.glb', 0)]);
const root: Tile = { boundingVolume: { region }, geometricError: 20, children: [
  tile('14/1/1.glb', 8, [tile('15/2/2.json', 4, [tile('15/5/5.glb', 3), tile('15/5/5.glb', 3)]), tile('15/2/2.json', 4)]),
  { ...tile('15/9/9.json', 0), boundingVolume: { region: [25.1, 60.2, 25.2, 60.3].map(value => value * Math.PI / 180).concat([0, 80]) } }
] };
const base: CityBase = { terrain: { width: 2, height: 2, origin: [0, 0], step: [1, 1], elevations: [0, 0, 0, 0] },
  shorelines: [], roads: [], rails: [], waterLevel: 0, bounds: [-1000, -1000, 1000, 1000] };
const cli = fileURLToPath(new URL('../scripts/cache-city-map.ts', import.meta.url));
const run = promisify(execFile);

async function prepared(directory: string) {
  const id = 'fixture';
  return publishCityAssets({ base, gaps: [], chunks: [{
    chunk: { id, positions: [0, 1, 0, 1, 1, 0, 0, 1, 1], ranges: [{ buildingId: id, firstTriangle: 0, triangleCount: 1 }],
      origin: { ...SCENE_ORIGIN }, coordinateReference: 'local metres', verticalReference: 'N2000 metres' },
    buildings: [{ id, gmlId: id, vtjPrt: null, ratu: null, uuid: null, chunkRef: id, longitude: SCENE_ORIGIN.longitude,
      latitude: SCENE_ORIGIN.latitude, attributes: {}, sourceId: id }]
  }], sources: [{ id, provider: 'Test fixture', url: 'https://example.org/fixture', license: 'CC BY 4.0', attribution: 'Fixture',
    retrievedAt: '2026-10-08T00:00:00Z', vintage: null, units: ['m'], coverage: 'test', method: 'test', checksum: null,
    coordinateReference: 'EPSG:3879', axisOrder: 'east,north', verticalReference: 'N2000' }]
  }, join(directory, 'static/data/city'));
}

async function fixtureDownload() {
  const model = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
  const jpeg = Buffer.alloc(22); jpeg.writeUInt16BE(0xffd8, 0); jpeg.writeUInt16BE(0xffc0, 2);
  jpeg.writeUInt16BE(17, 4); jpeg[6] = 8; jpeg.writeUInt16BE(1024, 7); jpeg.writeUInt16BE(1024, 9); jpeg.writeUInt16BE(0xffd9, 20);
  return async (asset: string) => {
    if (asset === TEXTURED_BUILDINGS_URL) return Buffer.from(JSON.stringify({ root }));
    if (asset === nestedUrl) return Buffer.from(JSON.stringify({ root: nested }));
    if (models.includes(asset)) return model;
    if (asset.includes('/wms?')) return jpeg;
    throw new Error('Unexpected fixture URL: ' + asset);
  };
}

test('all-level discovery collects parents and descendants once, follows nested indexes and respects prepared bounds', async () => {
  const calls: string[] = [];
  const readIndex = async (asset: string) => { calls.push(asset); return asset === TEXTURED_BUILDINGS_URL ? root : nested; };
  const overview = await discoverTexturedEntries(base, readIndex, () => true, () => 10, new AbortController().signal);
  assert.deepEqual(overview.entries.map(entry => entry.url), [models[0]]);
  assert.deepEqual(calls, [TEXTURED_BUILDINGS_URL]); calls.length = 0;
  const full = await discoverTexturedEntries(base, readIndex, () => true, () => 10, new AbortController().signal, true);
  assert.deepEqual(full.entries.map(entry => entry.url), models);
  assert.deepEqual(calls, [TEXTURED_BUILDINGS_URL, nestedUrl]);
  assert.deepEqual(full.failed, []);
  assert.deepEqual(full.entries[2].ancestors, [models[0], models[1]]);
  const incomplete = await discoverTexturedEntries(base, async asset => {
    if (asset === nestedUrl) throw new Error('Source offline'); return root;
  }, () => true, () => 10, new AbortController().signal, true);
  assert.deepEqual(incomplete.failed, [nestedUrl]);
  assert.deepEqual(incomplete.entries.map(entry => entry.url), [models[0], models[3]]);
});

test('full-area warming persists, resumes, refreshes and retains saved assets after failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'city-warm-')), previous = process.cwd();
  t.after(async () => { process.chdir(previous); await rm(directory, { recursive: true, force: true }); });
  t.mock.method(console, 'warn', () => {});
  const published = await prepared(directory); process.chdir(directory);
  const download = await fixtureDownload(), calls: string[] = [], cacheDirectory = join(directory, 'cache');
  const fetchAsset = async (asset: string) => { calls.push(asset); return download(asset); };
  let cache = new CityMapCache(cacheDirectory, fetchAsset);
  assert.equal((await warmCityArea(cache, undefined, false, true)).phase, 'complete');
  assert.equal(calls.length, 7); assert.equal(new Set(calls).size, 7);
  calls.length = 0;
  cache = new CityMapCache(cacheDirectory, fetchAsset);
  assert.equal((await warmCityArea(cache, undefined, false, true)).phase, 'complete'); assert.equal(calls.length, 0);
  assert.equal((await warmCityArea(cache, undefined, true, true)).phase, 'complete'); assert.equal(calls.length, 7);
  const savedFiles = (await readdir(cacheDirectory)).sort();
  const before = await Promise.all(savedFiles.map(name => readFile(join(cacheDirectory, name))));
  const good = await cache.read(models[1]);
  const offline = new CityMapCache(cacheDirectory, async () => { throw new Error('Source offline'); });
  const incomplete = await warmCityArea(offline, undefined, true, true);
  assert.equal(incomplete.phase, 'partial'); assert.ok(incomplete.failed > 0);
  assert.deepEqual((await new CityMapCache(cacheDirectory, download).read(models[1])).body, good.body);
  assert.deepEqual((await readdir(cacheDirectory)).sort(), savedFiles);
  assert.deepEqual(await Promise.all(savedFiles.map(name => readFile(join(cacheDirectory, name)))), before);
  const brokenDirectory = join(directory, 'blocked'); await writeFile(brokenDirectory, 'not a directory');
  const broken = new CityMapCache(brokenDirectory, download), phases: string[] = [];
  assert.equal((await warmCityArea(broken, state => phases.push(state.phase), true, true)).phase, 'stopped');
  assert.ok(broken.storageIssue); assert.ok(!phases.includes('complete'));
  const brokenModel = new CityMapCache(join(directory, 'bad-model'), async asset => {
    if (asset === models[1]) throw new Error('Model unavailable'); return download(asset);
  });
  const partial = await warmCityArea(brokenModel, undefined, false, true);
  assert.equal(partial.phase, 'partial'); assert.equal(partial.failed, 1);
  assert.equal((await warmCityArea(new CityMapCache(join(directory, 'bad-model'), download), undefined, false, true)).phase, 'complete');
  const result = await run(process.execPath, [cli], { cwd: directory, env: { ...process.env, CITY_MAP_CACHE_DIR: cacheDirectory } });
  assert.match(result.stdout, /complete: 6\/6/); assert.equal(result.stderr, '');
  await assert.rejects(run(process.execPath, [cli, '--unknown'], { cwd: directory }), error => {
    assert.equal((error as { code: number }).code, 1); assert.match((error as { stderr: string }).stderr, /Usage:/); return true;
  });
  const chunkPath = join(directory, 'static', published.manifest.chunks[0].url);
  const chunkBytes = await readFile(chunkPath); await writeFile(chunkPath, '{}');
  await assert.rejects(run(process.execPath, [cli, '--all-levels'], { cwd: directory, env: { ...process.env, CITY_MAP_CACHE_DIR: cacheDirectory } }), error => {
    assert.equal((error as { code: number }).code, 1); assert.match((error as { stdout: string }).stdout, /partial:/);
    assert.match((error as { stderr: string }).stderr, /resume missing parts/); return true;
  });
  await writeFile(chunkPath, chunkBytes);
  await rm(join(directory, 'static'), { recursive: true });
  await assert.rejects(run(process.execPath, [cli, '--all-levels', '--refresh'], { cwd: directory }), error => {
    assert.equal((error as { code: number }).code, 1); assert.match((error as { stderr: string }).stderr, /City asset unavailable/); return true;
  });
});
