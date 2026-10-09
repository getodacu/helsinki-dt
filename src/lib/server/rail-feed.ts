import { RELEASE_BOUNDS, inBounds } from '../area.ts';
import { decodeRailPosition, withRailJourney } from '../data/rail.ts';
import { TRAFFIC_REMOVE_MS, type TrafficStatus } from '../traffic.ts';
import type { Vehicle } from '../types.ts';
import { fetchRail, railData, type FetchRail, type RailDataStore } from './rail.ts';

export interface RailFeedUpdate { vehicles: Vehicle[]; status: TrafficStatus }
export interface RailSource { start(listener: (update: RailFeedUpdate) => void): void; stop(): void }
const idle = (): TrafficStatus => ({ state: 'idle', connectedAt: null, lastPositionAt: null, retryAt: null });
export class RailFeed implements RailSource {
  private listener: ((update: RailFeedUpdate) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lifetime: AbortController | null = null;
  private vehicles = new Map<string, Vehicle>();
  private reportedTimes = new Map<string, number>();
  private status = idle();
  private retryMs = 5_000;
  private fetcher: FetchRail; private data: Pick<RailDataStore, 'train'>;
  constructor(fetcher: FetchRail = fetchRail, data: Pick<RailDataStore, 'train'> = railData) { this.fetcher = fetcher; this.data = data; }
  start(listener: (update: RailFeedUpdate) => void) {
    if (this.lifetime) return;
    this.listener = listener; this.lifetime = new AbortController();
    this.status = { ...idle(), state: 'connecting' }; this.emit(); void this.poll(this.lifetime);
  }
  private emit() { this.listener?.({ vehicles: [...this.vehicles.values()], status: { ...this.status } }); }
  private async poll(lifetime: AbortController) {
    let delay = 5_000;
    try {
      const value = await this.fetcher(`train-locations/latest?bbox=${RELEASE_BOUNDS.join(',')}`, lifetime.signal);
      if (!Array.isArray(value) || value.length > 2000) throw new Error('Invalid train position snapshot');
      if (lifetime.signal.aborted) return;
      const now = Date.now(), next = new Map<string, Vehicle>(), reports = new Map<string, Vehicle>();
      let valid = 0;
      for (const row of value) {
        let vehicle: Vehicle;
        try { vehicle = decodeRailPosition(row, new Date(now).toISOString()); valid++; } catch { continue; }
        const at = Date.parse(vehicle.reportedAt);
        if (at > now + 5000 || now - at >= TRAFFIC_REMOVE_MS) continue;
        if (at > Date.parse(reports.get(vehicle.id)?.reportedAt ?? '1970-01-01')) reports.set(vehicle.id, vehicle);
      }
      if (value.length && !valid) throw new Error('No valid records in train snapshot');
      for (const [id, at] of this.reportedTimes) if (now - at >= TRAFFIC_REMOVE_MS) this.reportedTimes.delete(id);
      for (let vehicle of reports.values()) {
        const at = Date.parse(vehicle.reportedAt), previous = this.vehicles.get(vehicle.id);
        if (at <= (this.reportedTimes.get(vehicle.id) ?? -Infinity)) {
          if (previous && now - Date.parse(previous.reportedAt) < TRAFFIC_REMOVE_MS) next.set(previous.id, previous);
          continue;
        }
        if (!this.reportedTimes.has(vehicle.id) && this.reportedTimes.size >= 2000) throw new Error('Rail identity capacity reached');
        this.reportedTimes.set(vehicle.id, at);
        if (!inBounds(vehicle.longitude!, vehicle.latitude!, RELEASE_BOUNDS)) continue;
        if (previous?.rail?.timetableAt) vehicle = { ...vehicle, rail: previous.rail, delaySeconds: previous.delaySeconds, operatingOperatorId: previous.operatingOperatorId };
        next.set(vehicle.id, vehicle);
      }
      this.vehicles = next; this.retryMs = 5_000;
      const latest = [...next.values()].map(vehicle => vehicle.reportedAt).sort().at(-1);
      this.status = { state: 'live', connectedAt: this.status.connectedAt ?? new Date(now).toISOString(),
        lastPositionAt: latest && (!this.status.lastPositionAt || latest > this.status.lastPositionAt) ? latest : this.status.lastPositionAt, retryAt: null, error: null };
      this.emit();
      // Timetables enrich current reports without blocking the next position poll.
      for (const vehicle of next.values()) if (vehicle.rail?.departureDate) {
        void this.data.train(vehicle.rail.departureDate, vehicle.rail.trainNumber, lifetime.signal).then(result => {
          if (lifetime.signal.aborted || this.lifetime !== lifetime || !result.data) return;
          const current = this.vehicles.get(vehicle.id);
          const stale = result.state !== 'ready';
          if (!current || (current.rail?.timetableAt === result.data.summary.timetableAt && !!current.rail?.timetableStale === stale)) return;
          const enriched = withRailJourney(current, result.data);
          enriched.rail = { ...enriched.rail!, timetableStale: stale };
          if (stale) enriched.delaySeconds = null;
          this.vehicles.set(vehicle.id, enriched); this.emit();
        }).catch(() => {});
      }
    } catch (error) {
      if (lifetime.signal.aborted) return;
      delay = this.retryMs; this.retryMs = Math.min(60_000, delay * 2);
      this.status = { ...this.status, state: 'reconnecting', connectedAt: null, retryAt: new Date(Date.now() + delay).toISOString(),
        error: error instanceof Error ? error.message : 'Rail feed unavailable' };
      this.emit();
    } finally {
      if (!lifetime.signal.aborted && this.lifetime === lifetime) {
        this.timer = setTimeout(() => void this.poll(lifetime), delay); this.timer.unref?.();
      }
    }
  }
  stop() {
    this.lifetime?.abort(); this.lifetime = null; clearTimeout(this.timer); this.timer = undefined;
    this.listener = null; this.vehicles.clear(); this.reportedTimes.clear(); this.status = idle(); this.retryMs = 5_000;
  }
}
