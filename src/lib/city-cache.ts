const CACHE_NAME = 'helsinki-map-v1';
import { municipalAssetUrl } from './city-source.ts';
const DAY = 24 * 60 * 60 * 1000;
type Priority = 'foreground' | 'background';
interface Job {
  url: string; limit: number; priority: Priority; controller: AbortController; started: boolean;
  consumers: number; promise: Promise<{ bytes: ArrayBuffer; cached: boolean }>;
  resolve: (value: { bytes: ArrayBuffer; cached: boolean }) => void; reject: (error: unknown) => void;
}

async function boundedBytes(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error(`City asset unavailable (${response.status})`);
  const reader = response.body.getReader(), pieces: Uint8Array[] = []; let length = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('City asset exceeds byte limit');
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > limit) throw new Error('City asset exceeds byte limit'); pieces.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  return bytes.buffer;
}

/** One bounded queue for static map assets; live feeds never enter this cache. */
export class CityAssetCache {
  storageIssue = '';
  private jobs = new Map<string, Job>();
  private active = 0;
  private activeBackground = 0;
  private backgroundAllowed = false;
  private paused = false;
  private disposed = false;
  private store: Promise<Cache | null>;
  private saved = new Set<string>();
  private invalid = new Set<string>();
  private fetcher: typeof fetch;
  private origin: string;
  private changed: () => void;
  constructor(fetcher: typeof fetch = fetch, storage: CacheStorage | undefined = globalThis.caches,
    origin = globalThis.location?.origin ?? 'http://localhost', changed: () => void = () => {}) {
    this.fetcher = fetcher.bind(globalThis); this.origin = origin; this.changed = changed;
    this.store = storage ? storage.open(CACHE_NAME).catch(() => { this.storageFailed(); return null; }) : Promise.resolve(null);
    if (!storage) this.storageFailed();
  }
  private storageFailed() {
    this.storageIssue = 'Browser map caching is unavailable or storage is full. Shared server caching continues.';
    this.changed(); this.pump();
  }
  private key(url: string) {
    const key = new URL(url, this.origin);
    const local = key.origin === this.origin && /^\/data\/city\/generations\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json$/.test(key.pathname) && !key.search;
    const municipal = key.origin === 'https://kartta.hel.fi';
    if (municipal) municipalAssetUrl(key.href);
    if ((!local && !municipal) || key.hash || key.username || key.password) throw new Error('Unsafe city cache URL');
    return key.href;
  }
  setBackgroundAllowed(allowed: boolean) { this.backgroundAllowed = allowed; this.pump(); }
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) for (const job of this.jobs.values()) if (job.started) job.controller.abort();
    this.pump();
  }
  async invalidate(url: string) {
    const key = this.key(url); this.saved.delete(key); this.invalid.add(key);
    const store = await this.store;
    try { return store ? await store.delete(key) : false; } catch { this.storageFailed(); return false; }
  }
  private pump() {
    if (this.disposed || this.paused) return;
    if (this.storageIssue) for (const job of this.jobs.values()) if (!job.started && job.priority === 'background') {
      this.jobs.delete(job.url); job.reject(new Error(this.storageIssue));
    }
    while (this.active < 4) {
      const jobs = [...this.jobs.values()].filter(job => !job.started && !job.controller.signal.aborted);
      const job = jobs.find(job => job.priority === 'foreground') ??
        (this.backgroundAllowed && this.activeBackground < 2 ? jobs.find(job => job.priority === 'background') : undefined);
      if (!job) break;
      job.started = true; this.active++;
      const background = job.priority === 'background'; if (background) this.activeBackground++;
      void this.download(job).then(job.resolve, error => {
        if (error instanceof Error) Object.assign(error, { assetUrl: job.url });
        job.reject(error);
      }).finally(() => {
        this.active--; if (background) this.activeBackground--; this.pump();
      });
    }
  }
  private async download(job: Job) {
    const store = await this.store; job.controller.signal.throwIfAborted();
    if (store) {
      try {
        const response = await store.match(job.url);
        if (response) {
          const at = Number(response.headers.get('x-helsinki-cached-at'));
          if (at > 0 && (new URL(job.url).origin === this.origin || Date.now() - at < DAY)) {
            try { return { bytes: await boundedBytes(response, job.limit), cached: true }; }
            catch { await store.delete(job.url); }
          }
          this.saved.delete(job.url);
        }
      } catch { this.storageFailed(); }
    }
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(30_000)]);
    const local = new URL(job.url).origin === this.origin;
    const requestUrl = local ? job.url : this.origin + '/api/city-asset?' + new URLSearchParams({ url: job.url });
    const refresh = this.invalid.delete(job.url);
    const response = await this.fetcher(requestUrl, { signal, cache: refresh ? 'reload' : 'default', headers: refresh && !local ? { 'x-helsinki-refresh': '1' } : undefined });
    return { bytes: await boundedBytes(response, job.limit), cached: false };
  }
  private async save(url: string, bytes: ArrayBuffer) {
    if (this.storageIssue || this.saved.has(url)) return;
    const store = await this.store;
    if (!store) return;
    try {
      await store.put(url, new Response(bytes, { headers: { 'x-helsinki-cached-at': String(Date.now()), 'content-length': String(bytes.byteLength) } }));
      this.saved.add(url);
    } catch { this.storageFailed(); }
  }
  async read<T>(url: string, limit: number, decode: (bytes: ArrayBuffer) => T | Promise<T>, signal?: AbortSignal,
    priority: Priority = 'foreground', retry = true): Promise<T> {
    if (this.disposed) throw new DOMException('Map disposed', 'AbortError');
    signal?.throwIfAborted();
    if (priority === 'background' && this.storageIssue) throw new Error(this.storageIssue);
    const key = this.key(url); let job = this.jobs.get(key);
    if (job && job.limit !== limit) throw new Error('Inconsistent city asset byte limit');
    if (!job) {
      let resolve!: Job['resolve'], reject!: Job['reject'];
      const promise = new Promise<{ bytes: ArrayBuffer; cached: boolean }>((yes, no) => { resolve = yes; reject = no; });
      job = { url: key, limit, priority, controller: new AbortController(), started: false, consumers: 0, promise, resolve, reject };
      this.jobs.set(key, job);
    } else if (priority === 'foreground') job.priority = 'foreground';
    job.consumers++; this.pump();
    const current = job;
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    let data: { bytes: ArrayBuffer; cached: boolean } | undefined;
    try {
      data = await Promise.race([current.promise, aborted]); signal?.throwIfAborted();
      let value: T;
      try { value = await decode(data.bytes.slice(0)); }
      catch (error) {
        await this.invalidate(url);
        if (data.cached && retry && !signal?.aborted) {
          // Release this completed job before refetching its rejected cached contents.
          if (this.jobs.get(key) === current) this.jobs.delete(key);
          return await this.read(url, limit, decode, signal, priority, false);
        }
        throw error;
      }
      if (!data.cached) await this.save(key, data.bytes);
      return value;
    } finally {
      signal?.removeEventListener('abort', abort); current.consumers--;
      if (!current.consumers) {
        if (!data) { current.controller.abort(); if (!current.started) current.reject(new DOMException('Aborted', 'AbortError')); }
        if (this.jobs.get(key) === current) this.jobs.delete(key);
      }
    }
  }
  dispose() {
    this.disposed = true;
    for (const job of this.jobs.values()) { job.controller.abort(); if (!job.started) job.reject(new DOMException('Map disposed', 'AbortError')); }
    this.jobs.clear();
  }
}
