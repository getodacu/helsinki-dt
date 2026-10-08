import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeNuukaProperty, matchBuildingIdentity, normalizeNuukaEnergy } from '../src/lib/data/energy.ts';
import { inspectWorkbook, verifyWorkbookInflation } from '../scripts/energy-workbooks.ts';
import type { Building } from '../src/lib/types.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/nuuka-leijonakortteli.json', import.meta.url), 'utf8'));
const buildings: Building[] = fixture.buildings;
const property = decodeNuukaProperty(fixture.metadata, '091-001-0030-0001');

test('real property membership yields one exact, one ambiguous and one missing association', () => {
  const result = normalizeNuukaEnergy(fixture.consumption, property, buildings);
  assert.deepEqual(result.matches.map(match => match.status), ['exact', 'ambiguous', 'missing']);
  assert.equal(result.matches[1].candidates.length, 3);
  assert.deepEqual(result.records[0].matchedBuildingIds, ['BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e']);
  assert.equal(result.records[0].scope, 'property');
  assert.equal(result.records[0].scopeId, '091-001-0030-0001');
  assert.equal(result.records[0].unmatchedSourceIds.length, 2);
  assert.equal(result.records.length, 2);
  assert.equal(result.hasMeasuredAssociation, true);
  assert.equal(result.records.reduce((sum, record) => sum + (record.value ?? 0), 0), 10412.486000000001);
  assert.equal(result.records[0].period.start, '2026-10-06');
  assert.equal(result.records[0].period.end, '2026-10-07');
});

test('exact identity joins are deterministic; contradictory GMLID and VTJ-PRT do not fall back', () => {
  const id = 'BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e';
  assert.deepEqual(matchBuildingIdentity(buildings, id, '103027184J'), matchBuildingIdentity([...buildings].reverse(), id, '103027184J'));
  assert.equal(matchBuildingIdentity(buildings, id, '103027185K').status, 'conflict');
  assert.equal(matchBuildingIdentity(buildings, 'BID_unknown', '103027184J').status, 'missing');
  assert.equal(matchBuildingIdentity(buildings, null, '103027185K').status, 'ambiguous');
});

test('null readings remain null; malformed units, dates, duplicates and wrong properties fail', () => {
  const row = fixture.consumption[0];
  assert.equal(normalizeNuukaEnergy([{ ...row, value: null }], property, buildings).records[0].value, null);
  assert.throws(() => normalizeNuukaEnergy([{ ...row, value: '6088.751' }], property, buildings), /Malformed/);
  assert.throws(() => normalizeNuukaEnergy([{ ...row, unit: 'unknown' }], property, buildings), /unverified/);
  assert.throws(() => normalizeNuukaEnergy([{ ...row, timestamp: '2026-02-30T00:00:00' }], property, buildings), /Invalid Nuuka date/);
  assert.throws(() => normalizeNuukaEnergy([row, row], property, buildings), /Duplicate/);
  assert.throws(() => decodeNuukaProperty(fixture.metadata, 'wrong'), /Malformed/);
});

test('modeled City Hall source row has exact identity but no asserted energy unit', async () => {
  const modeled = JSON.parse(await readFile(new URL('./fixtures/modeled-cityhall.json', import.meta.url), 'utf8'));
  assert.equal(matchBuildingIdentity(buildings, modeled.values.gmlid, modeled.values.vtj_prt).status, 'exact');
  assert.equal(modeled.values.SQ_2020_Total_Yearly_Heat_DHW_demand, 59114);
  assert.equal(modeled.unit, null);
  assert.ok(!/kWh|MWh|joule/i.test(modeled.metadata.SQ_2020_Total_Yearly_Heat_DHW_demand));
});

test('workbook streaming preserves string identifiers, null cells and only wanted rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helsinki-energy-'));
  try {
    const path = new URL('./fixtures/energy-streaming.xlsx', import.meta.url).pathname;
    const result = await inspectWorkbook(path, buildings);
    assert.equal(result.sheets[0].rowCount, 3);
    assert.equal(result.sheets[0].rows.length, 1);
    assert.equal(result.sheets[0].rows[0].values.vtj_prt, '103027184J');
    assert.equal(result.sheets[0].rows[0].values.yearly_demand, null);
    assert.ok(result.inflatedBytes > 0);
    const bad = join(dir, 'malformed.xlsx');
    await writeFile(bad, '<html>not an XLSX ZIP</html>');
    await assert.rejects(verifyWorkbookInflation(bad));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all-null measured source rows retain nulls and cannot pass the measured association gate', () => {
  const allNull = fixture.consumption.map((row: Record<string, unknown>) => ({ ...row, value: null }));
  const result = normalizeNuukaEnergy(allNull, property, buildings);
  assert.equal(result.records.length, 2);
  assert.ok(result.records.every(record => record.value === null));
  assert.equal(result.hasMeasuredAssociation, false);
});
