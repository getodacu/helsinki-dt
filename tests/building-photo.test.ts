import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildingImageCache, BuildingPhotoCache } from '../src/lib/server/building-photo.ts';
import { validBuildingPhoto } from '../src/lib/building-photo.ts';
import { fetchEntity } from '../src/lib/entity-query.ts';

const cacheRoot = await mkdtemp(join(tmpdir(), 'helsinki-photos-'));
after(() => rm(cacheRoot, { recursive: true, force: true }));
function photoCache(fetch: ConstructorParameters<typeof BuildingPhotoCache>[0], now?: () => number) {
  return new BuildingPhotoCache(fetch, now, join(cacheRoot, randomUUID()));
}

const building = { vtjPrt: '103027184J', ratu: '00216' };
const binding = { item: { value: 'http://www.wikidata.org/entity/Q1393988' },
  image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/City%20Hall.jpg' },
  vtj: { value: building.vtjPrt }, ratu: { value: building.ratu } };
const info = { mime: 'image/jpeg', thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/City_Hall.jpg/960px-City_Hall.jpg',
  descriptionurl: 'https://commons.wikimedia.org/wiki/File:City_Hall.jpg', extmetadata: {
    Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Example">A &amp; B &#xE4;</a>' },
    LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' } } };
const body = (value: unknown) => Promise.resolve({ body: JSON.stringify(value) });
const matches = (rows = [binding]) => ({ results: { bindings: rows } });
const commons = (image = info) => ({ query: { pages: [{ imageinfo: [image] }] } });

test('exact IDs, Commons metadata, safe attribution, deduplication and bounded requests', async () => {
  const urls: URL[] = [];
  const cache = photoCache((url, options) => {
    assert.equal(options.maxBytes, 256 * 1024); assert.equal(options.timeoutMs, 10_000); assert.equal(options.redirect, 'error');
    const parsed = new URL(url); urls.push(parsed);
    return body(parsed.hostname === 'query.wikidata.org' ? matches() : commons());
  });
  const [a, b] = await Promise.all([cache.get(building), cache.get(building)]);
  assert.deepEqual(a, b); assert.ok(a); assert.equal(a.author, 'A & B ä');
  assert.equal(urls.length, 2); assert.match(urls[0].searchParams.get('query')!, /P3824 "103027184J"/);
  assert.match(urls[0].searchParams.get('query')!, /P8355 "00216"/);
  assert.equal(urls[1].searchParams.get('titles'), 'File:City Hall.jpg');
  await cache.get(building); assert.equal(urls.length, 2);
});

test('missing IDs, missing images, conflicting identifiers and ambiguous matches stay empty', async () => {
  let requests = 0;
  const noIds = photoCache(() => { requests++; return body(matches()); });
  assert.equal(await noIds.get({ vtjPrt: null, ratu: null }), null);
  assert.equal(await noIds.get({ vtjPrt: '" } UNION { ?item ?p ?v', ratu: '1"' }), null);
  assert.equal(requests, 0);
  for (const rows of [[], [{ ...binding, image: undefined }], [binding, { ...binding, item: { value: 'http://www.wikidata.org/entity/Q1' } }],
    [{ ...binding, vtj: { value: '103027999J' } }], [{ ...binding, ratu: { value: '999' } }]]) {
    const cache = photoCache(() => body(matches(rows as typeof binding[])));
    assert.equal(await cache.get(building), null);
  }
});

test('unsafe URLs, restricted images and missing attribution cannot become hero images', async () => {
  for (const image of [{ ...info, thumburl: 'https://evil.example/photo.jpg' }, { ...info, mime: 'image/svg+xml' },
    { ...info, extmetadata: { ...info.extmetadata, Artist: { value: '' } } },
    { ...info, extmetadata: { ...info.extmetadata, Restrictions: { value: 'non-commercial' } } },
    { ...info, extmetadata: { ...info.extmetadata, LicenseUrl: { value: 'javascript:alert(1)' } } }]) {
    const cache = photoCache(url => body(url.startsWith('https://query.wikidata.org') ? matches() : commons(image)));
    assert.equal(await cache.get(building), null);
  }
  assert.equal(validBuildingPhoto({ url: info.thumburl }), false);
});

test('failed refresh retains a photo and retries after five minutes; misses are cached for a day', async () => {
  let now = 0, fail = false, requests = 0;
  const cache = photoCache(url => {
    requests++; if (fail) throw new Error('offline');
    return body(url.startsWith('https://query.wikidata.org') ? matches() : commons());
  }, () => now);
  const photo = await cache.get(building); assert.ok(photo); fail = true; now = 24 * 3600_000;
  assert.deepEqual(await cache.get(building), photo); assert.equal(requests, 3);
  await cache.get(building); assert.equal(requests, 3);
  now += 5 * 60_000; fail = false; await cache.get(building); assert.equal(requests, 5);
  let misses = 0;
  const missing = photoCache(() => { misses++; return body(matches([])); }, () => now);
  await missing.get(building); await missing.get(building); assert.equal(misses, 1);
  now += 24 * 3600_000; await missing.get(building); assert.equal(misses, 2);
});

test('parallel lookups are capped at two and cached entries are bounded', async () => {
  const pending: ((value: { body: string }) => void)[] = [];
  const ready = Promise.withResolvers<void>();
  const cache = photoCache(() => new Promise(resolve => { pending.push(resolve); if (pending.length === 2) ready.resolve(); }));
  const first = cache.get(building), second = cache.get({ vtjPrt: null, ratu: '1' });
  await ready.promise;
  await assert.rejects(cache.get({ vtjPrt: null, ratu: '2' }), /busy/);
  for (const finish of pending) finish({ body: JSON.stringify(matches([])) });
  await Promise.all([first, second]);
  let requests = 0;
  const bounded = photoCache(() => { requests++; return body(matches([])); });
  for (let ratu = 1; ratu <= 513; ratu++) await bounded.get({ vtjPrt: null, ratu: String(ratu) });
  await bounded.get({ vtjPrt: null, ratu: '1' }); assert.equal(requests, 513);
});

test('client validates photo URLs, generation and payload without requiring building details', async t => {
  const photo = await photoCache(url => body(url.startsWith('https://query.wikidata.org') ? matches() : commons())).get(building);
  let payload: unknown = { generation: 'generation', buildingId: 'BID_1', photo };
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
  const path = '/api/entities/building/BID_1/photo?generation=generation', signal = new AbortController().signal;
  assert.deepEqual((await fetchEntity(path, signal, 'generation') as { photo: unknown }).photo, photo);
  payload = { generation: 'old', buildingId: 'BID_1', photo };
  await assert.rejects(fetchEntity(path, signal, 'generation'), /generation mismatch/);
  payload = { generation: 'generation', buildingId: 'BID_1', photo: { ...photo, url: 'javascript:alert(1)' } };
  await assert.rejects(fetchEntity(path, signal, 'generation'), /photo response/);
  payload = { generation: 'generation', buildingId: 'BID_1', photo: null };
  assert.equal((await fetchEntity(path, signal, 'generation') as { photo: unknown }).photo, null);
});

test('photo metadata survives restart and retains the matched photo during source outages', async () => {
  const directory = join(cacheRoot, randomUUID()); let now = 0, requests = 0;
  const fetch = (url: string) => { requests++; return body(url.startsWith('https://query.wikidata.org') ? matches() : commons()); };
  const photo = await new BuildingPhotoCache(fetch, () => now, directory).get(building); assert.ok(photo);
  const offline = async () => { throw new Error('offline'); };
  assert.deepEqual(await new BuildingPhotoCache(offline, () => now, directory).get(building), photo);
  assert.equal(requests, 2); now += 24 * 3600_000;
  assert.deepEqual(await new BuildingPhotoCache(offline, () => now, directory).get(building), photo);
  const file = (await readdir(directory)).find(name => name.endsWith('.json'))!;
  await writeFile(join(directory, file), '{broken');
  assert.deepEqual(await new BuildingPhotoCache(fetch, () => now, directory).get(building), photo); assert.equal(requests, 4);
});

test('image bytes are deduplicated, persisted, checksum checked and reused offline after restart', async () => {
  const photo = await photoCache(url => body(url.startsWith('https://query.wikidata.org') ? matches() : commons())).get(building); assert.ok(photo);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=', 'base64');
  const directory = join(cacheRoot, randomUUID()); let downloads = 0;
  const fetch = async (_url: string, options: { maxBytes?: number; redirect?: RequestRedirect }) => {
    downloads++; assert.equal(options.maxBytes, 4 * 1024 ** 2); assert.equal(options.redirect, 'error'); return { body: png };
  };
  const cache = new BuildingImageCache(directory, fetch);
  const [a, b] = await Promise.all([cache.read(photo), cache.read(photo)]);
  assert.deepEqual(a.body, png); assert.equal(a.type, 'image/png'); assert.equal(a.etag, b.etag); assert.equal(downloads, 1);
  const offline = new BuildingImageCache(directory, async () => { throw new Error('offline'); });
  assert.deepEqual((await offline.read(photo)).body, png);
  const file = (await readdir(directory)).find(name => name.endsWith('.image'))!;
  await writeFile(join(directory, file), Buffer.from('corrupt'));
  await assert.rejects(offline.read(photo), /offline/);
  assert.deepEqual((await cache.read(photo)).body, png); assert.equal(downloads, 2);
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
});

test('image downloads reject unsafe sources, invalid image bytes and oversized files', async () => {
  const photo = await photoCache(url => body(url.startsWith('https://query.wikidata.org') ? matches() : commons())).get(building); assert.ok(photo);
  let calls = 0;
  const cache = new BuildingImageCache(join(cacheRoot, randomUUID()), async () => { calls++; return { body: Buffer.from('<html>not a photo</html>') }; });
  await assert.rejects(cache.read({ ...photo, url: 'https://evil.example/photo.jpg' }), /source/); assert.equal(calls, 0);
  await assert.rejects(cache.read(photo), /Invalid building photo image/);
  const huge = new BuildingImageCache(join(cacheRoot, randomUUID()), async () => ({ body: Buffer.alloc(4 * 1024 ** 2 + 1) }));
  await assert.rejects(huge.read(photo), /byte limit/);
});

test('only two image cache misses can download concurrently', async () => {
  const photo = await photoCache(url => body(url.startsWith('https://query.wikidata.org') ? matches() : commons())).get(building); assert.ok(photo);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=', 'base64');
  const downloads: ((value: { body: Buffer }) => void)[] = [], ready = Promise.withResolvers<void>();
  const cache = new BuildingImageCache(join(cacheRoot, randomUUID()), () => new Promise(resolve => {
    downloads.push(resolve); if (downloads.length === 2) ready.resolve();
  }));
  const first = cache.read(photo), second = cache.read({ ...photo, url: photo.url + '?version=2' });
  await ready.promise;
  await assert.rejects(cache.read({ ...photo, url: photo.url + '?version=3' }), /busy/);
  for (const finish of downloads) finish({ body: png });
  await Promise.all([first, second]); assert.equal(downloads.length, 2);
});
