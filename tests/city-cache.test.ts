import test from 'node:test';
import assert from 'node:assert/strict';
import { CityAssetCache } from '../src/lib/city-cache.ts';
const origin = 'http://localhost';
const url = (name: string) => `${origin}/data/city/generations/test/${name}.json`;
const municipal = 'https://kartta.hel.fi/3d/datasource-data/e5e7158a-52df-45a1-9be0-1be8f2828abd/tileset.json';
const json = (bytes: ArrayBuffer) => JSON.parse(new TextDecoder().decode(bytes));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function memoryStorage() {
  const entries = new Map<string, Response>();
  const store = { match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, value: Response) => { entries.set(key, value.clone()); }, delete: async (key: string) => entries.delete(key) } as unknown as Cache;
  return { entries, store, storage: { open: async () => store } as unknown as CacheStorage };
}

test('validated map bytes persist across instances, generation URLs stay isolated, and stale municipal bytes revalidate', async () => {
  const disk = memoryStorage(); let requests = 0;
  const fetcher = (async () => { requests++; return new Response('{"ok":true}'); }) as typeof fetch;
  let cache = new CityAssetCache(fetcher, disk.storage, origin);
  assert.deepEqual(await cache.read(url('one'), 100, json), { ok: true }); cache.dispose();
  cache = new CityAssetCache(fetcher, disk.storage, origin);
  assert.deepEqual(await cache.read(url('one'), 100, json), { ok: true }); assert.equal(requests, 1);
  await cache.read(url('one').replace('/test/', '/next/'), 100, json); assert.equal(requests, 2);
  await cache.read(municipal, 100, json);
  disk.entries.set(municipal, new Response('{"old":true}', { headers: { 'x-helsinki-cached-at': String(Date.now() - 86_400_001) } }));
  assert.deepEqual(await cache.read(municipal, 100, json), { ok: true }); assert.equal(requests, 4);
  assert.ok(Number(disk.entries.get(municipal)!.headers.get('x-helsinki-cached-at')) > Date.now() - 1000);
  cache.dispose();
});

test('corrupt cached data is evicted and refetched; rejected source data is never persisted', async () => {
  const disk = memoryStorage(); disk.entries.set(url('one'), new Response('{"wrong":true}', { headers: { 'x-helsinki-cached-at': String(Date.now()) } }));
  let requests = 0;
  const fetcher = (async () => { requests++; return new Response('{"ok":true}'); }) as typeof fetch;
  const cache = new CityAssetCache(fetcher, disk.storage, origin);
  const validate = (bytes: ArrayBuffer) => { const value = json(bytes); if (!value.ok) throw new Error('Invalid fixture'); return value; };
  assert.deepEqual(await cache.read(url('one'), 100, validate), { ok: true }); assert.equal(requests, 1);
  await assert.rejects(cache.read(url('two'), 100, () => { throw new Error('Invalid source'); }), /Invalid source/);
  assert.ok(!disk.entries.has(url('two'))); cache.dispose();
});

test('the shared queue bounds requests to four, background to two, and promotes foreground consumers', async () => {
  const disk = memoryStorage(); const calls: { url: string; resolve: (response: Response) => void }[] = [];
  const fetcher = ((input: RequestInfo | URL) => new Promise<Response>(resolve => calls.push({ url: String(input), resolve }))) as typeof fetch;
  const cache = new CityAssetCache(fetcher, disk.storage, origin); cache.setBackgroundAllowed(true);
  const b1 = cache.read(url('b1'), 100, json, undefined, 'background');
  const b2 = cache.read(url('b2'), 100, json, undefined, 'background');
  const b3 = cache.read(url('b3'), 100, json, undefined, 'background');
  await tick(); assert.equal(calls.length, 2);
  cache.setBackgroundAllowed(false);
  const f = cache.read(url('f'), 100, json);
  const promoted = cache.read(url('b3'), 100, json);
  const last = cache.read(url('last'), 100, json);
  await tick(); assert.equal(calls.length, 4);
  assert.ok(calls.some(call => call.url === url('f'))); assert.ok(calls.some(call => call.url === url('b3')));
  calls[0].resolve(new Response('{}')); await tick(); assert.equal(calls.length, 5);
  for (const call of calls.slice(1)) call.resolve(new Response('{}'));
  await Promise.all([b1, b2, b3, f, promoted, last]); assert.equal(calls.filter(call => call.url === url('b3')).length, 1);
  cache.dispose();
});

test('aborting one consumer preserves a shared download; disposal aborts the final consumer', async () => {
  const disk = memoryStorage(); let resolve!: (response: Response) => void, signal!: AbortSignal;
  const fetcher = ((_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((yes, no) => {
    resolve = yes; signal = options!.signal!; signal.addEventListener('abort', () => no(signal.reason), { once: true });
  })) as typeof fetch;
  const cache = new CityAssetCache(fetcher, disk.storage, origin), abort = new AbortController();
  const first = cache.read(url('one'), 100, json, abort.signal), second = cache.read(url('one'), 100, json);
  const rejected = assert.rejects(first, /abort/i); await tick(); abort.abort(); await rejected; assert.equal(signal.aborted, false);
  resolve(new Response('{}')); await second;
  const pending = cache.read(url('two'), 100, json); const disposed = assert.rejects(pending, /abort|disposed/i);
  await tick(); cache.dispose(); await disposed; assert.equal(signal.aborted, true);
});

test('storage failures preserve foreground results, stop warming, and byte limits and URL restrictions remain enforced', async () => {
  const disk = memoryStorage(); disk.store.put = async () => { throw new DOMException('Full', 'QuotaExceededError'); };
  const fetcher = (async () => new Response('{"ok":true}')) as typeof fetch;
  const cache = new CityAssetCache(fetcher, disk.storage, origin);
  assert.deepEqual(await cache.read(url('one'), 100, json), { ok: true }); assert.ok(cache.storageIssue);
  await assert.rejects(cache.read(url('bg'), 100, json, undefined, 'background'), /storage/);
  await assert.rejects(cache.read('https://example.org/private', 100, json), /Unsafe/);
  await assert.rejects(cache.read('/api/traffic', 100, json), /Unsafe/);
  await assert.rejects(cache.read(url('large'), 2, json), /byte limit/); cache.dispose();
});

test('hidden-page pause interrupts active work and queues new work until resume', async () => {
  const disk = memoryStorage(); let requests = 0;
  const fetcher = ((_input: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_yes, no) => {
    requests++; options!.signal!.addEventListener('abort', () => no(options!.signal!.reason), { once: true });
  })) as typeof fetch;
  const cache = new CityAssetCache(fetcher, disk.storage, origin);
  const pending = cache.read(url('one'), 100, json); const paused = assert.rejects(pending, /abort/i);
  await tick(); cache.setPaused(true); await paused;
  const next = cache.read(url('two'), 100, json); const disposed = assert.rejects(next, /abort|disposed/i);
  await tick(); assert.equal(requests, 1); cache.setPaused(false); await tick(); assert.equal(requests, 2);
  cache.dispose(); await disposed;
});


test('browser fetch retains its required global receiver when invoked by the queue', async () => {
  const disk = memoryStorage();
  const fetcher = (function (this: unknown) { assert.equal(this, globalThis); return Promise.resolve(new Response('{}')); }) as typeof fetch;
  const cache = new CityAssetCache(fetcher, disk.storage, origin);
  assert.deepEqual(await cache.read(url('one'), 100, json), {}); cache.dispose();
});

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

test('navigation waits four seconds for seven cache misses, but 1.5 seconds for eight', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  for (const count of [7, 8]) {
    const disk = memoryStorage(); let requests = 0;
    const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
    cache.viewChanged();
    const results = Array.from({ length: count }, (_, i) => cache.read(url(String(i)), 100, json));
    t.mock.timers.tick(1499); await flush(); assert.equal(requests, 0);
    t.mock.timers.tick(1); await flush(); assert.equal(requests, count === 8 ? 8 : 0);
    if (count === 7) {
      t.mock.timers.tick(2499); await flush(); assert.equal(requests, 0);
      t.mock.timers.tick(1); await flush(); assert.equal(requests, 7);
    }
    await Promise.all(results); cache.dispose();
  }
});

test('holding the camera blocks work and its last damped movement resets the settle deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(); let requests = 0, updates = 0;
  const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.onViewSettled = () => updates++;
  cache.setInteracting(true);
  const results = Array.from({ length: 8 }, (_, i) => cache.read(url(String(i)), 100, json));
  t.mock.timers.tick(5000); await flush(); assert.equal(requests, 0); assert.equal(updates, 0);
  cache.setInteracting(false);
  t.mock.timers.tick(1000); cache.viewChanged();
  t.mock.timers.tick(1499); await flush(); assert.equal(requests, 0); assert.equal(updates, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(requests, 8); assert.equal(updates, 1);
  await Promise.all(results); cache.dispose();
});

test('cached URLs, duplicate consumers and background warming do not inflate the missing batch', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(); let requests = 0, cachedDecodes = 0;
  for (let i = 0; i < 8; i++) disk.entries.set(url('cached' + i), new Response('{}', { headers: { 'x-helsinki-cached-at': '10000' } }));
  const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.setBackgroundAllowed(true); cache.viewChanged();
  const results = [
    ...Array.from({ length: 8 }, (_, i) => cache.read(url('cached' + i), 100, bytes => { cachedDecodes++; return json(bytes); })),
    ...Array.from({ length: 8 }, () => cache.read(url('one'), 100, json)),
    ...Array.from({ length: 8 }, (_, i) => cache.read(url('background' + i), 100, json, undefined, 'background'))
  ];
  t.mock.timers.tick(1500); await flush(); assert.equal(cachedDecodes, 8); assert.equal(requests, 0);
  t.mock.timers.tick(2499); await flush(); assert.equal(requests, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(requests, 9);
  await Promise.all(results); cache.dispose();
});

test('completing in-flight downloads during movement neither decodes nor launches queued assets', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(), calls: ((response: Response) => void)[] = []; let decodes = 0;
  const cache = new CityAssetCache((() => new Promise<Response>(resolve => calls.push(resolve))) as typeof fetch, disk.storage, origin);
  const results = Array.from({ length: 6 }, (_, i) => cache.read(url(String(i)), 100, bytes => { decodes++; return json(bytes); }));
  await flush(); assert.equal(calls.length, 4);
  cache.setInteracting(true);
  for (const resolve of calls) resolve(new Response('{}'));
  await flush(); t.mock.timers.tick(5000); await flush();
  assert.equal(calls.length, 4); assert.equal(decodes, 0);
  cache.setInteracting(false);
  t.mock.timers.tick(1500); await flush(); assert.equal(decodes, 4); assert.equal(calls.length, 4);
  t.mock.timers.tick(2500); await flush(); assert.equal(calls.length, 6);
  for (const resolve of calls.slice(4)) resolve(new Response('{}'));
  await Promise.all(results); assert.equal(decodes, 6); cache.dispose();
});

test('disposal cancels navigation timers and rejects work waiting for the settled view', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(); let requests = 0, updates = 0;
  const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.onViewSettled = () => updates++;
  cache.viewChanged();
  const rejected = assert.rejects(cache.read(url('one'), 100, json), /abort|disposed/i);
  const waiting = assert.rejects(cache.whenViewSettled(), /abort|disposed/i);
  cache.dispose(); await Promise.all([rejected, waiting]);
  t.mock.timers.tick(5000); await flush(); assert.equal(requests, 0); assert.equal(updates, 0);
});

test('storage failure and expired municipal data still fetch after the small-batch delay', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000_000 });
  for (const storage of [undefined, memoryStorage().storage]) {
    let requests = 0;
    if (storage) await (await storage.open('test')).put(municipal, new Response('{}', { headers: { 'x-helsinki-cached-at': '1' } }));
    const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, storage, origin);
    cache.viewChanged(); const result = cache.read(municipal, 100, json);
    t.mock.timers.tick(1500); await flush(); assert.equal(requests, 0);
    t.mock.timers.tick(2500); await flush(); assert.equal(requests, 1);
    await result; cache.dispose();
  }
});


test('the final view prunes obsolete requests before downloads resume', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(), calls: ((response: Response) => void)[] = [], abort = new AbortController();
  const cache = new CityAssetCache((() => new Promise<Response>(resolve => calls.push(resolve))) as typeof fetch, disk.storage, origin);
  const obsolete = Array.from({ length: 12 }, (_, i) => assert.rejects(cache.read(url('old' + i), 100, json, abort.signal), /abort/i));
  await flush(); assert.equal(calls.length, 4);
  cache.viewChanged();
  for (const resolve of calls) resolve(new Response('{}'));
  await flush();
  cache.onViewSettled = () => abort.abort();
  t.mock.timers.tick(1500); await flush();
  assert.equal(calls.length, 4);
  await Promise.all(obsolete); cache.dispose();
});

test('deferred decoder cancellation preserves valid cached data and decode concurrency stays bounded', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(), decodes: (() => void)[] = []; let requests = 0;
  for (let i = 0; i < 8; i++) disk.entries.set(url(String(i)), new Response('{}', { headers: { 'x-helsinki-cached-at': '10000' } }));
  const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  const abort = new AbortController();
  const cancelled = assert.rejects(cache.read(url('0'), 100, async bytes => {
    cache.viewChanged(); await cache.whenViewSettled(abort.signal); return json(bytes);
  }, abort.signal), /abort/i);
  await flush(); abort.abort(); await cancelled;
  assert.ok(disk.entries.has(url('0')));
  t.mock.timers.tick(1500); await flush();
  const results = Array.from({ length: 8 }, (_, i) => cache.read(url(String(i)), 100, () => new Promise<void>(resolve => decodes.push(resolve))));
  await flush(); assert.equal(decodes.length, 4);
  for (const resolve of decodes.slice()) resolve();
  await flush(); assert.equal(decodes.length, 8);
  for (const resolve of decodes.slice(4)) resolve();
  await Promise.all(results); assert.equal(requests, 0); cache.dispose();
});

test('a hidden page suspends the pending deadline and cannot download until visible', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(); let requests = 0;
  const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.viewChanged(); const result = cache.read(url('one'), 100, json);
  t.mock.timers.tick(1000); cache.setPaused(true);
  t.mock.timers.tick(10_000); await flush(); assert.equal(requests, 0);
  cache.setPaused(false); cache.viewChanged();
  t.mock.timers.tick(3999); await flush(); assert.equal(requests, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(requests, 1);
  await result; cache.dispose();
});


test('slow decoders bound downloaded buffers while an admitted batch drains without another delay', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(), decodes: (() => void)[] = []; let requests = 0;
  const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.viewChanged();
  const results = Array.from({ length: 8 }, (_, i) => cache.read(url(String(i)), 100, () => new Promise<void>(resolve => decodes.push(resolve))));
  t.mock.timers.tick(1500); await flush(); assert.equal(requests, 4); assert.equal(decodes.length, 4);
  for (const resolve of decodes.slice()) resolve();
  await flush(); assert.equal(requests, 8); assert.equal(decodes.length, 8);
  for (const resolve of decodes.slice(4)) resolve();
  await Promise.all(results); cache.dispose();
});


test('continuous camera changes keep replacing one deadline until movement stops', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(); let requests = 0, settled = 0;
  const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.onViewSettled = () => settled++;
  cache.viewChanged(); const result = cache.read(url('one'), 100, json);
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1000); cache.viewChanged(); await flush(); }
  assert.equal(requests, 0); assert.equal(settled, 0);
  t.mock.timers.tick(1500); await flush(); assert.equal(settled, 1); assert.equal(requests, 0);
  t.mock.timers.tick(2500); await flush(); assert.equal(requests, 1);
  await result; cache.dispose();
});


test('visual assets fetch and decode immediately during movement while semantic assets wait', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(), requests: string[] = []; let mapDecodes = 0;
  disk.entries.set(url('cached-map'), new Response('{}', { headers: { 'x-helsinki-cached-at': '10000' } }));
  const cache = new CityAssetCache((async input => { requests.push(String(input)); return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.setInteracting(true);
  const abort = new AbortController(), semantic = assert.rejects(cache.read(url('semantic'), 100, json, abort.signal), /abort/i);
  const decode = (bytes: ArrayBuffer) => { mapDecodes++; return json(bytes); };
  const maps = [cache.read(url('map'), 100, decode, undefined, 'foreground', true, 'map'),
    cache.read(url('cached-map'), 100, decode, undefined, 'foreground', true, 'map')];
  await flush(); assert.deepEqual(requests, [url('map')]); assert.equal(mapDecodes, 2);
  await Promise.all(maps); abort.abort(); await semantic; cache.dispose();
});

test('four deferred semantic completions cannot block bounded map downloads or decoders', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(), calls: { url: string; resolve: (response: Response) => void }[] = [], decodes: (() => void)[] = [];
  const cache = new CityAssetCache(((input: RequestInfo | URL) => new Promise<Response>(resolve => calls.push({ url: String(input), resolve }))) as typeof fetch, disk.storage, origin);
  let semanticDecodes = 0;
  const semantics = Array.from({ length: 4 }, (_, i) => cache.read(url('semantic' + i), 100, bytes => { semanticDecodes++; return json(bytes); }));
  await flush(); assert.equal(calls.length, 4);
  cache.setInteracting(true);
  const maps = Array.from({ length: 8 }, (_, i) => cache.read(url('map' + i), 100, () => new Promise<void>(resolve => decodes.push(resolve)), undefined, 'foreground', true, 'map'));
  for (const call of calls.slice()) call.resolve(new Response('{}'));
  await flush(); assert.equal(calls.length, 8); assert.equal(semanticDecodes, 0);
  for (const call of calls.slice(4)) call.resolve(new Response('{}'));
  await flush(); assert.equal(decodes.length, 4); assert.equal(calls.length, 8);
  for (const resolve of decodes.slice()) resolve();
  await flush(); assert.equal(calls.length, 12);
  for (const call of calls.slice(8)) call.resolve(new Response('{}'));
  await flush(); assert.equal(decodes.length, 8);
  for (const resolve of decodes.slice(4)) resolve();
  await Promise.all(maps); assert.equal(semanticDecodes, 0);
  cache.setInteracting(false); t.mock.timers.tick(1500); await flush();
  await Promise.all(semantics); assert.equal(semanticDecodes, 4); cache.dispose();
});

test('imagery misses cannot shorten a seven-asset semantic deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(), requests: string[] = [];
  const cache = new CityAssetCache((async input => { requests.push(String(input)); return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.viewChanged();
  const semantics = Array.from({ length: 7 }, (_, i) => cache.read(url('semantic' + i), 100, json));
  const maps = Array.from({ length: 8 }, (_, i) => cache.read(url('map' + i), 100, json, undefined, 'foreground', true, 'map'));
  await flush(); assert.equal(requests.length, 8); await Promise.all(maps);
  t.mock.timers.tick(1500); await flush(); assert.equal(requests.length, 8);
  t.mock.timers.tick(2499); await flush(); assert.equal(requests.length, 8);
  t.mock.timers.tick(1); await flush(); assert.equal(requests.length, 15);
  await Promise.all(semantics); cache.dispose();
});

test('map work resumes immediately on visibility without waiting for semantic settlement', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(); let requests = 0;
  const cache = new CityAssetCache((async () => { requests++; return new Response('{}'); }) as typeof fetch, disk.storage, origin);
  cache.viewChanged(); cache.setPaused(true);
  const result = cache.read(url('map'), 100, json, undefined, 'foreground', true, 'map');
  await flush(); assert.equal(requests, 0);
  cache.setPaused(false); await flush(); assert.equal(requests, 1);
  await result; assert.equal(cache.viewSettled, false); cache.dispose();
});

test('corrupt visual cache entries recover immediately during movement', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const disk = memoryStorage(); let requests = 0;
  disk.entries.set(url('map'), new Response('{"wrong":true}', { headers: { 'x-helsinki-cached-at': '10000' } }));
  const cache = new CityAssetCache((async () => { requests++; return new Response('{"ok":true}'); }) as typeof fetch, disk.storage, origin);
  cache.setInteracting(true);
  const result = cache.read(url('map'), 100, bytes => { const value = json(bytes); if (!value.ok) throw new Error('Corrupt map'); return value; }, undefined, 'foreground', true, 'map');
  await flush(); assert.equal(requests, 1); assert.deepEqual(await result, { ok: true }); cache.dispose();
});
