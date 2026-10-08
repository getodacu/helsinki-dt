import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnergyCatalog, EnergyCatalogState, EnergyProperty } from '../src/lib/energy-types.ts';
import type { DatasetSource } from '../src/lib/types.ts';
import { EnergyCatalogStore, validateEnergyCatalog } from '../src/lib/server/energy-catalog.ts';
import { EnergyCache, ENERGY_MAX_ENTRIES, ENERGY_MAX_INFLIGHT, ENERGY_MAX_REQUESTS_PER_MINUTE, ENERGY_REFRESH_MS,
  completedEnergyMonths, decodeMeasuredDays, validateEnergyRequest } from '../src/lib/server/energy.ts';
import { GET } from '../src/routes/api/energy/+server.ts';
import { GET as catalogGET } from '../src/routes/api/energy/catalog/+server.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/nuuka-september-2026.json', import.meta.url), 'utf8'));
const membership = JSON.parse(await readFile(new URL('./fixtures/nuuka-leijonakortteli.json', import.meta.url), 'utf8'));
const initialNow = Date.parse('2026-10-08T14:00:00Z');
const property: EnergyProperty = { id: fixture.propertyCode, name: fixture.rows[0].locationName,
  memberSourceIds: ['103027184J', '103027185K', 'location:Bockin talo'], matchedBuildingIds: [membership.buildings[1].id],
  unmatchedSourceIds: ['103027185K', 'location:Bockin talo'], shared: true };
const source: DatasetSource = { id: 'helsinki-nuuka', provider: 'City of Helsinki municipal energy / Nuuka',
  url: membership.metadataUrl, license: 'CC BY 4.0', attribution: membership.attribution, retrievedAt: membership.retrievedAt,
  vintage: null, units: ['kWh'], coverage: 'One verified municipal property', method: 'Measured property electricity',
  checksum: 'a'.repeat(64), coordinateReference: null, axisOrder: null, verticalReference: null };
const geometrySource: DatasetSource = { ...source, id: 'helsinki-semantic-tiles', units: ['m'], checksum: 'c'.repeat(64), vintage: '2017' };
const catalog = (): EnergyCatalog => ({ version: 1, generatedAt: '2026-10-08T13:00:00Z', cityGeneratedAt: '2026-10-08T10:00:00Z', sources: [structuredClone(source), structuredClone(geometrySource)],
  energy: [], solar: [], properties: [structuredClone(property)], reports: [{ sourceId: 'helsinki-nuuka', sourceVintage: null, totalSourceRecords: 3, recordsWithinScope: 3, exactMatches: 1, reviewedMatches: 0, unmatchedRecords: 1, ambiguousRecords: 1, conflictingRecords: 0, buildingsCovered: 1, denominator: 'Three declared property members', associations: [{ sourceId: '103027184J', gmlId: membership.buildings[1].id, vtjPrt: '103027184J', status: 'exact', buildingIds: [membership.buildings[1].id], candidates: [membership.buildings[1].id] }, { sourceId: '103027185K', gmlId: null, vtjPrt: '103027185K', status: 'ambiguous', buildingIds: [], candidates: [membership.buildings[0].id] }, { sourceId: 'location:Bockin talo', gmlId: null, vtjPrt: null, status: 'missing', buildingIds: [], candidates: [] }], notes: [] }] });
const ready = (value = catalog()): EnergyCatalogState => ({ status: 'ready', catalog: value, message: null, attemptedAt: value.generatedAt });
const query = { propertyId: property.id, month: null };
const window = { start: '2025-10-01', end: '2026-10-01' };
const response = (rows = fixture.rows, now = initialNow) => ({ body: JSON.stringify(rows), retrievedAt: new Date(now).toISOString() });
async function temporary(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'helsinki-energy-')); t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test('measured series uses actual property membership, full daily month, units and dated provenance once', async t => {
  const directory = await temporary(t); let requests = 0; let requestedUrl = '';
  const cache = new EnergyCache({ cacheDirectory: directory, now: () => initialNow, loadCatalog: async () => ready(),
    fetchEnergy: async (url, options) => { requests++; requestedUrl = url; assert.deepEqual(options, { maxBytes: 262144, timeoutMs: 15000 }); return response(); } });
  const result = await cache.series(query);
  assert.equal(result.status, 'current'); assert.equal(result.scope, 'property'); assert.equal(result.property.shared, true);
  assert.deepEqual(result.period, { start: '2026-09-01', end: '2026-10-01' }); assert.equal(result.timezone, 'Europe/Helsinki');
  assert.equal(result.records.length, 30); assert.equal(result.complete, true); assert.equal(result.total, 173390.33299999998);
  assert.equal(result.records[0].value, fixture.rows[0].value); assert.equal(result.unit, 'kWh');
  assert.ok(result.records.every(record => record.scope === 'property' && record.scopeId === property.id && record.matchedBuildingIds.length === 1));
  assert.deepEqual(result.availableMonths, ['2026-09']); assert.deepEqual(result.availableCompleteMonths, ['2026-09']);
  assert.equal(result.source?.retrievedAt, new Date(initialNow).toISOString()); assert.match(result.source!.method, /no building allocation/);
  assert.equal(new URL(requestedUrl).searchParams.get('EndTime'), '2026-09-30');
  assert.equal(new URL(requestedUrl).searchParams.get('StartTime'), '2025-10-01');
  await cache.series({ ...query, month: '2026-09' }); assert.equal(requests, 1); assert.equal((await readdir(directory)).length, 1);
});

test('null/absent days stay gaps, a real zero is retained and partial months have no total', async t => {
  const rows = fixture.rows.filter((_: unknown, index: number) => index !== 8).map((row: object) => ({ ...row }));
  rows[0].value = 0; rows[1].value = null;
  const cache = new EnergyCache({ cacheDirectory: await temporary(t), now: () => initialNow, loadCatalog: async () => ready(), fetchEnergy: async () => response(rows) });
  const result = await cache.series(query);
  assert.equal(result.status, 'current'); assert.equal(result.complete, false); assert.equal(result.total, null);
  assert.equal(result.records[0].value, 0); assert.equal(result.records[1].value, null); assert.equal(result.records[8].value, null);
  assert.equal(result.records.length, 30); assert.deepEqual(result.availableMonths, ['2026-09']); assert.deepEqual(result.availableCompleteMonths, []);
  assert.match(result.message!, /missing daily/);
});

test('latest default prefers complete coverage over a more recent partial month', async t => {
  const august = Array.from({ length: 31 }, (_, index) => ({ ...fixture.rows[0], timestamp: '2026-08-' + String(index + 1).padStart(2, '0') + 'T00:00:00', value: 1 }));
  const cache = new EnergyCache({ cacheDirectory: await temporary(t), now: () => initialNow, loadCatalog: async () => ready(), fetchEnergy: async () => response([...august, fixture.rows[0]]) });
  const result = await cache.series(query);
  assert.equal(result.period.start, '2026-08-01'); assert.equal(result.total, 31); assert.deepEqual(result.availableMonths, ['2026-09', '2026-08']);
  const partial = await cache.series({ ...query, month: '2026-09' }); assert.equal(partial.total, null); assert.equal(partial.records[1].value, null);
  assert.deepEqual(partial.availableMonths, result.availableMonths);
});

test('successful empty, all-null, and cold provider failure remain distinct', async t => {
  const directory = await temporary(t);
  const empty = new EnergyCache({ cacheDirectory: join(directory, 'empty'), now: () => initialNow, loadCatalog: async () => ready(), fetchEnergy: async () => response([]) });
  assert.equal((await empty.series(query)).status, 'empty');
  const allNull = new EnergyCache({ cacheDirectory: join(directory, 'null'), now: () => initialNow, loadCatalog: async () => ready(), fetchEnergy: async () => response(fixture.rows.map((row: object) => ({ ...row, value: null }))) });
  const nullResult = await allNull.series(query); assert.equal(nullResult.status, 'empty'); assert.equal(nullResult.total, null);
  assert.deepEqual(nullResult.availableMonths, ['2026-09']); assert.ok(nullResult.records.every(record => record.value === null));
  const unavailable = new EnergyCache({ cacheDirectory: join(directory, 'fail'), now: () => initialNow, loadCatalog: async () => ready(), fetchEnergy: async () => { throw new Error('offline'); } });
  const result = await unavailable.series(query); assert.equal(result.status, 'unavailable'); assert.equal(result.retrievedAt, null); assert.match(result.message!, /No dated readings/);
});

test('identical and different selected months share one property latest lookup', async t => {
  let release!: () => void, requests = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const cache = new EnergyCache({ cacheDirectory: await temporary(t), now: () => initialNow, loadCatalog: async () => ready(), fetchEnergy: async () => { requests++; await wait; return response(); } });
  const results = [cache.series(query), cache.series(query), cache.series({ ...query, month: '2026-09' })];
  await new Promise(resolve => setImmediate(resolve)); release(); await Promise.all(results); assert.equal(requests, 1);
});

test('provider outage retains the original retrieval date in memory and after process restart', async t => {
  const directory = await temporary(t); let now = initialNow, offline = false, requests = 0;
  const options = { cacheDirectory: directory, now: () => now, loadCatalog: async () => ready(), fetchEnergy: async () => { requests++; if (offline) throw new Error('offline'); return response(); } };
  const cache = new EnergyCache(options); const first = await cache.series(query);
  now += ENERGY_REFRESH_MS + 1; offline = true;
  const stale = await cache.series(query); assert.equal(stale.status, 'stale'); assert.equal(stale.retrievedAt, first.retrievedAt); assert.equal(stale.total, first.total);
  assert.match(stale.message!, /Dated readings are retained/); assert.equal(requests, 2);
  await cache.series(query); assert.equal(requests, 2);
  const restarted = await new EnergyCache(options).series(query); assert.equal(restarted.status, 'stale'); assert.equal(restarted.retrievedAt, first.retrievedAt); assert.equal(restarted.total, first.total);
});

test('calendar rollover retains dated previous-month cache during an outage', async t => {
  const directory = await temporary(t); let now = initialNow;
  await new EnergyCache({ cacheDirectory: directory, now: () => now, loadCatalog: async () => ready(), fetchEnergy: async () => response() }).series(query);
  now = Date.parse('2026-11-01T00:00:00Z');
  const result = await new EnergyCache({ cacheDirectory: directory, now: () => now, loadCatalog: async () => ready(), fetchEnergy: async () => { throw new Error('offline'); } }).series(query);
  assert.equal(result.status, 'stale'); assert.equal(result.period.start, '2026-09-01'); assert.equal(result.complete, true);
});

test('disk write failure keeps fresh readings with a visible persistence warning', async t => {
  const directory = await temporary(t), path = join(directory, 'not-a-directory'); await writeFile(path, 'occupied');
  const cache = new EnergyCache({ cacheDirectory: path, now: () => initialNow, loadCatalog: async () => ready(), fetchEnergy: async () => response() });
  const result = await cache.series(query); assert.equal(result.status, 'current'); assert.equal(result.complete, true); assert.match(result.message!, /could not be saved to disk/);
  assert.equal((await cache.series(query)).total, result.total);
});

test('cache envelope corruption, property membership and source version changes cannot reuse old data', async t => {
  const directory = await temporary(t); let value = catalog();
  const online = new EnergyCache({ cacheDirectory: directory, now: () => initialNow, loadCatalog: async () => ready(value), fetchEnergy: async () => response() });
  await online.series(query);
  const path = join(directory, (await readdir(directory))[0]), original = await readFile(path, 'utf8'), saved = JSON.parse(original);
  saved.rows[0].value += 123; // Finite, well-formed corruption must still fail the persisted checksum.
  await writeFile(path, JSON.stringify(saved));
  const offline = () => new EnergyCache({ cacheDirectory: directory, now: () => initialNow, loadCatalog: async () => ready(value), fetchEnergy: async () => { throw new Error('offline'); } });
  assert.equal((await offline().series(query)).status, 'unavailable');
  await writeFile(path, original); assert.equal((await offline().series(query)).status, 'current');
  await online.series(query); // Existing memory retains the independently validated source rows.
  value = catalog(); value.properties[0].matchedBuildingIds = ['a-new-building'];
  assert.equal((await offline().series(query)).status, 'unavailable');
  value = catalog(); value.sources[0].checksum = 'b'.repeat(64);
  assert.equal((await offline().series(query)).status, 'unavailable');
  value = catalog(); value.cityGeneratedAt = '2026-10-08T11:00:00Z';
  assert.equal((await offline().series(query)).status, 'unavailable');
});

test('Nuuka validates daily dates, unit, scope, duplicates, bounds, rows and finite values', () => {
  for (const change of [{ unit: 'MWh' }, { reportingGroup: 'Water' }, { locationName: 'another property' }, { timestamp: '2026-09-31T00:00:00' },
    { timestamp: '2026-09-01T00:00:00Z' }, { timestamp: '2026-10-01T00:00:00' }, { value: Infinity }, { value: '12' }]) {
    assert.throws(() => decodeMeasuredDays([{ ...fixture.rows[0], ...change }], property, window));
  }
  assert.throws(() => decodeMeasuredDays([fixture.rows[0], fixture.rows[0]], property, window));
  assert.throws(() => decodeMeasuredDays(Array(367).fill(fixture.rows[0]), property, window));
});

test('browser requests accept only one prepared property and twelve completed Helsinki months', async () => {
  const valid = new URL('http://localhost/api/energy?property=' + property.id + '&month=2026-09');
  assert.deepEqual(validateEnergyRequest(valid, initialNow), { propertyId: property.id, month: '2026-09' });
  for (const suffix of ['', '?property=wrong', '?property=' + property.id + '&property=' + property.id,
    '?property=' + property.id + '&month=2026-09&month=2026-08', '?property=' + property.id + '&url=https://other.example',
    '?property=' + property.id + '&month=2026-10', '?property=' + property.id + '&month=2025-09', '?property=' + property.id + '&month=2026-02-30']) {
    assert.throws(() => validateEnergyRequest(new URL('http://localhost/api/energy' + suffix), initialNow));
  }
  assert.equal(completedEnergyMonths(Date.parse('2026-09-30T21:30:00Z'))[0], '2026-09');
  assert.equal(completedEnergyMonths(Date.parse('2026-09-30T20:30:00Z'))[0], '2026-08');
  assert.equal((await GET({ url: new URL('http://localhost/api/energy?url=x') })).status, 400);
  assert.equal((await catalogGET({ url: new URL('http://localhost/api/energy/catalog?path=x'), request: new Request('http://localhost/api/energy/catalog?path=x') })).status, 400);
});

test('catalog and property whitelist failures do not make an upstream request', async t => {
  let requests = 0;
  const cache = new EnergyCache({ cacheDirectory: await temporary(t), now: () => initialNow, loadCatalog: async () => ready(), fetchEnergy: async () => { requests++; return response(); } });
  await assert.rejects(cache.series({ propertyId: '000-000-0000-0000', month: null }), /not in the prepared/);
  await assert.rejects(cache.series({ ...query, month: '2026-10' }), /bounded/); assert.equal(requests, 0);
  const unavailable = new EnergyCache({ loadCatalog: async () => ({ status: 'unavailable', catalog: null, message: 'missing catalog', attemptedAt: null }) });
  await assert.rejects(unavailable.series(query), /missing catalog/);
});

async function publish(path: string, value = catalog(), refreshStatus: 'current' | 'failed' = 'current') {
  await mkdir(join(path, 'city'), { recursive: true });
  await writeFile(join(path, 'city', 'manifest.json'), JSON.stringify({ version: 1, generatedAt: value.cityGeneratedAt, sources: value.sources.filter(source => source.id === 'helsinki-semantic-tiles') }));
  const bytes = JSON.stringify(value); await writeFile(join(path, 'energy.json'), bytes);
  await writeFile(join(path, 'energy-manifest.json'), JSON.stringify({ version: 1, generatedAt: value.generatedAt,
    asset: { path: 'energy.json', bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') },
    refresh: { status: refreshStatus, attemptedAt: value.generatedAt, message: refreshStatus === 'failed' ? 'provider failed' : null } }));
}

test('catalog reader coalesces, checks checksum/version and retains last valid generation on refresh failure', async t => {
  const directory = await temporary(t); let now = initialNow;
  const store = new EnergyCatalogStore(join(directory, 'energy-manifest.json'), () => now);
  assert.equal((await store.load()).status, 'unavailable');
  await publish(directory); now += 60000;
  const [first, second] = await Promise.all([store.load(), store.load()]); assert.equal(first.status, 'ready'); assert.equal(first.catalog, second.catalog);
  await writeFile(join(directory, 'energy.json'), '{}'); now += 60000;
  const stale = await store.load(); assert.equal(stale.status, 'stale'); assert.equal(stale.catalog, first.catalog); assert.match(stale.message!, /byte count|checksum/);
  await publish(directory, { ...catalog(), version: 2 } as unknown as EnergyCatalog); now += 60000;
  const wrongVersion = await store.load(); assert.equal(wrongVersion.status, 'stale'); assert.match(wrongVersion.message!, /Unsupported/); assert.equal(wrongVersion.catalog, first.catalog);
  await publish(directory, catalog(), 'failed'); now += 60000;
  assert.equal((await store.load()).message, 'provider failed'); assert.equal((await store.load()).status, 'stale');
});

test('prepared catalog validates joins/provenance/finite data and refuses unsafe manifest paths', async t => {
  assert.equal(validateEnergyCatalog(catalog()).properties[0].shared, true);
  const bad = catalog(); bad.properties[0].shared = false; assert.throws(() => validateEnergyCatalog(bad), /membership/);
  const sourceBad = catalog(); sourceBad.sources[0].retrievedAt = 'unknown'; assert.throws(() => validateEnergyCatalog(sourceBad), /provenance/);
  sourceBad.sources[0].retrievedAt = '2026-02-31T00:00:00Z'; assert.throws(() => validateEnergyCatalog(sourceBad), /provenance/);
  const duplicate = catalog(); duplicate.properties.push(duplicate.properties[0]); assert.throws(() => validateEnergyCatalog(duplicate), /membership/);
  const unitBad = catalog();
  unitBad.energy = [{ id: 'test', scope: 'property', scopeId: property.id, matchedBuildingIds: [...property.matchedBuildingIds], unmatchedSourceIds: [...property.unmatchedSourceIds], metric: 'electricity_consumption', period: { start: '2026-09-01', end: '2026-09-02' }, value: 1, unit: 'unknown', method: 'measured', scenario: null, sourceId: 'helsinki-nuuka' }];
  assert.throws(() => validateEnergyCatalog(unitBad), /energy record/);
  unitBad.energy[0].unit = 'kWh'; unitBad.energy[0].scope = 'building'; assert.throws(() => validateEnergyCatalog(unitBad), /scope/);
  unitBad.energy[0].scope = 'property'; unitBad.energy[0].period.end = '2026-09-03'; assert.throws(() => validateEnergyCatalog(unitBad), /scope/);
  unitBad.energy[0].period.end = '2026-09-02'; assert.equal(validateEnergyCatalog(unitBad).energy[0].unit, 'kWh');
  unitBad.reports[0].exactMatches = 0; assert.throws(() => validateEnergyCatalog(unitBad), /counts/);
  unitBad.reports[0].exactMatches = 1; unitBad.reports[0].associations[0].buildingIds = ['unproved']; assert.throws(() => validateEnergyCatalog(unitBad), /proved/);
  const directory = await temporary(t); await publish(directory);
  const path = join(directory, 'energy-manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.asset.path = '../energy.json'; await writeFile(path, JSON.stringify(manifest));
  const result = await new EnergyCatalogStore(path, () => initialNow).load(); assert.equal(result.status, 'unavailable'); assert.match(result.message!, /Invalid energy manifest/);
});

test('in-flight and rolling request budgets bound different prepared properties', async t => {
  const value = catalog(); value.properties = Array.from({ length: 30 }, (_, index) => ({ ...property, id: '091-001-0030-' + String(index).padStart(4, '0') }));
  let release!: () => void, budgetReached!: () => void, rejected = 0, active = 0, peak = 0, requests = 0;
  const limited = new Promise<void>(resolve => { budgetReached = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const cache = new EnergyCache({ cacheDirectory: await temporary(t), now: () => initialNow, loadCatalog: async () => ready(value),
    fetchEnergy: async () => { requests++; active++; peak = Math.max(peak, active); await wait; active--; return response(); } });
  const pending = value.properties.slice(0, 8).map(property => cache.series({ propertyId: property.id, month: null }).then(result => {
    if (result.status === 'unavailable' && ++rejected === 4) budgetReached(); return result;
  }));
  await limited; release(); const results = await Promise.all(pending);
  assert.equal(peak, ENERGY_MAX_INFLIGHT); assert.equal(requests, ENERGY_MAX_INFLIGHT); assert.equal(results.filter(result => result.status === 'unavailable').length, 4);
  for (const property of value.properties.slice(8)) await cache.series({ propertyId: property.id, month: null });
  assert.equal(requests, ENERGY_MAX_REQUESTS_PER_MINUTE);
});

test('memory and durable cache sizes remain bounded without background source work', async t => {
  const directory = await temporary(t), value = catalog(); let now = initialNow, requests = 0;
  value.properties = Array.from({ length: ENERGY_MAX_ENTRIES + 2 }, (_, index) => ({ ...property, id: '091-001-0030-' + String(index).padStart(4, '0') }));
  const cache = new EnergyCache({ cacheDirectory: directory, now: () => now, loadCatalog: async () => ready(value), fetchEnergy: async () => { requests++; return response([], now); } });
  for (const property of value.properties) { now += 60001; await cache.series({ propertyId: property.id, month: null }); }
  assert.equal(requests, ENERGY_MAX_ENTRIES + 2); assert.equal((await readdir(directory)).length, ENERGY_MAX_ENTRIES);
  await cache.series({ propertyId: value.properties[0].id, month: null }); assert.equal(requests, ENERGY_MAX_ENTRIES + 3);
});


test('failed first preparation exposes its dated reason without inventing a catalog', async t => {
  const directory = await temporary(t);
  await writeFile(join(directory, 'energy-refresh-status.json'), JSON.stringify({ status: 'failed', attemptedAt: '2026-10-08T12:00:00Z', message: 'provider unavailable' }));
  const result = await new EnergyCatalogStore(join(directory, 'energy-manifest.json'), () => initialNow).load();
  assert.equal(result.status, 'unavailable'); assert.equal(result.catalog, null); assert.equal(result.attemptedAt, '2026-10-08T12:00:00Z'); assert.match(result.message!, /provider unavailable/);
});

test('static refresh warning stays visible beside newly fetched measured data', async t => {
  const state: EnergyCatalogState = { ...ready(), status: 'stale', message: 'A static source refresh failed; retained generation.' };
  const cache = new EnergyCache({ cacheDirectory: await temporary(t), now: () => initialNow, loadCatalog: async () => state, fetchEnergy: async () => response() });
  const result = await cache.series(query); assert.equal(result.status, 'stale'); assert.equal(result.complete, true); assert.match(result.message!, /static source refresh failed/);
});

test('malformed or oversized provider refresh keeps only previously validated readings', async t => {
  let now = initialNow, oversized = false;
  const cache = new EnergyCache({ cacheDirectory: await temporary(t), now: () => now, loadCatalog: async () => ready(), fetchEnergy: async () => oversized ? { body: '[]' + ' '.repeat(262144), retrievedAt: new Date(now).toISOString() } : response() });
  const first = await cache.series(query); now += ENERGY_REFRESH_MS + 1; oversized = true;
  const result = await cache.series(query); assert.equal(result.status, 'stale'); assert.equal(result.retrievedAt, first.retrievedAt); assert.equal(result.total, first.total); assert.match(result.message!, /oversized/);
});


test('a completed calendar month change refreshes in-memory latest coverage before its ordinary cadence', async t => {
  let now = Date.parse('2026-09-30T20:30:00Z'), requests = 0;
  const august = Array.from({ length: 31 }, (_, index) => ({ ...fixture.rows[0], timestamp: '2026-08-' + String(index + 1).padStart(2, '0') + 'T00:00:00', value: 1 }));
  const cache = new EnergyCache({ cacheDirectory: await temporary(t), now: () => now, loadCatalog: async () => ready(), fetchEnergy: async () => { requests++; return response(requests === 1 ? august : fixture.rows, now); } });
  assert.equal((await cache.series(query)).period.start, '2026-08-01');
  now = Date.parse('2026-09-30T21:30:00Z');
  const result = await cache.series(query); assert.equal(requests, 2); assert.equal(result.period.start, '2026-09-01'); assert.equal(result.complete, true);
});


test('changed geometry version with reused building IDs disables old values until a compatible catalog is prepared', async t => {
  const directory = await temporary(t), cityPath = join(directory, 'city', 'manifest.json'); let now = initialNow;
  await mkdir(join(directory, 'city'));
  const geometry: DatasetSource = { ...source, id: 'helsinki-semantic-tiles', units: ['m'], checksum: 'c'.repeat(64), vintage: '2017' };
  const value = catalog(); value.sources[1] = geometry;
  value.energy = [{ id: 'retained-measurement', scope: 'property', scopeId: property.id, matchedBuildingIds: [...property.matchedBuildingIds], unmatchedSourceIds: [...property.unmatchedSourceIds], metric: 'electricity_consumption', period: { start: '2026-09-01', end: '2026-09-02' }, value: 123, unit: 'kWh', method: 'measured', scenario: null, sourceId: 'helsinki-nuuka' }];
  await publish(directory, value); await writeFile(cityPath, JSON.stringify({ version: 1, generatedAt: value.cityGeneratedAt, sources: [geometry] }));
  const store = new EnergyCatalogStore(join(directory, 'energy-manifest.json'), () => now);
  assert.equal((await store.load()).catalog?.energy[0].value, 123);
  const newGeometry = { ...geometry }, newCityGeneratedAt = '2026-10-08T11:00:00Z';
  await writeFile(cityPath, JSON.stringify({ version: 1, generatedAt: newCityGeneratedAt, sources: [newGeometry] }));
  // The identity is reused by the current city, but the catalog's older numeric value cannot attach.
  const incompatible = await store.load(); assert.equal(incompatible.status, 'unavailable'); assert.equal(incompatible.catalog, null); assert.match(incompatible.message!, /geometry version/);
  assert.equal(JSON.parse(await readFile(join(directory, 'energy.json'), 'utf8')).energy[0].value, 123);
  await writeFile(join(directory, 'energy-manifest.json'), '{}'); now += 60000;
  assert.equal((await store.load()).catalog, null); // Generic validation failure must not reactivate the disqualified generation.
  const refreshed = structuredClone(value); refreshed.sources[1] = newGeometry; refreshed.cityGeneratedAt = newCityGeneratedAt; refreshed.energy[0].value = 456;
  await publish(directory, refreshed); now += 60000;
  const restored = await store.load(); assert.equal(restored.status, 'ready'); assert.equal(restored.catalog?.energy[0].value, 456);
  await writeFile(cityPath, JSON.stringify({ version: 1, generatedAt: newCityGeneratedAt, sources: [{ ...newGeometry, vintage: '2026' }] }));
  assert.equal((await store.load()).catalog, null); assert.match((await store.load()).message!, /vintage/);
});

test('missing or oversized current geometry manifest cannot activate declared geometry energy', async t => {
  const directory = await temporary(t), value = catalog();
  await publish(directory, value); await rm(join(directory, 'city'), { recursive: true });
  const result = await new EnergyCatalogStore(join(directory, 'energy-manifest.json'), () => initialNow).load(); assert.equal(result.status, 'unavailable'); assert.equal(result.catalog, null); assert.match(result.message!, /geometry version/);
  await mkdir(join(directory, 'city')); await writeFile(join(directory, 'city', 'manifest.json'), ' '.repeat(1024 ** 2 + 1));
  const large = await new EnergyCatalogStore(join(directory, 'energy-manifest.json'), () => initialNow).load(); assert.equal(large.catalog, null); assert.match(large.message!, /byte bound/);
});


test('a catalog with no declared semantic geometry source cannot bypass the scene version gate', async t => {
  const directory = await temporary(t), value = catalog(); value.sources = value.sources.filter(source => source.id !== 'helsinki-semantic-tiles');
  await publish(directory, value);
  const result = await new EnergyCatalogStore(join(directory, 'energy-manifest.json'), () => initialNow).load();
  assert.equal(result.catalog, null); assert.equal(result.status, 'unavailable'); assert.match(result.message!, /geometry source is not declared/);
});


test('energy outage and corrupt cache recover on retry and produce a valid durable restart', async t => {
  const directory = await temporary(t); let now = initialNow, offline = false;
  const options = { cacheDirectory: directory, now: () => now, loadCatalog: async () => ready(), fetchEnergy: async () => {
    if (offline) throw new Error('Deliberate source outage'); return response(fixture.rows, now);
  } };
  const cache = new EnergyCache(options), first = await cache.series(query);
  now += ENERGY_REFRESH_MS + 1; offline = true;
  const stale = await cache.series(query);
  assert.equal(stale.status, 'stale'); assert.equal(stale.retrievedAt, first.retrievedAt); assert.equal(stale.total, first.total);
  now += 60_001; offline = false;
  const restored = await cache.series(query);
  assert.equal(restored.status, 'current'); assert.equal(restored.retrievedAt, new Date(now).toISOString());
  const path = join(directory, (await readdir(directory))[0]); await writeFile(path, '{broken'); offline = true;
  const restarted = new EnergyCache(options);
  assert.equal((await restarted.series(query)).status, 'unavailable');
  now += 60_001; offline = false;
  const repaired = await restarted.series(query); assert.equal(repaired.status, 'current'); assert.equal(repaired.total, first.total);
  offline = true;
  const final = await new EnergyCache(options).series(query); assert.equal(final.status, 'current'); assert.equal(final.retrievedAt, repaired.retrievedAt);
});
