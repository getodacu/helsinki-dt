import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEntityDatabase, entityHash, type EntityInput } from '../scripts/entity-database.ts';
import { prepareEntities } from '../scripts/prepare-entities.ts';
import { EntityDatabase, EntityStore, entityResponse } from '../src/lib/server/entities.ts';
import { buildingEnergyTheme, energyThemeOptions } from '../src/lib/energy-display.ts';
import { ryhtiTheme } from '../src/lib/ryhti-display.ts';
import { prepareRyhtiCatalog } from '../src/lib/data/ryhti.ts';
import { SCENE_ORIGIN } from '../src/lib/area.ts';
import type { CityManifest } from '../src/lib/city-assets.ts';
import type { Building, DatasetSource, EnergyRecord } from '../src/lib/types.ts';
import type { EntitySearch, EntityDetail, EntityThemeValues } from '../src/lib/entity-types.ts';

const originals = JSON.parse(await readFile(new URL('./fixtures/ryhti-original.json', import.meta.url), 'utf8'));
const source: DatasetSource = { id: 'helsinki-semantic-tiles', provider: 'City of Helsinki', url: 'https://example.org/source', license: 'CC BY 4.0',
  attribution: 'Fixture', retrievedAt: '2026-10-09T00:00:00Z', vintage: '2017', units: ['m'], coverage: 'Fixture', method: 'Fixture',
  checksum: 'a'.repeat(64), coordinateReference: null, axisOrder: null, verticalReference: null };
function fixture(): EntityInput {
  const buildings: Building[] = originals.buildings.map((b: Building, i: number) => ({ ...b, id: 'BID_' + (i + 1), gmlId: 'gml_' + (i + 1),
    chunkRef: i === 2 ? 'b' : 'a', sourceId: source.id, attributes: { name: ['Käpylä Hall', 'Kapyla Annex', 'Literal %_ " place'][i], address: 'Katu ' + (i + 1) } }));
  buildings[1].uuid = '00001';
  const city: CityManifest = { version: 1, generatedAt: '2026-10-09T00:00:00Z', origin: SCENE_ORIGIN,
    bounds: [24.8, 60.1, 25.1, 60.3], sources: [source], gaps: [], initialChunkIds: ['a'], baseUrl: '/data/city/generations/f/base.json',
    chunks: ['a', 'b'].map(id => ({ id, bounds: [0, 0, 1, 1], buildingCount: id === 'a' ? 2 : 1, triangleCount: 1, bytes: 100,
      url: `/data/city/generations/f/${id}.json`, buildingsUrl: `/data/city/generations/f/${id}_buildings.json` })) };
  const record = (id: string, value: number, suffix = ''): EnergyRecord => ({ id: id + suffix, scope: 'building', scopeId: id,
    matchedBuildingIds: [id], unmatchedSourceIds: [], metric: 'heat', period: { start: '2020-01-01', end: '2021-01-01' },
    value, unit: 'kWh', method: 'modeled', scenario: 'baseline', sourceId: source.id });
  const ryhti = prepareRyhtiCatalog(buildings, originals.completed, originals.permits,
    { generatedAt: city.generatedAt, sha256: entityHash(JSON.stringify(city)) }, originals.sources);
  return { generation: randomUUID(), city, cityManifestSha256: entityHash(JSON.stringify(city)), buildings, foundation: null,
    energy: { status: 'ready', message: null, attemptedAt: city.generatedAt, catalog: { version: 1, generatedAt: city.generatedAt,
      cityGeneratedAt: city.generatedAt, sources: [source], energy: [record('BID_1', 10), record('BID_2', 50), record('BID_3', 0), record('BID_2', 75, '_duplicate')],
      solar: [], properties: [{ id: 'shared', name: 'Shared property', memberSourceIds: ['one', 'two'], matchedBuildingIds: ['BID_1', 'BID_3'], unmatchedSourceIds: [], shared: true }],
      reports: [{ sourceId: source.id, sourceVintage: '2017', totalSourceRecords: 3, recordsWithinScope: 3, exactMatches: 2,
        reviewedMatches: 0, unmatchedRecords: 0, ambiguousRecords: 1, conflictingRecords: 0, buildingsCovered: 2, denominator: 'Fixture', notes: [],
        associations: [{ sourceId: 'ambiguous', gmlId: null, vtjPrt: null, status: 'ambiguous', buildingIds: [], candidates: ['BID_2'] }] }] } },
    ryhti: { status: 'ready', message: null, attemptedAt: ryhti.generatedAt, catalog: ryhti } };
}
async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'helsinki-entities-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function database(t: TestContext, input = fixture()) {
  const root = await temporary(t), path = join(root, input.generation + '.sqlite');
  const catalog = buildEntityDatabase(path, input);
  const db = new EntityDatabase(path); t.after(() => db.close()); return { root, path, catalog, db, input };
}

test('search preserves accent-insensitive substrings, original IDs, literal punctuation and stable pages', async t => {
  const { db } = await database(t);
  const search = (q: string, extra = {}) => db.search(new URLSearchParams({ q, ...extra }));
  assert.deepEqual(search('kapyla').buildings.map(b => b.id), ['BID_1', 'BID_2']);
  assert.equal(search('ÄPY').buildings.length, 2);
  assert.equal(search('00001').buildings[0].id, 'BID_2');
  for (const q of ['%', '_ "', '"', '%_ "']) assert.equal(search(q).buildings.at(-1)?.id, 'BID_3');
  assert.equal(search("' OR 1=1 --").buildings.length, 0);
  assert.equal(search('BID_2').buildings[0].id, 'BID_2');
  const ids: string[] = []; let cursor: string | null = null;
  do { const page: EntitySearch = search('', { limit: '1', ...(cursor ? { cursor } : {}) }); ids.push(...page.buildings.map(b => b.id)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(ids, ['BID_1', 'BID_2', 'BID_3']);
  const first = search('', { limit: '1' });
  assert.throws(() => search('changed', { cursor: first.nextCursor! }), /cursor/);
  for (const limit of ['0', '61', 'Infinity', '-1', '1.5']) assert.throws(() => search('', { limit }), /Limit/);
});

test('details contain only the selection, its related members, and applicable ambiguity evidence', async t => {
  const { db, catalog, input } = await database(t);
  assert.equal(catalog.energy.catalog!.energy.length, 0); assert.equal(catalog.ryhti.catalog!.buildings.length, 0);
  assert.equal(catalog.energy.catalog!.reports[0].associations.length, 0);
  const detail = db.detail('BID_1');
  assert.ok(detail.energy.catalog!.energy.every(row => row.matchedBuildingIds.includes('BID_1')));
  assert.equal(detail.ryhti.catalog!.buildings.length, 1);
  assert.deepEqual(detail.members.map(b => b.id), ['BID_1', 'BID_3']);
  assert.deepEqual(detail.energy.catalog!.sources, input.energy.catalog!.sources);
  assert.equal(db.detail('BID_2').energy.catalog!.reports[0].associations[0].status, 'ambiguous');
  assert.throws(() => db.detail('missing'), /not found/);
});

test('theme subsets preserve global ranges, ambiguous exclusions, categories and split-chunk identities', async t => {
  const input = fixture(); input.buildings.push({ ...input.buildings[0], chunkRef: 'b' });
  const { db, catalog } = await database(t, input);
  assert.equal(catalog.buildingCount, 3);
  const expected = buildingEnergyTheme(input.energy.catalog, energyThemeOptions(input.energy.catalog)[0]);
  const theme = catalog.themes.find(t => t.energy)!;
  assert.equal(theme.minimum, 0); assert.equal(theme.maximum, 10); assert.equal(theme.count, 2);
  assert.deepEqual(db.theme(theme.key, new URLSearchParams({ chunks: 'a' })).values, [['BID_1', expected.colours.get('BID_1'), null]]);
  assert.equal(db.theme(theme.key, new URLSearchParams({ chunks: 'a,b' })).values.length, 2);
  assert.equal(db.theme(theme.key, new URLSearchParams({ chunks: 'b' })).values.length, 2);
  const key = 'ryhti:main_purpose', categories = ryhtiTheme(input.ryhti.catalog, key).categories;
  assert.deepEqual(catalog.themes.find(t => t.key === key)!.categories, categories);
  const category = categories[0];
  assert.equal(db.search(new URLSearchParams({ theme: key, category: category.key })).buildings.length, category.count);
  assert.throws(() => db.theme(key, new URLSearchParams({ chunks: 'a,a' })), /distinct/);
  assert.throws(() => db.theme(key, new URLSearchParams({ chunks: 'unknown' })), /Unknown/);
});

test('HTTP validates requests, pins generations, supports ETags, and retains a good database after corrupt publication', async t => {
  const { root, path, input } = await database(t);
  const data = join(root, 'data'); await mkdir(join(data, 'city'), { recursive: true });
  await writeFile(join(data, 'city/manifest.json'), JSON.stringify(input.city));
  const bytes = await readFile(path);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, generation: input.generation, bytes: bytes.length, sha256: entityHash(bytes) }));
  let now = 0; const store = new EntityStore(root, data, () => now); t.after(() => store.close());
  const get = (kind: Parameters<typeof entityResponse>[1], query = '', id = '', headers = {}) => entityResponse(new Request('http://localhost/api/test' + query, { headers }), kind, id, store);
  const status = await get('status'); assert.equal(status.status, 200);
  const etag = status.headers.get('ETag')!; assert.equal((await get('status', '', '', { 'If-None-Match': etag })).status, 304);
  const g = '?generation=' + input.generation;
  assert.equal((await get('search', g + '&q=kapyla')).status, 200);
  assert.equal((await get('search', g + '&q=a&q=b')).status, 400);
  assert.equal((await get('search', g + '&limit=999')).status, 400);
  assert.equal((await get('search')).status, 400);
  assert.equal((await get('search', '?generation=' + randomUUID())).status, 409);
  const detail = await (await get('detail', g, 'BID_1')).json() as EntityDetail; assert.equal(detail.building.id, 'BID_1');
  assert.equal((await get('detail', g, 'missing')).status, 404);
  assert.equal((await (await get('theme', g + '&chunks=a', 'ryhti:main_purpose')).json() as EntityThemeValues).values.length, 2);
  await writeFile(join(root, 'manifest.json'), '{}'); now += 1001;
  assert.equal((await (await get('status')).json()).status, 'stale');
  await writeFile(join(data, 'city/manifest.json'), JSON.stringify({ ...input.city, generatedAt: '2027-01-01T00:00:00Z' })); now += 1001;
  assert.equal((await get('status')).status, 503);
});

test('preparation publishes atomically, supports missing optional datasets, and leaves the previous generation on bad input', async t => {
  const root = await temporary(t), data = join(root, 'data'), destination = join(root, 'private');
  const input = fixture(); await mkdir(join(data, 'city/generations/f'), { recursive: true });
  await writeFile(join(data, 'city/manifest.json'), JSON.stringify(input.city));
  for (const chunk of input.city.chunks) await writeFile(join(data, chunk.buildingsUrl.slice(6)), JSON.stringify(input.buildings.filter(b => b.chunkRef === chunk.id)));
  const prepared = await prepareEntities(data, destination);
  assert.equal(prepared.buildings, 3); assert.equal(prepared.themes, 0);
  const pointer = await readFile(join(destination, 'manifest.json'), 'utf8');
  await writeFile(join(data, 'city/generations/f/a_buildings.json'), '[]');
  await assert.rejects(prepareEntities(data, destination), /Invalid building/);
  assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), pointer);
  await writeFile(join(data, 'city/generations/f/a_buildings.json'), JSON.stringify(input.buildings.filter(b => b.chunkRef === 'a')));
  await writeFile(join(data, 'energy-manifest.json'), '{}');
  await assert.rejects(prepareEntities(data, destination), /energy|object/i);
  assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), pointer);
});
