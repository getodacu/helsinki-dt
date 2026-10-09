import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CityMapCache, CITY_MAP_MAX_AGE, validateMunicipalAsset } from '../src/lib/server/city-map-cache.ts';
import { TEXTURED_BUILDINGS_URL, imageryUrl, municipalAssetUrl } from '../src/lib/city-source.ts';
const tile = Buffer.from(JSON.stringify({ root: { boundingVolume: { region: [0.435, 1.05, 0.436, 1.051, 0, 80] }, geometricError: 10 } }));
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const indexUrl = (id: number) => TEXTURED_BUILDINGS_URL.replace('tileset.json', `15/18650/${id}.json`);

test('server assets survive restarts, isolate URLs and repair corrupt disk contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-cache-')); let calls = 0;
  const download = async () => { calls++; return tile; };
  try {
    let cache = new CityMapCache(directory, download);
    const first = await cache.read(TEXTURED_BUILDINGS_URL); assert.equal(first.type, 'application/json');
    cache = new CityMapCache(directory, download);
    assert.deepEqual((await cache.read(TEXTURED_BUILDINGS_URL)).body, tile); assert.equal(calls, 1);
    await cache.read(indexUrl(9480)); assert.equal(calls, 2);
    const files = (await readdir(directory)).filter(name => name.endsWith('.bin'));
    for (const file of files) await writeFile(join(directory, file), 'corrupted');
    await cache.read(TEXTURED_BUILDINGS_URL); assert.equal(calls, 3);
    assert.equal((await readdir(directory)).filter(name => name.includes('.tmp')).length, 0);
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('30-day cache serves saved bytes during outages and revalidates without blocking the map', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-stale-')); let now = 1000, calls = 0, offline = false;
  const download = async () => { calls++; if (offline) throw new Error('Source offline'); return tile; };
  try {
    const cache = new CityMapCache(directory, download, () => now);
    await cache.read(TEXTURED_BUILDINGS_URL); now += CITY_MAP_MAX_AGE - 1;
    await cache.read(TEXTURED_BUILDINGS_URL); assert.equal(calls, 1);
    now += 2; offline = true;
    assert.deepEqual((await cache.read(TEXTURED_BUILDINGS_URL)).body, tile); await tick(); assert.equal(calls, 2);
    await cache.read(TEXTURED_BUILDINGS_URL); await tick(); assert.equal(calls, 2);
    now += 60_001; offline = false;
    await cache.read(TEXTURED_BUILDINGS_URL); await tick(); assert.equal(calls, 3);
    assert.equal((await cache.read(TEXTURED_BUILDINGS_URL)).retrievedAt, now);
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('server deduplicates downloads, limits background to two, and starts queued foreground first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-priority-'));
  const calls: { url: string; resolve: (body: Buffer) => void }[] = [];
  const cache = new CityMapCache(directory, url => new Promise(resolve => calls.push({ url, resolve })));
  try {
    const first = cache.read(indexUrl(1), true), second = cache.read(indexUrl(2), true);
    await tick(); assert.equal(calls.length, 2);
    const third = cache.read(indexUrl(3), true), fourth = cache.read(indexUrl(4), true);
    await tick(); assert.equal(calls.length, 2);
    const foreground = cache.read(indexUrl(5)), duplicate = cache.read(indexUrl(5));
    await tick(); assert.equal(calls.length, 3); assert.equal(calls[2].url, indexUrl(5));
    const promoted = cache.read(indexUrl(4)); await tick(); assert.equal(calls.length, 4); assert.equal(calls[3].url, indexUrl(4));
    for (const call of calls) call.resolve(tile);
    await Promise.all([first, second, foreground, duplicate, promoted, fourth]); await tick();
    assert.equal(calls.length, 5); calls[4].resolve(tile); await third;
    assert.equal(calls.filter(call => call.url === indexUrl(5)).length, 1);
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid sources, oversize bytes, corrupt source files and storage failure remain bounded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-invalid-'));
  try {
    const blocked = join(directory, 'file'); await writeFile(blocked, 'occupied');
    const cache = new CityMapCache(blocked, async () => tile);
    assert.deepEqual((await cache.read(TEXTURED_BUILDINGS_URL)).body, tile); assert.ok(cache.storageIssue);
    await assert.rejects(cache.read(TEXTURED_BUILDINGS_URL, true), /Server map cache/);
    await assert.rejects(cache.read('https://example.org/private'), /Unsafe/);
    assert.throws(() => municipalAssetUrl(TEXTURED_BUILDINGS_URL + '?other=1'), /Unsafe/);
    assert.throws(() => municipalAssetUrl(imageryUrl([0, 0, 1000, 1000]).replace('WIDTH=1024', 'WIDTH=9000')), /Unsafe/);
    const huge = new CityMapCache(join(directory, 'huge'), async () => Buffer.alloc(2_000_001));
    await assert.rejects(huge.read(TEXTURED_BUILDINGS_URL), /byte limit/);
    const corrupt = new CityMapCache(join(directory, 'corrupt'), async () => Buffer.from('not JSON'));
    await assert.rejects(corrupt.read(TEXTURED_BUILDINGS_URL));
    assert.throws(() => validateMunicipalAsset(imageryUrl([0, 0, 1000, 1000]), Buffer.from('<ServiceException>offline</ServiceException>')), /JPEG/);
    assert.equal((await readdir(directory)).includes('corrupt'), false);
    const model = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
    assert.equal(validateMunicipalAsset(TEXTURED_BUILDINGS_URL.replace('tileset.json', '16/100/100.glb'), model), 'model/gltf-binary');
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('equivalent WMS query orders share a cache key and use the working municipal request order', () => {
  const original = imageryUrl([0, 0, 1000, 1000]), sorted = new URL(original); sorted.searchParams.sort();
  assert.equal(municipalAssetUrl(sorted.href), original);
});
