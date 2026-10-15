import { CityChunkLoader, loadCityBase, loadCityManifest } from '../city-assets.ts';
import { aerialEntries, discoverTexturedEntries, validateTileIndex } from '../city-source.ts';
import type { BackgroundProgress } from '../city-loading.ts';
import { cityMapCache, preparedCityFetch, type CityMapCache } from './city-map-cache.ts';

/** Resuming enumerates the same URLs and skips all validated disk entries. */
export async function warmCityArea(cache: CityMapCache = cityMapCache, changed: (state: BackgroundProgress) => void = () => {}, refresh = false, allLevels = false) {
  let state: BackgroundProgress = { phase: 'discovering', completed: 0, total: 0, failed: 0 };
  const report = () => changed({ ...state }); report();
  const manifest = await loadCityManifest(preparedCityFetch), base = await loadCityBase(manifest, preparedCityFetch);
  const signal = new AbortController().signal;
  const discovered = await discoverTexturedEntries(base, async url => {
    const asset = await cache.read(url, true, refresh); return validateTileIndex(Uint8Array.from(asset.body).buffer, url);
  }, () => true, () => 10, signal, allLevels);
  if (discovered.failed.length) console.warn('Map cache source indices awaiting retry:', discovered.failed.join(', '));
  const loader = new CityChunkLoader(manifest, preparedCityFetch);
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
