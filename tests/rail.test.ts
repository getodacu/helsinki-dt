import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeRailPosition, decodeRailJourney, decodeRailStations, railDepartures, withRailJourney } from '../src/lib/data/rail.ts';
import { railId, railDate, railDelay, type RailJourney, type RailResult } from '../src/lib/rail.ts';
import { RailDataStore } from '../src/lib/server/rail.ts';
import { RailFeed, type RailFeedUpdate } from '../src/lib/server/rail-feed.ts';
import { railRoute, validateRailIndex, RAIL_GTFS_URL, type RailRouteIndex } from '../src/lib/server/rail-routes.ts';
import { railClock, prepareRailIndex, publishRailIndex } from '../scripts/prepare-rail.ts';
import { RELEASE_BOUNDS, inBounds } from '../src/lib/area.ts';
import { trafficAge } from '../src/lib/traffic.ts';
import { ReceivedPositions, LiveFleet, vehicleVisible } from '../src/lib/live-fleet.ts';
const NOW = Date.parse('2026-10-09T09:00:00Z');
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const position = (changes: Record<string, unknown> = {}) => ({ trainNumber: 23, departureDate: '2026-10-09', timestamp: iso(), speed: 72, location: { type: 'Point', coordinates: [24.94, 60.19] }, ...changes });
const stationRows = [{ stationShortCode: 'HKI', stationName: 'Helsinki', passengerTraffic: true, longitude: 24.941444, latitude: 60.171356 }, { stationShortCode: 'PSL', stationName: 'Pasila', passengerTraffic: true, longitude: 24.933521, latitude: 60.198689 }];
const stations = decodeRailStations(stationRows);
const event = (changes: Record<string, unknown> = {}) => ({ stationShortCode: 'HKI', type: 'DEPARTURE', scheduledTime: iso(60_000), liveEstimateTime: iso(180_000), commercialTrack: '5', trainStopping: true, commercialStop: true, cancelled: false, ...changes });
const timetable = (changes: Record<string, unknown> = {}) => ({ trainNumber: 23, departureDate: '2026-10-09', trainType: 'IC', trainCategory: 'Long-distance', operatorShortCode: 'vr', cancelled: false,
  timeTableRows: [event(), event({ stationShortCode: 'PSL', type: 'ARRIVAL', scheduledTime: iso(600_000), liveEstimateTime: null })], ...changes });
const journey = () => decodeRailJourney(timetable(), stations, iso(), NOW);
const ready = (): RailResult<RailJourney> => ({ state: 'ready', data: journey(), retrievedAt: iso(), error: null });
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test('rail identity uses departure date, preserves undated positions and converts lon/lat and km/h', () => {
  const vehicle = decodeRailPosition(position(), iso(500));
  assert.equal(vehicle.id, 'digitraffic:2026-10-09:23'); assert.equal(vehicle.longitude, 24.94); assert.equal(vehicle.latitude, 60.19); assert.equal(vehicle.speedMetresPerSecond, 20);
  const undated = decodeRailPosition(position({ departureDate: undefined, speed: null }), iso());
  assert.equal(undated.id, railId(null, '23')); assert.equal(undated.serviceDate, null); assert.equal(undated.journeyReference, null); assert.equal(undated.speedMetresPerSecond, null);
  assert.notEqual(decodeRailPosition(position({ departureDate: '2026-10-08' }), iso()).id, vehicle.id);
  for (const changes of [{ speed: -1 }, { speed: '72' }, { trainNumber: '../x' }, { departureDate: '2026-02-30' }, { timestamp: '2026-10-09T12:00:00' }, { location: { type: 'Point', coordinates: [60, 200] } }]) assert.throws(() => decodeRailPosition(position(changes), iso()));
  assert.equal(railDate('2026-02-30'), false);
});

test('journey metadata keeps report age, named delay sign, platforms, cancellations and unknown estimates', () => {
  const vehicle = decodeRailPosition(position(), iso(500)), metadata = journey(), enriched = withRailJourney(vehicle, metadata);
  assert.equal(enriched.reportedAt, vehicle.reportedAt); assert.equal(enriched.receivedAt, vehicle.receivedAt); assert.equal(trafficAge(enriched, NOW + 31_000), 31_000);
  assert.equal(enriched.delaySeconds, 120); assert.equal(metadata.summary.nextEvent?.stationName, 'Helsinki'); assert.equal(metadata.summary.nextEvent?.platform, '5');
  assert.equal(railDelay({ ...metadata.events[0], estimatedAt: iso() }), -60); assert.equal(railDelay(metadata.events[1]), null);
  assert.equal(railDelay({ ...metadata.events[0], actualAt: iso(90_000) }), 30);
  assert.equal(withRailJourney(decodeRailPosition(position({ departureDate: undefined }), iso()), metadata).rail?.timetableAt, null);
  const cancelled = decodeRailJourney(timetable({ cancelled: true }), stations, iso(), NOW);
  assert.equal(cancelled.summary.cancelled, true);
  const departures = railDepartures([cancelled, decodeRailJourney(timetable({ trainNumber: 24, trainCategory: 'Cargo' }), stations, iso(), NOW)], 'HKI', NOW);
  assert.equal(railDepartures([cancelled, cancelled], 'HKI', NOW).length, 1);
  assert.equal(departures.length, 1); assert.equal(departures[0].id, vehicle.id); assert.equal(departures[0].summary.cancelled, true);
  assert.equal(railDepartures(Array.from({ length: 20 }, (_, i) => decodeRailJourney(timetable({ trainNumber: i + 1 }), stations, iso(), NOW)), 'HKI', NOW).length, 12);
});

test('rail display text rejects controls and lone surrogates while preserving valid Unicode and nulls', () => {
  for (const invalid of ['station\u0001', 'station\n', '\ud800', '\udfff']) {
    assert.throws(() => decodeRailStations([{ ...stationRows[0], stationName: invalid }]));
    assert.throws(() => decodeRailJourney(timetable({ operatorShortCode: invalid }), stations, iso(), NOW));
    assert.throws(() => decodeRailJourney(timetable({ timeTableRows: [event({ commercialTrack: invalid })] }), stations, iso(), NOW));
  }
  const unicode = 'Ä東京🚆';
  assert.equal(decodeRailStations([{ ...stationRows[0], stationName: unicode }])[0].name, unicode);
  const summary = decodeRailJourney(timetable({ operatorShortCode: unicode, trainType: null }), stations, iso(), NOW).summary;
  assert.equal(summary.operator, unicode); assert.equal(summary.trainType, null);
});

test('cache shares requests, bounds concurrency, refreshes at 30 seconds and retains failed data as stale', async () => {
  let now = NOW, fail = false, calls = 0, active = 0, peak = 0;
  const store = new RailDataStore(async path => {
    if (path === 'metadata/stations') return stationRows;
    calls++; active++; peak = Math.max(peak, active); await settle(); active--;
    if (fail) throw new Error('offline');
    return [timetable({ trainNumber: Number(path.split('/').at(-1)) })];
  }, () => now);
  await Promise.all(Array.from({ length: 12 }, () => store.train('2026-10-09', '23'))); assert.equal(calls, 1);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.train('2026-10-09', String(i + 100)))); assert.ok(peak <= 4);
  now += 30_000; fail = true;
  const stale = await store.train('2026-10-09', '23'); assert.equal(stale.state, 'stale'); assert.equal(stale.retrievedAt, iso());
  const before = calls; await store.train('2026-10-09', '23'); assert.equal(calls, before);
});

test('cancelling one shared consumer preserves the inspector; cancelling all stops active and queued metadata', async () => {
  let started = 0, aborted = 0, complete: (() => void)[] = [];
  const store = new RailDataStore(async (path, signal) => {
    if (path === 'metadata/stations') return stationRows;
    started++;
    await new Promise<void>((resolve, reject) => { complete.push(resolve); signal?.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }); });
    return [timetable({ trainNumber: Number(path.split('/').at(-1)) })];
  });
  const controller = new AbortController();
  const feed = store.train('2026-10-09', '23', controller.signal); const inspector = store.train('2026-10-09', '23');
  await settle(); controller.abort(); await assert.rejects(feed); assert.equal(aborted, 0); complete.shift()!(); assert.equal((await inspector).state, 'ready');
  const lifetime = new AbortController();
  const pending = Array.from({ length: 12 }, (_, i) => store.train('2026-10-09', String(100 + i), lifetime.signal));
  const result = Promise.allSettled(pending); await settle(); assert.equal(started, 5); lifetime.abort(); await result; await settle(); assert.equal(aborted, 4); assert.equal(started, 5);
});

test('rail polling deduplicates, rejects older reports and exits, distinguishes malformed, empty and failed snapshots', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  let response: unknown = [position(), position({ timestamp: iso(-1000) })], fail = false, calls = 0;
  const updates: RailFeedUpdate[] = [];
  const feed = new RailFeed(async () => { calls++; if (fail) throw new Error('offline'); return response; }, { train: async () => ready() });
  t.after(() => feed.stop()); feed.start(update => updates.push(update)); feed.start(() => assert.fail('second start')); await settle();
  assert.equal(calls, 1); assert.equal(updates.at(-1)?.vehicles.length, 1); assert.equal(updates.at(-1)?.vehicles[0].delaySeconds, 120);
  const poll = async (ms = 5000) => { t.mock.timers.tick(ms); await settle(); };
  response = [position({ timestamp: iso(-1000), location: { type: 'Point', coordinates: [25.5, 60.19] } })]; await poll(); assert.equal(updates.at(-1)?.vehicles[0].reportedAt, iso());
  fail = true; await poll(); assert.equal(updates.at(-1)?.status.state, 'reconnecting'); assert.equal(updates.at(-1)?.vehicles.length, 1);
  fail = false; response = [{}]; await poll(); assert.equal(updates.at(-1)?.status.state, 'reconnecting'); assert.equal(updates.at(-1)?.vehicles.length, 1);
  response = [position({ timestamp: iso(20_000), location: { type: 'Point', coordinates: [25.5, 60.19] } })]; await poll(10_000); assert.equal(updates.at(-1)?.vehicles.length, 0);
  response = [position()]; await poll(); assert.equal(updates.at(-1)?.vehicles.length, 0);
  response = [position({ timestamp: iso(30_000) })]; await poll(); assert.equal(updates.at(-1)?.vehicles.length, 1);
  response = []; await poll(); assert.equal(updates.at(-1)?.status.state, 'live'); assert.equal(updates.at(-1)?.vehicles.length, 0);
  const count = calls; feed.stop(); t.mock.timers.tick(120_000); await settle(); assert.equal(calls, count);
});

test('undated and expired positions do not request journey metadata; stop aborts outstanding position poll', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const updates: RailFeedUpdate[] = []; let metadata = 0, signal: AbortSignal | undefined;
  const feed = new RailFeed(async () => [position({ departureDate: null }), position({ trainNumber: 24, timestamp: iso(-120_000) })], { train: async () => { metadata++; return ready(); } });
  feed.start(update => updates.push(update)); await settle(); assert.equal(metadata, 0); assert.equal(updates.at(-1)?.vehicles.length, 1); feed.stop();
  const hanging = new RailFeed(async (_path, request) => { signal = request; return new Promise((_, reject) => request?.addEventListener('abort', () => reject(request.reason), { once: true })); });
  hanging.start(() => {}); hanging.stop(); await settle(); assert.equal(signal?.aborted, true);
});

const index = (): RailRouteIndex => ({ version: 1, sourceId: 'digitraffic-gtfs', generatedAt: iso(), bounds: [...RELEASE_BOUNDS], source: { url: RAIL_GTFS_URL, archiveSha256: 'a'.repeat(64), retrievedAt: iso(), feedVersion: 'fixture', validFrom: '2026-01-01', validTo: '2026-12-31' },
 calendar: [], calendarDates: [{service_id:'service',date:'20261009',exception_type:'1'}],
 trips: { '23': [{ id: '23_20261212', serviceId: 'service', shapeId: 's', destination: 'Pasila', departure: '25:10:00', stops: [['PSL', 2, '25:20:00', '25:21:00']] }] }, shapes: { s: [[[24.94, 60.19], [24.933521, 60.198689]]] }, stops: { PSL: { name: 'Pasila', longitude: 24.933521, latitude: 60.198689 } } });
test('rail route matching is exact by date and number, handles missing/ambiguous shapes, overnight and Helsinki DST', () => {
  const source = validateRailIndex(index()), route = railRoute('2026-10-09', '23', source);
  assert.equal(route.status, 'exact'); assert.equal(route.tripId, '23_20261212'); assert.equal(route.departureAt, '2026-10-09T22:10:00.000Z'); assert.equal(route.stops[0].sequence, 2);
  assert.equal(railRoute('2026-10-08', '23', source).status, 'missing'); assert.equal(railRoute('2026-10-09', '24', source).status, 'missing');
  source.trips['23'].push({ ...source.trips['23'][0], id: 'other' }); assert.equal(railRoute('2026-10-09', '23', source).status, 'ambiguous'); source.trips['23'].pop();
  delete source.shapes.s; assert.equal(railRoute('2026-10-09', '23', validateRailIndex(source)).status, 'missing');
  for (const [date, expected] of [['2026-03-29', '2026-03-29T01:00:00.000Z'], ['2026-10-25', '2026-10-25T02:00:00.000Z']]) {
    const fixture = index(); fixture.calendarDates.push({service_id:'service', date:date.replaceAll('-', ''), exception_type:'1'}); fixture.trips['23'] = [{ ...fixture.trips['23'][0], departure: '04:00:00' }]; assert.equal(railRoute(date, '23', fixture).departureAt, expected);
  }
  assert.equal(railClock('6:54:00'), '06:54:00'); assert.throws(() => railClock('72:00:00'));
});

test('real archive preparation handles single digit clocks, shuffled stops, clipping and service cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helsinki-rail-'));
  const archive = join(directory, 'fixture.zip');
  const files: Record<string, string> = {
    'feed_info.txt': 'feed_version,feed_start_date,feed_end_date\nfixture,20260101,20261231\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns,1,1,1,1,1,1,1,20260101,20261231\n',
    'calendar_dates.txt': 'service_id,date,exception_type\ns,20261009,1\nc,20261009,2\n',
    'trips.txt': 'trip_id,service_id,shape_id,trip_headsign\n23_20261212,s,shape,Pasila\n24_20261009,c,shape,Cancelled\n25_20261009,s,missing,No shape\n',
    'shapes.txt': 'shape_id,shape_pt_sequence,shape_pt_lon,shape_pt_lat\nshape,2,24.94,60.19\nshape,1,24.80,60.19\n',
    'stops.txt': 'stop_id,stop_name,stop_lon,stop_lat\nHKI,Helsinki,24.94,60.19\nPSL,Pasila,24.933521,60.198689\n',
    'stop_times.txt': 'trip_id,stop_id,stop_sequence,arrival_time,departure_time\n23_20261212,PSL,3,7:10:00,7:11:00\n23_20261212,HKI,1,6:54:00,6:55:00\n25_20261009,HKI,1,6:54:00,6:55:00\n'
  };
  const zip = () => execFileSync('python3', ['-c', 'import json,sys,zipfile\nf=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n for name,data in f.items(): z.writestr(name,data)', archive], { input: JSON.stringify(files) });
  try {
    zip(); const result = await prepareRailIndex(archive); assert.equal(Object.keys(result.trips).length, 2); assert.equal(result.trips['23'][0].departure, '06:55:00');
    assert.deepEqual(result.trips['23'][0].stops.map(stop => stop[1]), [1, 3]); assert.ok(result.shapes.shape.flat().every(([lon, lat]) => inBounds(lon, lat, RELEASE_BOUNDS)));
    assert.equal(railRoute('2026-10-09', '25', result).status, 'missing'); assert.equal(railRoute('2026-10-08', '23', result).status, 'exact'); await publishRailIndex(result, join(directory, 'index.json'));
    files['calendar_dates.txt'] += 's,20261009,2\n'; zip(); await assert.rejects(prepareRailIndex(archive), /calendar exception/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('train motion buffers 12 seconds, derives bearing, holds at last report, rejects jumps and respects terrain/filters', () => {
  const buffer = new ReceivedPositions();
  for (let i = 0; i <= 20; i++) buffer.upsert(decodeRailPosition(position({ timestamp: iso(i * 1000), location: { type: 'Point', coordinates: [24.94 + i * .0001, 60.19] } }), iso(i * 1000)));
  const buffered = buffer.position(railId('2026-10-09', '23'), NOW + 20_000)!, discrete = buffer.position(railId('2026-10-09', '23'), NOW + 20_000, true)!;
  assert.ok(discrete.x - buffered.x > 50); assert.ok(Math.abs(discrete.heading! - 90) < 1); assert.equal(buffer.position(railId('2026-10-09', '23'), NOW + 60_000)?.x, discrete.x);
  assert.equal(buffer.position(railId('2026-10-09', '23'), NOW + 140_000), null);
  buffer.upsert(decodeRailPosition(position({ timestamp: iso(21_000), location: { type: 'Point', coordinates: [25.04, 60.19] } }), iso(21_000))); assert.equal(buffer.tracks.values().next().value?.positions.length, 1);
  const train = withRailJourney(decodeRailPosition(position(), iso()), journey()), modes = { tram: true, bus: true, ferry: true, train: true, ship: true };
  assert.equal(vehicleVisible(train, { ...modes, 'long-distance': false }), false);
  const fleet = new LiveFleet(() => null); fleet.setVehicles([train]); fleet.update(NOW, modes, true); assert.equal(fleet.visibleCount, 0); assert.equal(fleet.unplacedCount, 1); assert.equal(fleet.motion.tracks.size, 1); fleet.dispose();
});
