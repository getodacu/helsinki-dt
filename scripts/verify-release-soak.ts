import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TRAFFIC_IDLE_MS, TRAFFIC_MAX_VEHICLES, type TrafficEvent } from '../src/lib/traffic.ts';

const option = (name: string, fallback: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const seconds = Number(option('seconds', '1800'));
const port = Number(option('port', '4195'));
assert(Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3600, 'Invalid soak duration');
assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, 'Invalid local port');
const output = resolve(option('output', '.cache/task-e/soak-production.json'));
const log = output.replace(/\.json$/, '') + '.log';
const origin = `http://127.0.0.1:${port}`;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
await mkdir(resolve(output, '..'), { recursive: true });
const chunks = resolve('build/server/chunks');
const trafficChunk = (await readdir(chunks)).filter(name => name.endsWith('.js'));
let trafficModule: string | undefined;
for (const name of trafficChunk) {
  if ((await readFile(resolve(chunks, name), 'utf8')).includes('new TrafficFeed()')) { trafficModule = pathToFileURL(resolve(chunks, name)).href; break; }
}
assert(trafficModule, 'Built shared TrafficFeed chunk was not found; run the production build first');
const preload = output.replace(/\.json$/, '') + '.preload.mjs';
await writeFile(preload, `import * as module from ${JSON.stringify(trafficModule)};\nglobalThis.__releaseSoakFeed = Object.values(module).find(value => value && typeof value.diagnostics === 'function' && typeof value.snapshot === 'function');\n`);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const serverPaths: string[] = [];
const collectServer = async (directory: string) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) await collectServer(path);
    else if (entry.name.endsWith('.js')) serverPaths.push(path);
  }
};
await collectServer('build/server');
for (const name of await readdir('build')) if (name.endsWith('.js')) serverPaths.push('build/' + name);
const serverFiles = [];
for (const path of serverPaths.sort()) {
  const bytes = await readFile(path); serverFiles.push({ path: path.slice('build/'.length), bytes: bytes.length, sha256: sha256(bytes) });
}
const serverSha256 = sha256(serverFiles.map(file => file.path + '\0' + file.sha256 + '\n').join(''));
const buildSha256 = sha256(await readFile('build/server/manifest.js'));
const staticManifests = [];
for (const path of ['static/data/manifest.json', 'static/data/city/manifest.json', 'static/data/energy-manifest.json']) {
  const bytes = await readFile(path); staticManifests.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}
await writeFile(output.replace(/\.json$/, '-build.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, buildSha256, serverSha256, serverFiles, staticManifests }, null, 2));
let serverExit: string | null = null;
let inspectorUrl: string | undefined;
const server = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--import', preload, 'build/index.js'], {
  cwd: process.cwd(), env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe']
});
let pendingLog = Promise.resolve();
for (const [label, stream] of [['stdout', server.stdout], ['stderr', server.stderr]] as const) {
  stream.on('data', data => {
    const text = String(data);
    inspectorUrl ??= text.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
    pendingLog = pendingLog.then(() => appendFile(log, `${new Date().toISOString()} ${label} ${text}`));
  });
}
server.on('exit', (code, signal) => { serverExit = `code=${code} signal=${signal}`; });
let socket: WebSocket | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const command = (method: string, params: object) => new Promise<any>((resolve, reject) => {
  const id = ++sequence;
  const deadline = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector command timed out: ${method}`)); }, 15_000);
  pending.set(id, { resolve: value => { clearTimeout(deadline); resolve(value); }, reject: error => { clearTimeout(deadline); reject(error); } });
  socket!.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression: string) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const controllers = [new AbortController(), new AbortController()];
const clients = controllers.map(() => ({ frames: 0, bytes: 0, heartbeats: 0, snapshots: 0, updates: 0, lastEventAt: '', state: '', transitions: [] as { at: string; state: string }[], vehicles: new Map<string, string>(), peak: 0 }));
const latency = { bins: new Uint32Array(1201), count: 0, max: 0 };
const modes: Record<string, { reports: number; firstReportedAt: string; lastReportedAt: string }> = {};
const samples: any[] = [];
const endpoints: any[] = [];
let startedAt: string | undefined;
let endedAt: string | undefined;
let error: string | undefined;
let consumers: Promise<void>[] = [];
const consume = async (index: number, response: Response) => {
  const client = clients[index], reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { assert(controllers[index].signal.aborted, `Client ${index} disconnected during stable soak`); return; }
      client.bytes += value.byteLength; buffer += decoder.decode(value, { stream: true });
      assert(buffer.length <= 2 * 1024 * 1024, 'Unbounded client SSE parse buffer');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith(':')) { client.heartbeats++; continue; }
        const data = frame.split('\n').find(line => line.startsWith('data: ')); if (!data) continue;
        const event = JSON.parse(data.slice(6)) as TrafficEvent;
        client.frames++; client.lastEventAt = event.generatedAt;
        if (client.state !== event.status.state) { client.state = event.status.state; client.transitions.push({ at: event.generatedAt, state: client.state }); }
        if (event.type === 'snapshot') { client.snapshots++; client.vehicles.clear(); } else { client.updates++; for (const id of event.removed) client.vehicles.delete(id); }
        for (const vehicle of event.vehicles) {
          client.vehicles.set(vehicle.id, vehicle.reportedAt);
          if (index === 0) {
            const ms = Math.max(0, Date.now() - Date.parse(vehicle.receivedAt));
            latency.bins[Math.min(1200, Math.floor(ms / 100))]++; latency.count++; latency.max = Math.max(latency.max, ms);
            const mode = modes[vehicle.mode] ??= { reports: 0, firstReportedAt: vehicle.reportedAt, lastReportedAt: vehicle.reportedAt };
            mode.reports++; mode.lastReportedAt = vehicle.reportedAt;
          }
        }
        client.peak = Math.max(client.peak, client.vehicles.size);
        assert(client.vehicles.size <= TRAFFIC_MAX_VEHICLES, 'Client fleet exceeded release bound');
      }
    }
  } catch (failure) { if (!controllers[index].signal.aborted) throw failure; }
  finally { await reader.cancel().catch(() => {}); }
};
const json = async (path: string) => {
  const start = performance.now(), response = await fetch(origin + path, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, path);
  const body = await response.json(); endpoints.push({ at: new Date().toISOString(), path, status: response.status, durationMs: Math.round(performance.now() - start), contentEncoding: response.headers.get('content-encoding') });
  return body;
};
let property: string | undefined;
const exercise = async (initial = false) => {
  const [traffic, observations, route, catalog] = await Promise.all(['/api/traffic', '/api/observations', '/api/route', '/api/energy/catalog'].map(json));
  assert(Array.isArray(traffic.vehicles) && Array.isArray(observations.sources), 'Invalid source snapshots');
  property ??= catalog.catalog?.properties[0]?.id;
  assert(property, 'No prepared measured energy property');
  const series = await json('/api/energy?property=' + encodeURIComponent(property));
  if (initial) {
    const response = await fetch(origin, { signal: AbortSignal.timeout(30_000) }); assert.equal(response.status, 200); await response.text();
    for (const path of ['/data/manifest.json', '/data/city/manifest.json']) await json(path);
    const city = await json('/data/city/manifest.json');
    assert(city.chunks?.length, 'No prepared city geometry chunks');
    for (const path of [city.baseUrl, city.chunks[0].url, city.chunks[0].buildingsUrl]) {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(30_000) }); assert.equal(response.status, 200, path); await response.arrayBuffer();
      endpoints.push({ at: new Date().toISOString(), path, status: response.status });
    }
    assert(Array.isArray(route.routes), 'No prepared route labels');
  }
  return { observations: observations.sources.map((source: any) => ({ id: source.id, state: source.state, observedAt: source.observedAt, retrievedAt: source.retrievedAt, lastAttemptAt: source.lastAttemptAt })), energy: { status: series.status, retrievedAt: series.retrievedAt, period: series.period, complete: series.complete }, catalog: { status: catalog.status, generatedAt: catalog.catalog?.generatedAt } };
};
const record = async (sourceStates?: object) => {
  const diagnostic = await evaluate(`({at:new Date().toISOString(),pid:process.pid,uptimeSeconds:process.uptime(),memory:process.memoryUsage(),traffic:globalThis.__releaseSoakFeed.diagnostics(),status:globalThis.__releaseSoakFeed.snapshot().status})`);
  assert.equal(diagnostic.pid, server.pid, 'Sampled a different process');
  const traffic = diagnostic.traffic;
  assert.equal(traffic.subscribers, 2, 'Stable SSE client count changed'); assert.equal(traffic.consumers, 2, 'Leaked demand');
  assert(traffic.upstreamConnections <= 1 && traffic.vehicles <= TRAFFIC_MAX_VEHICLES && traffic.identities <= TRAFFIC_MAX_VEHICLES, 'Unbounded feed state');
  assert(traffic.pendingVehicles <= TRAFFIC_MAX_VEHICLES && traffic.pendingRemovals <= TRAFFIC_MAX_VEHICLES, 'Unbounded pending changes');
  assert.equal(serverExit, null, 'Production process exited');
  samples.push({ ...diagnostic, clients: clients.map(({ vehicles, transitions, ...value }) => ({ ...value, vehicles: vehicles.size })), ...sourceStates });
  await appendFile(log, JSON.stringify(samples.at(-1)) + '\n');
  console.log(JSON.stringify({ sample: samples.length, at: diagnostic.at, elapsedSeconds: Math.round((Date.now() - Date.parse(startedAt!)) / 1000), rss: diagnostic.memory.rss, heap: diagnostic.memory.heapUsed, ...traffic }));
};
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    assert.equal(serverExit, null, 'Production server failed during startup');
    if (inspectorUrl) { try { const response = await fetch(origin); if (response.ok) { await response.body?.cancel(); break; } } catch {} }
    assert(Date.now() < deadline, 'Production startup timed out'); await delay(100);
  }
  socket = new WebSocket(inspectorUrl!);
  await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', () => reject(new Error('Inspector connection failed')), { once: true }); });
  socket.addEventListener('close', () => { for (const callback of pending.values()) callback.reject(new Error('Inspector disconnected')); pending.clear(); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), callback = pending.get(message.id); if (!callback) return; pending.delete(message.id);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  });
  assert.equal(await evaluate('!!globalThis.__releaseSoakFeed'), true, 'Preload did not resolve the built shared feed');
  const responses = await Promise.all(controllers.map(controller => fetch(origin + '/api/traffic/stream', { signal: controller.signal })));
  for (const response of responses) { assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/); }
  consumers = responses.map((response, index) => consume(index, response));
  // A rejection immediately fails the workload instead of silently reducing the client count.
  const readerFailure = Promise.race(consumers.map(promise => promise.then(() => { if (!controllers[0].signal.aborted) throw new Error('SSE reader ended early'); })));
  startedAt = new Date().toISOString(); const stopAt = Date.now() + seconds * 1000;
  await record(await exercise(true));
  while (Date.now() < stopAt) {
    await Promise.race([delay(Math.min(60_000, stopAt - Date.now())), readerFailure]);
    await record(await exercise());
  }
  endedAt = new Date().toISOString();
  assert(Date.parse(endedAt) - Date.parse(startedAt) >= seconds * 1000, 'Soak was shortened');
  assert(clients.every(client => client.peak > 0), 'No live vehicle reports received');
  for (let attempts = 0; clients[0].lastEventAt !== clients[1].lastEventAt && attempts < 20; attempts++) await delay(100);
  assert.equal(clients[0].lastEventAt, clients[1].lastEventAt, 'Active readers ended on different events');
  assert.deepEqual([...clients[0].vehicles].sort(), [...clients[1].vehicles].sort(), 'Active clients diverged');
  controllers.forEach(controller => controller.abort()); await Promise.all(consumers);
  await delay(TRAFFIC_IDLE_MS + 200);
  const after = await evaluate(`globalThis.__releaseSoakFeed.diagnostics()`);
  for (const name of ['upstreamConnections', 'subscribers', 'consumers', 'vehicles', 'identities', 'pendingVehicles', 'pendingRemovals', 'timers']) assert.equal(after[name], 0, `Idle cleanup: ${name}`);
  samples.push({ at: new Date().toISOString(), phase: 'idle-cleanup', traffic: after });
} catch (failure) { error = failure instanceof Error ? failure.stack : String(failure); process.exitCode = 1; }
finally {
  controllers.forEach(controller => controller.abort()); await Promise.allSettled(consumers);
  socket?.close(); server.kill('SIGTERM');
  await pendingLog;
  let cumulative = 0, p95Ms: number | null = null;
  for (let index = 0; index < latency.bins.length; index++) { cumulative += latency.bins[index]; if (cumulative >= latency.count * .95) { p95Ms = index * 100; break; } }
  await writeFile(output, JSON.stringify({ workload: 'production Node HTTP + two stable SSE clients; no fixtures', requestedSeconds: seconds, startedAt, endedAt, finishedAt: new Date().toISOString(), node: process.version, origin, pid: server.pid, buildSha256, serverSha256, serverFiles, staticManifests, trafficModule, success: !error, error, clients: clients.map(({ vehicles, ...value }) => ({ ...value, finalVehicles: vehicles.size })), modes, latency: { count: latency.count, p95BucketStartMs: p95Ms, maxMs: latency.max }, samples, endpoints }, null, 2));
  console.log(JSON.stringify({ output, success: !error, startedAt, endedAt, error }));
}
