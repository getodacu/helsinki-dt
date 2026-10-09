import { requestText } from './io.ts';
import { decodeRailJourney, decodeRailStations, railDepartures } from '../data/rail.ts';
import { railDate, railNumber, type RailJourney, type RailStation, type RailDeparture, type RailResult } from '../rail.ts';

export const RAIL_API = 'https://rata.digitraffic.fi/api/v1/';
export type FetchRail = (path: string, signal?: AbortSignal) => Promise<unknown>;
export const fetchRail: FetchRail = async (path, signal) => JSON.parse((await requestText(RAIL_API + path, {
  maxBytes: 4 * 1024 ** 2, timeoutMs: 12_000, redirect: 'error', signal,
  headers: { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'HelsinkiLens/1.0' }
})).body);
type Pending = { controller: AbortController; clients: number; promise: Promise<void> };
type Entry = { data: unknown; retrievedAt: string | null; attemptedAt: number; error: string | null; pending?: Pending };

/** One bounded, single-flight cache shared by the feed and all inspectors. */
export class RailDataStore {
  private entries = new Map<string, Entry>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private fetcher: FetchRail; private now: () => number;
  constructor(fetcher: FetchRail = fetchRail, now = Date.now) { this.fetcher = fetcher; this.now = now; }
  private async limited<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= 4) {
      if (this.waiting.length >= 128) throw new Error('Rail request capacity reached');
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiting.splice(this.waiting.indexOf(ready), 1); reject(signal.reason); };
        this.waiting.push(ready); signal.addEventListener('abort', abort, { once: true });
      });
    } else this.active++;
    try { signal.throwIfAborted(); return await work(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  private async get<T>(key: string, ttl: number, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<RailResult<T>> {
    signal?.throwIfAborted();
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 256) {
        const oldest = [...this.entries].find(([key, entry]) => key !== 'stations' && !entry.pending);
        if (!oldest) return { state: 'unavailable', data: null, retrievedAt: null, error: 'Rail cache capacity reached' };
        this.entries.delete(oldest[0]);
      }
      entry = { data: null, retrievedAt: null, attemptedAt: -Infinity, error: null }; this.entries.set(key, entry);
    }
    const current = entry;
    if (current.pending?.controller.signal.aborted) await current.pending.promise;
    signal?.throwIfAborted();
    if (!current.pending && this.now() - current.attemptedAt >= (current.error ? 30_000 : ttl)) {
      current.attemptedAt = this.now();
      const controller = new AbortController();
      const pending: Pending = { controller, clients: 0, promise: Promise.resolve() };
      pending.promise = this.limited(() => load(controller.signal), controller.signal)
        .then(data => { controller.signal.throwIfAborted(); current.data = data; current.retrievedAt = new Date(this.now()).toISOString(); current.error = null; })
        .catch(error => {
          if (controller.signal.aborted) current.attemptedAt = -Infinity;
          else current.error = error instanceof Error ? error.message : 'Rail data unavailable';
        }).finally(() => { current.pending = undefined; });
      current.pending = pending;
    }
    const pending = current.pending;
    if (pending) {
      pending.clients++;
      let abort: (() => void) | undefined;
      try {
        await (signal ? Promise.race([pending.promise, new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })]) : pending.promise);
      } finally {
        if (abort) signal?.removeEventListener('abort', abort);
        if (--pending.clients === 0 && current.pending === pending) pending.controller.abort();
      }
    }
    return { state: current.error ? current.data === null ? 'unavailable' : 'stale' : 'ready', data: current.data as T | null,
      retrievedAt: current.retrievedAt, error: current.error };
  }
  stations(signal?: AbortSignal): Promise<RailResult<RailStation[]>> {
    return this.get('stations', 86_400_000, async request => decodeRailStations(await this.fetcher('metadata/stations', request)), signal);
  }
  async train(date: string, number: string, signal?: AbortSignal): Promise<RailResult<RailJourney>> {
    if (!railDate(date)) throw new Error('Invalid departure date'); railNumber(number);
    const stations = await this.stations(signal);
    return this.get(`train/${date}/${number}`, 30_000, async request => {
      const value = await this.fetcher(`trains/${date}/${number}`, request);
      if (!Array.isArray(value) || value.length !== 1) throw new Error('Train timetable unavailable');
      const journey = decodeRailJourney(value[0], stations.data ?? [], new Date(this.now()).toISOString(), this.now());
      if (journey.summary.departureDate !== date || journey.summary.trainNumber !== number) throw new Error('Train identity mismatch');
      return journey;
    }, signal);
  }
  async departures(code: string, signal?: AbortSignal): Promise<RailResult<RailDeparture[]>> {
    const stations = await this.stations(signal);
    if (!stations.data?.some(station => station.code === code && station.passenger)) throw new Error('Unknown passenger station');
    const result = await this.get<RailJourney[]>(`departures/${code}`, 30_000, async request => {
      const value = await this.fetcher(`live-trains/station/${encodeURIComponent(code)}?arrived_trains=0&arriving_trains=0&departed_trains=0&departing_trains=100&include_nonstopping=false&train_categories=Commuter,Long-distance`, request);
      if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid departure board');
      return value.map(row => decodeRailJourney(row, stations.data!, new Date(this.now()).toISOString(), this.now()));
    }, signal);
    return { ...result, data: result.data ? railDepartures(result.data, code, this.now()) : null };
  }
}
export const railData = new RailDataStore();
