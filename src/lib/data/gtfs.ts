import yauzl from 'yauzl';
import { parse } from 'csv-parse';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Vehicle } from '../types.ts';

export type GtfsRow = Record<string, string>;
export interface GtfsSnapshot {
  route: GtfsRow | null;
  calendar: GtfsRow[];
  calendarDates: GtfsRow[];
  trips: GtfsRow[];
  firstStops: GtfsRow[];
  feedInfo: GtfsRow[];
  inflatedBytes: number;
  scannedRows: number;
}
export interface JourneyMatch {
  vehicleId: string;
  tripId: string | null;
  status: 'exact' | 'missing' | 'ambiguous';
  candidates: string[];
  departureAt: string | null;
  firstStopId: string | null;
}

function validateServiceDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid GTFS service date');
  }
}
export function serviceIsActive(serviceId: string, date: string, calendar: GtfsRow[], exceptions: GtfsRow[]): boolean {
  validateServiceDate(date);
  const compact = date.replaceAll('-', '');
  const changes = exceptions.filter((row) => row.service_id === serviceId && row.date === compact);
  if (changes.length > 1 || changes.some((row) => !['1', '2'].includes(row.exception_type))) throw new Error('Conflicting GTFS calendar exceptions');
  if (changes.length) return changes[0].exception_type === '1';
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const day = weekdays[new Date(`${date}T12:00:00Z`).getUTCDay()];
  return calendar.some((row) => row.service_id === serviceId && compact >= row.start_date && compact <= row.end_date && row[day] === '1');
}
export function serviceSeconds(time: string): number {
  const match = /^(\d{2,3}):([0-5]\d):([0-5]\d)$/.exec(time);
  if (!match || Number(match[1]) > 71) throw new Error('Invalid GTFS service clock');
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** GTFS defines zero at local noon minus 12 elapsed hours, including DST dates. */
export function serviceTimeToUtc(date: string, seconds: number): string {
  validateServiceDate(date);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 259199) throw new Error('Invalid GTFS service seconds');
  const noonUtc = Date.parse(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(noonUtc);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = Date.parse(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}Z`) - noonUtc;
  return new Date(noonUtc - offset - 12 * 3600_000 + seconds * 1000).toISOString();
}
export function matchJourney(vehicle: Vehicle, feed: GtfsSnapshot): JourneyMatch {
  const base: JourneyMatch = { vehicleId: vehicle.id, tripId: null, status: 'missing', candidates: [], departureAt: null, firstStopId: null };
  if (!vehicle.serviceDate || !vehicle.startTime || !['1', '2'].includes(vehicle.directionId ?? '') || feed.route?.route_id !== vehicle.routeId) return base;
  const direction = String(Number(vehicle.directionId) - 1);
  const firstStops = new Map(feed.firstStops.map((row) => [row.trip_id, row]));
  const clock = new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  const candidates = feed.trips.filter((trip) => {
    const stop = firstStops.get(trip.trip_id);
    return trip.route_id === vehicle.routeId && trip.direction_id === direction
      && serviceIsActive(trip.service_id, vehicle.serviceDate!, feed.calendar, feed.calendarDates)
      && stop !== undefined && clock.format(Date.parse(serviceTimeToUtc(vehicle.serviceDate!, serviceSeconds(stop.departure_time)))) === vehicle.startTime;
  });
  base.candidates = candidates.map((trip) => trip.trip_id).sort();
  if (candidates.length !== 1) return { ...base, status: candidates.length ? 'ambiguous' : 'missing' };
  const first = firstStops.get(candidates[0].trip_id)!;
  return { ...base, status: 'exact', tripId: candidates[0].trip_id, firstStopId: first.stop_id,
    departureAt: serviceTimeToUtc(vehicle.serviceDate, serviceSeconds(first.departure_time)) };
}

/** Stream selected entries once with archive, row, inflation and processing limits. */
export async function withGtfsRows<T>(path: string, use: (readRows: (name: string, retain: (row: GtfsRow) => void) => Promise<void>) => Promise<T>): Promise<{ value: T; inflatedBytes: number; scannedRows: number }> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, value) => error || !value ? reject(error ?? new Error('GTFS ZIP missing')) : resolve(value)));
  const allowed = ['routes.txt', 'calendar.txt', 'calendar_dates.txt', 'trips.txt', 'stop_times.txt', 'feed_info.txt', 'stops.txt', 'shapes.txt'];
  const entries = new Map<string, yauzl.Entry>();
  const started = Date.now(); let inflatedBytes = 0, scannedRows = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject); zip.once('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        if (allowed.includes(entry.fileName)) {
          if (entries.has(entry.fileName)) { reject(new Error('Duplicate GTFS CSV')); return; }
          if (entry.uncompressedSize > 1024 ** 3) { reject(new Error('GTFS entry exceeds inflation limit')); return; }
          entries.set(entry.fileName, entry);
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
    const readRows = async (name: string, retain: (row: GtfsRow) => void): Promise<void> => {
      if (!allowed.includes(name)) throw new Error('Unsupported GTFS entry');
      const entry = entries.get(name);
      if (!entry) { if (name === 'calendar.txt' || name === 'calendar_dates.txt' || name === 'feed_info.txt') return; throw new Error(`Missing GTFS ${name}`); }
      const input = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('GTFS entry unreadable')) : resolve(stream)));
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        inflatedBytes += chunk.length;
        if (inflatedBytes > 1536 * 1024 ** 2 || Date.now() - started > 180_000) callback(new Error('GTFS inflation/time limit exceeded'));
        else callback(null, chunk);
      } });
      const rows = parse({ columns: true, bom: true, skip_empty_lines: true, max_record_size: 64 * 1024 });
      const complete = pipeline(input, limiter, rows); complete.catch(() => {});
      try {
        for await (const row of rows) {
          if (++scannedRows > 20_000_000) throw new Error('GTFS row limit exceeded');
          retain(row as GtfsRow);
        }
        await complete;
      } catch (error) { rows.destroy(error instanceof Error ? error : new Error(String(error))); await complete.catch(() => {}); throw error; }
    };
    return { value: await use(readRows), inflatedBytes, scannedRows };
  } finally { zip.close(); }
}

/** Inspect only selected CSVs and retain one route's active trips and earliest stops. */
export async function readGtfsSnapshot(path: string, routeId: string, date: string): Promise<GtfsSnapshot> {
  validateServiceDate(date);
  const feed: GtfsSnapshot = { route: null, calendar: [], calendarDates: [], trips: [], firstStops: [], feedInfo: [], inflatedBytes: 0, scannedRows: 0 };
  const result = await withGtfsRows(path, async (readRows) => {
    await readRows('routes.txt', (row) => { if (row.route_id === routeId) { if (feed.route) throw new Error('Duplicate GTFS route'); feed.route = row; } });
    for (const [name, target] of [['calendar.txt', feed.calendar], ['calendar_dates.txt', feed.calendarDates], ['feed_info.txt', feed.feedInfo]] as const) {
      await readRows(name, (row) => { if (target.length >= 100_000) throw new Error('GTFS retained metadata limit exceeded'); target.push(row); });
    }
    await readRows('trips.txt', (row) => {
      if (row.route_id === routeId && serviceIsActive(row.service_id, date, feed.calendar, feed.calendarDates)) {
        if (feed.trips.length >= 5000) throw new Error('GTFS retained trip limit exceeded'); feed.trips.push(row);
      }
    });
    const selected = new Set(feed.trips.map((trip) => trip.trip_id));
    const first = new Map<string, GtfsRow>();
    await readRows('stop_times.txt', (row) => {
      if (!selected.has(row.trip_id)) return;
      if (!/^\d+$/.test(row.stop_sequence)) throw new Error('Invalid GTFS stop sequence');
      const previous = first.get(row.trip_id);
      if (!previous || Number(row.stop_sequence) < Number(previous.stop_sequence)) first.set(row.trip_id, row);
    });
    feed.firstStops = [...first.values()];
  });
  feed.inflatedBytes = result.inflatedBytes; feed.scannedRows = result.scannedRows;
  return feed;
}
