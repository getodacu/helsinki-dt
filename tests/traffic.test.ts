import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { TrafficFeed, TRAFFIC_TOPICS, type TrafficConnection } from '../src/lib/server/traffic.ts';
import { createTrafficResponse } from '../src/lib/server/traffic-stream.ts';
import { TRAFFIC_IDLE_MS, TRAFFIC_MAX_VEHICLES, TRAFFIC_MAX_QUEUE_BYTES, TRAFFIC_REMOVE_MS, TRAFFIC_STALE_MS,
  trafficAge, trafficIsStale, type TrafficEvent } from '../src/lib/traffic.ts';

const source = JSON.parse(await readFile(new URL('./fixtures/hfp-samples.json', import.meta.url), 'utf8')) as {
  topic: string; payload: { VP: Record<string, unknown> }; receivedAt: string
}[];
const NOW = Date.parse('2026-10-08T12:00:00Z');

class Broker extends EventEmitter {
  subscriptions: string[] = [];
  ended = false;
  subscriptionError: Error | null = null;
  subscribe(topics: string[], _options: { qos: number }, done: (error: Error | null, granted: { topic: string; qos: number }[]) => void) {
    this.subscriptions = topics;
    done(this.subscriptionError, topics.map(topic => ({ topic, qos: 0 })));
  }
  end() { this.ended = true; this.emit('close'); }
  report(mode = 'tram', index = 0, changes: Record<string, unknown> = {}, time = Date.now()) {
    const sample = source.find(sample => sample.topic.includes(`/${mode}/`))!;
    const fields = sample.topic.split('/');
    fields[8] = String(index).padStart(5, '0');
    this.emit('message', fields.join('/'), Buffer.from(JSON.stringify({ VP: { ...sample.payload.VP,
      tst: new Date(time).toISOString(), ...changes } })));
  }
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
  const brokers: Broker[] = [];
  const feed = new TrafficFeed(() => { const broker = new Broker(); brokers.push(broker); return broker as unknown as TrafficConnection; });
  t.after(() => feed.close());
  return { feed, brokers };
}

function updates(events: TrafficEvent[]) { return events.filter(event => event.type === 'update'); }

test('two consumers share one upstream; idle grace, reuse, release idempotency and timer cleanup', t => {
  const { feed, brokers } = setup(t);
  const first: TrafficEvent[] = [], second: TrafficEvent[] = [];
  const release1 = feed.subscribe(event => first.push(event));
  const release2 = feed.subscribe(event => second.push(event));
  assert.equal(brokers.length, 1);
  assert.equal(first[0].type, 'snapshot');
  assert.equal(first[0].status.state, 'connecting');
  brokers[0].emit('connect');
  assert.deepEqual(brokers[0].subscriptions, TRAFFIC_TOPICS);
  assert.equal(TRAFFIC_TOPICS.length, 6);
  assert.ok(TRAFFIC_TOPICS.some(topic => topic.includes('/ferry/') && topic.endsWith('/60;24/19/#')));
  assert.ok(TRAFFIC_TOPICS.some(topic => topic.includes('/ferry/') && topic.endsWith('/60;25/10/#')));
  brokers[0].report();
  t.mock.timers.tick(1_000);
  assert.equal(updates(first)[0].vehicles[0].id, '0040/00000');
  assert.deepEqual(first, second);
  release1(); release1();
  assert.equal(feed.diagnostics().subscribers, 1);
  release2();
  t.mock.timers.tick(TRAFFIC_IDLE_MS - 1);
  assert.equal(brokers[0].ended, false);
  const release3 = feed.subscribe(() => {});
  assert.equal(brokers.length, 1);
  release3();
  t.mock.timers.tick(TRAFFIC_IDLE_MS);
  assert.equal(brokers[0].ended, true);
  assert.equal(feed.diagnostics().timers, 0);
  assert.equal(feed.diagnostics().upstreamConnections, 0);
  assert.equal(feed.diagnostics().vehicles, 0);
  assert.equal(feed.snapshot().status.state, 'idle');
});

test('freshness uses position time; duplicate, out-of-order and metadata-only reports do not refresh it', t => {
  const { feed, brokers } = setup(t);
  const events: TrafficEvent[] = [];
  feed.subscribe(event => events.push(event)); brokers[0].emit('connect');
  brokers[0].report('tram', 1, { dl: -45, oper: 99 });
  brokers[0].report('bus', 1);
  brokers[0].report('ferry', 1);
  brokers[0].report('tram', 1, { dl: 50 });
  brokers[0].report('tram', 1, {}, NOW - 1);
  assert.equal(feed.snapshot().vehicles.length, 3);
  const vehicle = feed.snapshot().vehicles.find(vehicle => vehicle.mode === 'tram')!;
  assert.equal(vehicle.ownerOperatorId, '0040');
  assert.equal(vehicle.vehicleId, '00001');
  assert.equal(vehicle.operatingOperatorId, '99');
  assert.equal(vehicle.delaySeconds, 45);
  t.mock.timers.tick(TRAFFIC_STALE_MS - 1);
  assert.equal(trafficIsStale(vehicle), false);
  t.mock.timers.tick(1);
  assert.equal(trafficIsStale(vehicle), true);
  brokers[0].report('tram', 1, { lat: null, long: null, dl: 0 });
  assert.equal(feed.snapshot().vehicles.find(vehicle => vehicle.mode === 'tram')!.reportedAt, vehicle.reportedAt);
  assert.equal(feed.snapshot().status.lastPositionAt, vehicle.reportedAt);
  assert.equal(trafficAge(vehicle), TRAFFIC_STALE_MS);
  t.mock.timers.tick(TRAFFIC_REMOVE_MS - TRAFFIC_STALE_MS);
  assert.equal(feed.snapshot().vehicles.length, 0);
  const last = updates(events).at(-1)!;
  assert.deepEqual(new Set(last.removed), new Set(['0040/00001', '0022/00001', '0060/00001']));
  assert.equal(feed.diagnostics().identities, 0);
  assert.equal(feed.diagnostics().duplicates, 2);
});

test('malformed, null, zero/out-of-region, impossible and future source values are rejected', t => {
  const { feed, brokers } = setup(t);
  feed.subscribe(() => {}); brokers[0].emit('connect');
  brokers[0].emit('message', '/other', Buffer.from('{}'));
  brokers[0].emit('message', source[0].topic, Buffer.from('not JSON'));
  brokers[0].emit('message', source[0].topic, Buffer.alloc(33 * 1024));
  for (const changes of [{ lat: 0, long: 0 }, { lat: null }, { spd: '2' }, { spd: -1 },
    { hdg: 361 }, { dl: 'Infinity' }, { dl: 86_401 }, { long: 181 }, { tst: '2026-10-08T12:00:00' },
    { tst: new Date(NOW + 5_001).toISOString() }, { tst: new Date(NOW - TRAFFIC_REMOVE_MS).toISOString() }]) {
    brokers[0].report('tram', 1, changes);
  }
  assert.equal(feed.snapshot().vehicles.length, 0);
  assert.equal(feed.snapshot().status.lastPositionAt, null);
  assert.equal(feed.diagnostics().rejected, 13);
  brokers[0].report('bus', 2, { spd: 0, hdg: 0, dl: 0 });
  assert.equal(feed.snapshot().vehicles[0].speedMetresPerSecond, 0);
  assert.equal(feed.snapshot().vehicles[0].headingDegrees, 0);
  assert.equal(feed.snapshot().vehicles[0].rawDeviationSeconds, 0);
});

test('scope exits remove immediately and keep a bounded watermark to prevent older reappearance', t => {
  const { feed, brokers } = setup(t);
  const events: TrafficEvent[] = [];
  feed.subscribe(event => events.push(event)); brokers[0].emit('connect');
  brokers[0].report('ferry', 1);
  t.mock.timers.tick(1_000);
  brokers[0].report('ferry', 1, { long: 25.1 });
  brokers[0].report('ferry', 1, {}, NOW);
  t.mock.timers.tick(1_000);
  assert.equal(feed.snapshot().vehicles.length, 0);
  assert.deepEqual(updates(events).at(-1)!.removed, ['0060/00001']);
  assert.equal(feed.diagnostics().identities, 1);
  brokers[0].report('ferry', 1, { long: 25.03 });
  t.mock.timers.tick(1_000);
  assert.equal(feed.snapshot().vehicles[0].longitude, 25.03);
});

test('coalescing delivers latest state within one second and keeps the fleet/watermarks bounded', t => {
  const { feed, brokers } = setup(t);
  const events: TrafficEvent[] = [];
  feed.subscribe(event => events.push(event)); brokers[0].emit('connect');
  for (let index = 0; index <= TRAFFIC_MAX_VEHICLES; index++) brokers[0].report('tram', index);
  assert.equal(feed.diagnostics().vehicles, TRAFFIC_MAX_VEHICLES);
  assert.equal(feed.diagnostics().identities, TRAFFIC_MAX_VEHICLES);
  assert.equal(feed.diagnostics().capacityDrops, 1);
  assert.equal(updates(events).length, 0);
  t.mock.timers.tick(999);
  brokers[0].report('tram', 0, { long: 24.96 });
  t.mock.timers.tick(1);
  const event = updates(events)[0];
  assert.equal(event.vehicles.length, TRAFFIC_MAX_VEHICLES);
  assert.equal(event.vehicles.find(vehicle => vehicle.id === '0040/00000')!.longitude, 24.96);
  const latency = Date.parse(event.generatedAt) - Date.parse(event.vehicles.at(-1)!.receivedAt);
  assert.ok(latency <= 1_000);
  assert.equal(feed.diagnostics().pendingVehicles, 0);
});

test('disconnection publishes status, retries with bounded backoff and reconnect sends a full snapshot', t => {
  const { feed, brokers } = setup(t);
  const events: TrafficEvent[] = [];
  feed.subscribe(event => events.push(event)); brokers[0].emit('connect'); brokers[0].report();
  t.mock.timers.tick(1_000);
  const lastPosition = feed.snapshot().status.lastPositionAt;
  brokers[0].emit('close');
  assert.equal(feed.snapshot().status.state, 'reconnecting');
  assert.equal(feed.snapshot().status.lastPositionAt, lastPosition);
  t.mock.timers.tick(1_000);
  assert.equal(brokers.length, 2);
  assert.equal(updates(events).at(-1)!.status.state, 'reconnecting');
  brokers[1].emit('error', new Error('unavailable'));
  t.mock.timers.tick(1_999); assert.equal(brokers.length, 2);
  t.mock.timers.tick(1); assert.equal(brokers.length, 3);
  brokers[2].emit('connect');
  const restored = events.at(-1)!;
  assert.equal(restored.type, 'snapshot');
  assert.equal(restored.status.state, 'live');
  assert.equal(restored.vehicles.length, 1);
  assert.equal(restored.vehicles[0].reportedAt, lastPosition);
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    brokers.at(-1)!.emit('error', new Error('unavailable'));
    const count: number = brokers.length;
    t.mock.timers.tick(delay - 1); assert.equal(brokers.length, count);
    t.mock.timers.tick(1); assert.equal(brokers.length, count + 1);
  }
  feed.close();
  assert.equal(feed.diagnostics().timers, 0);
  assert.equal(feed.diagnostics().consumers, 0);
  const count: number = brokers.length;
  t.mock.timers.tick(60_000); assert.equal(brokers.length, count);
});

test('connection/subscribe failures retry; throwing subscribers clean up and cannot disrupt others', t => {
  const { feed, brokers } = setup(t);
  feed.subscribe(() => { throw new Error('gone'); });
  assert.equal(feed.diagnostics().consumers, 0);
  const events: TrafficEvent[] = [];
  feed.subscribe(event => events.push(event));
  brokers[0].subscriptionError = new Error('subscription rejected');
  brokers[0].emit('connect');
  assert.equal(feed.snapshot().status.state, 'reconnecting');
  t.mock.timers.tick(1_000); brokers[1].emit('connect');
  assert.equal(events.at(-1)!.status.state, 'live');
});

test('SSE snapshot, update, heartbeat, request abort and reader cancellation release both clients', async t => {
  const { feed, brokers } = setup(t);
  const abort = new AbortController();
  const response1 = createTrafficResponse(new Request('http://localhost/api/traffic/stream', { signal: abort.signal }), feed);
  const response2 = createTrafficResponse(new Request('http://localhost/api/traffic/stream'), feed);
  assert.equal(response1.headers.get('x-accel-buffering'), 'no');
  assert.equal(response1.headers.get('cache-control'), 'no-store, no-transform');
  const reader1 = response1.body!.getReader();
  const reader2 = response2.body!.getReader();
  const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
  assert.match(text((await reader1.read()).value), /^event: snapshot\ndata:/);
  await reader2.read();
  brokers[0].emit('connect');
  await reader1.read(); await reader2.read();
  brokers[0].report('ferry'); t.mock.timers.tick(1_000);
  assert.match(text((await reader1.read()).value), /^event: update\ndata:/);
  await reader2.read();
  t.mock.timers.tick(14_000);
  assert.equal(text((await reader1.read()).value), ': heartbeat\n\n');
  await reader2.read();
  assert.equal(brokers.length, 1);
  abort.abort();
  assert.equal((await reader1.read()).done, true);
  assert.equal(feed.diagnostics().subscribers, 1);
  await reader2.cancel();
  t.mock.timers.tick(TRAFFIC_IDLE_MS);
  assert.equal(feed.diagnostics().subscribers, 0);
  assert.equal(feed.diagnostics().upstreamConnections, 0);
  assert.equal(feed.diagnostics().timers, 0);
});

test('bounded slow SSE buffering closes that subscriber while a reading subscriber keeps receiving', async t => {
  const { feed, brokers } = setup(t);
  const slow = createTrafficResponse(new Request('http://localhost/api/traffic/stream'), feed);
  const fast = createTrafficResponse(new Request('http://localhost/api/traffic/stream'), feed);
  const reader = fast.body!.getReader();
  await reader.read(); brokers[0].emit('connect'); await reader.read();
  for (let turn = 0; turn < 32 && feed.diagnostics().subscribers > 1; turn++) {
    for (let id = 0; id < TRAFFIC_MAX_VEHICLES; id++) brokers[0].report('tram', id);
    t.mock.timers.tick(1_000);
    let chunk = await reader.read();
    while (new TextDecoder().decode(chunk.value).startsWith(':')) chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /^event: update/);
  }
  assert.equal(feed.diagnostics().subscribers, 1);
  assert.equal(feed.diagnostics().vehicles, TRAFFIC_MAX_VEHICLES);
  assert.equal(feed.diagnostics().pendingVehicles, 0);
  await slow.body!.cancel(); await reader.cancel();
  t.mock.timers.tick(TRAFFIC_IDLE_MS);
  assert.equal(feed.diagnostics().timers, 0);
});

test('already aborted request creates no demand or heartbeat timer', t => {
  const { feed, brokers } = setup(t);
  const abort = new AbortController(); abort.abort();
  createTrafficResponse(new Request('http://localhost/api/traffic/stream', { signal: abort.signal }), feed);
  assert.equal(brokers.length, 0);
  assert.equal(feed.diagnostics().timers, 0);
});


test('closing direct snapshot demand invalidates its release and connector throws use retry timers', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
  let attempts = 0;
  const feed = new TrafficFeed(() => { attempts++; throw new Error('connect failed'); });
  const release = feed.acquire();
  assert.equal(feed.snapshot().status.state, 'reconnecting');
  t.mock.timers.tick(1_000); assert.equal(attempts, 2);
  t.mock.timers.tick(2_000); assert.equal(attempts, 3);
  feed.close(); release();
  assert.equal(feed.diagnostics().consumers, 0);
  assert.equal(feed.diagnostics().timers, 0);
  t.mock.timers.tick(60_000); assert.equal(attempts, 3);
});


test('subscribing the same callback twice retains two independent lifetimes', t => {
  const { feed, brokers } = setup(t);
  const events: TrafficEvent[] = [];
  const listener = (event: TrafficEvent) => events.push(event);
  const release1 = feed.subscribe(listener);
  const release2 = feed.subscribe(listener);
  assert.equal(feed.diagnostics().subscribers, 2);
  release1();
  brokers[0].emit('connect');
  assert.equal(feed.diagnostics().subscribers, 1);
  assert.equal(events.length, 3);
  release2(); t.mock.timers.tick(TRAFFIC_IDLE_MS);
  assert.equal(feed.diagnostics().timers, 0);
});


test('HSL outage retains stale positions, expires at 120 seconds and recovery replaces both SSE clients', async t => {
  const { feed, brokers } = setup(t);
  const responses = [0, 1].map(() => createTrafficResponse(new Request('http://localhost/api/traffic/stream'), feed));
  const readers = responses.map(response => response.body!.getReader());
  const frame = async () => Promise.all(readers.map(async reader => JSON.parse(new TextDecoder().decode((await reader.read()).value).split('data: ')[1]) as TrafficEvent));
  await frame(); brokers[0].emit('connect'); await frame();
  brokers[0].report('tram', 4); t.mock.timers.tick(1_000);
  const [first, second] = await frame(); assert.deepEqual(first, second);
  const vehicle = first.vehicles[0]; brokers[0].emit('close');
  t.mock.timers.tick(TRAFFIC_STALE_MS - 1_000);
  assert.equal(trafficIsStale(feed.snapshot().vehicles[0]), true);
  assert.equal(feed.snapshot().vehicles[0].reportedAt, vehicle.reportedAt);
  assert.equal(feed.snapshot().status.state, 'reconnecting');
  t.mock.timers.tick(TRAFFIC_REMOVE_MS - TRAFFIC_STALE_MS);
  assert.equal(feed.snapshot().vehicles.length, 0); assert.equal(feed.diagnostics().identities, 0);
  assert.equal(feed.diagnostics().upstreamConnections, 1); assert.equal(feed.diagnostics().pendingVehicles, 0);
  brokers.at(-1)!.emit('connect');
  brokers.at(-1)!.report('tram', 4); t.mock.timers.tick(1_000);
  const restored = feed.snapshot(); assert.equal(restored.status.state, 'live');
  assert.equal(restored.vehicles.length, 1); assert.notEqual(restored.vehicles[0].reportedAt, vehicle.reportedAt);
  // Recovery reaches each bounded SSE stream; no expired coordinate is synthesized.
  for (const reader of readers) {
    let recovered: TrafficEvent | null = null;
    for (let count = 0; count < 20 && !recovered; count++) {
      const text = new TextDecoder().decode((await reader.read()).value);
      const data = text.split('data: ')[1]; if (!data) continue;
      const event = JSON.parse(data) as TrafficEvent;
      if (event.type === 'update' && event.status.state === 'live' && event.vehicles.length) recovered = event;
    }
    assert.deepEqual(recovered?.vehicles, restored.vehicles);
    await reader.cancel();
  }
  t.mock.timers.tick(TRAFFIC_IDLE_MS); assert.equal(feed.diagnostics().timers, 0);
});

test('two clients share rail polling, provider outages are independent and reconnect snapshots include trains', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
  const { RailFeed } = await import('../src/lib/server/rail-feed.ts');
  const { decodeRailJourney } = await import('../src/lib/data/rail.ts');
  let railCalls = 0, railOffline = false;
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const rail = new RailFeed(async () => {
    railCalls++; if (railOffline) throw new Error('rail offline');
    return [{ trainNumber: 23, departureDate: '2026-10-08', timestamp: new Date(Date.now()).toISOString(), speed: 72, location: { type: 'Point', coordinates: [24.94, 60.19] } }];
  }, { train: async () => ({ state: 'ready', data: decodeRailJourney({ trainNumber: 23, departureDate: '2026-10-08', timeTableRows: [], trainType: 'IC', trainCategory: 'Long-distance' }, [], new Date().toISOString()), retrievedAt: new Date().toISOString(), error: null }) });
  const brokers: Broker[] = [];
  const feed = new TrafficFeed(() => { const broker = new Broker(); brokers.push(broker); return broker as unknown as TrafficConnection; }, rail);
  t.after(() => feed.close());
  const first: TrafficEvent[] = [], second: TrafficEvent[] = [];
  const release1 = feed.subscribe(event => first.push(event)), release2 = feed.subscribe(event => second.push(event));
  brokers[0].emit('connect'); brokers[0].report(); await settle(); t.mock.timers.tick(1000);
  assert.equal(railCalls, 1); assert.equal(feed.snapshot().vehicles.length, 2); assert.equal(feed.snapshot().sources?.rail.state, 'live');
  railOffline = true; t.mock.timers.tick(4000); await settle();
  assert.equal(feed.snapshot().sources?.rail.state, 'reconnecting'); assert.equal(feed.snapshot().sources?.hsl.state, 'live'); assert.equal(feed.snapshot().vehicles.length, 2);
  railOffline = false; brokers[0].emit('error', new Error('hsl offline')); t.mock.timers.tick(5000); await settle();
  assert.equal(feed.snapshot().sources?.hsl.state, 'reconnecting'); assert.equal(feed.snapshot().sources?.rail.state, 'live'); assert.equal(feed.snapshot().vehicles.length, 2);
  const snapshots: TrafficEvent[] = []; const release3 = feed.subscribe(event => snapshots.push(event));
  assert.equal(snapshots[0].type, 'snapshot'); assert.equal(snapshots[0].vehicles.filter(vehicle => vehicle.mode === 'train').length, 1);
  release1(); release2(); release3(); t.mock.timers.tick(TRAFFIC_IDLE_MS); await settle();
  const before = railCalls; t.mock.timers.tick(120_000); await settle(); assert.equal(railCalls, before); assert.equal(feed.snapshot().vehicles.length, 0); assert.equal(feed.diagnostics().timers, 0);
});

test('a maximum combined provider snapshot fits the bounded SSE queue', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
  const { decodeRailPosition } = await import('../src/lib/data/rail.ts');
  const vehicles = Array.from({ length: 2000 }, (_, i) => {
    const vehicle = decodeRailPosition({ trainNumber: i + 1, departureDate: '2026-10-08', timestamp: new Date(NOW).toISOString(), location: { type: 'Point', coordinates: [24.94, 60.19] } }, new Date(NOW).toISOString());
    vehicle.rail = { ...vehicle.rail!, origin: 'a'.repeat(200), destination: 'b'.repeat(200), label: 'c'.repeat(36), operator: 'd'.repeat(60), trainType: 'e'.repeat(30),
      nextEvent: { stationCode: 'HKI', stationName: 'f'.repeat(200), type: 'DEPARTURE', scheduledAt: new Date(NOW).toISOString(), estimatedAt: new Date(NOW).toISOString(), actualAt: null, platform: 'g'.repeat(30), cancelled: false, commercial: true, stopping: true } };
    return vehicle;
  });
  const rail = { start(listener: (value: import('../src/lib/server/rail-feed.ts').RailFeedUpdate) => void) { listener({ vehicles, status: { state: 'live', connectedAt: null, lastPositionAt: null, retryAt: null } }); }, stop() {} };
  const broker = new Broker(), feed = new TrafficFeed(() => broker as unknown as TrafficConnection, rail); t.after(() => feed.close());
  const release = feed.acquire(); broker.emit('connect'); for (let i = 0; i < TRAFFIC_MAX_VEHICLES; i++) broker.report('tram', i);
  const response = createTrafficResponse(new Request('http://localhost/api/traffic/stream'), feed), reader = response.body!.getReader();
  const first = await reader.read(); assert.equal(first.done, false); assert.ok(first.value!.byteLength < TRAFFIC_MAX_QUEUE_BYTES);
  const snapshot = JSON.parse(new TextDecoder().decode(first.value).split('\ndata: ')[1].trim()); assert.equal(snapshot.vehicles.length, 3000);
  await reader.cancel(); release(); t.mock.timers.tick(TRAFFIC_IDLE_MS); assert.equal(feed.diagnostics().timers, 0);
});
