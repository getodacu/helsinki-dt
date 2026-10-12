import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { counterId, decodeTrafficCounters, decodeTrafficMeasurements, decodeTrafficSources } from '../src/lib/data/traffic-measurements.ts';
import { aggregateTrafficCounts, latestTrafficCounts, measurementMode, TRAFFIC_MEASUREMENT_COLOUR, trafficCountRecent,
  MEASUREMENT_RECENT_MS, MEASUREMENT_REFRESH_MS, summarizeTrafficCounts, activeTrafficCounters, trafficCounterStations, colocatedCounters, trafficHistorySegments,
  type TrafficMeasurement, type TrafficCount, type TrafficMeasurementSnapshot } from '../src/lib/traffic-measurements.ts';
import { TrafficMeasurementStore, measurementPageUrl, MEASUREMENT_API, TrafficCounterNotFound } from '../src/lib/server/traffic-measurements.ts';
import { GET as snapshotGET } from '../src/routes/api/traffic-measurements/+server.ts';
import { GET as counterGET } from '../src/routes/api/traffic-measurements/counters/[id]/+server.ts';

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/traffic-measurements/${name}.json`, import.meta.url), 'utf8'));
const hel = await fixture('hel-counters'), eco = await fixture('eco-counters'), observations = await fixture('hel-observations'), ecoLatest = await fixture('eco-latest'), sources = await fixture('sources');
const received = '2026-10-11T10:00:00.000Z', clock = Date.parse(received);
const helCounter = hel.results.features.find((feature: any) => feature.id === 6373);
const ecoCounter = eco.results.features.find((feature: any) => feature.id === 100008546);
const counterPage = (features: unknown[], next: string | null = null) => ({ count: features.length, next, results: { type: 'FeatureCollection', features } });
const page = (results: unknown[], next: string | null = null) => ({ results, next });
const rows = decodeTrafficMeasurements(observations, received).measurements;
const row = (changes: Partial<TrafficMeasurement> = {}): TrafficMeasurement => ({ ...rows[0], ...changes });

function mockStore(options: { fail?: () => boolean; observationPage?: (url: URL) => unknown; catalogPages?: boolean; sourceNames?: string[] } = {}) {
  let now = clock; const requests: URL[] = []; let active = 0, maximum = 0;
  const sourceNames = options.sourceNames ?? ['HEL LAM', 'EcoCounter'];
  const store = new TrafficMeasurementStore(async (path, request) => {
    const url = new URL(path); requests.push(url); active++; maximum = Math.max(maximum, active);
    assert.equal(request.redirect, 'error'); assert.ok(request.maxBytes && request.timeoutMs && request.signal);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (options.fail?.()) throw new Error('Simulated upstream timeout');
      let data: unknown;
      if (url.pathname.includes('metadata')) data = sources.filter((source: any) => sourceNames.includes(source.name));
      else if (url.pathname.includes('counters')) data = options.catalogPages
        ? url.searchParams.has('page') ? counterPage([ecoCounter]) : counterPage([helCounter], path + '&page=2')
        : counterPage([helCounter, ecoCounter]);
      else if (options.observationPage) data = options.observationPage(url);
      else if (url.searchParams.get('counter') === '100008546') data = page(ecoLatest.results);
      else if (url.searchParams.get('page_size') === '1') data = page([observations.results[0]]);
      else data = url.searchParams.get('source') === 'EcoCounter' ? page([]) : page(observations.results);
      return { body: JSON.stringify(data), retrievedAt: new Date(now).toISOString() };
    } finally { active--; }
  }, () => now);
  return { store, requests, advance: (ms: number) => now += ms, concurrency: () => maximum };
}

test('actual GeoJSON/camelCase payloads retain identity, coordinates, metadata and source descriptions', () => {
  const counters = decodeTrafficCounters(hel).counters;
  assert.ok(counters.some(counter => counter.id === 'HEL LAM:6373'));
  assert.ok(counters.every(counter => counter.longitude >= 24.86 && counter.latitude <= 60.225));
  const bicycle = decodeTrafficCounters(eco).counters.find(counter => counter.id === 'EcoCounter:100008546')!;
  assert.equal(bicycle.lastObservedAt, null);
  assert.equal(decodeTrafficMeasurements(ecoLatest, received).measurements[0].value, 24);
  assert.equal(decodeTrafficSources(sources).find(source => source.name === 'EcoCounter')?.license, 'CC-BY-4.0');
  assert.equal(rows[0].counterId, 'HEL LAM:6373'); assert.equal(rows[0].observedAt, '2026-10-10T20:45:00.000Z');
  assert.equal(rows[0].durationSeconds, 900); assert.equal(rows[2].type, 'speed'); assert.equal(rows[2].value, 0);
});

test('invalid IDs, coordinates, dates, values, page shapes and units cannot become trusted totals', () => {
  for (const id of ['', '-1', '1.2', '1e3', '2147483648', {}, NaN]) assert.throws(() => counterId(id));
  assert.equal(counterId('0006373'), '6373');
  assert.throws(() => decodeTrafficCounters({ ...hel, results: [] }));
  for (const changes of [{ crsEpsg: 3879 }, { id: 1 }]) assert.throws(() => decodeTrafficCounters(counterPage([{ ...helCounter, properties: { ...helCounter.properties, ...changes } }])));
  assert.throws(() => decodeTrafficCounters(counterPage([{ ...helCounter, geometry: { type: 'Point', coordinates: [Infinity, 60] } }])));
  assert.equal(decodeTrafficCounters(counterPage([{ ...helCounter, geometry: null }])).counters.length, 0);
  for (const changes of [{ value: -1 }, { value: '19' }, { value: 1.2 }, { phenomenondurationseconds: 0 }, { datetime: 'bad' }, { counterId: null }]) {
    assert.throws(() => decodeTrafficMeasurements(page([{ ...observations.results[0], ...changes }]), received));
  }
  assert.equal(aggregateTrafficCounts([row({ unit: 'bananas' })])[0].value, null);
});

test('Finnish and English classifications preserve modes and unknown categories', () => {
  for (const label of ['Bussi', 'Henkilöauto tai kevytpakettiauto', 'Kuorma-auto', 'Kevyt ajoneuvo', 'Määrittelemätön']) assert.equal(measurementMode(label, 'HEL LAM'), 'vehicles');
  for (const label of ['bicycle', 'Polkupyörä', 'pyöräilijä']) assert.equal(measurementMode(label, 'EcoCounter'), 'cycling');
  for (const label of ['pedestrian', 'Jalankulkija']) assert.equal(measurementMode(label, 'EcoCounter'), 'walking');
  assert.equal(measurementMode('Määrittelemätön', 'EcoCounter'), 'unknown');
  assert.equal(measurementMode('unmapped class', 'HEL LAM'), 'unknown');
});

test('directions/classes sum once, provider totals take precedence, and incompatible intervals stay separate', () => {
  const latest = latestTrafficCounts(aggregateTrafficCounts(rows))[0];
  assert.equal(latest.value, 38); assert.equal(latest.hourlyEquivalent, 152);
  assert.equal(aggregateTrafficCounts([rows[0], rows[0], rows[1]])[0].value, 38);
  assert.equal(aggregateTrafficCounts([row({ vehicleClass: 'all', value: 20 }), row({ vehicleClass: 'Bussi', value: 3 })])[0].value, 20);
  assert.equal(aggregateTrafficCounts([row({ vehicleClass: 'Määrittelemätön', value: 19 }), row({ vehicleClass: 'Bussi', value: 3 })])[0].value, 22);
  assert.equal(aggregateTrafficCounts([row({ vehicleClass: 'unknown', value: 0 }), row({ vehicleClass: 'Bussi', value: 3 })])[0].value, 3);
  assert.equal(aggregateTrafficCounts([row({ direction: 'all', value: 20 }), row({ direction: 'Itään', value: 3 })])[0].value, 20);
  assert.equal(aggregateTrafficCounts([row(), row({ value: 21 })])[0].value, null);
  assert.equal(aggregateTrafficCounts([row({ value: null })])[0].complete, false);
  assert.equal(aggregateTrafficCounts([row({ value: 0 })])[0].value, 0);
  assert.equal(aggregateTrafficCounts([row(), row({ mode: 'cycling' }), row({ durationSeconds: 3600 })]).length, 3);
  assert.equal(aggregateTrafficCounts([row({ vehicleClass: 'Kevyt ajoneuvo' }), row({ vehicleClass: 'Henkilöauto' })])[0].complete, false);
});

test('traffic freshness retains zero readings and excludes the exact 24-hour cutoff and incomplete data', () => {
  const base = aggregateTrafficCounts([row()])[0];
  assert.equal(trafficCountRecent({ ...base, value: 0, hourlyEquivalent: 0 }, clock), true);
  assert.equal(trafficCountRecent({ ...base, observedAt: new Date(clock - MEASUREMENT_RECENT_MS).toISOString() }, clock), false);
  assert.equal(trafficCountRecent({ ...base, observedAt: new Date(clock - MEASUREMENT_RECENT_MS + 1).toISOString() }, clock), true);
  assert.equal(trafficCountRecent({ ...base, observedAt: new Date(clock + 1).toISOString() }, clock), false);
  assert.equal(trafficCountRecent({ ...base, value: null, complete: false }, clock), false);
});

test('pagination cannot change origin, path, filters, credentials or add upstream options', () => {
  const original = MEASUREMENT_API + '/api/observations/?source=HEL+LAM&page_size=5000';
  assert.equal(measurementPageUrl(original + '&cursor=next', 'observations', original), original + '&cursor=next');
  for (const next of ['https://evil.example/api/observations/', original.replace('https:', 'http:'), original.replace('/observations/', '/counters/'), original.replace('HEL+LAM', 'EcoCounter'), original + '&counter=1', original + '&source=EcoCounter', original.replace('https://', 'https://user@')]) assert.throws(() => measurementPageUrl(next, 'observations', original));
});

test('server refresh is single-flight; snapshot/detail reads are cached and exclude inactive catalog entries', async () => {
  const mock = mockStore({ catalogPages: true });
  assert.equal(mock.store.snapshot().state, 'loading'); assert.equal(mock.requests.length, 0);
  assert.throws(() => mock.store.counter('HEL LAM:6373'), /warming/);
  await Promise.all([mock.store.refreshNow(), mock.store.refreshNow()]);
  const a = mock.store.snapshot(), b = mock.store.snapshot();
  assert.equal(a.counters.length, 1); assert.deepEqual(a, b); assert.equal(a.state, 'ready');
  assert.equal(a.summaries[0].latest.value, 38); assert.equal(a.sources.find(source => source.name === 'EcoCounter')?.state, 'dated');
  const length = mock.requests.length;
  const detail = mock.store.counter('HEL LAM:6373'); assert.equal(detail.measurements[2].value, 0);
  assert.equal(detail.summaries[0].latest.value, 38); assert.equal(Date.parse(detail.window!.end) - Date.parse(detail.window!.start), MEASUREMENT_RECENT_MS);
  assert.throws(() => mock.store.counter('EcoCounter:100008546'), TrafficCounterNotFound);
  assert.throws(() => mock.store.counter('HEL LAM:99999'), TrafficCounterNotFound);
  assert.equal(mock.requests.length, length);
  assert.ok(mock.requests.filter(url => url.pathname.includes('observations')).every(url => url.searchParams.has('source') && !url.searchParams.has('counter') && !url.searchParams.has('measurement_type')));
  mock.advance(MEASUREMENT_REFRESH_MS); await mock.store.refreshNow();
  assert.equal(mock.requests.filter(url => url.pathname.includes('metadata')).length, 1);
  assert.equal(mock.requests.filter(url => url.pathname.includes('counters')).length, 2);
  assert.ok(mock.concurrency() <= 3);
});

test('source refresh failure retains readings as partial, then expires them; cold failure becomes unavailable', async () => {
  let fail = false; const mock = mockStore({ fail: () => fail });
  await mock.store.refreshNow(); const good = mock.store.snapshot(); fail = true; mock.advance(MEASUREMENT_REFRESH_MS);
  await mock.store.refreshNow(); const retained = mock.store.snapshot();
  assert.equal(retained.state, 'partial'); assert.deepEqual(retained.summaries[0].latest, good.summaries[0].latest);
  assert.equal(retained.summaries[0].partial, true); assert.match(retained.sources[0].error!, /timeout/);
  mock.advance(MEASUREMENT_RECENT_MS); await mock.store.refreshNow();
  assert.equal(mock.store.snapshot().counters.length, 0); assert.equal(mock.store.snapshot().summaries.length, 0);
  assert.throws(() => mock.store.counter('HEL LAM:6373'), TrafficCounterNotFound);
  const cold = mockStore({ fail: () => true }); await cold.store.refreshNow();
  assert.equal(cold.store.snapshot().state, 'unavailable'); assert.deepEqual(cold.store.snapshot().summaries, []);
});

test('a failed continuation cannot publish a partial final timestamp as a total or full-day maximum', async () => {
  const mock = mockStore({ observationPage: url => {
    if (url.searchParams.get('source') === 'EcoCounter') return page([]);
    if (url.searchParams.has('cursor')) throw new Error('Missing continuation');
    return page(observations.results.slice(0, 5), url.href + '&cursor=next');
  } });
  await mock.store.refreshNow(); const snapshot = mock.store.snapshot();
  assert.equal(snapshot.state, 'partial'); assert.equal(snapshot.summaries.length, 1);
  assert.equal(snapshot.summaries[0].latest.value, 38); assert.equal(snapshot.summaries[0].maximum.observedAt, rows[0].observedAt);
  assert.equal(snapshot.summaries[0].partial, true);
});

test('recent observations qualify despite false catalog dates, and detail never probes historical timestamps', async () => {
  const mock = mockStore({ observationPage: url => url.searchParams.get('source') === 'EcoCounter'
    ? page(ecoLatest.results.map((row: any) => ({ ...row, datetime: received }))) : page(observations.results) });
  await mock.store.refreshNow(); const length = mock.requests.length;
  const detail = mock.store.counter('EcoCounter:100008546');
  assert.equal(detail.state, 'ready'); assert.equal(detail.counter.lastObservedAt, null); assert.equal(detail.counts[0].value, 24);
  assert.equal(detail.window?.end, received); assert.equal(mock.requests.length, length);
  assert.deepEqual(detail.counter.modes, ['cycling']);
});

test('latest valid and daily maximum use hourly equivalents, newest ties, zero and the precise rolling boundary', () => {
  const base = aggregateTrafficCounts([row()])[0];
  const count = (age: number, changes: Partial<TrafficCount> = {}) => ({ ...base, observedAt: new Date(clock - age).toISOString(), ...changes });
  const summaries = summarizeTrafficCounts([
    count(4 * 3600_000, { value: 400, durationSeconds: 3600, hourlyEquivalent: 400 }),
    count(3 * 3600_000, { value: 200, durationSeconds: 900, hourlyEquivalent: 800 }),
    count(2 * 3600_000, { value: 200, durationSeconds: 900, hourlyEquivalent: 800 }),
    count(1 * 3600_000, { value: 0, hourlyEquivalent: 0 }),
    count(0, { value: null, hourlyEquivalent: null, complete: false }), count(-1),
    count(MEASUREMENT_RECENT_MS, { value: 10000, hourlyEquivalent: 40000 }), count(0, { mode: 'unknown' }),
    count(0, { mode: 'walking', value: 0, hourlyEquivalent: 0 })
  ], clock);
  assert.equal(summaries.length, 2); assert.equal(summaries[0].latest.value, 0);
  assert.equal(summaries[0].maximum.value, 200); assert.equal(summaries[0].maximum.observedAt, new Date(clock - 2 * 3600_000).toISOString());
  assert.equal(summaries[1].maximum.hourlyEquivalent, 0);
});

test('expired maxima fall back to the remaining server history and inactive modes/posts/search counters disappear', async () => {
  const base = observations.results[0];
  const mock = mockStore({ observationPage: url => url.searchParams.get('source') === 'EcoCounter' ? page([]) : page([
    { ...base, datetime: received, value: 0 },
    { ...base, datetime: new Date(clock - MEASUREMENT_RECENT_MS + 1000).toISOString(), value: 500 }
  ]) });
  await mock.store.refreshNow(); const snapshot = mock.store.snapshot();
  assert.equal(snapshot.summaries[0].maximum.value, 500);
  const vehicle = trafficCounterStations(snapshot, 'vehicles', clock);
  assert.equal(vehicle.length, 1); assert.equal(vehicle[0].colour, TRAFFIC_MEASUREMENT_COLOUR);
  assert.match(vehicle[0].detail!, /0 \/ 15 min/); assert.match(vehicle[0].detail!, /Max 24 h/);
  assert.equal(trafficCounterStations(snapshot, 'walking', clock).length, 0);
  assert.equal(activeTrafficCounters(snapshot, clock + MEASUREMENT_RECENT_MS).length, 0);
  const grouped = colocatedCounters([snapshot.counters[0], { ...snapshot.counters[0], id: 'other' }], snapshot.counters[0]);
  assert.equal(grouped.length, 2);
  mock.advance(1000); assert.equal(mock.store.snapshot().summaries[0].maximum.value, 0);
});

test('history lines stop at missing readings, missing intervals and changes of aggregation duration', () => {
  const base = aggregateTrafficCounts([row()])[0];
  const count = (minutes: number, changes: Partial<TrafficCount> = {}) => ({ ...base, observedAt: new Date(Date.parse(base.observedAt) + minutes * 60_000).toISOString(), ...changes });
  assert.deepEqual(trafficHistorySegments([count(0), count(15), count(30, { value: null, complete: false }), count(45), count(90), count(105, { durationSeconds: 3600 })]).map(segment => segment.length), [2, 1, 1, 1]);
});

test('API boundaries reject invalid IDs and arbitrary dates/areas before fetching', async () => {
  assert.equal((await snapshotGET({ url: new URL('http://local/api/traffic-measurements?source=other') })).status, 400);
  for (const id of ['abc', '-1', '0', '2147483648']) assert.equal((await counterGET({ params: { id }, url: new URL('http://local/api/traffic-measurements/counters/' + id) })).status, 400);
  assert.equal((await counterGET({ params: { id: 'HEL LAM:6373' }, url: new URL('http://local/api/traffic-measurements/counters/HEL%20LAM%3A6373?date=2000-01-01') })).status, 400);
});

test('counter IDs reused by different sources remain distinct and background queries retain source filters', async () => {
  const reused = { ...helCounter, properties: { ...helCounter.properties, source: 'LIVA' } };
  const counters = decodeTrafficCounters(counterPage([helCounter, reused])).counters;
  assert.deepEqual(counters.map(counter => counter.id), ['HEL LAM:6373', 'LIVA:6373']);
  assert.equal(counters[0].upstreamId, counters[1].upstreamId);
  const mock = mockStore(); await mock.store.refreshNow();
  assert.equal(mock.store.counter('HEL LAM:6373').counter.source, 'HEL LAM');
  assert.ok(mock.requests.filter(url => url.pathname.includes('observations')).every(url => url.searchParams.has('source')));
});

test('all source requests share the three-call limit and expired retained sources stop rendering', async () => {
  let fail = false;
  const mock = mockStore({ sourceNames: sources.map((source: any) => source.name), fail: () => fail });
  await mock.store.refreshNow(); assert.equal(mock.concurrency(), 3);
  mock.advance(MEASUREMENT_RECENT_MS); fail = true; await mock.store.refreshNow();
  const snapshot = mock.store.snapshot();
  assert.ok(snapshot.sources.every(source => source.state !== 'ready'));
  assert.deepEqual(trafficCounterStations(snapshot, 'vehicles', clock + MEASUREMENT_RECENT_MS), []);
});

test('partial refresh keeps cached inspector history and exposes an observed maximum', async () => {
  let partial = false;
  const mock = mockStore({ observationPage: url => {
    if (url.searchParams.get('source') === 'EcoCounter') return page([]);
    if (partial && url.searchParams.has('cursor')) throw new Error('History continuation timeout');
    return page(observations.results.slice(0, partial ? 5 : undefined), partial ? url.href + '&cursor=next' : null);
  } });
  await mock.store.refreshNow(); const good = mock.store.counter('HEL LAM:6373');
  partial = true; mock.advance(MEASUREMENT_REFRESH_MS); await mock.store.refreshNow();
  const retained = mock.store.counter('HEL LAM:6373');
  assert.equal(retained.state, 'partial'); assert.match(retained.error!, /timeout/);
  assert.deepEqual(retained.measurements, good.measurements); assert.deepEqual(retained.counts, good.counts);
  assert.equal(retained.retrievedAt, good.retrievedAt); assert.equal(retained.summaries[0].partial, true);
});

test('background refresh starts without clients, skips builds, runs every five minutes once, and stops cleanly', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const mock = mockStore();
  mock.store.start(true); assert.equal(mock.requests.length, 0);
  mock.store.start(); mock.store.start();
  await mock.store.refreshNow();
  const count = mock.requests.length; assert.ok(count > 0);
  mock.advance(MEASUREMENT_REFRESH_MS); context.mock.timers.tick(MEASUREMENT_REFRESH_MS); await mock.store.refreshNow();
  assert.equal(mock.requests.length, count + 2);
  mock.store.stop(); mock.advance(MEASUREMENT_REFRESH_MS); context.mock.timers.tick(MEASUREMENT_REFRESH_MS);
  assert.equal(mock.requests.length, count + 2);
});

test('stop aborts an in-flight warmup without publishing it or scheduling more calls', async () => {
  let calls = 0;
  const store = new TrafficMeasurementStore(async (_url, request) => {
    calls++;
    await new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }));
    return { body: '[]', retrievedAt: received };
  });
  store.start(); const flight = store.refreshNow(); store.stop(); await flight;
  assert.equal(calls, 1); assert.equal(store.snapshot().state, 'loading'); assert.deepEqual(store.snapshot().counters, []);
});

test('cached endpoints return a loading snapshot and a 503 detail during startup', async () => {
  const response = await snapshotGET({ url: new URL('http://local/api/traffic-measurements') });
  assert.equal(response.status, 200); assert.equal((await response.json()).state, 'loading');
  const detail = await counterGET({ params: { id: 'HEL LAM:6373' }, url: new URL('http://local/api/traffic-measurements/counters/HEL%20LAM%3A6373') });
  assert.equal(detail.status, 503);
});


test('timer ticks during a slow refresh share one cycle', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const mock = mockStore(); mock.store.start();
  const flight = mock.store.refreshNow();
  mock.advance(MEASUREMENT_REFRESH_MS * 2); context.mock.timers.tick(MEASUREMENT_REFRESH_MS * 2);
  assert.equal(mock.requests.length, 1);
  await flight; assert.equal(mock.requests.length, 4); mock.store.stop();
});

test('reloading the server module stops the previous process-wide timer', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const shared = globalThis as typeof globalThis & { helsinkiTrafficMeasurements?: TrafficMeasurementStore };
  const original = shared.helsinkiTrafficMeasurements, mock = mockStore();
  mock.store.start(); await mock.store.refreshNow(); const length = mock.requests.length;
  try {
    shared.helsinkiTrafficMeasurements = mock.store;
    await import(new URL('../src/lib/server/traffic-measurements.ts?reload-test', import.meta.url).href);
    mock.advance(MEASUREMENT_REFRESH_MS); context.mock.timers.tick(MEASUREMENT_REFRESH_MS);
    assert.equal(mock.requests.length, length);
  } finally { shared.helsinkiTrafficMeasurements?.stop(); shared.helsinkiTrafficMeasurements = original; mock.store.stop(); }
});
