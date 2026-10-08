import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeHfp, uniqueHfpReports, cadenceSeconds, latestHfpVehicles } from '../src/lib/data/hfp.ts';
import { matchJourney, readGtfsSnapshot, serviceIsActive, serviceSeconds, serviceTimeToUtc, type GtfsSnapshot } from '../src/lib/data/gtfs.ts';
import type { HfpRawSample } from '../scripts/transit.ts';

const samples: HfpRawSample[] = JSON.parse(await readFile(new URL('./fixtures/hfp-samples.json', import.meta.url), 'utf8'));
const fixtureFeed: GtfsSnapshot = JSON.parse(await readFile(new URL('./fixtures/gtfs-selected.json', import.meta.url), 'utf8'));
const tram = samples.find((sample) => sample.topic.includes('/tram/'))!;
const decode = (sample: HfpRawSample) => decodeHfp(sample.topic, sample.payload, sample.receivedAt);

test('real tram, bus and ferry samples preserve zero-padded owner/vehicle IDs and separate event times', () => {
  assert.deepEqual([...new Set(samples.map((sample) => decode(sample).mode))], ['tram', 'bus', 'ferry']);
  const vehicle = decode(tram);
  assert.equal(vehicle.id, '0040/00100');
  assert.equal(vehicle.ownerOperatorId, '0040');
  assert.equal(vehicle.vehicleId, '00100');
  assert.equal(vehicle.operatingOperatorId, '40');
  assert.equal(vehicle.reportedAt, (tram.payload as { VP: { tst: string } }).VP.tst);
  assert.notEqual(vehicle.reportedAt, vehicle.receivedAt);
  assert.equal(vehicle.journeyReference, String((tram.payload as { VP: { jrn: number } }).VP.jrn));
  const subcontracted = structuredClone(tram) as HfpRawSample & { payload: { VP: Record<string, unknown> } };
  subcontracted.payload.VP.oper = 99;
  assert.equal(decode(subcontracted).id, '0040/00100');
  assert.equal(decode(subcontracted).operatingOperatorId, '99');
});
test('HFP deviation sign and nulls are explicit; invalid numeric strings and topics are rejected', () => {
  const raw = structuredClone(tram) as HfpRawSample & { payload: { VP: Record<string, unknown> } };
  raw.payload.VP.dl = -45;
  assert.equal(decode(raw).delaySeconds, 45);
  raw.payload.VP.dl = 20;
  assert.equal(decode(raw).delaySeconds, -20);
  raw.payload.VP.dl = null; raw.payload.VP.lat = null; raw.payload.VP.long = null;
  assert.equal(decode(raw).delaySeconds, null);
  assert.deepEqual(decode(raw).quality, ['position-missing']);
  raw.payload.VP.spd = '2';
  assert.throws(() => decode(raw), /Invalid HFP spd/);
  assert.throws(() => decodeHfp('/other/topic', {}, raw.receivedAt), /topic/);
  assert.throws(() => decodeHfp(tram.topic, {}, raw.receivedAt), /Missing HFP VP/);
});
test('topic repeats do not create false cadence; out-of-order delivery does not move a snapshot backwards', () => {
  const first = decode(tram);
  const second = { ...first, reportedAt: new Date(Date.parse(first.reportedAt) + 1000).toISOString() };
  assert.equal(uniqueHfpReports([first, first, second]).length, 2);
  assert.deepEqual(cadenceSeconds([second, first, first]), [1]);
  assert.deepEqual(latestHfpVehicles([second, first]), [second]);
});
test('real GTFS trip is matched by ID, direction, calendar and departure; ambiguity remains unknown', () => {
  const vehicle = decode(tram);
  const match = matchJourney(vehicle, fixtureFeed);
  assert.equal(match.status, 'exact');
  assert.equal(match.tripId, '1009_20261007_To_1_1327');
  assert.equal(match.firstStopId, '1203416');
  assert.equal(match.departureAt, '2026-10-08T10:27:00.000Z');
  assert.equal(matchJourney({ ...vehicle, directionId: '2' }, fixtureFeed).status, 'missing');
  assert.equal(matchJourney({ ...vehicle, routeId: 'a label' }, fixtureFeed).tripId, null);
  const duplicate = structuredClone(fixtureFeed);
  duplicate.trips.push({ ...duplicate.trips[0], trip_id: 'second-trip' });
  duplicate.firstStops.push({ ...duplicate.firstStops[0], trip_id: 'second-trip' });
  const ambiguous = matchJourney(vehicle, duplicate);
  assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.tripId, null);
});
test('calendar additions/removals override weekdays, and malformed service dates fail', () => {
  const calendar = [{ service_id: 's', start_date: '20261001', end_date: '20261031', thursday: '1', friday: '0' }];
  assert.equal(serviceIsActive('s', '2026-10-08', calendar, []), true);
  assert.equal(serviceIsActive('s', '2026-10-08', calendar, [{ service_id: 's', date: '20261008', exception_type: '2' }]), false);
  assert.equal(serviceIsActive('s', '2026-10-09', calendar, [{ service_id: 's', date: '20261009', exception_type: '1' }]), true);
  assert.throws(() => serviceIsActive('s', '2026-02-30', calendar, []), /service date/);
});
test('GTFS extended hours use Helsinki service dates and local noon-minus-12 on both DST changes', () => {
  assert.equal(serviceSeconds('25:30:00'), 91800);
  assert.equal(serviceTimeToUtc('2026-10-08', serviceSeconds('25:30:00')), '2026-10-08T22:30:00.000Z');
  assert.equal(serviceTimeToUtc('2026-03-29', 0), '2026-03-28T21:00:00.000Z');
  assert.equal(serviceTimeToUtc('2026-10-25', 0), '2026-10-24T22:00:00.000Z');
  assert.throws(() => serviceSeconds('24:70:00'), /clock/);
  const extended = structuredClone(fixtureFeed);
  extended.firstStops[0].departure_time = '25:30:00';
  assert.equal(matchJourney({ ...decode(tram), startTime: '01:30' }, extended).status, 'exact');
});
test('journey matching uses the resulting Helsinki clock on both DST transitions', () => {
  for (const [date, departure, clock, instant] of [
    ['2026-03-29', '03:00:20', '02:00', '2026-03-29T00:00:20.000Z'],
    ['2026-10-25', '02:00:20', '03:00', '2026-10-25T00:00:20.000Z'],
  ]) {
    const feed = structuredClone(fixtureFeed);
    feed.calendarDates = [{service_id: feed.trips[0].service_id, date: date.replaceAll('-', ''), exception_type: '1'}];
    feed.firstStops[0].departure_time = departure;
    const vehicle = {...decode(tram), serviceDate: date, startTime: clock};
    assert.equal(matchJourney(vehicle, feed).status, 'exact');
    assert.equal(matchJourney(vehicle, feed).departureAt, instant);
    assert.equal(matchJourney({...vehicle, startTime: departure.slice(0, 5)}, feed).status, 'missing');
  }
});
test('competing departures with the same Helsinki clock remain ambiguous across the repeated DST hour', () => {
  const feed = structuredClone(fixtureFeed);
  feed.calendarDates = [{service_id: feed.trips[0].service_id, date: '20261025', exception_type: '1'}];
  feed.firstStops[0].departure_time = '02:00:00';
  feed.trips.push({...feed.trips[0], trip_id: 'repeated-hour'});
  feed.firstStops.push({...feed.firstStops[0], trip_id: 'repeated-hour', departure_time: '03:00:00'});
  const match = matchJourney({...decode(tram), serviceDate: '2026-10-25', startTime: '03:00'}, feed);
  assert.equal(match.status, 'ambiguous');
  assert.deepEqual(match.candidates, [feed.trips[0].trip_id, 'repeated-hour'].sort());
  assert.equal(match.tripId, null);
  assert.equal(match.departureAt, null);
});
test('streamed ZIP/CSV reads the attributed route subset and rejects malformed archives', async () => {
  const snapshot = await readGtfsSnapshot(new URL('./fixtures/gtfs-selected.zip', import.meta.url).pathname, '1009', '2026-10-08');
  assert.equal(snapshot.trips.length, 1);
  assert.equal(snapshot.firstStops[0].stop_id, '1203416');
  assert.equal(matchJourney(decode(tram), snapshot).status, 'exact');
  const directory = await mkdtemp(join(tmpdir(), 'helsinki-gtfs-'));
  try { const file = join(directory, 'bad.zip'); await writeFile(file, 'HTTP 200 is not a GTFS archive'); await assert.rejects(readGtfsSnapshot(file, '1009', '2026-10-08')); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test('MQTT source errors use a failed status and retain the provider diagnostic', () => {
  const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import { mock } from 'node:test';
    import { EventEmitter } from 'node:events';
    mock.module('mqtt', {exports: {default: {connect() {
      const client = new EventEmitter();
      client.end = () => {};
      queueMicrotask(() => client.emit('error', new Error('connack timeout')));
      return client;
    }}}});
    const { probeTransit } = await import('./scripts/transit.ts');
    const result = await probeTransit(1000);
    console.log(JSON.stringify(result.evidence));
  `], {cwd: new URL('../', import.meta.url), encoding: 'utf8'});
  const entries = JSON.parse(output);
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.equal(entry.status, 'failed');
    assert.ok(entry.notes.includes('connack timeout'));
  }
});
