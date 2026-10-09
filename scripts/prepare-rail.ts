import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_BOUNDS, inBounds } from '../src/lib/area.ts';
import { withGtfsRows, serviceSeconds, type GtfsRow } from '../src/lib/data/gtfs.ts';
import { boundedShape } from '../src/lib/server/route-context.ts';
import { downloadFile } from '../src/lib/server/io.ts';
import { RAIL_GTFS_URL, RAIL_INDEX_MAX_BYTES, validateRailIndex, type RailRouteIndex, type RailTrip } from '../src/lib/server/rail-routes.ts';

export function railClock(value: string): string {
  const clock = /^\d:/.test(value) ? `0${value}` : value;
  serviceSeconds(clock); return clock;
}

export async function prepareRailIndex(archive: string, retrievedAt: string | null = null): Promise<RailRouteIndex> {
  if ((await stat(archive)).size > 128 * 1024 ** 2) throw new Error('Rail GTFS archive too large');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const index: RailRouteIndex = { version: 1, sourceId: 'digitraffic-gtfs', generatedAt: new Date().toISOString(), bounds: [...RELEASE_BOUNDS],
    source: { url: RAIL_GTFS_URL, archiveSha256: hash.digest('hex'), retrievedAt, feedVersion: null, validFrom: '', validTo: '' }, calendar: [], calendarDates: [], trips: {}, shapes: {}, stops: {} };
  await withGtfsRows(archive, async readRows => {
    const calendar: GtfsRow[] = [], exceptions: GtfsRow[] = [];
    for (const [file, rows] of [['calendar.txt', calendar], ['calendar_dates.txt', exceptions]] as const) await readRows(file, row => {
      if (rows.length >= 400_000) throw new Error('Rail calendar exceeds limit'); rows.push(row);
    });
    await readRows('feed_info.txt', row => {
      const date = (value: string) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      index.source.feedVersion = row.feed_version || null; index.source.validFrom = date(row.feed_start_date); index.source.validTo = date(row.feed_end_date);
    });
    const shapes = new Map<string, { point: [number, number]; sequence: number }[]>();
    await readRows('shapes.txt', row => {
      const point: [number, number] = [Number(row.shape_pt_lon), Number(row.shape_pt_lat)];
      if (!row.shape_pt_lon || !row.shape_pt_lat || !inBounds(point[0], point[1], [-180, -90, 180, 90]) || !/^\d+$/.test(row.shape_pt_sequence)) throw new Error('Invalid rail shape row');
      const points = shapes.get(row.shape_id) ?? []; points.push({ point, sequence: Number(row.shape_pt_sequence) }); shapes.set(row.shape_id, points);
      if (shapes.size > 20_000 || points.length > 20_000) throw new Error('Rail shape limit exceeded');
    });
    for (const [id, points] of shapes) {
      points.sort((a, b) => a.sequence - b.sequence);
      if (points.some((point, i) => i > 0 && point.sequence === points[i - 1].sequence)) throw new Error('Duplicate rail shape sequence');
      const paths = boundedShape(points.map(point => point.point)); if (paths.length) index.shapes[id] = paths;
    }
    shapes.clear();
    await readRows('stops.txt', row => {
      const longitude = Number(row.stop_lon), latitude = Number(row.stop_lat);
      if (row.stop_lon && row.stop_lat && inBounds(longitude, latitude, RELEASE_BOUNDS)) index.stops[row.stop_id] = { name: row.stop_name, longitude, latitude };
    });
    const trips = new Map<string, { key: string; trip: RailTrip; first: number }>();
    // The numeric prefix identifies the train; the date suffix is a timetable-period ID.
    await readRows('trips.txt', row => {
      const match = /^([1-9]\d{0,4})_(\d{4})(\d{2})(\d{2})$/.exec(row.trip_id);
      if (!match) return;
      if (trips.has(row.trip_id) || trips.size >= 400_000) throw new Error('Duplicate or excessive rail trips');
      trips.set(row.trip_id, { key: match[1], first: Infinity, trip: { id: row.trip_id, serviceId: row.service_id, shapeId: row.shape_id, destination: row.trip_headsign || '', departure: '', stops: [] } });
    });
    await readRows('stop_times.txt', row => {
      const item = trips.get(row.trip_id); if (!item) return;
      if (!/^\d+$/.test(row.stop_sequence)) throw new Error('Invalid rail stop sequence');
      const sequence = Number(row.stop_sequence);
      if (sequence < item.first) { item.first = sequence; item.trip.departure = railClock(row.departure_time); }
      if (index.stops[row.stop_id]) item.trip.stops.push([row.stop_id, sequence, row.arrival_time ? railClock(row.arrival_time) : '', row.departure_time ? railClock(row.departure_time) : '']);
      if (item.trip.stops.length > 500) throw new Error('Too many rail stops');
    });
    for (const { key, trip } of trips.values()) {
      if (!trip.departure || (!index.shapes[trip.shapeId] && !trip.stops.length)) continue;
      trip.stops.sort((a, b) => a[1] - b[1]); (index.trips[key] ??= []).push(trip);
    }
    const services = new Set(Object.values(index.trips).flat().map(trip => trip.serviceId));
    index.calendar = calendar.filter(row => services.has(row.service_id));
    index.calendarDates = exceptions.filter(row => services.has(row.service_id));
  });
  if (!Object.keys(index.trips).length) throw new Error('Rail preparation produced no covered journeys');
  return validateRailIndex(index);
}
export async function publishRailIndex(index: RailRouteIndex, output: string) {
  validateRailIndex(index); const json = JSON.stringify(index);
  if (Buffer.byteLength(json) > RAIL_INDEX_MAX_BYTES) throw new Error('Rail index exceeds byte limit');
  await mkdir(dirname(output), { recursive: true }); const staging = `${output}.${randomUUID()}.tmp`;
  try { await writeFile(staging, json); await rename(staging, output); }
  finally { await rm(staging, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = resolve(process.argv[2] ?? '.cache/rail/gtfs-all.zip');
  let retrievedAt: string | null = null;
  if (!process.argv[2]) {
    const result = await downloadFile(RAIL_GTFS_URL, archive, { maxBytes: 128 * 1024 ** 2, timeoutMs: 120_000,
      headers: { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'HelsinkiLens/1.0' } });
    retrievedAt = result.retrievedAt; await writeFile(`${archive}.metadata.json`, JSON.stringify(result));
  }
  const index = await prepareRailIndex(archive, retrievedAt);
  if (process.argv[2]) {
    try {
      const value = JSON.parse(await readFile(`${archive}.metadata.json`, 'utf8'));
      if (value.sha256 === index.source.archiveSha256 && Number.isFinite(Date.parse(value.retrievedAt))) index.source.retrievedAt = value.retrievedAt;
    } catch { /* Existing archives can lack retrieval evidence. */ }
  }
  await publishRailIndex(index, resolve('static/data/rail-index.json'));
  console.log(JSON.stringify({ trainNumbers: Object.keys(index.trips).length, tripPatterns: Object.values(index.trips).flat().length, shapes: Object.keys(index.shapes).length, stops: Object.keys(index.stops).length, source: index.source }));
}
