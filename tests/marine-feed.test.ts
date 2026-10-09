import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MarineFeed, MARINE_TOPICS, MARINE_LIMITS, type MarineConnection, type MarineFeedUpdate, type FetchMarine } from '../src/lib/server/marine-feed.ts';
import { UpstreamHttpError, type RequestOptions } from '../src/lib/server/io.ts';
const NOW = Date.parse('2026-10-09T12:00:00Z');
const MMSI = '230123456';
const iso = (at = NOW) => new Date(at).toISOString();
const rest = (mmsi = MMSI, at = NOW, changes: Record<string, unknown> = {}, longitude = 24.94) => ({
  type: 'Feature', mmsi: Number(mmsi), geometry: { type: 'Point', coordinates: [longitude, 60.18] },
  properties: { mmsi: Number(mmsi), timestampExternal: at, timestamp: 20, sog: 0, cog: 360, heading: 511, navStat: 5, ...changes } });
const body = (features: unknown[] = []) => ({ body: JSON.stringify({ type: 'FeatureCollection', features }) });
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Clock {
  now = NOW; id = 0; tasks = new Map<number, { at: number; callback: () => void }>();
  schedule = (callback: () => void, delay: number) => { const id = ++this.id; this.tasks.set(id, { at: this.now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; };
  cancel = (timer: ReturnType<typeof setTimeout>) => { this.tasks.delete(timer as unknown as number); };
  advance(ms: number) { const end = this.now + ms;
    for (;;) { const next = [...this.tasks].sort((a,b) => a[1].at - b[1].at).find(([, task]) => task.at <= end);
      if (!next) break; this.tasks.delete(next[0]); this.now = next[1].at; next[1].callback(); }
    this.now = end;
  }
}
class Broker extends EventEmitter {
  ended = false; subscriptions: string[] = []; subscriptionError: Error | null = null; denied = false; autoSubscribe = true;
  done: (() => void) | null = null;
  subscribe(topics: string[], _options: unknown, done: (error: Error | null, granted: { topic: string; qos: number }[]) => void) {
    this.subscriptions = topics; this.done = () => done(this.subscriptionError, topics.map(topic => ({ topic, qos: this.denied ? 128 : 0 })));
    if (this.autoSubscribe) this.done();
  }
  end() { this.ended = true; this.emit('close'); }
  report(at = NOW, changes: Record<string, unknown> = {}, mmsi = MMSI) {
    this.emit('message', `vessels-v2/${mmsi}/location`, Buffer.from(JSON.stringify({ time: at / 1_000, lon: 24.94, lat: 60.18, sog: 0, cog: 360, heading: 511, navStat: 5, ...changes })));
  }
  metadata(at = NOW, name = 'Ship', mmsi = MMSI) { this.emit('message', `vessels-v2/${mmsi}/metadata`, Buffer.from(JSON.stringify({ timestamp: at, name, type: 70 }))); }
  status(at = NOW) { this.emit('message', 'vessels-v2/status', Buffer.from(JSON.stringify({ updated: at / 1_000 }))); }
}
function setup(t: TestContext, fetcher: FetchMarine = async url => url.includes('/locations?') ? body() : { body: 'null' }) {
  const clock = new Clock(), brokers: Broker[] = [], events: MarineFeedUpdate[] = [];
  const feed = new MarineFeed({ connector: () => { const broker = new Broker(); brokers.push(broker); return broker as unknown as MarineConnection; },
    fetcher, now: () => clock.now, random: () => 0, schedule: clock.schedule, cancel: clock.cancel });
  t.after(() => feed.stop()); feed.start(update => events.push(update)); return { feed, clock, brokers, events };
}

test('independent startup merges late REST after MQTT without rolling back, and keeps untouched references', async t => {
  const pending = deferred<{body:string}>(); const { feed, brokers } = setup(t, async url => url.includes('/locations?') ? pending.promise : { body: 'null' });
  brokers[0].emit('connect'); brokers[0].report(NOW, { lon: 24.94001 });
  const initial = feed.snapshot().vehicles[0]; assert.ok(initial); assert.equal(initial.marine?.name, null);
  pending.resolve(body([rest(MMSI, NOW - 1_000), rest('230123457')])); await settle();
  assert.equal(feed.snapshot().vehicles.find(v => v.id === initial.id), initial);
  assert.equal(feed.snapshot().status.lastSnapshotAt, iso()); assert.deepEqual(brokers[0].subscriptions, MARINE_TOPICS);
  brokers[0].status(); assert.equal(feed.snapshot().vehicles.find(v => v.id === initial.id), initial);
});

test('REST-first startup gets superseded by later MQTT; same-second REST precision and conflicts snap', async t => {
  const { feed, brokers, clock } = setup(t, async url => url.includes('/locations?') ? body([rest(MMSI, NOW + 200)]) : {body:'null'});
  await settle(); const first = feed.snapshot().vehicles[0]; brokers[0].emit('connect');
  brokers[0].report(NOW, { lon: 24.950 }); assert.equal(feed.snapshot().vehicles[0], first);
  clock.advance(1_000); brokers[0].report(clock.now, { lon: 24.9401 });
  assert.equal(feed.snapshot().vehicles[0].marine?.positionSource, 'mqtt');
  const latest = feed.snapshot().vehicles[0]; brokers[0].report(clock.now); assert.equal(feed.snapshot().vehicles[0], latest);
  assert.equal(feed.diagnostics().conflicts, 1);
  const pending = deferred<{body:string}>(); const next = setup(t, async url => url.includes('/locations?') ? pending.promise : {body:'null'});
  next.brokers[0].emit('connect'); next.brokers[0].report(NOW);
  pending.resolve(body([rest(MMSI, NOW + 500, {}, 24.950)])); await settle();
  assert.equal(next.feed.snapshot().vehicles[0].reportedAt, iso(NOW + 500));
  assert.ok(next.feed.snapshot().vehicles[0].quality.includes('position-same-second-conflict'));
});

test('REST failure leaves live MQTT and MQTT failure leaves successful empty periodic coverage', async t => {
  const live = setup(t, async () => { throw new Error('REST failed'); });
  live.brokers[0].emit('connect'); live.brokers[0].report(); await settle();
  assert.equal(live.feed.snapshot().vehicles.length, 1); assert.equal(live.feed.snapshot().status.state, 'live');
  const periodic = setup(t); periodic.brokers[0].emit('error', new Error('socket failed')); await settle();
  assert.equal(periodic.feed.snapshot().vehicles.length, 0); assert.equal(periodic.feed.snapshot().status.periodic, true);
  assert.equal(periodic.feed.snapshot().status.lastSnapshotAt, iso()); assert.equal(periodic.feed.snapshot().status.stale, false);
});

test('failed subscription ignores retained pre-subscription messages and follows 15/30/60 retry attempts once', async t => {
  const { feed, brokers, clock } = setup(t); brokers[0].autoSubscribe = false; brokers[0].emit('connect');
  brokers[0].report(); assert.equal(feed.snapshot().vehicles.length, 0);
  brokers[0].denied = true; brokers[0].done!(); brokers[0].emit('close'); assert.equal(feed.diagnostics().reconnects, 1);
  clock.advance(14_999); assert.equal(brokers.length, 1); clock.advance(1); assert.equal(brokers.length, 2);
  brokers[1].emit('error', new Error('broken')); clock.advance(29_999); assert.equal(brokers.length, 2);
  clock.advance(1); brokers[2].emit('close'); clock.advance(59_999); assert.equal(brokers.length, 3);
  clock.advance(1); assert.equal(brokers.length, 4);
  brokers[3].emit('connect'); assert.equal(feed.snapshot().status.connectedAt, iso(clock.now));
  brokers[3].emit('close'); assert.equal(feed.snapshot().status.retryAt, iso(clock.now + 15_000));
});

test('429/503 Retry-After seconds and HTTP dates delay REST fallback, while MQTT is independent', async t => {
  for (const [status, after] of [[429, '180'], [503, iso(NOW + 180_000)]] as const) {
    let positions = 0;
    const { feed, clock, brokers } = setup(t, async url => { if (!url.includes('/locations?')) return {body:'null'};
      positions++; if (positions === 1) throw new UpstreamHttpError(status, url, after); return body(); });
    await settle(); brokers[0].emit('close'); clock.advance(179_999); await settle(); assert.equal(positions, 1);
    clock.advance(1); await settle(); assert.equal(positions, 2); assert.equal(feed.snapshot().status.periodic, true);
    feed.stop();
  }
});

test('newer area exit leaves a version tombstone; old bootstrap cannot resurrect it, later re-entry succeeds', async t => {
  const pending = deferred<{body:string}>(); const { feed, brokers, clock } = setup(t, async url => url.includes('/locations?') ? pending.promise : {body:'null'});
  brokers[0].emit('connect'); brokers[0].report(); clock.advance(1_000); brokers[0].report(clock.now, { lon: 25.2 });
  assert.equal(feed.snapshot().vehicles.length, 0); assert.equal(feed.diagnostics().identities, 1);
  pending.resolve(body([rest()])); await settle(); assert.equal(feed.snapshot().vehicles.length, 0);
  clock.advance(1_000); brokers[0].report(clock.now); assert.equal(feed.snapshot().vehicles.length, 1);
});

test('known metadata arrives before next position, rejects older lookup results, and never freshens position clocks', async t => {
  const lookup = deferred<{body:string}>(); const { feed, brokers, clock } = setup(t, async url => url.includes('/locations?') ? body([rest()]) : lookup.promise);
  await settle(); brokers[0].emit('connect'); const position = feed.snapshot().vehicles[0];
  clock.advance(1_000); brokers[0].metadata(clock.now, 'Fresh Name');
  assert.equal(feed.snapshot().vehicles[0].marine?.name, 'Fresh Name'); assert.equal(feed.snapshot().vehicles[0].reportedAt, position.reportedAt);
  assert.equal(feed.snapshot().vehicles[0].receivedAt, position.receivedAt);
  lookup.resolve({ body: JSON.stringify({ timestamp: NOW, name: 'Old Name' }) }); await settle();
  assert.equal(feed.snapshot().vehicles[0].marine?.name, 'Fresh Name');
  clock.advance(1_000); brokers[0].report(clock.now); assert.equal(feed.snapshot().vehicles[0].marine?.name, 'Fresh Name');
  brokers[0].metadata(clock.now, 'Unknown', '230999999'); assert.equal(feed.diagnostics().metadata, 1);
});

test('future/sentinel/implausible/replayed positions cannot advance local clocks; long gaps restart', async t => {
  const { feed, brokers, clock } = setup(t); brokers[0].emit('connect'); brokers[0].report(); const first = feed.snapshot().vehicles[0];
  brokers[0].report(NOW + 6_000); brokers[0].report(NOW + 1_000, { lon: 181 });
  clock.advance(1_000); brokers[0].report(clock.now, { lon: 25.0 }); brokers[0].report(NOW - 1_000);
  assert.equal(feed.snapshot().vehicles[0], first); assert.equal(feed.diagnostics().motionDrops, 1);
  clock.advance(31_000); brokers[0].report(clock.now, { lon: 25.0 }); assert.equal(feed.snapshot().vehicles[0].longitude, 25.0);
  assert.equal(feed.snapshot().status.lastPositionAt, iso(clock.now)); assert.ok(feed.diagnostics().rejected >= 3);
});

test('old heartbeat replay cannot keep MQTT live or freshen ships; REST fallback stops after live recovery', async t => {
  let positions = 0; const { feed, brokers, clock } = setup(t, async url => { if (!url.includes('/locations?')) return {body:'null'}; positions++; return body([rest()]); });
  await settle(); brokers[0].emit('connect'); brokers[0].status(NOW - 180_000);
  const ship = feed.snapshot().vehicles[0]; clock.advance(120_000); await settle();
  assert.equal(brokers[0].ended, true); assert.equal(feed.snapshot().status.periodic, true); assert.equal(feed.snapshot().vehicles[0], ship);
  clock.advance(15_000); brokers[1].emit('connect'); brokers[1].status(clock.now); await settle();
  assert.equal(feed.snapshot().status.periodic, false); const requests = positions;
  clock.advance(60_000); await settle(); const afterRecovery = positions; assert.ok(afterRecovery <= requests + 1);
  clock.advance(59_000); await settle(); assert.equal(positions, afterRecovery);
});

test('metadata starts are bounded to two in flight and 20 per rolling minute; failures cache 15 minutes', async t => {
  const pending: ReturnType<typeof deferred<{body:string}>>[] = [];
  const { feed, clock } = setup(t, async url => { if (url.includes('/locations?')) return body(Array.from({length:30},(_,i) => rest(String(230100000 + i))));
    const request = deferred<{body:string}>(); pending.push(request); return request.promise; });
  await settle(); assert.equal(pending.length, 2); assert.equal(feed.diagnostics().metadataFlight, 2);
  for (let i = 0; i < 20; i++) { pending[i].resolve({body:'null'}); await settle(); }
  assert.equal(pending.length, 20); assert.equal(feed.diagnostics().metadataQueue, 10);
  clock.advance(59_999); await settle(); assert.equal(pending.length, 20);
  clock.advance(1); await settle(); assert.equal(pending.length, 22);
  pending[20].reject(new UpstreamHttpError(429, 'https://meri.digitraffic.fi/', '180')); pending[21].reject(new Error('metadata unavailable')); await settle();
  assert.equal(feed.snapshot().vehicles.length, 30); assert.equal(feed.diagnostics().metadataFailures, 2);
  clock.advance(179_999); await settle(); assert.equal(pending.length, 22);
  clock.advance(1); await settle(); assert.equal(pending.length, 24);
});

test('active state, versions and input are bounded and capacity is visible', async t => {
  const { feed, brokers, clock } = setup(t); brokers[0].emit('connect');
  for (let i = 0; i <= MARINE_LIMITS.vehicles; i++) brokers[0].report(NOW, {}, String(230100000 + i));
  clock.advance(1_000); await settle(); assert.equal(feed.snapshot().vehicles.length, MARINE_LIMITS.vehicles);
  assert.equal(feed.snapshot().status.capacityReached, true); assert.equal(feed.diagnostics().capacityDrops, 1);
  brokers[0].emit('message', 'vessels-v2/status', Buffer.alloc(MARINE_LIMITS.payloadBytes + 1));
  for (let i = 0; i <= MARINE_LIMITS.messagesPerSecond; i++) brokers[0].emit('message', 'bad', Buffer.from('{}'));
  clock.advance(1_000); assert.ok(feed.diagnostics().budgetDrops >= 3); assert.equal(feed.snapshot().status.degraded, true);
  assert.ok(feed.diagnostics().identities <= MARINE_LIMITS.identities); assert.ok(feed.diagnostics().metadataQueue <= MARINE_LIMITS.metadataQueue);
});

test('moving expires at ten minutes, stationary at thirty, absent REST observations do not delete', async t => {
  let calls = 0; const { feed, clock } = setup(t, async url => url.includes('/locations?') ? body(++calls === 1 ? [rest(MMSI, NOW, {navStat:0}), rest('230123457')] : []) : {body:'null'});
  await settle(); clock.advance(60_000); await settle(); assert.equal(feed.snapshot().vehicles.length, 2);
  clock.advance(540_000); await settle(); assert.deepEqual(feed.snapshot().vehicles.map(v => v.id), ['ais:230123457']);
  clock.advance(1_200_000); await settle(); assert.equal(feed.snapshot().vehicles.length, 0); assert.equal(feed.diagnostics().identities, 0);
});

test('stop cancels requests/socket/timers and old connection, subscription and HTTP callbacks cannot cross lifetimes', async t => {
  const pending = deferred<{body:string}>(); let signal: AbortSignal | undefined; let calls = 0;
  const { feed, brokers, clock, events } = setup(t, async (url, options: RequestOptions) => { signal = options.signal;
    if (url.includes('/locations?')) return ++calls === 1 ? pending.promise : body(); return {body:'null'}; });
  brokers[0].autoSubscribe = false; brokers[0].emit('connect'); feed.stop(); assert.equal(signal?.aborted, true);
  assert.equal(brokers[0].ended, true); assert.equal(clock.tasks.size, 0); const length = events.length;
  brokers[0].done!(); brokers[0].report(); pending.resolve(body([rest()])); await settle(); assert.equal(events.length, length);
  assert.deepEqual(feed.snapshot(), { vehicles: [], status: { state: 'idle', connectedAt:null,lastPositionAt:null,retryAt:null,lastSnapshotAt:null,lastMessageAt:null,feedUpdatedAt:null,positionError:null,metadataError:null,periodic:false,stale:false,degraded:false,capacityReached:false,localCount:0 } });
  feed.start(update => events.push(update)); brokers[0].report(); await settle(); assert.equal(feed.snapshot().vehicles.length, 0);
  feed.stop(); assert.equal(clock.tasks.size, 0); assert.equal(feed.diagnostics().restFlight, 0); assert.equal(feed.diagnostics().metadataFlight, 0);
});

test('fixed REST requests use compression, identity header, timeout, no redirects and decoded byte caps', async t => {
  let request: {url:string;options:RequestOptions} | undefined;
  const { feed } = setup(t, async (url, options) => { request = {url,options}; return {body:'x'.repeat(MARINE_LIMITS.restBytes + 1)}; });
  await settle(); assert.ok(request); assert.ok(request.url.startsWith('https://meri.digitraffic.fi/api/ais/v1/locations?latitude=60.18&longitude=25&radius=15&from='));
  assert.ok(request.url.endsWith(String(NOW - 1_800_000))); assert.equal(request.options.timeoutMs, 12_000);
  assert.equal(request.options.redirect, 'error'); assert.equal(request.options.maxBytes, MARINE_LIMITS.restBytes);
  assert.deepEqual(request.options.headers, {'Accept-Encoding':'gzip','Digitraffic-User':'HelsinkiLens/1.0'});
  assert.match(feed.snapshot().status.positionError!, /byte limit/);
});


test('inoperative REST fixes cannot replace a usable position or refresh its clocks', async t => {
  const pending = deferred<{body:string}>(); const { feed, brokers } = setup(t, async url => url.includes('/locations?') ? pending.promise : {body:'null'});
  brokers[0].emit('connect'); brokers[0].report(); const usable = feed.snapshot().vehicles[0];
  pending.resolve(body([rest(MMSI, NOW + 1_000, {timestamp:63}, 25.0), rest('230123457', NOW, {timestamp:63})])); await settle();
  assert.equal(feed.snapshot().vehicles.length, 1); assert.equal(feed.snapshot().vehicles[0], usable);
  assert.equal(feed.snapshot().status.lastPositionAt, usable.reportedAt); assert.equal(feed.diagnostics().inoperativeDrops, 2);
});

test('identity tombstones and known metadata remain bounded under local vessel churn', async t => {
  const { feed, brokers, clock } = setup(t); brokers[0].emit('connect');
  for (let i = 0; i < MARINE_LIMITS.identities; i++) {
    const mmsi = String(230100000 + i); brokers[0].report(clock.now, {}, mmsi); brokers[0].metadata(clock.now, 'Known', mmsi);
    clock.advance(1_000); brokers[0].report(clock.now, {lon:25.2}, mmsi);
  }
  await settle(); assert.equal(feed.diagnostics().identities, MARINE_LIMITS.identities);
  assert.equal(feed.diagnostics().metadata, MARINE_LIMITS.metadata); assert.equal(feed.snapshot().vehicles.length, 0);
  brokers[0].report(clock.now, {}, '230999999'); clock.advance(1_000);
  assert.equal(feed.snapshot().vehicles.length, 0); assert.equal(feed.diagnostics().capacityDrops, 1);
  assert.equal(feed.snapshot().status.capacityReached, true);
  clock.advance(1_800_000); await settle(); assert.equal(feed.diagnostics().identities, 0);
});

test('decoded MQTT aggregate byte budget drops before parsing', async t => {
  const { feed, brokers, clock } = setup(t); brokers[0].emit('connect');
  const bytes = Buffer.from(JSON.stringify({updated:NOW / 1_000, padding:'x'.repeat(32_000)}));
  for (let i = 0; i < 40; i++) brokers[0].emit('message', 'vessels-v2/status', bytes);
  clock.advance(1_000); assert.ok(feed.diagnostics().budgetDrops > 0);
  assert.equal(feed.snapshot().status.degraded, true); assert.equal(feed.diagnostics().receivedBytes, bytes.length * 40);
});

test('metadata failures are cached for fifteen minutes independently of position freshness', async t => {
  let lookups = 0; const { feed, clock } = setup(t, async url => { if (url.includes('/locations?')) return body([rest()]);
    lookups++; throw new Error('metadata failure'); });
  await settle(); assert.equal(lookups, 1); clock.advance(899_999); await settle(); assert.equal(lookups, 1);
  clock.advance(1); await settle(); assert.equal(lookups, 2); assert.equal(feed.snapshot().vehicles.length, 1);
});


test('long valid Retry-After stays absolute while every Node sleep remains safely bounded', async t => {
  let calls=0; const {feed,clock}=setup(t,async url=>{if(!url.includes('/locations?'))return {body:'null'};calls++;throw new UpstreamHttpError(429,url,'2592000');});
  await settle();assert.equal(calls,1);assert.ok([...clock.tasks.values()].every(task=>task.at-clock.now<=60000));
  clock.advance(60000);await settle();assert.equal(calls,1);
  clock.advance(60000);await settle();assert.equal(calls,1);
  assert.ok([...clock.tasks.values()].every(task=>task.at-clock.now<=60000));assert.equal(feed.diagnostics().restRequests,1);
});

test('overflowing Retry-After is ignored instead of scheduling an infinite timeout',async t=>{
  let calls=0;const {clock}=setup(t,async url=>{if(!url.includes('/locations?'))return {body:'null'};calls++;
    if(calls===1)throw new UpstreamHttpError(503,url,'9'.repeat(400));return body();});
  await settle();assert.ok([...clock.tasks.values()].every(task=>Number.isFinite(task.at)&&task.at-clock.now<=60000));
  clock.advance(60000);await settle();assert.equal(calls,2);
});


test('missing subscription acknowledgement releases the socket, retries, and ignores obsolete late grants', async t=>{
  const {feed,brokers,clock}=setup(t);await settle();brokers[0].autoSubscribe=false;brokers[0].emit('connect');
  clock.advance(11999);assert.equal(brokers[0].ended,false);clock.advance(1);assert.equal(brokers[0].ended,true);
  assert.equal(feed.diagnostics().reconnects,1);assert.match(feed.snapshot().status.positionError!,/acknowledgement timed out/);
  assert.equal(feed.snapshot().status.periodic,true);brokers[0].done!();assert.equal(feed.snapshot().status.connectedAt,null);
  clock.advance(15000);assert.equal(brokers.length,2);brokers[1].emit('connect');const connected=feed.snapshot().status.connectedAt;
  brokers[0].done!();assert.equal(feed.snapshot().status.connectedAt,connected);brokers[0].report();assert.equal(feed.snapshot().vehicles.length,0);
  assert.equal(feed.diagnostics().upstreamConnections,1);
});
