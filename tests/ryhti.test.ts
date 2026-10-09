import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeRyhtiRecord, prepareRyhtiCatalog, validateRyhtiCatalog, uniqueRyhtiRecords, ryhtiDate } from '../src/lib/data/ryhti.ts';
import { RYHTI_COLLECTIONS, type RyhtiRecord } from '../src/lib/ryhti-types.ts';
import { ryhtiCategory, ryhtiTheme, ryhtiValue, ryhtiForCity, RYHTI_DIM_COLOUR } from '../src/lib/ryhti-display.ts';
import { fetchRyhtiBatch, publishRyhti, recordRyhtiFailure } from '../scripts/prepare-ryhti.ts';
import { RyhtiCatalogStore, ryhtiHash, validateRyhtiManifest } from '../src/lib/server/ryhti-catalog.ts';
import { verifyRyhtiRelease } from '../scripts/package-release.ts';
import { GET } from '../src/routes/api/ryhti/catalog/+server.ts';
import { ryhtiCatalogStore } from '../src/lib/server/ryhti-catalog.ts';
import type { Building, DatasetSource } from '../src/lib/types.ts';

const fixture: { buildings: Building[]; completed: RyhtiRecord[]; permits: RyhtiRecord[]; sources: DatasetSource[] } = JSON.parse(await readFile(new URL('./fixtures/ryhti-original.json', import.meta.url), 'utf8'));
const cityBytes = JSON.stringify({ version: 1, generatedAt: '2026-10-09T00:00:00Z' });
const catalog = () => prepareRyhtiCatalog(fixture.buildings, fixture.completed, fixture.permits,
  { generatedAt: '2026-10-09T00:00:00Z', sha256: ryhtiHash(cityBytes) }, fixture.sources, '2026-10-09T12:00:00Z');
const feature = fixture.completed[0], id = feature.properties.permanent_building_identifier;
const page = (rows: RyhtiRecord[], matched = rows.length, next?: string) => ({ type: 'FeatureCollection', features: rows, numberMatched: matched,
  numberReturned: rows.length, ...(next ? { links: [{ rel: 'next', href: next }] } : {}) });

test('real Ryhti control records retain exact joins, source dates and multiple historical permits', () => {
  const value = validateRyhtiCatalog(catalog());
  assert.equal(value.coverage.completedBuildings, 3); assert.equal(value.coverage.permitBuildings, 3);
  assert.equal(value.coverage.permitSourceRecords, 4);
  assert.ok(value.buildings.some(b => b.permits.length === 2));
  for (const b of value.buildings) assert.equal(b.completed?.properties.permanent_building_identifier, b.vtjPrt);
  assert.equal(ryhtiDate('1970-01-01Z'), '1970-01-01');
  assert.equal(ryhtiValue(null), 'Unknown — not supplied');
  assert.match(ryhtiValue('http://uri.suomi.fi/codelist/unknown/code/999'), /Unrecognized code/);
  assert.equal(ryhtiValue('http://uri.suomi.fi/codelist/rytj/avoin_rakennusluokitus/code/02'), 'Office, production, utility and other buildings');
  assert.throws(() => ryhtiDate('2025-02-29Z'), /calendar date/);
  assert.throws(() => decodeRyhtiRecord({ ...feature, properties: { ...feature.properties, number_of_storeys: -1 } }), /floor count/);
});

test('missing and ambiguous municipal identities and conflicting completed records are never enriched', () => {
  const b = fixture.buildings[0];
  const value = prepareRyhtiCatalog([...fixture.buildings, { ...b, id: 'duplicate' }, { ...b, id: 'no-id', vtjPrt: null }, { ...b, id: 'unmatched', vtjPrt: '0000000000' }], fixture.completed, fixture.permits,
    { generatedAt: catalog().cityGeneratedAt, sha256: ryhtiHash(cityBytes) }, fixture.sources);
  assert.equal(value.coverage.ambiguousBuildings, 2); assert.equal(value.coverage.missingIdentifiers, 1);
  assert.ok(value.buildings.filter(row => row.match !== 'exact').every(row => !row.completed && !row.permits.length));
  const conflict = prepareRyhtiCatalog(fixture.buildings, [...fixture.completed, { ...feature, id: 'different-feature' }], fixture.permits,
    { generatedAt: catalog().cityGeneratedAt, sha256: ryhtiHash(cityBytes) }, fixture.sources);
  assert.equal(conflict.coverage.conflictingBuildings, 1);
  assert.equal(uniqueRyhtiRecords([feature, structuredClone(feature)]).length, 1);
  assert.throws(() => uniqueRyhtiRecords([feature, { ...feature, properties: { ...feature.properties, number_of_storeys: 999 } }]), /Conflicting/);
  const invalid = catalog(); invalid.coverage.completedBuildings++; assert.throws(() => validateRyhtiCatalog(invalid), /coverage/);
  const invalidSource = structuredClone(catalog()); (invalidSource.sources[0] as unknown as Record<string, unknown>).units = null; assert.throws(() => validateRyhtiCatalog(invalidSource), /source/);
  const wrong = catalog(); wrong.buildings[0].vtjPrt = 'wrong'; assert.throws(() => validateRyhtiCatalog(wrong), /association/);
});

test('bounded OGC pagination validates each identity and follows only the original filtered collection', async () => {
  const second = { ...feature, id: 'second' };
  let count = 0;
  const rows = await fetchRyhtiBatch(RYHTI_COLLECTIONS.completed, [id], async url => {
    count++; const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('filter-lang'), 'cql-text');
    assert.ok(parsed.searchParams.get('filter')?.includes(id));
    if (count === 1) { parsed.searchParams.set('startIndex', '1'); return page([feature], 2, parsed.href); }
    return page([second], 2);
  });
  assert.equal(rows.length, 2); assert.equal(count, 2);
  assert.deepEqual(await fetchRyhtiBatch(RYHTI_COLLECTIONS.completed, [id], async () => page([])), []);
  await assert.rejects(fetchRyhtiBatch(RYHTI_COLLECTIONS.completed, [id], async () => page([{ ...feature, properties: { ...feature.properties, permanent_building_identifier: 'not-requested' } }])), /ignored/);
  await assert.rejects(fetchRyhtiBatch(RYHTI_COLLECTIONS.completed, [id], async () => page([feature], 2)), /Incomplete/);
  await assert.rejects(fetchRyhtiBatch(RYHTI_COLLECTIONS.completed, [id], async () => page([feature], 2, 'https://evil.example/')), /Unsafe/);
  await assert.rejects(fetchRyhtiBatch(RYHTI_COLLECTIONS.completed, [id], async url => page([feature], 2, url)), /did not complete/);
  await assert.rejects(fetchRyhtiBatch(RYHTI_COLLECTIONS.completed, [id], async () => ({ ...page([]), numberMatched: 'unknown' })), /Malformed/);
  await assert.rejects(fetchRyhtiBatch(RYHTI_COLLECTIONS.completed, [id], async () => { throw new Error('timeout'); }), /timeout/);
});

test('categories preserve missing values, historical and mixed statuses, and share highlighting membership', () => {
  const value = structuredClone(catalog());
  const permits = value.buildings.find(b => b.permits.length === 2)!;
  permits.permits[1].properties.status_of_construction_action = 'http://uri.suomi.fi/codelist/rytj/rakkohteen-toimenpiteen-tila/code/1';
  assert.equal(ryhtiCategory(permits, 'ryhti:permits'), 'mixed');
  const noPermits = { ...permits, permits: [] };
  assert.equal(ryhtiCategory(noPermits, 'ryhti:permits'), 'no-permits');
  assert.equal(ryhtiCategory({ ...noPermits, vtjPrt: null }, 'ryhti:permits'), 'unknown');
  const all = ryhtiTheme(value, 'ryhti:main_purpose');
  assert.equal(all.categories.reduce((sum, row) => sum + row.count, 0), value.buildings.length);
  const choice = all.categories[0], selected = ryhtiTheme(value, 'ryhti:main_purpose', choice.key);
  assert.equal(selected.matchingIds.size, choice.count);
  for (const row of value.buildings) assert.equal(selected.colours.get(row.buildingId), selected.matchingIds.has(row.buildingId) ? all.colours.get(row.buildingId) : RYHTI_DIM_COLOUR);
  assert.equal(ryhtiTheme(value, '').colours.size, 0);
  assert.equal(ryhtiForCity({ status: 'ready', catalog: value, message: null, attemptedAt: null }, 'other-city').catalog, null);
});

test('publication is atomic; failed refresh and corrupt assets retain only a compatible snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ryhti-')); let now = Date.parse('2026-10-09T12:01:00Z');
  try {
    await mkdir(join(root, 'city')); await writeFile(join(root, 'city/manifest.json'), cityBytes);
    const value = catalog(), manifest = await publishRyhti(value, root);
    const before = await readFile(join(root, 'ryhti-manifest.json'), 'utf8');
    await assert.rejects(publishRyhti(value, root, async () => { throw new Error('interrupted'); }), /interrupted/);
    assert.equal(await readFile(join(root, 'ryhti-manifest.json'), 'utf8'), before);
    const store = new RyhtiCatalogStore(root, () => now);
    assert.equal((await store.load()).status, 'ready');
    await recordRyhtiFailure(root, new Error('offline'), '2026-10-09T12:01:00Z'); now += 60000;
    const stale = await store.load(); assert.equal(stale.status, 'stale'); assert.equal(stale.message, 'offline'); assert.ok(stale.catalog);
    await writeFile(join(root, manifest.asset.path), '{}'); now += 60000;
    assert.equal((await store.load()).status, 'stale');
    assert.equal((await new RyhtiCatalogStore(root).load()).catalog, null);
    await writeFile(join(root, 'city/manifest.json'), cityBytes + ' ');
    assert.equal((await store.load()).status, 'unavailable'); assert.equal((await store.load()).catalog, null);
    assert.throws(() => validateRyhtiManifest({ ...manifest, asset: { ...manifest.asset, path: '../escape.json' } }), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('optional release assets enforce checksums, build parity and city compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ryhti-release-')), data = join(root, 'static/data');
  try {
    assert.deepEqual(await verifyRyhtiRelease(root), []);
    await mkdir(join(data, 'city'), { recursive: true }); await writeFile(join(data, 'city/manifest.json'), cityBytes);
    await publishRyhti(catalog(), data);
    await mkdir(join(root, 'build/client'), { recursive: true }); await cp(data, join(root, 'build/client/data'), { recursive: true });
    assert.equal((await verifyRyhtiRelease(root)).length, 2);
    await writeFile(join(root, 'build/client/data/ryhti-manifest.json'), '{}');
    await assert.rejects(verifyRyhtiRelease(root), /Build differs/);
    await writeFile(join(data, 'city/manifest.json'), '{}');
    await assert.rejects(verifyRyhtiRelease(root), /does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('catalog endpoint rejects parameters and negotiates compressed validated state', async () => {
  const original = ryhtiCatalogStore.load;
  ryhtiCatalogStore.load = async () => ({ status: 'ready', catalog: catalog(), message: null, attemptedAt: null });
  try {
    const response = await GET({ url: new URL('http://localhost/api/ryhti/catalog'), request: new Request('http://localhost', { headers: { 'Accept-Encoding': 'gzip' } }) });
    assert.equal(response.headers.get('Content-Encoding'), 'gzip');
    const decoded = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
    assert.equal(decoded.catalog.coverage.completedBuildings, 3);
    const invalid = await GET({ url: new URL('http://localhost/api/ryhti/catalog?q=x'), request: new Request('http://localhost') }); assert.equal(invalid.status, 400);
  } finally { ryhtiCatalogStore.load = original; }
});
