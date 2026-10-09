import { mkdir, writeFile, rename, rm, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RELEASE_BOUNDS, inBounds } from '../src/lib/area.ts';
import { withGtfsRows, serviceSeconds, type GtfsRow } from '../src/lib/data/gtfs.ts';
import { boundedShape, ROUTE_INDEX_MAX_BYTES, type RouteIndex, type RouteTrip } from '../src/lib/server/route-context.ts';

export function matchingRouteRetrieval(checksum: string, metadata: unknown): string | null {
  const source = metadata as { checksum?: unknown; retrievedAt?: unknown } | null;
  return source?.checksum === checksum && typeof source.retrievedAt === 'string' && Number.isFinite(Date.parse(source.retrievedAt)) ? source.retrievedAt : null;
}

/** Preparation scans the source archive once; live requests use only this bounded index. */
export async function prepareRouteIndex(archive: string): Promise<RouteIndex> {
  if ((await stat(archive)).size > 128 * 1024 ** 2) throw new Error('GTFS archive exceeds download limit');
  const digest = createHash('sha256'); for await (const chunk of createReadStream(archive)) digest.update(chunk);
  const archiveSha256 = digest.digest('hex'); let retrievedAt: string | null = null;
  try { const metadata = JSON.parse(await readFile(`${archive}.metadata.json`, 'utf8'));
    retrievedAt = matchingRouteRetrieval(archiveSha256, metadata); } catch { /* Cached archives can lack a retrieval sidecar. */ }
  if (!retrievedAt) try {
    const manifest = JSON.parse(await readFile(resolve('static/data/manifest.json'), 'utf8'));
    retrievedAt = matchingRouteRetrieval(archiveSha256, manifest.sources?.find((source: {id: string}) => source.id === 'hsl-gtfs'));
  } catch { /* Unknown retrieval stays separate from preparation time. */ }
  const index: RouteIndex = { version: 1, generatedAt: new Date().toISOString(), sourceId: 'hsl-gtfs', bounds: [...RELEASE_BOUNDS],
    source: { url: 'https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip', archiveSha256, feedVersion: null, validFrom: '', validTo: '', retrievedAt },
    routes: {}, calendar: [], calendarDates: [], feedInfo: [], trips: [], shapes: {}, stops: {}, patterns: {} };
  await withGtfsRows(archive, async readRows => {
    await readRows('routes.txt', row => {
      // HSL buses use extended GTFS types 701/702/704; 900 also identifies tram service.
      const mode = ['0', '900'].includes(row.route_type) ? 'tram' : /^(3|70\d|71[0-6])$/.test(row.route_type) ? 'bus' : row.route_type === '4' ? 'ferry' : null;
      if (!mode) return;
      if (index.routes[row.route_id]) throw new Error('Duplicate GTFS route');
      index.routes[row.route_id] = { label: row.route_short_name || row.route_id, name: row.route_long_name || '', mode };
    });
    for (const [name, target] of [['calendar.txt', index.calendar], ['calendar_dates.txt', index.calendarDates], ['feed_info.txt', index.feedInfo]] as const) {
      await readRows(name, row => { if (target.length >= 100_000) throw new Error('GTFS retained metadata limit exceeded'); target.push(row); });
    }
    const shapes = new Map<string, { sequence: number; point: [number, number] }[]>();
    await readRows('shapes.txt', row => {
      const point: [number, number] = [Number(row.shape_pt_lon), Number(row.shape_pt_lat)], sequence = Number(row.shape_pt_sequence);
      if (!row.shape_pt_lon || !row.shape_pt_lat || !Number.isFinite(point[0]) || Math.abs(point[0]) > 180 || !Number.isFinite(point[1]) || Math.abs(point[1]) > 90 || !/^\d+$/.test(row.shape_pt_sequence)) throw new Error('Invalid GTFS shape coordinate or sequence');
      const points = shapes.get(row.shape_id) ?? []; points.push({ point, sequence }); shapes.set(row.shape_id, points);
      if (points.length > 20_000 || shapes.size > 20_000) throw new Error('GTFS shape retention limit exceeded');
    });
    for (const [id, points] of shapes) {
      points.sort((a, b) => a.sequence - b.sequence);
      if (points.some((point, i) => i > 0 && points[i - 1].sequence === point.sequence)) throw new Error('Duplicate GTFS shape sequence');
      const bounded = boundedShape(points.map(point => point.point)); if (bounded.length) index.shapes[id] = bounded;
    }
    shapes.clear();
    await readRows('stops.txt', row => {
      const longitude = Number(row.stop_lon), latitude = Number(row.stop_lat);
      if (!row.stop_lon || !row.stop_lat || !inBounds(longitude, latitude, RELEASE_BOUNDS)) return;
      if (index.stops[row.stop_id]) throw new Error('Duplicate GTFS stop');
      index.stops[row.stop_id] = { name: row.stop_name || row.stop_id, longitude, latitude };
      if (Object.keys(index.stops).length > 20_000) throw new Error('GTFS stop retention limit exceeded');
    });
    const trips = new Map<string, RouteTrip>();
    await readRows('trips.txt', row => {
      if (!index.routes[row.route_id]) return;
      if (trips.has(row.trip_id) || !['0', '1'].includes(row.direction_id)) throw new Error('Invalid or duplicate GTFS trip');
      trips.set(row.trip_id, [row.trip_id, row.route_id, row.service_id, row.direction_id, row.shape_id, row.trip_headsign || '', '', '', '']);
      if (trips.size > 400_000) throw new Error('GTFS trip retention limit exceeded');
    });
    // Matching must retain outside/missing-shape competitors for every route that intersects the release.
    const coveredRoutes = new Set([...trips.values()].filter(trip => index.shapes[trip[4]]?.length).map(trip => trip[1]));
    for (const [id, trip] of trips) if (!coveredRoutes.has(trip[1])) trips.delete(id);
    const first = new Map<string, { sequence: number; departure: string; stopId: string }>();
    const stops = new Map<string, [string, number][]>(); let retainedStops = 0;
    await readRows('stop_times.txt', row => {
      if (!trips.has(row.trip_id)) return;
      if (!/^\d+$/.test(row.stop_sequence)) throw new Error('Invalid GTFS stop sequence');
      const sequence = Number(row.stop_sequence), previous = first.get(row.trip_id);
      if (!previous || sequence < previous.sequence) { serviceSeconds(row.departure_time); first.set(row.trip_id, { sequence, departure: row.departure_time, stopId: row.stop_id }); }
      if (!index.stops[row.stop_id]) return;
      const pattern = stops.get(row.trip_id) ?? []; pattern.push([row.stop_id, sequence]); stops.set(row.trip_id, pattern);
      if (pattern.length > 500 || ++retainedStops > 8_000_000) throw new Error('GTFS scheduled stop retention limit exceeded');
    });
    const usedRoutes = new Set<string>(), usedShapes = new Set<string>();
    for (const trip of trips.values()) {
      const departure = first.get(trip[0]); if (!departure) continue;
      const pattern = (stops.get(trip[0]) ?? []).sort((a, b) => a[1] - b[1]);
      if (pattern.some((point, i) => i > 0 && pattern[i - 1][1] === point[1])) throw new Error('Duplicate GTFS stop sequence');
      const patternId = createHash('sha256').update(JSON.stringify(pattern)).digest('hex');
      index.patterns[patternId] = pattern;
      trip[6] = departure.departure; trip[7] = departure.stopId; trip[8] = patternId;
      index.trips.push(trip); usedRoutes.add(trip[1]); usedShapes.add(trip[4]);
      index.shapes[trip[4]] ??= []; 
    }
    for (const id of Object.keys(index.routes)) if (!usedRoutes.has(id)) delete index.routes[id];
    for (const id of Object.keys(index.shapes)) if (!usedShapes.has(id)) delete index.shapes[id];
  });
  if (!index.trips.length || !index.feedInfo.length) throw new Error('GTFS preparation produced no routes or coverage');
  const coverage = index.feedInfo[0], date = (value: string) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  index.source.feedVersion = coverage.feed_version || null; index.source.validFrom = date(coverage.feed_start_date); index.source.validTo = date(coverage.feed_end_date);
  return index;
}
export async function publishRouteIndex(index: RouteIndex, output: string): Promise<number> {
  const json = JSON.stringify(index), bytes = Buffer.byteLength(json);
  if (bytes > ROUTE_INDEX_MAX_BYTES) throw new Error('Prepared route index exceeds its size limit');
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.${randomUUID()}.tmp`;
  try { await writeFile(staging, json); await rename(staging, output); }
  finally { await rm(staging, { force: true }); }
  return bytes;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = resolve(process.argv[2] ?? '.cache/task-a/hsl-gtfs.zip');
  const output = resolve(process.argv[3] ?? 'static/data/route-index.json');
  const index = await prepareRouteIndex(archive); const bytes = await publishRouteIndex(index, output);
  console.log(JSON.stringify({ output, bytes, routes: Object.keys(index.routes).length, trips: index.trips.length,
    shapes: Object.keys(index.shapes).length, stops: Object.keys(index.stops).length, patterns: Object.keys(index.patterns).length,
    coverage: index.feedInfo, generatedAt: index.generatedAt }));
}
