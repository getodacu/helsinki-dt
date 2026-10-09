import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { EnergyCatalog } from '../src/lib/energy-types.ts';
import { decodeNuukaProperty } from '../src/lib/data/energy.ts';
import { prepareModeled, prepareSolar, prepareProperty, joinIdentities, joinReport, uniqueBuildings, requireSourceVersion,
  MODEL_SOURCE, SOLAR_SOURCE, SOLAR_VINTAGE } from '../src/lib/data/energy-static.ts';
import { decodeSolarTile } from '../scripts/energy-solar.ts';
import { inspectWorkbook } from '../scripts/energy-workbooks.ts';
import { publishEnergy, recordEnergyFailure } from '../scripts/prepare-energy.ts';
import { validateEnergyCatalog } from '../src/lib/server/energy-catalog.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/energy-static-original.json', import.meta.url), 'utf8'));
const modeled = prepareModeled(fixture.modeledRows, fixture.buildings);
const solar = prepareSolar(fixture.solarRows, fixture.buildings);
const property = prepareProperty(decodeNuukaProperty(fixture.property, '091-001-0030-0001'), fixture.buildings);
const catalog: EnergyCatalog = { version: 1, generatedAt: '2026-10-08T14:30:00.000Z', cityGeneratedAt: '2026-10-08T12:10:39.077Z', sources: fixture.sources,
  energy: modeled.energy, solar: solar.solar, properties: [property.property], reports: [
    joinReport(MODEL_SOURCE, '2020-10-21', fixture.modeledRows.length, modeled.associations, modeled.energy.flatMap(row => row.matchedBuildingIds), 5, []),
    joinReport(SOLAR_SOURCE, SOLAR_VINTAGE, fixture.solarRows.length, solar.associations, solar.solar.flatMap(row => row.matchedBuildingIds), 5, []),
    joinReport('helsinki-nuuka', null, 3, property.associations, property.property.matchedBuildingIds, 5, [])] };

test('five original building associations are verified, including a shared Nuuka property and model/solar source versions', () => {
  const ids = new Set([...modeled.associations, ...solar.associations, ...property.associations].flatMap(row => row.buildingIds));
  assert.equal(ids.size, 5);
  assert.equal(property.property.shared, true);
  assert.equal(property.property.memberSourceIds.length, 3);
  assert.equal(property.property.matchedBuildingIds.length, 2);
  assert.equal(property.property.unmatchedSourceIds.length, 1);
  assert.equal(modeled.associations.find(row => row.gmlId === 'BID_cf43c58b-5f52-4da0-9e2a-2cb440430d86')?.status, 'conflict');
  assert.equal(solar.associations.find(row => row.gmlId === 'BID_cf43c58b-5f52-4da0-9e2a-2cb440430d86')?.status, 'exact');
  assert.equal(modeled.energy.find(row => row.scopeId === 'BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e' && row.period.start === '2020-01-01')?.value, 59114);
  assert.equal(solar.solar.find(row => row.scopeId === 'BID_4d58c091-9185-42fd-a8be-78f1f6eb891f')?.value, 4304491.6873486955);
  assert.ok(modeled.energy.every(row => row.method === 'modeled' && row.unit === 'kWh' && row.period.end === `${Number(row.period.start.slice(0, 4)) + 1}-01-01`));
  assert.ok(solar.solar.every(row => row.metric === 'global_solar_radiation' && row.unit === 'kWh' && row.vintage === SOLAR_VINTAGE));
});

test('preparation is deterministic under source/building order changes; null calculations stay null', () => {
  assert.deepEqual(prepareModeled([...fixture.modeledRows].reverse(), [...fixture.buildings].reverse()), modeled);
  assert.deepEqual(prepareSolar([...fixture.solarRows].reverse(), [...fixture.buildings].reverse()), solar);
  const original = fixture.modeledRows.find((row: { gmlId: string }) => row.gmlId === 'BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e');
  const missing = { ...original, values: { ...original.values, SQ_2020_Total_Yearly_Heat_DHW_demand: 'non calculated' } };
  assert.equal(prepareModeled([missing], fixture.buildings).energy[0].value, null);
  assert.equal(prepareSolar([{ ...fixture.solarRows[0], globalRadYear: null }], fixture.buildings).solar[0].value, null);
  assert.throws(() => prepareModeled([{ ...original, values: { ...original.values, SQ_2020_Total_Yearly_Heat_DHW_demand: -1 } }], fixture.buildings), /Invalid modeled/);
  assert.throws(() => prepareSolar([{ ...fixture.solarRows[0], globalRadYear: Infinity }], fixture.buildings), /Invalid annual/);
});

test('duplicates, reused national identities, conflicts and missing declared GMLIDs cannot produce usable associations', () => {
  const row = fixture.modeledRows[0];
  const duplicate = joinIdentities([row, { ...row, sourceId: 'other-row' }], fixture.buildings);
  assert.ok(duplicate.every(row => row.status === 'ambiguous' && !row.buildingIds.length));
  const conflict = joinIdentities([row, { ...row, sourceId: 'other-version', vtjPrt: 'wrong' }], fixture.buildings);
  assert.ok(conflict.every(row => row.status === 'conflict' && !row.buildingIds.length));
  const a = fixture.buildings[0], b = { ...fixture.buildings[1], vtjPrt: a.vtjPrt };
  const nationals = joinIdentities([{ sourceId: 'a', gmlId: a.gmlId, vtjPrt: a.vtjPrt }, { sourceId: 'b', gmlId: b.gmlId, vtjPrt: b.vtjPrt }], [a, b]);
  assert.ok(nationals.every(row => row.status === 'ambiguous' && !row.buildingIds.length));
  assert.equal(joinIdentities([{ ...row, gmlId: 'BID_missing' }], fixture.buildings)[0].status, 'missing');
  assert.equal(prepareModeled([row, { ...row, sourceId: 'duplicate' }], fixture.buildings).energy.length, 0);
  assert.equal(prepareSolar([fixture.solarRows[0], { ...fixture.solarRows[0], sourceId: 'duplicate' }], fixture.buildings).solar.length, 0);
  assert.throws(() => requireSourceVersion('changed-export', 'verified-export', 'Solar'), /unreviewed source version/);
  requireSourceVersion('same', 'same', 'Solar');
});

test('renderer split batches count once; semantic identity conflicts fail', () => {
  const original = fixture.buildings[0];
  assert.equal(uniqueBuildings([original, { ...original, chunkRef: 'second-render-batch' }]).length, 1);
  assert.throws(() => uniqueBuildings([original, { ...original, vtjPrt: 'reused-identifier' }]), /Conflicting city identity/);
  for (const report of catalog.reports) assert.equal(report.recordsWithinScope,
    report.exactMatches + report.reviewedMatches + report.unmatchedRecords + report.ambiguousRecords + report.conflictingRecords);
});

test('legacy solar batch table preserves the original building parent and rejects malformed tables', () => {
  const source = fixture.solarRows[0];
  const table = { id: [source.original.id], parentPosition: [-1], classId: [26], attributes: [source.original.attributes] };
  const encode = (table: unknown) => {
    const body = Buffer.from(JSON.stringify(table)), bytes = Buffer.alloc(21 + body.length);
    bytes.write('b3dm'); bytes.writeUInt32LE(1, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(0, 12); bytes.writeUInt32LE(body.length, 16); body.copy(bytes, 20);
    return bytes;
  };
  const decoded = decodeSolarTile(encode(table), source.tile)[0];
  assert.equal(decoded.gmlId, source.gmlId);
  assert.equal(decoded.globalRadYear, source.globalRadYear);
  assert.throws(() => decodeSolarTile(encode({ ...table, parentPosition: [0] }), source.tile), /Unsupported solar building parent/);
  assert.throws(() => decodeSolarTile(encode({ ...table, attributes: [] }), source.tile), /Invalid solar parent/);
  assert.throws(() => decodeSolarTile(Buffer.from('{}'), source.tile), /Invalid bounded/);
});

test('release workbook preparation retains more than 500 identities and counts all source rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'energy-workbook-'));
  try {
    const path = join(directory, 'scope.xlsx'), workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('data');
    sheet.addRow(['vtj_prt', 'gmlid', 'yearly_demand']);
    for (let row = 0; row < 750; row++) sheet.addRow([fixture.buildings[0].vtjPrt, fixture.buildings[0].gmlId, row === 0 ? null : row]);
    sheet.addRow(['source-outside-scope', 'BID_outside', 3]);
    await workbook.xlsx.writeFile(path);
    await assert.rejects(inspectWorkbook(path, fixture.buildings), /retained-row limit/);
    const parsed = await inspectWorkbook(path, fixture.buildings, { maxRetainedRows: 1000 });
    assert.equal(parsed.sheets[0].rows.length, 750);
    assert.equal(parsed.sheets[0].rowCount - 1, 751);
    assert.equal(parsed.sheets[0].rows[0].values.yearly_demand, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed publication and a changed source preserve the dated valid generation with diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'energy-publication-'));
  try {
    const first = await publishEnergy(catalog, directory);
    const originalBytes = await readFile(join(directory, first.asset.path));
    await assert.rejects(publishEnergy({ ...catalog, generatedAt: '2026-10-08T15:00:00.000Z' }, directory, async () => { throw new Error('Source version changed'); }), /Source version changed/);
    await recordEnergyFailure(directory, new Error('Source version changed'), '2026-10-08T15:00:00.000Z');
    const retained = JSON.parse(await readFile(join(directory, 'energy-manifest.json'), 'utf8'));
    assert.deepEqual(retained.asset, first.asset);
    assert.equal(retained.generatedAt, first.generatedAt);
    assert.equal(retained.refresh.status, 'failed');
    assert.equal(retained.refresh.message, 'Source version changed');
    assert.deepEqual(await readFile(join(directory, retained.asset.path)), originalBytes);
    assert.equal((await readdir(join(directory, 'energy'))).length, 1);
    const second = await publishEnergy({ ...catalog, generatedAt: '2026-10-08T16:00:00.000Z' }, directory);
    assert.equal(second.refresh.status, 'current');
    assert.notEqual(second.asset.path, first.asset.path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('expanded energy catalogs exceed the old row cap while retaining record validation and a hard bound', () => {
  const energy=Array.from({length:50001},(_,index)=>({...modeled.energy[0],id:'expanded-'+index}));
  assert.equal(validateEnergyCatalog({...catalog,energy}).energy.length,50001);
  assert.throws(()=>validateEnergyCatalog({...catalog,energy:[{...energy[0],value:NaN},...energy.slice(1)]}),/Invalid prepared energy record/);
  assert.throws(()=>validateEnergyCatalog({...catalog,energy:Array(100001).fill(modeled.energy[0])}),/Energy list exceeds its bound/);
});
