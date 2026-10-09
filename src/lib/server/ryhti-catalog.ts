import { createHash } from 'node:crypto';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { RYHTI_MAX_BYTES, ryhtiObject, ryhtiTimestamp, validateRyhtiCatalog } from '../data/ryhti.ts';
import type { RyhtiCatalogState, RyhtiManifest } from '../ryhti-types.ts';

export const ryhtiHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function readRyhtiFile(root: string, path: string, maxBytes: number): Promise<Buffer> {
  const base = await realpath(root), file = await realpath(resolve(base, path));
  if (!file.startsWith(base + sep) || (await stat(file)).size > maxBytes) throw new Error('Unsafe or oversized Ryhti asset');
  const bytes = await readFile(file);
  if (bytes.length > maxBytes) throw new Error('Ryhti asset exceeds byte limit');
  return bytes;
}
export function validateRyhtiManifest(value: unknown): RyhtiManifest {
  const manifest = ryhtiObject(value), asset = ryhtiObject(manifest.asset);
  if (manifest.version !== 1 || !ryhtiTimestamp(manifest.generatedAt)
    || typeof asset.path !== 'string' || !/^ryhti\/[a-zA-Z0-9_-]+\/catalog\.json$/.test(asset.path)
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || !Number.isSafeInteger(asset.bytes) || (asset.bytes as number) < 1 || (asset.bytes as number) > RYHTI_MAX_BYTES) throw new Error('Invalid Ryhti manifest');
  return value as RyhtiManifest;
}
export class RyhtiCatalogStore {
  private root: string;
  private now: () => number;
  private checkedAt = -Infinity;
  private pending: Promise<void> | null = null;
  private state: RyhtiCatalogState = { status: 'unavailable', catalog: null, message: 'Ryhti data has not been prepared.', attemptedAt: null };
  constructor(root = resolve('static/data'), now = Date.now) { this.root = root; this.now = now; }
  async load(): Promise<RyhtiCatalogState> {
    if (!this.pending && this.now() - this.checkedAt >= 60000) {
      this.checkedAt = this.now();
      this.pending = this.refresh().finally(() => { this.pending = null; });
    }
    await this.pending;
    if (this.state.catalog) {
      try {
        const city = await readRyhtiFile(this.root, 'city/manifest.json', 2_000_000);
        if (ryhtiHash(city) !== this.state.catalog.cityManifestSha256) throw new Error('Ryhti catalog does not match the prepared city; run ryhti:prepare.');
      } catch (error) { this.state = { ...this.state, status: 'unavailable', catalog: null, message: String(error) }; }
    }
    return this.state;
  }
  private async refresh() {
    try {
      const manifest = validateRyhtiManifest(JSON.parse((await readRyhtiFile(this.root, 'ryhti-manifest.json', 16384)).toString()));
      const bytes = await readRyhtiFile(this.root, manifest.asset.path, RYHTI_MAX_BYTES);
      if (bytes.length !== manifest.asset.bytes || ryhtiHash(bytes) !== manifest.asset.sha256) throw new Error('Ryhti checksum or byte count mismatch');
      const catalog = validateRyhtiCatalog(JSON.parse(bytes.toString()));
      if (catalog.generatedAt !== manifest.generatedAt) throw new Error('Ryhti generation mismatch');
      this.state = { status: 'ready', catalog, message: null, attemptedAt: catalog.generatedAt };
    } catch (error) {
      this.state = { ...this.state, status: this.state.catalog ? 'stale' : 'unavailable', message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Ryhti snapshot has not been prepared or an asset is missing.' : error instanceof Error ? error.message : 'Invalid Ryhti data' };
    }
    try {
      const failure = ryhtiObject(JSON.parse((await readRyhtiFile(this.root, 'ryhti-refresh-status.json', 16384)).toString()));
      if (failure.status === 'failed' && ryhtiTimestamp(failure.attemptedAt) && typeof failure.message === 'string'
        && failure.message.length <= 1000 && (!this.state.catalog || Date.parse(failure.attemptedAt) >= Date.parse(this.state.catalog.generatedAt))) {
        this.state = { ...this.state, status: this.state.catalog ? 'stale' : 'unavailable', message: failure.message, attemptedAt: failure.attemptedAt };
      }
    } catch { /* The manifest remains usable without an optional refresh diagnostic. */ }
  }
}
export const ryhtiCatalogStore = new RyhtiCatalogStore();
