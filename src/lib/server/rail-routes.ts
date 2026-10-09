import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RELEASE_BOUNDS, inBounds } from '../area.ts';
import { railDate, railId } from '../rail.ts';
import { serviceSeconds, serviceTimeToUtc, serviceIsActive, type GtfsRow } from '../data/gtfs.ts';
import type { RouteContext, RouteSource } from '../route-context.ts';

export const RAIL_GTFS_URL = 'https://rata.digitraffic.fi/api/v1/trains/gtfs-all.zip';
export const RAIL_INDEX_MAX_BYTES = 64 * 1024 ** 2;
export interface RailTrip {
  id: string; serviceId: string; shapeId: string; destination: string; departure: string;
  stops: [id: string, sequence: number, arrival: string, departure: string][];
}
export interface RailRouteIndex {
  version: 1; sourceId: 'digitraffic-gtfs'; generatedAt: string; bounds: number[]; source: RouteSource;
  calendar: GtfsRow[]; calendarDates: GtfsRow[];
  trips: Record<string, RailTrip[]>; shapes: Record<string, [number, number][][]>;
  stops: Record<string, { name: string; longitude: number; latitude: number }>;
}
export function validateRailIndex(value: unknown): RailRouteIndex {
  const index = value as RailRouteIndex;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown) => typeof v === 'string' && v.length <= 500;
  if (!record(index) || index.version !== 1 || index.sourceId !== 'digitraffic-gtfs' || !Number.isFinite(Date.parse(index.generatedAt))
    || JSON.stringify(index.bounds) !== JSON.stringify(RELEASE_BOUNDS) || !record(index.source) || index.source.url !== RAIL_GTFS_URL
    || !/^[a-f0-9]{64}$/.test(index.source.archiveSha256) || !railDate(index.source.validFrom) || !railDate(index.source.validTo)
    || index.source.validTo < index.source.validFrom || !Array.isArray(index.calendar) || index.calendar.length > 400_000 || !Array.isArray(index.calendarDates) || index.calendarDates.length > 400_000 || !record(index.trips) || !record(index.shapes) || !record(index.stops)
    || Object.keys(index.trips).length > 400_000 || Object.keys(index.shapes).length > 20_000 || Object.keys(index.stops).length > 5000) throw new Error('Invalid rail index');
  const compactDate = (value: unknown) => typeof value === 'string' && /^\d{8}$/.test(value) && railDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
  const services = new Set<string>(), changes = new Set<string>();
  for (const row of index.calendar) {
    if (!record(row) || !text(row.service_id) || services.has(row.service_id) || !compactDate(row.start_date) || !compactDate(row.end_date) || row.end_date < row.start_date
      || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].some(day => !['0', '1'].includes(row[day]))) throw new Error('Invalid rail calendar');
    services.add(row.service_id);
  }
  for (const row of index.calendarDates) {
    const key = `${row.service_id}:${row.date}`;
    if (!record(row) || !text(row.service_id) || !compactDate(row.date) || !['1', '2'].includes(row.exception_type) || changes.has(key)) throw new Error('Invalid rail calendar exception');
    changes.add(key); services.add(row.service_id);
  }
  for (const stop of Object.values(index.stops)) if (!record(stop) || !text(stop.name) || !inBounds(stop.longitude, stop.latitude, RELEASE_BOUNDS)) throw new Error('Invalid rail stop');
  for (const paths of Object.values(index.shapes)) {
    if (!Array.isArray(paths) || paths.length > 1000) throw new Error('Invalid rail shape');
    for (const path of paths) if (!Array.isArray(path) || path.length < 2 || path.length > 20_000
      || path.some(point => !Array.isArray(point) || point.length !== 2 || !inBounds(point[0], point[1], RELEASE_BOUNDS))) throw new Error('Invalid rail coordinates');
  }
  for (const [number, trips] of Object.entries(index.trips)) {
    if (!/^[1-9]\d{0,4}$/.test(number) || !Array.isArray(trips) || !trips.length || trips.length > 2000) throw new Error('Invalid rail trip identity');
    for (const trip of trips) {
      if (!record(trip) || !text(trip.id) || !trip.id.startsWith(`${number}_`) || !services.has(trip.serviceId) || !text(trip.destination) || !text(trip.shapeId) || !Array.isArray(trip.stops) || trip.stops.length > 500) throw new Error('Invalid rail trip');
      serviceSeconds(trip.departure);
      for (const [i, stop] of trip.stops.entries()) {
        if (!Array.isArray(stop) || stop.length !== 4 || !index.stops[stop[0]] || !Number.isSafeInteger(stop[1]) || stop[1] < 0
          || (i > 0 && stop[1] <= trip.stops[i - 1][1])) throw new Error('Invalid rail stop sequence');
        if (stop[2]) serviceSeconds(stop[2]); if (stop[3]) serviceSeconds(stop[3]);
      }
    }
  }
  return index;
}
export function railRoute(date: string, number: string, index: RailRouteIndex | null, reason = 'Rail route index unavailable.'): RouteContext {
  const base: RouteContext = { status: 'unavailable', vehicleId: railId(date, number), routeId: `rail:${number}`, routeLabel: null,
    destination: null, tripId: null, departureAt: null, candidates: [], shape: [], stops: [], reason,
    sourceId: 'digitraffic-gtfs', generatedAt: index?.generatedAt ?? null, source: index?.source ?? null };
  if (!index) return base;
  if (date < index.source.validFrom || date > index.source.validTo) return { ...base, reason: 'Journey date is outside prepared rail schedule coverage.' };
  const trips = (index.trips[number] ?? []).filter(trip => serviceIsActive(trip.serviceId, date, index.calendar, index.calendarDates));
  if (trips.length !== 1) return { ...base, status: trips.length ? 'ambiguous' : 'missing', candidates: trips.map(trip => trip.id),
    reason: trips.length ? 'Multiple rail journeys match; no guessed path is shown.' : 'No exact rail journey is available in the prepared schedule.' };
  const trip = trips[0], shape = index.shapes[trip.shapeId] ?? [];
  if (!shape.length) return { ...base, status: 'missing', reason: 'This journey has no rail shape in the city area.' };
  return { ...base, status: 'exact', reason: null, tripId: trip.id, candidates: [trip.id], destination: trip.destination,
    departureAt: serviceTimeToUtc(date, serviceSeconds(trip.departure)), shape,
    stops: trip.stops.map(([id, sequence, arrival, departure]) => ({ id, sequence, ...index.stops[id],
      arrivalAt: arrival ? serviceTimeToUtc(date, serviceSeconds(arrival)) : null,
      departureAt: departure ? serviceTimeToUtc(date, serviceSeconds(departure)) : null })) };
}
export class RailRouteStore {
  private checkedAt = -Infinity; private modifiedAt = -1; private index: RailRouteIndex | null = null;
  private loading: Promise<void> | null = null;
  private path: string;
  constructor(path = resolve('static/data/rail-index.json')) { this.path = path; }
  async journey(date: string, number: string): Promise<RouteContext> {
    if (!this.loading && Date.now() - this.checkedAt >= 60_000) {
      this.checkedAt = Date.now();
      this.loading = (async () => {
        try {
          const info = await stat(this.path);
          if (info.mtimeMs === this.modifiedAt && this.index) return;
          if (info.size > RAIL_INDEX_MAX_BYTES) throw new Error('Rail index exceeds size limit');
          this.index = validateRailIndex(JSON.parse(await readFile(this.path, 'utf8'))); this.modifiedAt = info.mtimeMs;
        } catch { this.index = null; }
      })().finally(() => { this.loading = null; });
    }
    await this.loading; return railRoute(date, number, this.index);
  }
}
export const railRoutes = new RailRouteStore();
