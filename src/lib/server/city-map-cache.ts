import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { loadCityBase, loadCityManifest, type CityBase } from '../city-assets.ts';
import { aerialEntries, municipalAssetUrl, TEXTURED_BUILDINGS_URL, texturedBuildingIds, tileLocation, validateTileIndex, type Tile } from '../city-source.ts';
import { requestBytes } from './io.ts';

export const CITY_MAP_MAX_AGE = 30 * 86400_000;
const assetKey = (value: string) => { const url = new URL(value); url.searchParams.sort(); return hash(url.href); };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
interface SavedAsset { body: Buffer; retrievedAt: number; type: string }
interface Download {
  url: string; background: boolean; started: boolean; settled: boolean; clients: number;
  controller: AbortController; promise: Promise<SavedAsset>;
  resolve: (asset: SavedAsset) => void; reject: (error: unknown) => void;
}
type FetchAsset = (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Buffer>;
interface CacheOptions { maxBytes?: number; maxEntries?: number; maxPending?: number; maxQueued?: number; base?: () => Promise<CityBase> }
interface DiskEntry { files: Map<string, number>; usedAt: number }
const configured = (value: number | string | undefined, fallback: number) => {
  const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};

export const preparedCityFetch = (async (input: RequestInfo | URL) => {
  const path = String(input);
  if (!/^\/data\/city\/(manifest\.json|generations\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json)$/.test(path)) throw new Error('Unsafe prepared asset');
  try {
    const body = await readFile(resolve('static', path.slice(1))).catch(() => readFile(resolve('build/client', path.slice(1))));
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  } catch { return new Response(null, { status: 404 }); }
}) as typeof fetch;

export function validateMunicipalAsset(url: string, body: Buffer) {
  const bytes = Uint8Array.from(body).buffer;
  if (new URL(url).pathname.endsWith('.json')) { validateTileIndex(bytes, url); return 'application/json'; }
  if (new URL(url).pathname.endsWith('.glb')) { texturedBuildingIds(bytes); return 'model/gltf-binary'; }
  if (body.length < 20 || body.readUInt16BE(0) !== 0xffd8 || body.readUInt16BE(body.length - 2) !== 0xffd9) throw new Error('Invalid aerial JPEG');
  let offset = 2;
  while (offset + 9 <= body.length && body[offset] === 0xff) {
    const marker = body[offset + 1], length = body.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > body.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (body.readUInt16BE(offset + 5) !== 1024 || body.readUInt16BE(offset + 7) !== 1024) break;
      return 'image/jpeg';
    }
    offset += length + 2;
  }
  throw new Error('Invalid aerial JPEG dimensions');
}

/** One process owns this directory. Stale bytes survive refresh failures and atomic publication. */
export class CityMapCache {
  storageIssue = '';
  private directory: string;
  private fetchAsset: FetchAsset;
  private now: () => number;
  private options: Required<CacheOptions>;
  private pending = new Map<string, Download>();
  private failures = new Map<string, { due: number; error: unknown }>();
  private queue: Download[] = [];
  private active = 0;
  private activeBackground = 0;
  private disk = new Map<string, DiskEntry>();
  private inUse = new Map<string, number>();
  private diskReady = false;
  private publication: Promise<unknown> = Promise.resolve();
  private publicReady?: Promise<void>;
  private base?: CityBase;
  private admitted = new Set<string>([TEXTURED_BUILDINGS_URL]);
  constructor(directory = process.env.CITY_MAP_CACHE_DIR || resolve('.cache/city-map'),
    fetchAsset: FetchAsset = async (url, maxBytes, signal) => (await requestBytes(url, { maxBytes, timeoutMs: 30_000, redirect: 'error', signal })).body,
    now = Date.now, options: CacheOptions = {}) {
    this.directory = directory; this.fetchAsset = fetchAsset; this.now = now;
    this.options = {
      maxBytes: configured(options.maxBytes ?? process.env.CITY_MAP_CACHE_MAX_BYTES, 8 * 1024 ** 3),
      maxEntries: configured(options.maxEntries ?? process.env.CITY_MAP_CACHE_MAX_ENTRIES, 16_384),
      maxPending: configured(options.maxPending ?? process.env.CITY_MAP_CACHE_MAX_PENDING, 36),
      maxQueued: configured(options.maxQueued ?? process.env.CITY_MAP_CACHE_MAX_QUEUED, 32),
      base: options.base ?? (async () => loadCityBase(await loadCityManifest(preparedCityFetch), preparedCityFetch))
    };
  }
  private limit(url: string) { return new URL(url).pathname.endsWith('.json') ? 2_000_000 : 8_000_000; }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.publication.then(work); this.publication = result.catch(() => {}); return result;
  }
  private async inventory() {
    if (this.diskReady) return;
    let files;
    try { files = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.diskReady = true; return; } throw error; }
    for (const file of files) {
      // Only municipal hash files belong to this budget; never touch temp files or other caches.
      const match = /^([a-f0-9]{64})(?:\.[a-f0-9-]{36})?\.(bin|json)$/.exec(file.name);
      if (!file.isFile() || !match || (match[2] === 'json' && file.name !== match[1] + '.json')) continue;
      const info = await stat(resolve(this.directory, file.name));
      let entry = this.disk.get(match[1]);
      if (!entry) { entry = { files: new Map(), usedAt: info.mtimeMs }; this.disk.set(match[1], entry); }
      entry.files.set(file.name, info.size);
    }
    this.diskReady = true;
  }
  private async remove(key: string) {
    const entry = this.disk.get(key); if (!entry) return;
    await rm(resolve(this.directory, key + '.json'), { force: true });
    for (const file of entry.files.keys()) if (file !== key + '.json') await rm(resolve(this.directory, file), { force: true });
    this.disk.delete(key);
  }
  private async room(key: string, bytes: number, replacing: boolean) {
    const size = (entry: DiskEntry) => [...entry.files.values()].reduce((sum, value) => sum + value, 0);
    const previous = replacing ? this.disk.get(key) : undefined;
    let usedBytes = bytes - (previous ? size(previous) : 0), entries = this.disk.size - (previous ? 1 : 0) + (replacing ? 1 : 0);
    for (const entry of this.disk.values()) usedBytes += size(entry);
    const fits = () => usedBytes <= this.options.maxBytes && entries <= this.options.maxEntries;
    if (bytes > this.options.maxBytes) return false;
    if (fits()) return true;
    const protectedKeys = new Set([...this.pending.keys()].map(assetKey));
    const candidates = [...this.disk].filter(([candidate]) => candidate !== key && !this.inUse.has(candidate)
      && !protectedKeys.has(candidate)).sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [candidate, entry] of candidates) {
      if (fits()) break;
      await this.remove(candidate); usedBytes -= size(entry); entries--;
    }
    return fits();
  }
  private async savedUnlocked(url: string): Promise<SavedAsset | null> {
    const key = assetKey(url), path = resolve(this.directory, key);
    try {
      if ((await stat(path + '.json')).size > 2048) throw new Error('Oversized saved map metadata');
      const metadata = JSON.parse(await readFile(path + '.json', 'utf8'));
      const file = metadata.file ?? key + '.bin';
      if (file !== key + '.bin' && !new RegExp('^' + key + '\\.[a-f0-9-]{36}\\.bin$').test(file)) throw new Error('Unsafe saved map file');
      const bodyPath = resolve(this.directory, file);
      if ((await stat(bodyPath)).size > this.limit(url)) throw new Error('Oversized saved map asset');
      const body = await readFile(bodyPath);
      if (municipalAssetUrl(metadata.url) !== url || !Number.isFinite(metadata.retrievedAt) || metadata.retrievedAt > this.now() + 60_000 || metadata.sha256 !== hash(body)) throw new Error('Corrupt saved map asset');
      const asset = { body, retrievedAt: metadata.retrievedAt, type: validateMunicipalAsset(url, body) };
      const entry = this.disk.get(key); if (entry) entry.usedAt = this.now();
      return asset;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await this.remove(key).catch(() => {});
      return null;
    }
  }
  private saved(url: string) {
    const key = assetKey(url); this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
    return this.serialized(async () => {
      await this.inventory();
      return this.savedUnlocked(url);
    }).catch(() => null).finally(async () => {
      const clients = this.inUse.get(key)! - 1; if (clients) this.inUse.set(key, clients); else this.inUse.delete(key);
      // Reads and publication share the lock; prune only after this reader owns its bytes.
      await this.serialized(async () => { await this.room('', 0, false); }).catch(() => {});
    });
  }
  private registerIndex(url: string, body: Buffer) {
    if (!this.base || !url.endsWith('.json')) return;
    const root = validateTileIndex(Uint8Array.from(body).buffer, url), base = this.base;
    this.admitted.add(url);
    const visit = (tile: Tile, transform: THREE.Matrix4) => {
      const entry = tileLocation(tile, transform, url), [west, south, east, north] = entry.bounds;
      if (west >= base.bounds[2] || east <= base.bounds[0] || south >= base.bounds[3] || north <= base.bounds[1]) return;
      if (entry.url) this.admitted.add(municipalAssetUrl(entry.url));
      for (const child of tile.children ?? []) visit(child, entry.transform);
    };
    visit(root, new THREE.Matrix4());
  }
  private preparePublic() {
    if (!this.publicReady) this.publicReady = (async () => {
      this.base = await this.options.base();
      for (const entry of aerialEntries(this.base)) this.admitted.add(municipalAssetUrl(entry.url));
      await this.serialized(async () => {
        await this.inventory();
        // Browser-cached indices can skip the proxy after restart: restore their validated discoveries.
        for (const key of this.disk.keys()) {
          try {
            const path = resolve(this.directory, key + '.json');
            if ((await stat(path)).size > 2048) continue;
            const metadata = JSON.parse(await readFile(path, 'utf8')), url = municipalAssetUrl(metadata.url);
            if (assetKey(url) !== key || !url.endsWith('.json')) continue;
            const asset = await this.savedUnlocked(url); if (asset) this.registerIndex(url, asset.body);
          } catch { /* Unusable cached indices cannot admit public keys. */ }
        }
      });
    })().catch(error => { this.publicReady = undefined; throw error; });
    return this.publicReady;
  }
  async readPublic(value: string, signal?: AbortSignal, refresh = false): Promise<SavedAsset> {
    const url = municipalAssetUrl(value); signal?.throwIfAborted();
    await this.preparePublic(); signal?.throwIfAborted();
    if (!this.admitted.has(url) && /\.(glb|json)$/.test(new URL(url).pathname) && this.disk.has(assetKey(url))) {
      const saved = await this.saved(url); signal?.throwIfAborted();
      if (saved) {
        this.admitted.add(url);
        if (!refresh) {
          this.registerIndex(url, saved.body);
          if (this.now() - saved.retrievedAt >= CITY_MAP_MAX_AGE) void this.download(url, true).catch(() => {});
          return saved;
        }
      }
    }
    signal?.throwIfAborted();
    if (!this.admitted.has(url)) throw new Error('Map asset is not prepared or discovered');
    return this.read(url, false, refresh, signal);
  }
  private async publish(url: string, asset: SavedAsset, signal: AbortSignal) {
    return this.serialized(async () => {
      signal.throwIfAborted(); await this.inventory();
      const key = assetKey(url), file = key + '.' + randomUUID() + '.bin';
      const path = resolve(this.directory, key), bodyPath = resolve(this.directory, file);
      const metadata = JSON.stringify({ url, file, retrievedAt: asset.retrievedAt, sha256: hash(asset.body) });
      // ponytail: one process serializes publication/eviction; separate directories for multiple workers.
      if (!await this.room(key, asset.body.length + Buffer.byteLength(metadata), true)) {
        this.storageIssue = 'Server map cache capacity reached. Adjust CITY_MAP_CACHE_MAX_BYTES or CITY_MAP_CACHE_MAX_ENTRIES for this deployment.';
        return;
      }
      let published = false;
      try {
        await mkdir(this.directory, { recursive: true });
        await writeFile(bodyPath + '.tmp', asset.body, { flag: 'wx' });
        await writeFile(bodyPath + '.json.tmp', metadata, { flag: 'wx' });
        signal.throwIfAborted();
        await rename(bodyPath + '.tmp', bodyPath);
        await rename(bodyPath + '.json.tmp', path + '.json'); published = true;
        const previous = this.disk.get(key);
        const files = new Map(previous?.files);
        files.set(file, asset.body.length); files.set(key + '.json', Buffer.byteLength(metadata));
        this.disk.set(key, { files, usedAt: this.now() });
        if (previous) for (const old of previous.files.keys()) if (old !== key + '.json') {
          await rm(resolve(this.directory, old), { force: true }); files.delete(old);
        }
      } finally {
        await Promise.all([rm(bodyPath + '.tmp', { force: true }), rm(bodyPath + '.json.tmp', { force: true }),
          ...(!published ? [rm(bodyPath, { force: true })] : [])]).catch(() => {});
      }
    });
  }
  private pump() {
    while (this.active < 4) {
      const foreground = this.queue.findIndex(job => !job.background);
      const index = foreground >= 0 ? foreground : this.active === this.activeBackground && this.activeBackground < 2 ? 0 : -1;
      if (index < 0 || !this.queue.length) return;
      const job = this.queue.splice(index, 1)[0], wasBackground = job.background;
      job.started = true; this.active++; if (wasBackground) this.activeBackground++;
      const finish = () => {
        job.settled = true;
        if (this.pending.get(job.url) === job) this.pending.delete(job.url);
        this.active--; if (wasBackground) this.activeBackground--; this.pump();
      };
      void (async () => {
        const body = await this.fetchAsset(job.url, this.limit(job.url), job.controller.signal);
        job.controller.signal.throwIfAborted();
        if (body.length > this.limit(job.url)) throw new Error('Municipal asset exceeds byte limit');
        const asset = { body, retrievedAt: this.now(), type: validateMunicipalAsset(job.url, body) };
        try { await this.publish(job.url, asset, job.controller.signal); }
        catch {
          job.controller.signal.throwIfAborted();
          this.storageIssue = 'Server map cache could not be saved. Check disk space and cache directory permissions.';
        }
        this.registerIndex(job.url, body); this.failures.delete(job.url); return asset;
      })().then(asset => { finish(); job.resolve(asset); }, error => {
        if (!job.controller.signal.aborted) {
          if (error instanceof Error) Object.assign(error, { assetUrl: job.url });
          this.failures.set(job.url, { due: this.now() + 60_000, error });
        }
        finish(); job.reject(error);
      });
    }
  }
  private async consume(job: Download, signal?: AbortSignal): Promise<SavedAsset> {
    job.clients++;
    let abort: (() => void) | undefined;
    try {
      if (!signal) return await job.promise;
      const cancelled = Promise.withResolvers<never>();
      abort = () => cancelled.reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      return await Promise.race([job.promise, cancelled.promise]);
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
      if (--job.clients === 0 && !job.settled) {
        job.controller.abort();
        if (!job.started) {
          this.queue.splice(this.queue.indexOf(job), 1); this.pending.delete(job.url);
          job.settled = true; job.reject(job.controller.signal.reason); this.pump();
        }
      }
    }
  }
  private async download(url: string, background: boolean, signal?: AbortSignal): Promise<SavedAsset> {
    signal?.throwIfAborted();
    let job = this.pending.get(url);
    if (job?.controller.signal.aborted) { await job.promise.catch(() => {}); signal?.throwIfAborted(); job = this.pending.get(url); }
    if (job) {
      if (!background && !job.started) job.background = false;
      const result = this.consume(job, signal); this.pump(); return result;
    }
    const failure = this.failures.get(url);
    if (failure && failure.due > this.now()) throw failure.error;
    if (this.pending.size >= this.options.maxPending ||
      (this.queue.length >= this.options.maxQueued && (background || this.active >= 4))) throw new Error('Map request capacity reached');
    const deferred = Promise.withResolvers<SavedAsset>();
    job = { url, background, started: false, settled: false, clients: 0, controller: new AbortController(),
      promise: deferred.promise, resolve: deferred.resolve, reject: deferred.reject };
    this.pending.set(url, job); this.queue.push(job);
    const result = this.consume(job, signal); this.pump(); return result;
  }
  /** Trusted discovery/warmer callers retain the syntactic URL guard, not public admission. */
  async read(value: string, background = false, refresh = false, signal?: AbortSignal): Promise<SavedAsset> {
    const url = municipalAssetUrl(value); signal?.throwIfAborted();
    if (background && this.storageIssue) throw new Error(this.storageIssue);
    if (refresh) return this.download(url, background, signal);
    const saved = await this.saved(url); signal?.throwIfAborted();
    if (saved) {
      this.registerIndex(url, saved.body);
      if (this.now() - saved.retrievedAt >= CITY_MAP_MAX_AGE) void this.download(url, true).catch(() => {});
      return saved;
    }
    return this.download(url, background, signal);
  }
}
export const cityMapCache = new CityMapCache();
