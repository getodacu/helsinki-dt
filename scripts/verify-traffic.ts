import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TrafficFeed, type TrafficConnection } from '../src/lib/server/traffic.ts';
import { createTrafficResponse } from '../src/lib/server/traffic-stream.ts';
import { TRAFFIC_IDLE_MS, TRAFFIC_MAX_VEHICLES, TRAFFIC_MAX_QUEUE_BYTES, type TrafficEvent } from '../src/lib/traffic.ts';

const fixture = process.argv.includes('--fixture');
const argument = (name: string, fallback: number) => {
  const value = Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  assert(Number.isSafeInteger(value) && value > 0, `Invalid ${name}`);
  return value;
};
const durationMs = argument('seconds', 1800) * 1000;
assert(durationMs <= 3_600_000, 'Soak bounded to one hour');
const fleetSize = fixture ? argument('peak', 100) * 2 : 0;
assert(fleetSize <= TRAFFIC_MAX_VEHICLES, 'Fixture exceeds feed capacity');
const startedAt = new Date().toISOString();
let injected = 0;
let connections = 0;
let emitter: EventEmitter | null = null;
const connector = () => {
  const connection = new EventEmitter();
  emitter = connection; connections++;
  Object.assign(connection, {
    subscribe: (_topics: unknown, _options: unknown, callback: (error: Error | null) => void) => callback(null),
    end: () => { connection.removeAllListeners(); }
  });
  queueMicrotask(() => connection.emit('connect'));
  return connection as unknown as TrafficConnection;
};
const feed = fixture ? new TrafficFeed(connector) : new TrafficFeed();
const controllers = [new AbortController(), new AbortController(), new AbortController()];
const streams = controllers.map(controller => createTrafficResponse(new Request('http://localhost/api/traffic/stream', {signal:controller.signal}), feed));
const liveIds = [new Map<string, string>(), new Map<string, string>()];
const modes: Record<string, {reports:number; firstReportedAt:string; lastReportedAt:string}> = {};
const latency = {bins:new Uint32Array(1201), count:0, max:0};
const providerAge = {bins:new Uint32Array(1201), count:0, max:0};
const observe = (histogram: typeof latency, value:number) => {
  histogram.bins[Math.min(1200, Math.floor(Math.max(0,value)/100))]++;
  histogram.count++; histogram.max = Math.max(histogram.max,value);
};
const percentile = (histogram:typeof latency, percent:number) => {
  let count = 0;
  for(let index=0; index<histogram.bins.length; index++) {
    count += histogram.bins[index];
    if(count >= histogram.count*percent) return index*100;
  }
  return null;
};
const clientCounts = [0, 0];
let peak = 0;
const consume = async (index: number) => {
  const reader = streams[index].body!.getReader();
  let remainder = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) return;
    remainder += new TextDecoder().decode(value);
    assert(Buffer.byteLength(remainder) <= TRAFFIC_MAX_QUEUE_BYTES, 'Unbounded SSE parse buffer');
    let end: number;
    while ((end = remainder.indexOf('\n\n')) >= 0) {
      const frame = remainder.slice(0, end); remainder = remainder.slice(end + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)) as TrafficEvent;
      clientCounts[index]++;
      if (event.type === 'snapshot') liveIds[index].clear();
      else for (const id of event.removed) liveIds[index].delete(id);
      for (const vehicle of event.vehicles) {
        liveIds[index].set(vehicle.id, vehicle.reportedAt);
        if (index === 0) {
          const received = Date.parse(vehicle.receivedAt);
          observe(latency, Date.now() - received);
          observe(providerAge, received - Date.parse(vehicle.reportedAt));
          const mode = modes[vehicle.mode] ??= {reports:0, firstReportedAt:vehicle.reportedAt, lastReportedAt:vehicle.reportedAt};
          mode.reports++; mode.lastReportedAt = vehicle.reportedAt;
        }
      }
      peak = Math.max(peak, liveIds[index].size);
    }
  }
};
const readers = [consume(0), consume(1)];
const memory: {at:string; heap:number; rss:number; diagnostics:ReturnType<TrafficFeed['diagnostics']>}[] = [];
const record = () => {
  const diagnostics = feed.diagnostics();
  assert(diagnostics.upstreamConnections <= 1, 'Duplicate upstream connection');
  assert(diagnostics.vehicles <= TRAFFIC_MAX_VEHICLES && diagnostics.identities <= TRAFFIC_MAX_VEHICLES, 'Unbounded latest state');
  assert(diagnostics.pendingVehicles <= TRAFFIC_MAX_VEHICLES && diagnostics.pendingRemovals <= TRAFFIC_MAX_VEHICLES, 'Unbounded pending changes');
  const usage = process.memoryUsage();
  memory.push({at:new Date().toISOString(), heap:usage.heapUsed, rss:usage.rss, diagnostics});
  console.log(JSON.stringify({sample:memory.length, peak, modes:Object.keys(modes), ...diagnostics, heap:usage.heapUsed, rss:usage.rss}));
};
const sampleTimer = setInterval(record, 60_000);
let replay: ReturnType<typeof setInterval> | null = null;
try {
  if (fixture) {
    // Fixture timestamps/identities are rewritten only in this explicit offline workload.
    const samples = JSON.parse(await readFile(new URL('../tests/fixtures/hfp-samples.json', import.meta.url), 'utf8'));
    let sequence = 0;
    replay = setInterval(() => {
      const now = new Date().toISOString(); sequence++;
      for (let index = 0; index < fleetSize; index++) {
        const sample = structuredClone(samples[index % samples.length]);
        const fields = sample.topic.split('/');
        fields[7] = '9999'; fields[8] = String(index).padStart(5, '0');
        sample.payload.VP.tst = now;
        sample.payload.VP.lat = 60.17 + index % 10 * 0.00001;
        sample.payload.VP.long = 24.952 + sequence % 20 * 0.000001;
        emitter?.emit('message', fields.join('/'), Buffer.from(JSON.stringify(sample.payload)));
        injected++;
      }
    }, 1_000);
  }
  record();
  await new Promise(resolve => setTimeout(resolve, durationMs));
  record();
  assert(peak > 0, 'No positions received; soak is not representative');
  assert(clientCounts[0] === clientCounts[1], 'Active SSE clients diverged');
  assert.deepEqual([...liveIds[0]], [...liveIds[1]], 'Active clients have different latest state');
  if (fixture) { assert.equal(peak, fleetSize); assert.equal(connections, 1); }
  const during = feed.diagnostics();
  if (replay) { clearInterval(replay); replay = null; }
  for (const controller of controllers) controller.abort();
  await Promise.all(readers);
  assert.equal(feed.diagnostics().consumers, 0, 'Disconnected streams retained demand');
  await new Promise(resolve => setTimeout(resolve, TRAFFIC_IDLE_MS + 100));
  assert.equal(feed.diagnostics().upstreamConnections, 0, 'Last client did not release upstream');
  assert.equal(feed.diagnostics().timers, 0, 'Idle shutdown retained timers');
  const result = {mode:fixture?'explicit-offline-fixture':'real-hsl', startedAt, endedAt:new Date().toISOString(), durationMs, fleetSize, injected, peak, modes, clientCounts, slowClientReleased:during.subscribers === 2, latencyMs:{bucketWidthMs:100,p50:percentile(latency,.5),p95:percentile(latency,.95),max:latency.max}, providerAgeMs:{p50:percentile(providerAge,.5),p95:percentile(providerAge,.95)}, memory, final:feed.diagnostics()};
  await mkdir('.cache/task-b', {recursive:true});
  const path = `.cache/task-b/${fixture?'fixture':'live'}-soak.json`;
  await writeFile(path, JSON.stringify(result, null, 2)+'\n');
  console.log(`Saved ${path}`);
} finally {
  clearInterval(sampleTimer); if(replay) clearInterval(replay);
  for (const controller of controllers) controller.abort();
  feed.close();
}
