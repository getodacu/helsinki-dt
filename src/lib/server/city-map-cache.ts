import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { municipalAssetUrl, texturedBuildingIds, validateTileIndex } from '../city-source.ts';
import { requestBytes } from './io.ts';

export const CITY_MAP_MAX_AGE = 30 * 86400_000;
const assetKey = (value: string) => { const url = new URL(value); url.searchParams.sort(); return hash(url.href); };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
interface SavedAsset { body: Buffer; retrievedAt: number; type: string }
interface Download { url: string; background: boolean; run: () => void }
type FetchAsset = (url: string, maxBytes: number) => Promise<Buffer>;

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

/** Shared disk bytes survive restarts; stale data stays usable during source outages. */
export class CityMapCache {
  storageIssue = '';
  private directory: string;
  private fetchAsset: FetchAsset;
  private now: () => number;
  private pending = new Map<string, Promise<SavedAsset>>();
  private failures = new Map<string, { due: number; error: unknown }>();
  private queue: Download[] = [];
  private active = 0;
  private activeBackground = 0;
  constructor(directory = process.env.CITY_MAP_CACHE_DIR || resolve('.cache/city-map'),
    fetchAsset: FetchAsset = async (url, maxBytes) => (await requestBytes(url, { maxBytes, timeoutMs: 30_000, redirect: 'error' })).body,
    now = Date.now) { this.directory = directory; this.fetchAsset = fetchAsset; this.now = now; }
  private limit(url: string) { return new URL(url).pathname.endsWith('.json') ? 2_000_000 : 8_000_000; }
  private async saved(url: string): Promise<SavedAsset | null> {
    const key = assetKey(url), path = resolve(this.directory, key);
    try {
      if ((await stat(path + '.json')).size > 2048 || (await stat(path + '.bin')).size > this.limit(url)) throw new Error('Oversized saved map asset');
      const metadata = JSON.parse(await readFile(path + '.json', 'utf8')), body = await readFile(path + '.bin');
      if (municipalAssetUrl(metadata.url) !== url || !Number.isFinite(metadata.retrievedAt) || metadata.retrievedAt > this.now() + 60_000 || metadata.sha256 !== hash(body)) throw new Error('Corrupt saved map asset');
      return { body, retrievedAt: metadata.retrievedAt, type: validateMunicipalAsset(url, body) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await Promise.all([rm(path + '.json', { force: true }), rm(path + '.bin', { force: true })]).catch(() => {});
      return null;
    }
  }
  private pump() {
    while (this.active < 4) {
      const foreground = this.queue.findIndex(job => !job.background);
      const index = foreground >= 0 ? foreground : this.active === this.activeBackground && this.activeBackground < 2 ? 0 : -1;
      if (index < 0 || !this.queue.length) return;
      const job = this.queue.splice(index, 1)[0]; this.active++; if (job.background) this.activeBackground++;
      job.run();
    }
  }
  private download(url: string, background: boolean): Promise<SavedAsset> {
    const pending = this.pending.get(url);
    if (pending) { if (!background) { const queued = this.queue.find(job => job.url === url); if (queued) queued.background = false; this.pump(); } return pending; }
    const failure = this.failures.get(url);
    if (failure && failure.due > this.now()) return Promise.reject(failure.error);
    const promise = new Promise<SavedAsset>((yes, no) => {
      const job: Download = { url, background, run: () => {
        const wasBackground = job.background;
        void (async () => {
          const body = await this.fetchAsset(url, this.limit(url));
          if (body.length > this.limit(url)) throw new Error('Municipal asset exceeds byte limit');
          const asset = { body, retrievedAt: this.now(), type: validateMunicipalAsset(url, body) };
          const path = resolve(this.directory, assetKey(url)), temporary = path + '.' + randomUUID();
          try {
            await mkdir(this.directory, { recursive: true });
            await writeFile(temporary + '.bin', body, { flag: 'wx' });
            await writeFile(temporary + '.json', JSON.stringify({ url, retrievedAt: asset.retrievedAt, sha256: hash(body) }), { flag: 'wx' });
            await rename(temporary + '.bin', path + '.bin'); await rename(temporary + '.json', path + '.json');
          } catch { this.storageIssue = 'Server map cache could not be saved. Check disk space and cache directory permissions.'; }
          finally { await Promise.all([rm(temporary + '.bin', { force: true }), rm(temporary + '.json', { force: true })]).catch(() => {}); }
          this.failures.delete(url); return asset;
        })().then(yes, error => { if (error instanceof Error) Object.assign(error, { assetUrl: url }); this.failures.set(url, { due: this.now() + 60_000, error }); no(error); }).finally(() => {
          this.pending.delete(url); this.active--; if (wasBackground) this.activeBackground--; this.pump();
        });
      } };
      this.queue.push(job);
    });
    this.pending.set(url, promise); this.pump(); return promise;
  }
  async read(value: string, background = false, refresh = false): Promise<SavedAsset> {
    const url = municipalAssetUrl(value);
    if (background && this.storageIssue) throw new Error(this.storageIssue);
    if (refresh) return this.download(url, background);
    const saved = await this.saved(url);
    if (saved) {
      if (this.now() - saved.retrievedAt >= CITY_MAP_MAX_AGE) void this.download(url, true).catch(() => {});
      return saved;
    }
    return this.download(url, background);
  }
}
export const cityMapCache = new CityMapCache();
