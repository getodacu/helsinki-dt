import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildItinerary, itineraryStopLabel, itineraryTime } from '../src/lib/itinerary.ts';
import { decodeHfp } from '../src/lib/data/hfp.ts';
import { serviceTimeToUtc } from '../src/lib/data/gtfs.ts';
import { railId, type RailEvent, type RailJourney, type RailResult } from '../src/lib/rail.ts';
import type { RouteContext } from '../src/lib/route-context.ts';
import type { Vehicle } from '../src/lib/types.ts';

const samples = JSON.parse(await readFile(new URL('./fixtures/hfp-samples.json', import.meta.url), 'utf8'));
const sample = samples[0];
const at = Date.parse(sample.payload.VP.tst);
const vehicle = { ...decodeHfp(sample.topic, sample.payload, sample.receivedAt), nextStopId: 'second', delaySeconds: 90 };
const time = (seconds: number) => new Date(at + seconds * 1000).toISOString();
const route: RouteContext = { status: 'exact', vehicleId: vehicle.id, routeId: vehicle.routeId, routeLabel: '9', destination: 'Destination',
  tripId: 'test', departureAt: time(-300), candidates: [], shape: [], reason: null, sourceId: 'hsl-gtfs', generatedAt: null, source: null,
  stops: ['origin', 'second', 'destination'].map((id, i) => ({ id, name: id, sequence: i + 1,
    longitude: i === 0 ? 26 : 24.952, latitude: 60.1695, arrivalAt: time((i - 1) * 120), departureAt: time((i - 1) * 120 + 10) })) };

test('HSL reports retain next-stop IDs, empty values and end-of-line without using payload stop proximity', () => {
  assert.equal(decodeHfp(sample.topic, sample.payload, sample.receivedAt).nextStopId, sample.topic.split('/')[13]);
  const fields = sample.topic.split('/');
  fields[13] = 'EOL'; assert.equal(decodeHfp(fields.join('/'), sample.payload, sample.receivedAt).nextStopId, 'EOL');
  fields[13] = ''; assert.equal(decodeHfp(fields.join('/'), sample.payload, sample.receivedAt).nextStopId, null);
  fields[13] = '<invalid>'; assert.throws(() => decodeHfp(fields.join('/'), sample.payload, sample.receivedAt));
});

test('HSL itinerary begins at full origin, uses next-stop progress and adjusts cumulative minutes with the signed delay', () => {
  for (const mode of ['tram', 'bus'] as const) {
    const list = buildItinerary({ ...vehicle, mode }, route, null, [], at);
    assert.deepEqual(list.stops.map(stop => stop.id), ['origin', 'second', 'destination']);
    assert.deepEqual(list.stops.map(stop => stop.state), ['visited', 'next', 'upcoming']);
    assert.deepEqual(list.stops.map(stop => stop.minutes), [null, 2, 4]);
    assert.equal(itineraryStopLabel(list.stops[1]), 'Next · 2 min · Estimated');
    const early = buildItinerary({ ...vehicle, delaySeconds: -60 }, route, null, [], at);
    assert.deepEqual(early.stops.map(stop => stop.minutes), [null, 0, 1]);
    const scheduled = buildItinerary({ ...vehicle, delaySeconds: null }, route, null, [], at);
    assert.equal(scheduled.stops[1].estimated, false);
    assert.match(itineraryStopLabel(scheduled.stops[2]), /Scheduled/);
  }
});

test('missing, ambiguous and repeated stop IDs never invent visited stops; EOL completes all visits', () => {
  const repeated = { ...route, stops: [...route.stops, { ...route.stops[1], sequence: 4 }] };
  for (const [nextStopId, context] of [[null, route], ['missing', route], ['second', repeated]] as const) {
    const list = buildItinerary({ ...vehicle, nextStopId }, context, null, [], at);
    assert.equal(list.progressKnown, false); assert.ok(list.stops.every(stop => stop.state === 'unknown'));
    assert.equal(new Set(list.stops.map(stop => stop.key)).size, list.stops.length);
  }
  assert.ok(buildItinerary({ ...vehicle, nextStopId: 'EOL' }, repeated, null, [], at).stops.every(stop => stop.state === 'visited'));
  for (const context of [null, { ...route, status: 'ambiguous' as const }, { ...route, vehicleId: 'other' }]) {
    assert.equal(buildItinerary(vehicle, context, null, [], at).stops.length, 0);
  }
});

test('stale or removed vehicles retain recorded progress but suppress arrival countdowns; missing times remain unavailable', () => {
  for (const list of [buildItinerary(vehicle, route, null, [], at + 30_000), buildItinerary(vehicle, route, null, [], at, true)]) {
    assert.equal(list.stale, true); assert.ok(list.stops.every(stop => stop.minutes === null)); assert.equal(list.stops[0].state, 'visited');
  }
  const missing = { ...route, stops: route.stops.map(stop => ({ ...stop, arrivalAt: null, departureAt: null })) };
  assert.match(itineraryStopLabel(buildItinerary(vehicle, missing, null, [], at).stops[1]), /Time unavailable/);
});

const event = (stationCode: string, type: RailEvent['type'], seconds: number, changes: Partial<RailEvent> = {}): RailEvent => ({
  stationCode, stationName: stationCode, type, scheduledAt: time(seconds), estimatedAt: null, actualAt: null,
  platform: '2', stopping: true, cancelled: false, commercial: true, ...changes });
const train: Vehicle = { ...vehicle, id: railId('2026-10-08', '23'), mode: 'train', nextStopId: undefined };
const journey: RailResult<RailJourney> = { state: 'ready', retrievedAt: time(0), error: null, data: {
  summary: { trainNumber: '23', departureDate: '2026-10-08', label: '23', category: 'commuter', trainType: 'HL', operator: 'vr',
    origin: 'HKI', destination: 'END', cancelled: false, nextEvent: null, timetableAt: time(0) },
  events: [event('HKI', 'DEPARTURE', -300, { actualAt: time(-280) }), event('MID', 'ARRIVAL', -100, { actualAt: time(-80) }),
    event('MID', 'DEPARTURE', -60, { actualAt: time(-40) }), event('SKIP', 'ARRIVAL', 60, { stopping: false }),
    event('HKI', 'ARRIVAL', 60, { estimatedAt: time(90) }), event('HKI', 'DEPARTURE', 80),
    event('CANCEL', 'ARRIVAL', 120, { cancelled: true }), event('END', 'ARRIVAL', 180)] } };

test('train arrival/departure pairs produce one row per visit with actual progress, station-code coordinates and supplied estimates', () => {
  const stations = [{ code: 'HKI', name: 'Helsinki', longitude: 24.952, latitude: 60.1695, passenger: true }];
  const list = buildItinerary(train, null, journey, stations, at);
  assert.deepEqual(list.stops.map(stop => stop.id), ['HKI', 'MID', 'HKI', 'CANCEL', 'END']);
  assert.deepEqual(list.stops.map(stop => stop.state), ['visited', 'visited', 'next', 'cancelled', 'upcoming']);
  assert.deepEqual(list.stops.map(stop => stop.minutes), [null, null, 2, null, 3]);
  assert.equal(list.stops[2].longitude, stations[0].longitude); assert.equal(list.stops[4].longitude, null);
  assert.equal(list.stops[2].estimated, true); assert.equal(list.stops[4].estimated, false);
  const arrived = structuredClone(journey); arrived.data!.events[4].actualAt = time(0);
  assert.equal(buildItinerary(train, null, arrived, stations, at).stops[2].state, 'current');
  const completed = structuredClone(journey); completed.data!.events.at(-1)!.actualAt = time(0);
  assert.equal(buildItinerary(train, null, completed, stations, at).stops.at(-1)!.state, 'visited');
});

test('trains without actual station reports distinguish elapsed timetable stops from confirmed visits', () => {
  const scheduled = structuredClone(journey);
  scheduled.data!.events.forEach(event => { event.actualAt = null; });
  const list = buildItinerary(train, null, scheduled, [], at);
  assert.deepEqual(list.stops.map(stop => stop.state), ['elapsed', 'elapsed', 'next', 'cancelled', 'upcoming']);
  assert.deepEqual(list.stops.map(stop => stop.minutes), [null, null, 2, null, 3]);
  assert.equal(list.progressKnown, false);
  assert.match(list.reason!, /actual station reports unavailable/);
  assert.equal(itineraryStopLabel(list.stops[0]), 'Scheduled earlier');
  scheduled.data!.events[0].estimatedAt = time(60);
  assert.equal(buildItinerary(train, null, scheduled, [], at).stops[0].state, 'next');
  const stale = buildItinerary(train, null, { ...scheduled, state: 'stale' }, [], at + 180_000);
  assert.equal(stale.stops[0].state, 'next');
  assert.ok(stale.stops.every(stop => stop.minutes === null));
});

test('cancelled and stale trains do not promise arrival countdowns, and foreign timetable identities are rejected', () => {
  const cancelled = structuredClone(journey); cancelled.data!.summary.cancelled = true;
  assert.ok(buildItinerary(train, null, cancelled, [], at).stops.every(stop => stop.state === 'cancelled' && stop.minutes === null));
  const stale = buildItinerary(train, null, { ...journey, state: 'stale' }, [], at);
  assert.ok(stale.stops.every(stop => stop.minutes === null));
  assert.equal(buildItinerary({ ...train, id: 'foreign' }, null, journey, [], at).stops.length, 0);
});

test('itinerary clocks use Helsinki time for overnight services and daylight-saving changes', () => {
  assert.equal(itineraryTime(serviceTimeToUtc('2026-10-08', 25 * 3600 + 10 * 60)), '01:10');
  assert.equal(itineraryTime('2026-10-25T00:30:00Z'), '03:30');
  assert.equal(itineraryTime('2026-10-25T01:30:00Z'), '03:30');
  assert.equal(itineraryTime(null), '—');
});
