const CACHE_NAME = 'helsinki-map-v1';
import { municipalAssetUrl } from './city-source.ts';
const DAY = 24 * 60 * 60 * 1000;
type Priority = 'foreground' | 'background';
export type AssetScheduling = 'semantic' | 'map';
interface Job {
  url: string; limit: number; priority: Priority; scheduling: AssetScheduling; controller: AbortController; state: 'queued' | 'checking' | 'ready' | 'started' | 'complete';
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
  private checking = 0;
  private decoding = 0;
  private activeBackground = 0;
  private backgroundAllowed = false;
  private paused = false;
  private interacting = false;
  private settled = true;
  private batchOpen = true;
  private navigationAt = 0;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private downloadTimer: ReturnType<typeof setTimeout> | undefined;
  private waiting = new Set<() => void>();
  onViewSettled: () => void = () => {};
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
  get workAllowed() { return !this.paused && !this.disposed; }
  get viewSettled() { return this.settled && this.workAllowed; }
  hasStarted(url: string) { const state = this.jobs.get(this.key(url))?.state; return state === 'started' || state === 'complete'; }
  viewChanged() {
    if (this.disposed) return;
    this.settled = false; this.batchOpen = false; this.navigationAt = Date.now();
    clearTimeout(this.downloadTimer); this.armSettle();
  }
  setInteracting(active: boolean) { this.interacting = active; this.viewChanged(); }
  private armSettle() {
    clearTimeout(this.settleTimer);
    if (this.interacting || this.paused || this.disposed) return;
    this.settleTimer = setTimeout(() => {
      this.settled = true;
      // Prune the old view before any deferred decode or queue continuation runs.
      this.onViewSettled();
      for (const resume of [...this.waiting]) resume();
      this.pump();
    }, Math.max(0, 1500 - (Date.now() - this.navigationAt)));
  }
  whenViewSettled(signal?: AbortSignal): Promise<void> { return this.waitForWork(signal); }
  whenActive(signal?: AbortSignal): Promise<void> { return this.waitForWork(signal, false, 'map'); }
  private async waitForWork(signal?: AbortSignal, decode = false, scheduling: AssetScheduling = 'semantic'): Promise<void> {
    signal?.throwIfAborted();
    while (!this.workAllowed || (scheduling === 'semantic' && !this.settled) || (decode && this.decoding >= 4)) {
      if (this.disposed) throw new DOMException('Map disposed', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        const resume = () => { this.waiting.delete(resume); signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiting.delete(resume); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
        this.waiting.add(resume); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    if (decode) this.decoding++;
  }
  setBackgroundAllowed(allowed: boolean) { this.backgroundAllowed = allowed; this.pump(); }
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) {
      clearTimeout(this.settleTimer); clearTimeout(this.downloadTimer);
      for (const job of this.jobs.values()) if (job.state === 'started') job.controller.abort();
    } else {
      if (!this.settled) this.armSettle();
      for (const resume of [...this.waiting]) resume();
    }
    this.pump();
  }
  async invalidate(url: string) {
    const key = this.key(url); this.saved.delete(key); this.invalid.add(key);
    const store = await this.store;
    try { return store ? await store.delete(key) : false; } catch { this.storageFailed(); return false; }
  }
  private pump() {
    if (!this.workAllowed) return;
    if (this.storageIssue) for (const job of this.jobs.values()) if (job.priority === 'background' && !['started', 'complete'].includes(job.state)) {
      job.controller.abort(); this.jobs.delete(job.url); job.reject(new Error(this.storageIssue));
    }
    const buffered = (scheduling: AssetScheduling) => [...this.jobs.values()].filter(job => job.scheduling === scheduling && ['checking', 'started', 'complete'].includes(job.state)).length;
    const foreground = (jobs: Job[]) => jobs.find(job => job.priority === 'foreground' && job.scheduling === 'map') ?? jobs.find(job => job.priority === 'foreground');
    const allowed = (job: Job) => job.priority === 'background' ? this.backgroundAllowed && this.viewSettled : job.scheduling === 'map' || this.viewSettled;
    while (this.checking < 4) {
      const jobs = [...this.jobs.values()].filter(job => job.state === 'queued' && !job.controller.signal.aborted && allowed(job) && buffered(job.scheduling) < 4);
      const job = foreground(jobs) ?? jobs.find(job => job.priority === 'background');
      if (!job) break;
      job.state = 'checking'; this.checking++;
      void this.cached(job).then(bytes => {
        job.controller.signal.throwIfAborted();
        if (bytes) { job.state = 'complete'; job.resolve({ bytes, cached: true }); }
        else job.state = 'ready';
      }, job.reject).catch(job.reject).finally(() => { this.checking--; this.pump(); });
    }
    const ready = [...this.jobs.values()].filter(job => job.state === 'ready' && !job.controller.signal.aborted);
    if (this.viewSettled && !this.batchOpen && ready.some(job => job.scheduling === 'semantic')) {
      const missing = ready.filter(job => job.priority === 'foreground' && job.scheduling === 'semantic').length;
      const remaining = (missing >= 8 ? 1500 : 4000) - (Date.now() - this.navigationAt);
      clearTimeout(this.downloadTimer);
      if (remaining > 0) this.downloadTimer = setTimeout(() => this.pump(), remaining);
      else this.batchOpen = true;
    }
    while (this.active < 4) {
      const jobs = [...this.jobs.values()].filter(job => job.state === 'ready' && !job.controller.signal.aborted && allowed(job)
        && (job.scheduling === 'map' || this.batchOpen) && buffered(job.scheduling) < 4);
      const job = foreground(jobs) ?? (this.activeBackground < 2 ? jobs.find(job => job.priority === 'background') : undefined);
      if (!job) break;
      job.state = 'started'; this.active++;
      const background = job.priority === 'background'; if (background) this.activeBackground++;
      void this.download(job).then(job.resolve, error => {
        if (error instanceof Error) Object.assign(error, { assetUrl: job.url });
        job.reject(error);
      }).finally(() => {
        job.state = 'complete'; this.active--; if (background) this.activeBackground--; this.pump();
      });
    }
  }
  private async cached(job: Job): Promise<ArrayBuffer | null> {
    const store = await this.store; job.controller.signal.throwIfAborted();
    if (store) {
      try {
        const response = await store.match(job.url);
        if (response) {
          const at = Number(response.headers.get('x-helsinki-cached-at'));
          if (at > 0 && (new URL(job.url).origin === this.origin || Date.now() - at < DAY)) {
            try { return await boundedBytes(response, job.limit); }
            catch { await store.delete(job.url); }
          }
          this.saved.delete(job.url);
        }
      } catch { this.storageFailed(); }
    }
    return null;
  }
  private async download(job: Job) {
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
    priority: Priority = 'foreground', retry = true, scheduling: AssetScheduling = 'semantic'): Promise<T> {
    if (this.disposed) throw new DOMException('Map disposed', 'AbortError');
    signal?.throwIfAborted();
    if (priority === 'background' && this.storageIssue) throw new Error(this.storageIssue);
    const key = this.key(url); let job = this.jobs.get(key);
    if (job && job.limit !== limit) throw new Error('Inconsistent city asset byte limit');
    if (!job) {
      let resolve!: Job['resolve'], reject!: Job['reject'];
      const promise = new Promise<{ bytes: ArrayBuffer; cached: boolean }>((yes, no) => { resolve = yes; reject = no; });
      job = { url: key, limit, priority, scheduling, controller: new AbortController(), state: 'queued', consumers: 0, promise, resolve, reject };
      this.jobs.set(key, job);
    } else {
      if (priority === 'foreground') job.priority = 'foreground';
      if (scheduling === 'map') job.scheduling = 'map';
    }
    job.consumers++; this.pump();
    const current = job;
    let abort!: () => void, released = false;
    let data: { bytes: ArrayBuffer; cached: boolean } | undefined;
    const release = () => {
      if (released) return;
      released = true; current.consumers--;
      if (!current.consumers) {
        if (!data) { current.controller.abort(); if (current.state !== 'started') current.reject(new DOMException('Aborted', 'AbortError')); }
        if (this.jobs.get(key) === current) this.jobs.delete(key);
        queueMicrotask(() => this.pump());
      }
    };
    const aborted = new Promise<never>((_, reject) => {
      abort = () => { release(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    try {
      data = await Promise.race([current.promise, aborted]); signal?.throwIfAborted();
      let value: T;
      try {
        await this.waitForWork(signal, true, scheduling);
        try { value = await decode(data.bytes.slice(0)); }
        finally { this.decoding--; for (const resume of [...this.waiting]) resume(); }
      }
      catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        await this.invalidate(url);
        if (data.cached && retry && !signal?.aborted) {
          // Release this completed job before refetching its rejected cached contents.
          if (this.jobs.get(key) === current) this.jobs.delete(key);
          return await this.read(url, limit, decode, signal, priority, false, scheduling);
        }
        throw error;
      }
      if (!data.cached) await this.save(key, data.bytes);
      return value;
    } finally {
      signal?.removeEventListener('abort', abort); release();
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.settleTimer); clearTimeout(this.downloadTimer);
    this.onViewSettled = () => {};
    for (const resume of [...this.waiting]) resume();
    for (const job of this.jobs.values()) { job.controller.abort(); if (job.state !== 'started') job.reject(new DOMException('Map disposed', 'AbortError')); }
    this.jobs.clear();
  }
}
