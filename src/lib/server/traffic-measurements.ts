import { requestText, type RequestOptions } from './io.ts';
import { trafficCounterKey, decodeTrafficCounters, decodeTrafficMeasurements, decodeTrafficSources } from '../data/traffic-measurements.ts';
import { aggregateTrafficCounts, summarizeTrafficCounts, MEASUREMENT_RECENT_MS, MEASUREMENT_REFRESH_MS,
  type TrafficCounter, type TrafficCount, type TrafficMeasurement, type TrafficCounterDetail,
  type TrafficMeasurementSnapshot, type MeasurementSourceStatus, type MeasurementMode } from '../traffic-measurements.ts';

export const MEASUREMENT_API = 'https://lidotiku.api.hel.fi';
export const MEASUREMENT_LIMITS = { pages: 10, pageBytes: 8 * 1024 ** 2, totalBytes: 32 * 1024 ** 2,
  observations: 50_000, counters: 10_000, timeoutMs: 30_000, concurrency: 3 } as const;
type FetchText = (url: string, options: RequestOptions) => Promise<{ body: string; retrievedAt: string }>;
type Catalog = { counters: TrafficCounter[]; sources: MeasurementSourceStatus[]; retrievedAt: string; error: string | null };
type Recent = { measurements: TrafficMeasurement[]; counts: TrafficCount[]; source: MeasurementSourceStatus };
type Entry<T> = { data: T | null; attemptedAt: number; error: string | null; pending: Promise<void> | null };
const entry = <T>(): Entry<T> => ({ data: null, attemptedAt: -Infinity, error: null, pending: null });
const errorText = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : 'Traffic measurements unavailable';
const day = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
const url = (path: string, parameters: Record<string, string> = {}) => `${MEASUREMENT_API}/api/${path}/?${new URLSearchParams(parameters)}`;

/** Pagination is provider data, not permission to fetch another host or resource. */
export function measurementPageUrl(value: string, path: string, original: string): string {
  const parsed = new URL(value, original), initial = new URL(original);
  if (parsed.origin !== MEASUREMENT_API || parsed.pathname !== `/api/${path}/` || parsed.username || parsed.password || parsed.hash) throw new Error('Unsafe traffic pagination URL');
  for (const [key, value] of initial.searchParams) {
    if (!['cursor', 'page'].includes(key) && parsed.searchParams.get(key) !== value) throw new Error('Traffic pagination changed its filters');
  }
  for (const key of parsed.searchParams.keys()) {
    if (parsed.searchParams.getAll(key).length !== 1) throw new Error('Duplicate traffic pagination parameter');
    if (!initial.searchParams.has(key) && !['cursor', 'page'].includes(key)) throw new Error('Unexpected traffic pagination parameter');
  }
  return parsed.href;
}
export class TrafficCounterNotFound extends Error {}

/** Only the server refresh loop fetches upstream data; API reads use this bounded cache. */
export class TrafficMeasurementStore {
  private catalog = entry<Catalog>();
  private recent = new Map<string, Entry<Recent>>();
  private initialized = false;
  private flight: Promise<void> | null = null;
  private cycle: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = 0;
  private waiting: (() => void)[] = [];
  private fetcher: FetchText; private now: () => number;
  constructor(fetcher: FetchText = requestText, now: () => number = Date.now) { this.fetcher = fetcher; this.now = now; }
  start(building = false) {
    if (building || this.timer) return;
    void this.refreshNow();
    this.timer = setInterval(() => void this.refreshNow(), MEASUREMENT_REFRESH_MS); this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.cycle?.abort(); }
  private deadline() { return AbortSignal.any([AbortSignal.timeout(MEASUREMENT_LIMITS.timeoutMs), ...(this.cycle ? [this.cycle.signal] : [])]); }
  private async limited<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= MEASUREMENT_LIMITS.concurrency) {
      if (this.waiting.length >= 128) throw new Error('Traffic request capacity reached');
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { const index = this.waiting.indexOf(ready); if (index >= 0) this.waiting.splice(index, 1); reject(signal.reason); };
        this.waiting.push(ready); signal.addEventListener('abort', abort, { once: true });
      });
    } else this.active++;
    try { signal.throwIfAborted(); return await work(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  private async fetch(path: string, signal: AbortSignal) {
    return this.limited(async () => {
      const response = await this.fetcher(path, { maxBytes: MEASUREMENT_LIMITS.pageBytes, timeoutMs: 12_000,
        redirect: 'error', signal, headers: { Accept: 'application/json' } });
      signal.throwIfAborted();
      if (Buffer.byteLength(response.body) > MEASUREMENT_LIMITS.pageBytes) throw new Error('Traffic response exceeds byte limit');
      if (!Number.isFinite(Date.parse(response.retrievedAt))) throw new Error('Invalid traffic retrieval time');
      return response;
    }, signal);
  }
  private async refresh<T>(cache: Entry<T>, ttl: number, load: () => Promise<T>): Promise<Entry<T>> {
    if (!cache.pending && this.now() - cache.attemptedAt >= (cache.error ? 30_000 : ttl)) {
      cache.attemptedAt = this.now();
      const signal = this.cycle?.signal;
      cache.pending = load().then(data => { signal?.throwIfAborted(); cache.data = data; cache.error = null; })
        .catch(error => { if (!signal?.aborted) cache.error = errorText(error); }).finally(() => { cache.pending = null; });
    }
    await cache.pending; return cache;
  }
  private async loadCatalog(): Promise<Catalog> {
    const signal = this.deadline();
    const metadata = await this.fetch(url('metadata/sources', { language: 'en' }), signal);
    const sources = decodeTrafficSources(JSON.parse(metadata.body));
    const counters = new Map<string, TrafficCounter>();
    const initial = url('counters', { page_size: '1000', municipality_code: '091' });
    let next: string | null = initial, bytes = Buffer.byteLength(metadata.body), error: string | null = null, pages = 0;
    const seen = new Set<string>();
    try {
      while (next) {
        if (++pages > MEASUREMENT_LIMITS.pages || seen.has(next)) throw new Error('Counter pagination exceeds its bound');
        seen.add(next);
        const response = await this.fetch(next, signal); bytes += Buffer.byteLength(response.body);
        if (bytes > MEASUREMENT_LIMITS.totalBytes) throw new Error('Counter catalog exceeds byte limit');
        const page = decodeTrafficCounters(JSON.parse(response.body));
        for (const counter of page.counters) {
          if (!sources.some(source => source.name === counter.source)) throw new Error('Unknown counter source');
          if (counters.has(counter.id)) throw new Error('Duplicate counter identity');
          counters.set(counter.id, counter);
        }
        if (counters.size > MEASUREMENT_LIMITS.counters) throw new Error('Counter catalog exceeds its bound');
        next = page.next ? measurementPageUrl(page.next, 'counters', initial) : null;
      }
    } catch (failure) { if (!counters.size) throw failure; error = errorText(failure); }
    return { counters: [...counters.values()], sources, retrievedAt: metadata.retrievedAt, error };
  }
  private async getCatalog(): Promise<Entry<Catalog>> {
    return this.refresh(this.catalog, this.catalog.data?.error ? 30_000 : 24 * 3600_000, async () => {
      const loaded = await this.loadCatalog();
      if (loaded.error && this.catalog.data && !this.catalog.data.error) throw new Error(loaded.error);
      return loaded;
    });
  }
  private async observations(parameters: Record<string, string>, source?: string) {
    const signal = this.deadline();
    const initial = url('observations', { ...parameters, page_size: '5000' });
    let next: string | null = initial, bytes = 0, pages = 0, retrievedAt: string | null = null, error: string | null = null;
    let measurements: TrafficMeasurement[] = [], previousTime = Infinity;
    const seen = new Set<string>();
    try {
      while (next) {
        if (++pages > MEASUREMENT_LIMITS.pages || seen.has(next)) throw new Error('Observation pagination exceeds its bound');
        seen.add(next);
        const response = await this.fetch(next, signal); bytes += Buffer.byteLength(response.body);
        if (bytes > MEASUREMENT_LIMITS.totalBytes) throw new Error('Traffic history exceeds byte limit');
        const page = decodeTrafficMeasurements(JSON.parse(response.body), response.retrievedAt);
        let time = previousTime;
        for (const row of page.measurements) {
          if (Date.parse(row.observedAt) > time || (source && row.source !== source)
            || (parameters.counter && row.counterId !== `${source}:${parameters.counter}`)) throw new Error('Traffic observation query mismatch');
          time = Date.parse(row.observedAt);
        }
        previousTime = time; measurements.push(...page.measurements); retrievedAt = response.retrievedAt;
        if (measurements.length > MEASUREMENT_LIMITS.observations) throw new Error('Traffic history exceeds record limit');
        next = page.next ? measurementPageUrl(page.next, 'observations', initial) : null;
      }
    } catch (failure) {
      error = errorText(failure);
      // The last timestamp may continue on the missing page; none of its totals are complete.
      const boundary = measurements.at(-1)?.observedAt;
      if (boundary) measurements = measurements.filter(row => row.observedAt > boundary);
    }
    return { measurements, retrievedAt, error };
  }
  refreshNow(): Promise<void> {
    if (this.flight) return this.flight;
    const cycle = new AbortController(); this.cycle = cycle;
    this.flight = this.update().catch(error => { if (!cycle.signal.aborted) this.catalog.error = errorText(error); }).finally(() => {
      if (!cycle.signal.aborted) this.initialized = true;
      this.flight = null; this.cycle = null;
    });
    return this.flight;
  }
  private async update() {
    const catalog = await this.getCatalog(), data = catalog.data, now = this.now();
    if (!data || this.cycle?.signal.aborted) return;
    await Promise.all(data.sources.map(async source => {
      let cache = this.recent.get(source.name);
      if (!cache) { cache = entry<Recent>(); this.recent.set(source.name, cache); }
      const current = cache;
      await this.refresh(current, MEASUREMENT_REFRESH_MS, async () => {
        const response = await this.observations({ source: source.name, start_date: day(now - MEASUREMENT_RECENT_MS), end_date: day(now) }, source.name);
        if (response.error && (current.data || !response.measurements.length)) throw new Error(response.error);
        const ids = new Set(data.counters.filter(counter => counter.source === source.name).map(counter => counter.id));
        const measurements = response.measurements.filter(row => ids.has(row.counterId) && Date.parse(row.observedAt) > now - MEASUREMENT_RECENT_MS && Date.parse(row.observedAt) <= now);
        const counts = aggregateTrafficCounts(measurements), summaries = summarizeTrafficCounts(counts, now);
        const observedAt = summaries.reduce<string | null>((latest, row) => latest === null || row.latest.observedAt > latest ? row.latest.observedAt : latest, null);
        return { measurements, counts, source: { ...source, state: response.error ? 'partial' : observedAt ? 'ready' : 'dated',
          retrievedAt: response.retrievedAt, observedAt, error: response.error } };
      });
    }));
    for (const [name, cache] of this.recent) {
      if (!data.sources.some(source => source.name === name)) { this.recent.delete(name); continue; }
      if (cache.data) {
        const cutoff = this.now() - MEASUREMENT_RECENT_MS;
        cache.data.measurements = cache.data.measurements.filter(row => Date.parse(row.observedAt) > cutoff);
        cache.data.counts = cache.data.counts.filter(row => Date.parse(row.observedAt) > cutoff);
      }
    }
  }
  snapshot(): TrafficMeasurementSnapshot {
    const now = this.now(), data = this.catalog.data, generatedAt = new Date(now).toISOString();
    if (!this.initialized || !data) return { generatedAt, state: !this.initialized ? 'loading' : 'unavailable', counters: [], summaries: [], sources: [], error: this.catalog.error };
    const sources = data.sources.map(source => {
      const cache = this.recent.get(source.name), status = cache?.data?.source ?? source;
      return { ...status, ...(status.state === 'ready' && (!status.observedAt || now - Date.parse(status.observedAt) >= MEASUREMENT_RECENT_MS) ? { state: 'dated' as const } : {}),
        ...(cache?.error ? { state: cache.data ? 'partial' as const : 'unavailable' as const, error: cache.error } : {}) };
    });
    const error = this.catalog.error ?? data.error;
    const summaries = sources.flatMap(source => summarizeTrafficCounts(this.recent.get(source.name)?.data?.counts ?? [], now,
      !!error || source.state === 'partial' || source.state === 'unavailable'));
    const modes = new Map<string, MeasurementMode[]>();
    for (const summary of summaries) { const values = modes.get(summary.counterId) ?? []; values.push(summary.mode); modes.set(summary.counterId, values); }
    const counters = data.counters.filter(counter => modes.has(counter.id)).map(counter => ({ ...counter, modes: modes.get(counter.id)! }));
    const state = error || sources.some(source => ['partial', 'unavailable'].includes(source.state)) ? 'partial' : summaries.length ? 'ready' : 'dated';
    return { generatedAt, state, counters, summaries, sources, error };
  }
  counter(id: string): TrafficCounterDetail {
    id = trafficCounterKey(id);
    if (!this.initialized) throw new Error('Traffic measurements are warming up');
    if (!this.catalog.data) throw new Error(this.catalog.error ?? 'Counter catalog unavailable');
    const snapshot = this.snapshot(), counter = snapshot.counters.find(counter => counter.id === id);
    if (!counter) throw new TrafficCounterNotFound('No complete count in the last 24 hours');
    const current = this.recent.get(counter.source)!, data = current.data!, now = this.now();
    const summaries = snapshot.summaries.filter(row => row.counterId === id);
    const recent = (row: { counterId: string; observedAt: string }) => row.counterId === id && Date.parse(row.observedAt) > now - MEASUREMENT_RECENT_MS && Date.parse(row.observedAt) <= now;
    const error = current.error ?? data.source.error ?? snapshot.error;
    return { generatedAt: snapshot.generatedAt, state: error ? 'partial' : 'ready', counter,
      measurements: data.measurements.filter(recent), counts: data.counts.filter(recent), summaries,
      window: { start: new Date(now - MEASUREMENT_RECENT_MS).toISOString(), end: snapshot.generatedAt },
      retrievedAt: data.source.retrievedAt, error };
  }
}
const shared = globalThis as typeof globalThis & { helsinkiTrafficMeasurements?: TrafficMeasurementStore };
// SSR reloads can replace modules without disposing their old timers.
shared.helsinkiTrafficMeasurements?.stop();
export const trafficMeasurements = shared.helsinkiTrafficMeasurements = new TrafficMeasurementStore();
if (import.meta.hot) import.meta.hot.dispose(() => trafficMeasurements.stop());
