import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CityChunkLoader, loadCityBase, loadCityManifest } from '../city-assets.ts';
import { aerialEntries, discoverTexturedEntries, validateTileIndex } from '../city-source.ts';
import type { BackgroundProgress } from '../city-loading.ts';
import { cityMapCache, type CityMapCache } from './city-map-cache.ts';

const preparedFetch = (async (input: RequestInfo | URL) => {
  const path = String(input);
  if (!/^\/data\/city\/(manifest\.json|generations\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json)$/.test(path)) throw new Error('Unsafe prepared asset');
  try {
    const body = await readFile(resolve('static', path.slice(1))).catch(() => readFile(resolve('build/client', path.slice(1))));
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  } catch { return new Response(null, { status: 404 }); }
}) as typeof fetch;

/** Resuming enumerates the same URLs and skips all validated disk entries. */
export async function warmCityArea(cache: CityMapCache = cityMapCache, changed: (state: BackgroundProgress) => void = () => {}, refresh = false) {
  let state: BackgroundProgress = { phase: 'discovering', completed: 0, total: 0, failed: 0 };
  const report = () => changed({ ...state }); report();
  const manifest = await loadCityManifest(preparedFetch), base = await loadCityBase(manifest, preparedFetch);
  const signal = new AbortController().signal;
  const discovered = await discoverTexturedEntries(base, async url => {
    const asset = await cache.read(url, true, refresh); return validateTileIndex(Uint8Array.from(asset.body).buffer, url);
  }, () => true, () => 10, signal);
  if (discovered.failed.length) console.warn('Map cache source indices awaiting retry:', discovered.failed.join(', '));
  const loader = new CityChunkLoader(manifest, preparedFetch);
  const tasks = [...manifest.chunks.map(entry => async () => {
    try { await loader.load(entry.id); } finally { loader.unload(entry.id); }
  }), ...[...aerialEntries(base), ...discovered.entries].map(entry => async () => { await cache.read(entry.url, true, refresh); })];
  state = { phase: 'loading', completed: 0, total: tasks.length + discovered.failed.length, failed: discovered.failed.length }; report();
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !cache.storageIssue) {
      const task = tasks[next++];
      try { await task(); state.completed++; } catch (error) { state.failed++; console.warn('Map cache part awaiting retry:', error instanceof Error ? [error.message, (error as Error & { assetUrl?: string }).assetUrl, (error.cause as NodeJS.ErrnoException)?.code].filter(Boolean).join(' · ') : error); }
      report();
    }
  };
  try { await Promise.all([worker(), worker()]); } finally { loader.dispose(); }
  state.phase = cache.storageIssue ? 'stopped' : state.failed ? 'partial' : 'complete'; report(); return state;
}

export let areaCacheProgress: BackgroundProgress = { phase: 'idle', completed: 0, total: 0, failed: 0 };
let pending: Promise<BackgroundProgress> | null = null, retryAt = 0;
export function startAreaCache() {
  if (pending || areaCacheProgress.phase === 'complete' || areaCacheProgress.phase === 'stopped' || Date.now() < retryAt) return;
  pending = warmCityArea(cityMapCache, state => areaCacheProgress = state).catch(() => {
    areaCacheProgress = { ...areaCacheProgress, phase: 'partial', failed: Math.max(1, areaCacheProgress.failed) }; return areaCacheProgress;
  }).finally(() => { pending = null; retryAt = Date.now() + 60_000; });
}
