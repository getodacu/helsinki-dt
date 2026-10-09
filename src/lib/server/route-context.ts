import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RELEASE_BOUNDS, inBounds } from '../area.ts';
import { matchJourney, serviceSeconds, serviceTimeToUtc, type GtfsRow, type GtfsSnapshot } from '../data/gtfs.ts';
import type { JourneyIdentity, RouteCatalog, RouteContext, RouteSource } from '../route-context.ts';
import type { TransitMode, Vehicle } from '../types.ts';

export const ROUTE_INDEX_MAX_BYTES = 64 * 1024 ** 2;
export type RouteTrip = [id: string, routeId: string, serviceId: string, directionId: string, shapeId: string, destination: string, departure: string, firstStopId: string, patternId: string];
export interface RouteIndex {
  version: 1; generatedAt: string; sourceId: 'hsl-gtfs'; bounds: number[]; source: RouteSource;
  routes: Record<string, { label: string; name: string; mode: Exclude<TransitMode, 'ship'> }>;
  calendar: GtfsRow[]; calendarDates: GtfsRow[]; feedInfo: GtfsRow[];
  trips: RouteTrip[]; shapes: Record<string, [number, number][][]>;
  stops: Record<string, { name: string; longitude: number; latitude: number }>;
  patterns: Record<string, [stopId: string, sequence: number][]>;
}
export function journeyIdentity(query: URLSearchParams): JourneyIdentity {
  const fields = ['ownerOperatorId', 'vehicleId', 'routeId', 'directionId', 'serviceDate', 'startTime'];
  if ([...query.keys()].some(key => !fields.includes(key)) || fields.some(key => query.getAll(key).length !== 1)) throw new Error('Invalid journey query');
  const get = (key: string) => query.get(key)!;
  const ownerOperatorId = get('ownerOperatorId'), vehicleId = get('vehicleId'), routeId = get('routeId');
  const directionId = get('directionId'), serviceDate = get('serviceDate'), startTime = get('startTime');
  if (!/^\d{4}$/.test(ownerOperatorId) || !/^\d{5}$/.test(vehicleId) || !/^[A-Za-z0-9_-]{1,30}$/.test(routeId)
    || !/^[12]$/.test(directionId) || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new Error('Invalid journey query');
  serviceTimeToUtc(serviceDate, 0);
  return { id: `${ownerOperatorId}/${vehicleId}`, ownerOperatorId, vehicleId, routeId, directionId, serviceDate, startTime };
}
export function emptyRoute(vehicle: JourneyIdentity, reason: string): RouteContext {
  return { status: 'unavailable', vehicleId: vehicle.id, routeId: vehicle.routeId, routeLabel: null, destination: null,
    tripId: null, departureAt: null, candidates: [], shape: [], stops: [], reason, sourceId: 'hsl-gtfs', generatedAt: null, source: null };
}

/** Clip only real consecutive shape segments; gaps outside coverage never become invented paths. */
export function boundedShape(points: [number, number][], bounds: readonly number[] = RELEASE_BOUNDS): [number, number][][] {
  const segments: [number, number][][] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]; let low = 0, high = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - bounds[0]], [dx, bounds[2] - a[0]], [-dy, a[1] - bounds[1]], [dy, bounds[3] - a[1]]]) {
      if (p === 0) { if (q < 0) { high = -1; break; } }
      else { const t = q / p; if (p < 0) low = Math.max(low, t); else high = Math.min(high, t); }
    }
    if (low > high) continue;
    const start: [number, number] = [Math.max(bounds[0], Math.min(bounds[2], a[0] + low * dx)), Math.max(bounds[1], Math.min(bounds[3], a[1] + low * dy))];
    const end: [number, number] = [Math.max(bounds[0], Math.min(bounds[2], a[0] + high * dx)), Math.max(bounds[1], Math.min(bounds[3], a[1] + high * dy))];
    const previous = segments.at(-1);
    if (previous && previous.at(-1)![0] === start[0] && previous.at(-1)![1] === start[1]) previous.push(end);
    else segments.push([start, end]);
  }
  return segments;
}
export function routeForJourney(vehicle: JourneyIdentity, index: RouteIndex, routeTrips = index.trips.filter(trip => trip[1] === vehicle.routeId)): RouteContext {
  if (vehicle.routeId === null) return emptyRoute(vehicle, 'This report has no transit journey.');
  const base = { ...emptyRoute(vehicle, 'No scheduled journey matches these report identifiers.'), generatedAt: index.generatedAt, source: index.source,
    routeLabel: index.routes[vehicle.routeId]?.label ?? null };
  const compactDate = vehicle.serviceDate?.replaceAll('-', '');
  if (!compactDate || !index.feedInfo.some(info => compactDate >= info.feed_start_date && compactDate <= info.feed_end_date)) return { ...base, reason: 'The service date is outside the prepared GTFS coverage.' };
  const serviceIds = new Set(routeTrips.map(trip => trip[2]));
  const feed: GtfsSnapshot = { route: { route_id: vehicle.routeId }, calendar: index.calendar.filter(row => serviceIds.has(row.service_id)), calendarDates: index.calendarDates.filter(row => serviceIds.has(row.service_id)),
    feedInfo: index.feedInfo, inflatedBytes: 0, scannedRows: 0,
    trips: routeTrips.map(trip => ({ trip_id: trip[0], route_id: trip[1], service_id: trip[2], direction_id: trip[3] })),
    firstStops: routeTrips.map(trip => ({ trip_id: trip[0], departure_time: trip[6], stop_id: trip[7] })) };
  let match;
  try { match = matchJourney(vehicle as Vehicle, feed); }
  catch { return { ...base, reason: 'The prepared schedule could not resolve this service date safely.' }; }
  if (match.status !== 'exact') return { ...base, status: match.status, candidates: match.candidates,
    reason: match.status === 'ambiguous' ? 'More than one scheduled journey matches; no route is shown.' : base.reason };
  const trip = routeTrips.find(trip => trip[0] === match.tripId)!;
  const shape = index.shapes[trip[4]] ?? [];
  if (!shape.length) return { ...base, tripId: match.tripId, departureAt: match.departureAt, reason: 'The matched journey has no scheduled shape inside city coverage.' };
  const stops = (index.patterns[trip[8]] ?? []).flatMap(([id, sequence]) => {
    const stop = index.stops[id];
    return stop && inBounds(stop.longitude, stop.latitude, RELEASE_BOUNDS) ? [{ id, ...stop, sequence,
      arrivalAt: null, departureAt: id === trip[7] ? serviceTimeToUtc(vehicle.serviceDate!, serviceSeconds(trip[6])) : null }] : [];
  });
  return { ...base, status: 'exact', tripId: match.tripId, departureAt: match.departureAt, candidates: match.candidates,
    destination: trip[5] || null, shape, stops, reason: null };
}
function validateIndex(value: unknown): RouteIndex {
  const index = value as RouteIndex;
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length < 1000;
  if (!record(index) || index.version !== 1 || index.sourceId !== 'hsl-gtfs' || !Number.isFinite(Date.parse(index.generatedAt))
    || JSON.stringify(index.bounds) !== JSON.stringify(RELEASE_BOUNDS) || !Array.isArray(index.trips) || index.trips.length > 400_000
    || !Array.isArray(index.calendar) || index.calendar.length > 100_000 || !Array.isArray(index.calendarDates) || index.calendarDates.length > 100_000
    || !Array.isArray(index.feedInfo) || !index.feedInfo.length || index.feedInfo.length > 1000
    || !record(index.routes) || !record(index.shapes) || !record(index.stops) || !record(index.patterns)
    || Object.keys(index.routes).length > 1000 || Object.keys(index.shapes).length > 20_000 || Object.keys(index.stops).length > 20_000 || Object.keys(index.patterns).length > 20_000) throw new Error('Invalid prepared route index');
  const date = (value: unknown) => typeof value === 'string' && /^\d{8}$/.test(value)
    && new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T12:00:00Z`).toISOString().slice(0, 10).replaceAll('-', '') === value;
  if (!record(index.source) || index.source.url !== 'https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip' || !/^[a-f0-9]{64}$/.test(index.source.archiveSha256)
    || (index.source.feedVersion !== null && !text(index.source.feedVersion)) || !Number.isFinite(Date.parse(index.source.validFrom)) || !Number.isFinite(Date.parse(index.source.validTo))
    || (index.source.retrievedAt !== null && !Number.isFinite(Date.parse(index.source.retrievedAt)))) throw new Error('Invalid prepared route source');
  for (const route of Object.values(index.routes)) if (!record(route) || !text(route.label) || typeof route.name !== 'string' || !['tram', 'bus', 'ferry'].includes(route.mode)) throw new Error('Invalid prepared route label');
  for (const row of index.calendar) if (!record(row) || !text(row.service_id) || !date(row.start_date) || !date(row.end_date)
    || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].some(day => !['0', '1'].includes(row[day]))) throw new Error('Invalid prepared route calendar');
  for (const row of index.calendarDates) if (!record(row) || !text(row.service_id) || !date(row.date) || !['1', '2'].includes(row.exception_type)) throw new Error('Invalid prepared route calendar exception');
  for (const info of index.feedInfo) if (!record(info) || !date(info.feed_start_date) || !date(info.feed_end_date) || info.feed_end_date < info.feed_start_date) throw new Error('Invalid prepared route coverage');
  for (const paths of Object.values(index.shapes)) {
    if (!Array.isArray(paths) || paths.length > 20_000) throw new Error('Invalid prepared route shapes');
    for (const path of paths) if (!Array.isArray(path) || path.length < 2 || path.length > 20_000 || path.some(point => !Array.isArray(point) || point.length !== 2 || !inBounds(point[0], point[1], RELEASE_BOUNDS))) throw new Error('Invalid prepared route coordinates');
  }
  for (const stop of Object.values(index.stops)) if (!record(stop) || !text(stop.name) || !inBounds(stop.longitude, stop.latitude, RELEASE_BOUNDS)) throw new Error('Invalid prepared route stop');
  for (const pattern of Object.values(index.patterns)) {
    if (!Array.isArray(pattern) || pattern.length > 500 || pattern.some((entry, i) => !Array.isArray(entry) || entry.length !== 2 || !index.stops[entry[0]]
      || !Number.isSafeInteger(entry[1]) || entry[1] < 0 || (i > 0 && entry[1] <= pattern[i - 1][1]))) throw new Error('Invalid prepared route stop pattern');
  }
  const ids = new Set<string>();
  for (const trip of index.trips) {
    if (!Array.isArray(trip) || trip.length !== 9 || trip.some(value => typeof value !== 'string') || !text(trip[0]) || ids.has(trip[0])
      || !index.routes[trip[1]] || !text(trip[2]) || !['0', '1'].includes(trip[3]) || !index.shapes[trip[4]] || !index.patterns[trip[8]]) throw new Error('Invalid prepared route trip');
    serviceSeconds(trip[6]); ids.add(trip[0]);
  }
  return index;
}
export class RouteContextStore {
  private index: RouteIndex | null = null;
  private routeTrips = new Map<string, RouteTrip[]>();
  private loading: Promise<void> | null = null;
  private checkedAt = -Infinity; private modifiedAt = -1;
  private failure = 'The prepared route index is unavailable.';
  private results = new Map<string, RouteContext>();
  private path: string; private now: () => number;
  constructor(path = resolve('static/data/route-index.json'), now = Date.now) { this.path = path; this.now = now; }
  private async load() {
    if (this.loading) return this.loading;
    if (this.now() - this.checkedAt < 60_000) return;
    this.checkedAt = this.now();
    this.loading = (async () => {
      try {
        const info = await stat(this.path);
        if (info.mtimeMs === this.modifiedAt && this.index) return;
        if (info.size > ROUTE_INDEX_MAX_BYTES) throw new Error('Prepared route index exceeds its size limit');
        const index = validateIndex(JSON.parse(await readFile(this.path, 'utf8')));
        this.routeTrips.clear(); this.results.clear();
        for (const trip of index.trips) { const list = this.routeTrips.get(trip[1]) ?? []; list.push(trip); this.routeTrips.set(trip[1], list); }
        this.index = index; this.modifiedAt = info.mtimeMs;
      } catch (error) { this.index = null; this.routeTrips.clear(); this.results.clear(); this.failure = error instanceof Error ? error.message : 'The prepared route index is unavailable.'; }
    })().finally(() => { this.loading = null; });
    return this.loading;
  }
  async catalog(): Promise<RouteCatalog> {
    await this.load();
    return this.index ? { status: 'ready', generatedAt: this.index.generatedAt, reason: null, source: this.index.source,
      routes: Object.entries(this.index.routes).map(([routeId, route]) => ({ routeId, ...route })).sort((a, b) => a.label.localeCompare(b.label, 'fi', { numeric: true })) }
      : { status: 'unavailable', generatedAt: null, reason: this.failure, routes: [], source: null };
  }
  async journey(vehicle: JourneyIdentity): Promise<RouteContext> {
    await this.load();
    if (!this.index) return emptyRoute(vehicle, this.failure);
    const key = [vehicle.id, vehicle.routeId, vehicle.serviceDate, vehicle.directionId, vehicle.startTime].join('/');
    const cached = this.results.get(key); if (cached) return cached;
    const result = routeForJourney(vehicle, this.index, vehicle.routeId === null ? [] : this.routeTrips.get(vehicle.routeId) ?? []);
    if (this.results.size >= 128) this.results.delete(this.results.keys().next().value!);
    this.results.set(key, result); return result;
  }
}
export const routeContextStore = new RouteContextStore();
