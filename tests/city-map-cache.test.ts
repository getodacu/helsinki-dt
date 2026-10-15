import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CityMapCache, CITY_MAP_MAX_AGE, cityMapCache, validateMunicipalAsset } from '../src/lib/server/city-map-cache.ts';
import { TEXTURED_BUILDINGS_URL, imageryUrl, municipalAssetUrl, type Tile } from '../src/lib/city-source.ts';
import type { CityBase } from '../src/lib/city-assets.ts';
import { GET } from '../src/routes/api/city-asset/+server.ts';
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

for (const maxPending of [5, 6]) test(`full background queue preserves foreground slots and pending bound ${maxPending}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-reserved-capacity-'));
  const calls: { url: string; resolve: (body: Buffer) => void }[] = [];
  const cache = new CityMapCache(directory, url => {
    const deferred = Promise.withResolvers<Buffer>(); calls.push({ url, resolve: deferred.resolve }); return deferred.promise;
  }, Date.now, { maxQueued: 2, maxPending });
  try {
    const active = [1, 2].map(id => cache.read(indexUrl(id), true, true));
    const queued = [3, 4].map(id => cache.read(indexUrl(id), true, true));
    assert.deepEqual(calls.map(call => call.url), [indexUrl(1), indexUrl(2)]);
    await assert.rejects(cache.read(indexUrl(7), true, true), /capacity/);
    const foreground = [];
    for (let id = 5; id <= maxPending; id++) {
      const request = cache.read(indexUrl(id), false, true);
      request.catch(() => {});
      foreground.push(request);
      assert.equal(calls.at(-1)!.url, indexUrl(id));
      assert.equal(calls.length, id - 2);
    }
    await assert.rejects(cache.read(indexUrl(8), false, true), /capacity/);
    await assert.rejects(cache.read(indexUrl(9), true, true), /capacity/);
    assert.equal(calls.length, maxPending - 2);
    for (const call of calls) call.resolve(tile);
    await Promise.all([...active, ...foreground]); await tick();
    assert.deepEqual(calls.slice(maxPending - 2).map(call => call.url), [indexUrl(3), indexUrl(4)]);
    for (const call of calls) call.resolve(tile);
    await Promise.all(queued);
    assert.equal(calls.length, maxPending);
  } finally { for (const call of calls) call.resolve(tile); await tick(); await rm(directory, { recursive: true, force: true }); }
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

const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
const base: CityBase = { terrain: { width: 101, height: 2, origin: [0, 0], step: [20, 20], elevations: Array(202).fill(0) },
  shorelines: [], roads: [], rails: [], waterLevel: 0, bounds: [-2000, -2000, 2500, 2500] };
const modelUrl = TEXTURED_BUILDINGS_URL.replace('tileset.json', '16/100/1.glb');
const indexBody = (content?: string, children?: Tile[]) => Buffer.from(JSON.stringify({
  root: { boundingVolume: { region }, geometricError: 10, ...(content ? { content: { uri: content } } : {}), children }
}));
const jpeg = () => {
  const body = Buffer.alloc(22); body.writeUInt16BE(0xffd8, 0); body.writeUInt16BE(0xffc0, 2);
  body.writeUInt16BE(17, 4); body[6] = 8; body.writeUInt16BE(1024, 7); body.writeUInt16BE(1024, 9); body.writeUInt16BE(0xffd9, 20);
  return body;
};
async function usage(directory: string) {
  const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}(?:\.[a-f0-9-]{36})?\.(bin|json)$/.test(name));
  return { bytes: (await Promise.all(files.map(async name => (await stat(join(directory, name))).size))).reduce((sum, value) => sum + value, 0),
    entries: files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length };
}

test('public admission follows validated in-area indices, rejects off-grid/unlisted keys and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-admission-')), calls: string[] = [];
  const model = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
  const root = indexBody('15/18650/1.json', [{ boundingVolume: { region: [0, 0, .001, .001, 0, 80] },
    geometricError: 0, content: { uri: '16/999/999.glb' } }]);
  const download = async (url: string) => {
    calls.push(url);
    if (url === TEXTURED_BUILDINGS_URL) return root;
    if (url === indexUrl(1)) return indexBody('../../16/100/1.glb');
    return url === modelUrl ? model : url.endsWith('.json') ? tile : jpeg();
  };
  const options = { base: async () => base };
  try {
    let cache = new CityMapCache(directory, download, Date.now, options);
    await assert.rejects(cache.readPublic(imageryUrl([.1, 0, 1000, 20])), /not prepared/);
    await assert.rejects(cache.readPublic(indexUrl(900)), /not prepared/);
    await assert.rejects(cache.readPublic(modelUrl), /not prepared/);
    assert.equal(calls.length, 0); assert.deepEqual(await readdir(directory), []);
    await cache.readPublic(TEXTURED_BUILDINGS_URL);
    await assert.rejects(cache.readPublic(TEXTURED_BUILDINGS_URL.replace('tileset.json', '16/999/999.glb')), /not prepared/);
    await cache.readPublic(indexUrl(1)); await cache.readPublic(modelUrl);
    await cache.readPublic(imageryUrl([0, 0, 1000, 20]));
    assert.equal(calls.length, 4);
    cache = new CityMapCache(directory, download, Date.now, options);
    assert.deepEqual((await cache.readPublic(modelUrl)).body, model);
    assert.equal(calls.length, 4);
    // Trusted discovery remains available independently of public admission.
    await cache.read(indexUrl(900)); assert.equal(calls.length, 5);
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('validated cached models remain public when quota eviction removed their discovery indices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-model-admission-'));
  const model = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
  const options = { maxEntries: 1, base: async () => base };
  try {
    const cache = new CityMapCache(directory, async url => url === TEXTURED_BUILDINGS_URL ? indexBody('16/100/1.glb') : model, Date.now, options);
    await cache.read(TEXTURED_BUILDINGS_URL);
    await cache.read(modelUrl);
    assert.equal((await usage(directory)).entries, 1);
    const restarted = new CityMapCache(directory, async () => { throw new Error('Must not fetch'); }, Date.now, options);
    assert.deepEqual((await restarted.readPublic(modelUrl)).body, model);
    await assert.rejects(restarted.readPublic(indexUrl(888)), /not prepared/);
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('byte and entry budgets serialize concurrent publication and account for saved files after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-quota-'));
  const options = { maxBytes: 1500, maxEntries: 2 };
  let calls = 0;
  const download = async () => { calls++; return tile; };
  try {
    let cache = new CityMapCache(directory, download, Date.now, options);
    await cache.read(indexUrl(1)); await cache.read(indexUrl(2));
    assert.equal((await usage(directory)).entries, 2);
    await cache.read(indexUrl(1)); // Keep the recently used asset, not just the newest publication.
    await cache.read(indexUrl(3));
    const before = calls; await cache.read(indexUrl(1)); assert.equal(calls, before);
    cache = new CityMapCache(directory, download, Date.now, options);
    await Promise.all([4, 5, 6, 7].map(id => cache.read(indexUrl(id))));
    let used = await usage(directory); assert.ok(used.bytes <= options.maxBytes); assert.ok(used.entries <= options.maxEntries);
    cache = new CityMapCache(directory, download, Date.now, { maxBytes: 750, maxEntries: 1 });
    await cache.read(indexUrl(8));
    used = await usage(directory); assert.ok(used.bytes <= 750); assert.ok(used.entries <= 1);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
    // An asset larger than the entire budget is returned but never displaces a last-good copy.
    const tiny = new CityMapCache(directory, download, Date.now, { maxBytes: 1, maxEntries: 1 });
    const saved = await Promise.all((await readdir(directory)).map(async name => [name, await readFile(join(directory, name))] as const));
    await tiny.read(indexUrl(8), false, true);
    for (const [name, body] of saved) assert.deepEqual(await readFile(join(directory, name)), body);
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('restart inventory accounts legacy pairs and eviction leaves temporary files and sibling caches untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-legacy-'));
  try {
    const cache = new CityMapCache(directory, async () => tile);
    await cache.read(indexUrl(1));
    const metadataName = (await readdir(directory)).find(name => /^[a-f0-9]{64}\.json$/.test(name))!;
    const metadata = JSON.parse(await readFile(join(directory, metadataName), 'utf8'));
    await writeFile(join(directory, metadataName.replace('.json', '.bin')), await readFile(join(directory, metadata.file)));
    await rm(join(directory, metadata.file)); delete metadata.file;
    await writeFile(join(directory, metadataName), JSON.stringify(metadata));
    const temporary = metadataName.replace('.json', '.foreign.bin.tmp');
    await writeFile(join(directory, temporary), 'active download');
    await mkdir(join(directory, 'building-photos')); await writeFile(join(directory, 'building-photos', 'keep'), 'photo');
    const restarted = new CityMapCache(directory, async () => tile, Date.now, { maxBytes: 750, maxEntries: 1 });
    assert.deepEqual((await restarted.read(indexUrl(1))).body, tile);
    await restarted.read(indexUrl(2));
    const used = await usage(directory); assert.ok(used.bytes <= 750); assert.equal(used.entries, 1);
    assert.equal(await readFile(join(directory, temporary), 'utf8'), 'active download');
    assert.equal(await readFile(join(directory, 'building-photos', 'keep'), 'utf8'), 'photo');
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('failed publication preserves last-good stale bytes and never consumes a foreign temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-publication-')); let now = 1000;
  try {
    let cache = new CityMapCache(directory, async () => tile, () => now);
    await cache.read(TEXTURED_BUILDINGS_URL);
    const metadataName = (await readdir(directory)).find(name => /^[a-f0-9]{64}\.json$/.test(name))!;
    const metadataPath = join(directory, metadataName), metadata = await readFile(metadataPath);
    // A directory at the metadata destination makes the final atomic publication fail.
    await rm(metadataPath); await mkdir(metadataPath);
    const foreignTemporary = join(directory, 'foreign.tmp'); await writeFile(foreignTemporary, 'in use');
    cache = new CityMapCache(directory, async () => indexBody(), () => now);
    await cache.read(TEXTURED_BUILDINGS_URL, false, true);
    assert.ok(cache.storageIssue);
    await rm(metadataPath, { recursive: true }); await writeFile(metadataPath, metadata);
    now += CITY_MAP_MAX_AGE + 1;
    const offline = new CityMapCache(directory, async () => { throw new Error('Offline'); }, () => now);
    assert.deepEqual((await offline.read(TEXTURED_BUILDINGS_URL)).body, tile);
    await tick();
    assert.equal(await readFile(foreignTemporary, 'utf8'), 'in use');
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.bin')).length, 1);
  } finally { await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('finite queue rejects overload, drops last-owner work, and preserves shared and intentional warmer owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-owners-'));
  const calls: { url: string; resolve: (body: Buffer) => void }[] = [];
  const cache = new CityMapCache(directory, url => {
    const deferred = Promise.withResolvers<Buffer>(); calls.push({ url, resolve: deferred.resolve }); return deferred.promise;
  }, Date.now, { maxQueued: 3, maxPending: 7 });
  const active = [1, 2, 3, 4].map(id => cache.read(indexUrl(id), false, true));
  try {
    await tick(); assert.equal(calls.length, 4);
    const doomed = new AbortController(), sharedA = new AbortController(), sharedB = new AbortController(), foreground = new AbortController();
    const abandoned = cache.read(indexUrl(5), false, true, doomed.signal);
    const sharedFirst = cache.read(indexUrl(6), false, true, sharedA.signal);
    const sharedSecond = cache.read(indexUrl(6), false, true, sharedB.signal);
    const warmer = cache.read(indexUrl(7), true, true);
    const warmForeground = cache.read(indexUrl(7), false, true, foreground.signal);
    await assert.rejects(cache.read(indexUrl(8), false, true), /capacity/);
    const abandonedCheck = assert.rejects(abandoned, { name: 'AbortError' });
    const sharedCheck = assert.rejects(sharedFirst, { name: 'AbortError' });
    const warmCheck = assert.rejects(warmForeground, { name: 'AbortError' });
    doomed.abort(); sharedA.abort(); foreground.abort();
    await Promise.all([abandonedCheck, sharedCheck, warmCheck]);
    for (const call of calls) call.resolve(tile);
    await Promise.all(active); await tick();
    assert.equal(calls.some(call => call.url === indexUrl(5)), false);
    for (const call of calls) call.resolve(tile);
    await sharedSecond; await tick();
    for (const call of calls) call.resolve(tile);
    await warmer;
    assert.equal(calls.filter(call => call.url === indexUrl(6)).length, 1);
    assert.equal(calls.filter(call => call.url === indexUrl(7)).length, 1);
    // Cancellation does not enter the failure cooldown.
    const retry = cache.read(indexUrl(5), false, true); await tick();
    calls.at(-1)!.resolve(tile); await retry;
    assert.equal(calls.at(-1)!.url, indexUrl(5));
  } finally { for (const call of calls) call.resolve(tile); await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('last active owner aborts upstream without poisoning retry; route threads signal and overload stays generic', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'city-route-capacity-'));
  const calls: { signal: AbortSignal; resolve: (body: Buffer) => void }[] = [];
  const cache = new CityMapCache(directory, (_url, _max, signal) => {
    const deferred = Promise.withResolvers<Buffer>();
    calls.push({ signal: signal!, resolve: deferred.resolve });
    signal!.addEventListener('abort', () => deferred.reject(signal!.reason), { once: true });
    return deferred.promise;
  }, Date.now, { maxPending: 1, base: async () => base });
  t.mock.method(cityMapCache, 'readPublic', cache.readPublic.bind(cache));
  const request = (source: string, signal?: AbortSignal) => {
    const url = new URL('http://localhost/api/city-asset'); url.searchParams.set('url', source);
    return GET({ url, request: new Request(url, { signal }) });
  };
  try {
    const controller = new AbortController(), first = request(TEXTURED_BUILDINGS_URL, controller.signal);
    await tick(); assert.equal(calls.length, 1);
    const busy = await request(imageryUrl([0, 0, 1000, 20]));
    assert.equal(busy.status, 503); assert.equal(busy.headers.get('retry-after'), '60');
    assert.doesNotMatch(await busy.text(), /https?:\/\/|\n\s*at\s/);
    controller.abort(); assert.equal((await first).status, 503); await tick();
    assert.equal(calls[0].signal.aborted, true);
    const retry = request(TEXTURED_BUILDINGS_URL); await tick(); assert.equal(calls.length, 2);
    calls[1].resolve(tile); assert.equal((await retry).status, 200);
    const invalid = await request(indexUrl(999));
    assert.equal(invalid.status, 503); assert.equal(calls.length, 2);
  } finally { for (const call of calls) call.resolve(tile); await tick(); await rm(directory, { recursive: true, force: true }); }
});

test('quota eviction cannot remove the last-good bytes of an active refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-in-use-'));
  const refresh = Promise.withResolvers<Buffer>(); let refreshing = false;
  const cache = new CityMapCache(directory, async url => url === indexUrl(1) && refreshing ? refresh.promise : tile, Date.now,
    { maxBytes: 750, maxEntries: 1 });
  try {
    await cache.read(indexUrl(1)); refreshing = true;
    const pending = cache.read(indexUrl(1), false, true); await tick();
    await cache.read(indexUrl(2));
    assert.ok(cache.storageIssue.includes('capacity'));
    const offline = new CityMapCache(directory, async () => { throw new Error('Offline'); }, Date.now, { maxBytes: 750, maxEntries: 1 });
    assert.deepEqual((await offline.read(indexUrl(1))).body, tile);
    refresh.resolve(indexBody()); await pending;
    const used = await usage(directory); assert.ok(used.bytes <= 750); assert.equal(used.entries, 1);
  } finally { refresh.resolve(tile); await tick(); await rm(directory, { recursive: true, force: true }); }
});
