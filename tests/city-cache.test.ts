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
