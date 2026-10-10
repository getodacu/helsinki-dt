import test from 'node:test';
import assert from 'node:assert/strict';
import { energyThemeOptions, buildingEnergyTheme, compatibleEnergyHistory, energyChartSegments, propertyIsShared, formatEnergyDate, formatEnergyRecord, energyForCity } from '../src/lib/energy-display.ts';
import type { EnergyCatalog, EnergyCatalogState } from '../src/lib/energy-types.ts';
import type { DatasetSource, EnergyRecord, SolarRecord } from '../src/lib/types.ts';
const energy = (overrides: Partial<EnergyRecord> = {}): EnergyRecord => ({ id: 'model-A', scope: 'building', scopeId: 'A', matchedBuildingIds: ['A'], unmatchedSourceIds: [],
  metric: 'heating_demand', period: { start: '2020-01-01', end: '2021-01-01' }, value: 10, unit: 'kWh', method: 'modeled', scenario: '2020 baseline', sourceId: 'atlas', ...overrides });
const solar = (overrides: Partial<SolarRecord> = {}): SolarRecord => ({ id: 'solar-A', scope: 'building', scopeId: 'A', matchedBuildingIds: ['A'],
  metric: 'global_solar_radiation', value: 40, unit: 'kWh', calculationPeriod: 'annual reference climatology', vintage: '2017', assumptions: ['Incident roof and wall radiation; weather year unknown.'], sourceId: 'solar', ...overrides });
const catalog = (records: EnergyRecord[] = [], solarRecords: SolarRecord[] = []): EnergyCatalog => ({ version: 1, generatedAt: '2026-10-08T12:00:00Z', cityGeneratedAt: '2026-10-08T11:00:00Z', sources: [], properties: [], reports: [], energy: records, solar: solarRecords });

test('theme choices contain actual compatible building models and preserve unit, period, scenario, source and solar assumptions', () => {
  const data = catalog([energy(), energy({ id: 'annual-2030', scenario: '2030 projection', period: { start: '2030-01-01', end: '2031-01-01' } }),
    energy({ id: 'MWh', unit: 'MWh' }), energy({ id: 'source', sourceId: 'other-atlas' }), energy({ id: 'measured', method: 'measured' }),
    energy({ id: 'shared', scope: 'property', matchedBuildingIds: ['A', 'B'] }), energy({ id: 'ambiguous', matchedBuildingIds: ['A', 'B'] }),
    energy({ id: 'unmatched', unmatchedSourceIds: ['unknown'] }), energy({ id: 'null', scopeId: 'unknown', matchedBuildingIds: ['unknown'], value: null })],
    [solar(), solar({ id: 'irradiation', unit: 'kWh/m²', metric: 'global_solar_irradiation' }), solar({ id: 'unknown-weather', assumptions: ['Another source scenario'] }),
      solar({ id: 'surface', scope: 'surface' }), solar({ id: 'ambiguous-solar', matchedBuildingIds: ['A', 'B'] }), solar({ id: 'null-solar', value: null })]);
  const choices = energyThemeOptions(data);
  assert.equal(choices.filter(choice => choice.kind === 'modeled-demand').length, 4);
  assert.equal(choices.filter(choice => choice.kind === 'solar').length, 3);
  const baseline = choices.find(choice => choice.sourceId === 'atlas' && choice.unit === 'kWh' && choice.scenario === '2020 baseline')!;
  const theme = buildingEnergyTheme(data, baseline);
  assert.equal(theme.count, 1); assert.equal(theme.minimum, 10); assert.equal(theme.maximum, 10);
  assert.equal(buildingEnergyTheme(data, null).count, 0);
});

test('theme count uses exact release identities, includes true zero and excludes shared totals and duplicate null-first values', () => {
  const data = catalog([energy({ id: 'null-first', value: null }), energy(), energy({ id: 'B', scopeId: 'B', matchedBuildingIds: ['B'], value: 0 }),
    energy({ id: 'C', scopeId: 'C', matchedBuildingIds: ['C'], value: 30 }), energy({ id: 'outside', scopeId: 'outside', matchedBuildingIds: ['outside'], value: 200 }),
    energy({ id: 'property-total', scope: 'property', matchedBuildingIds: ['B', 'C'], value: 900 })]);
  const theme = buildingEnergyTheme(data, energyThemeOptions(data)[0], new Set(['A', 'B', 'C']));
  assert.equal(theme.count, 2); assert.equal(theme.minimum, 0); assert.equal(theme.maximum, 30);
  assert.ok(!theme.colours.has('A')); assert.ok(!theme.colours.has('outside')); assert.notEqual(theme.colours.get('B'), theme.colours.get('C'));
});
const day = (date: string, end: string, value: number | null = 1, overrides: Partial<EnergyRecord> = {}) => energy({ id: date, scope: 'property', scopeId: 'property-one',
  method: 'measured', metric: 'electricity_consumption', sourceId: 'nuuka', scenario: null, period: { start: date, end }, value, ...overrides });

test('daily energy history rejects different methods, boundaries, units, sources, scenarios and monthly/annual cadence', () => {
  const first = day('2026-09-01', '2026-09-02');
  const incompatible = [day('2026-09-02', '2026-10-02'), day('2026-01-01', '2027-01-01'), day('2026-09-02', '2026-09-03', 1, { unit: 'MWh' }),
    day('2026-09-02', '2026-09-03', 1, { method: 'modeled' }), day('2026-09-02', '2026-09-03', 1, { scopeId: 'another-property' }),
    day('2026-09-02', '2026-09-03', 1, { sourceId: 'another-source' }), day('2026-09-02', '2026-09-03', 1, { scenario: 'projection' })];
  assert.deepEqual(compatibleEnergyHistory([first, ...incompatible]), [first]);
  const months = [day('2026-01-01', '2026-02-01'), day('2026-02-01', '2026-03-01'), day('2026-03-01', '2026-04-01')];
  assert.equal(compatibleEnergyHistory([...months, first]).length, 3);
  assert.deepEqual(energyChartSegments(months).map(segment => segment.length), [3]);
});

test('energy lines stop at null and absent daily intervals; a real zero remains a point', () => {
  const records = [day('2026-09-01', '2026-09-02', 0), day('2026-09-02', '2026-09-03', 2), day('2026-09-03', '2026-09-04', null),
    day('2026-09-04', '2026-09-05', 4), day('2026-09-06', '2026-09-07', 6), day('2026-09-07', '2026-09-08', 7)];
  assert.deepEqual(energyChartSegments(records).map(segment => segment.map(record => record.value)), [[0, 2], [4], [6, 7]]);
  assert.deepEqual(energyChartSegments([]), []);
});

test('calendar cadence retains 23-hour spring and 25-hour autumn daily intervals', () => {
  const spring = [day('2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z'), day('2026-03-29T21:00:00Z', '2026-03-30T21:00:00Z')];
  const autumn = [day('2026-10-24T21:00:00Z', '2026-10-25T22:00:00Z'), day('2026-10-25T22:00:00Z', '2026-10-26T22:00:00Z')];
  assert.deepEqual(energyChartSegments(spring).map(segment => segment.length), [2]);
  assert.deepEqual(energyChartSegments(autumn).map(segment => segment.length), [2]);
  assert.equal(energyChartSegments([day('invalid', 'invalid')]).length, 0);
  assert.deepEqual(energyChartSegments([day('2026-09-01', '2026-09-02', NaN), day('2026-09-02', '2026-09-03', 4)]).map(segment => segment.length), [1]);
});

test('property sharing respects unresolved declared members and calendar dates never invent meter hours', () => {
  assert.equal(propertyIsShared({ id: 'one', name: 'Shared boundary', memberSourceIds: ['001', '002', '003'], matchedBuildingIds: ['A', 'B'], unmatchedSourceIds: ['003'], shared: false }), true);
  assert.equal(formatEnergyDate('2026-09-01'), '1 Sept 2026');
  assert.equal(formatEnergyDate('2026-10-01'), '1 Oct 2026');
  assert.equal(formatEnergyDate('bad'), 'Unknown');
});

test('catalog and loaded scene must share the prepared generation and original geometry checksum', () => {
  const source: DatasetSource = { id: 'helsinki-semantic-tiles', provider: 'City of Helsinki', url: 'https://kartta.hel.fi/3d/tileset.json', license: 'CC BY 4.0',
    attribution: 'City of Helsinki', retrievedAt: '2026-10-08T10:00:00Z', vintage: null, units: ['m'], coverage: 'Release area', method: 'Semantic geometry',
    checksum: 'a'.repeat(64), coordinateReference: 'EPSG:3879', axisOrder: 'easting,northing', verticalReference: 'N2000' };
  const data = catalog([energy()]); data.sources = [source];
  const state: EnergyCatalogState = { status: 'stale', catalog: data, message: 'Dated valid generation retained', attemptedAt: null };
  const city = { generatedAt: data.cityGeneratedAt, sources: [source] };
  assert.equal(energyForCity(state, city), state);
  for (const incompatible of [null, { ...city, generatedAt: '2026-10-08T13:00:00Z' }, { ...city, sources: [] }, { ...city, sources: [{ ...source, checksum: 'b'.repeat(64) }] }]) {
    const result = energyForCity(state, incompatible);
    assert.equal(result.catalog, null); assert.equal(result.status, 'unavailable'); assert.match(result.message!, /different source versions/);
    assert.equal(energyThemeOptions(result.catalog).length, 0);
  }
  assert.equal(state.catalog?.energy[0].value, 10);
  assert.equal(energyForCity({ ...state, catalog: null }, city).catalog, null);
});

test('annual energy display converts kWh and computes daily averages using the period day count', () => {
  assert.deepEqual(formatEnergyRecord(energy({ value: 4_317_983.99, period: { start: '2025-01-01', end: '2026-01-01' } })),
    { value: '4.32 GWh/year', dailyAverage: '≈11,830 kWh/day average' });
  assert.deepEqual(formatEnergyRecord(energy({ value: 366_000 })),
    { value: '0.366 GWh/year', dailyAverage: '≈1,000 kWh/day average' });
  assert.deepEqual(formatEnergyRecord(solar({ value: 4_317_983.99 })),
    { value: '4.32 GWh/year', dailyAverage: '≈11,830 kWh/day average' });
});

test('annual energy display preserves zero, small totals and missing values', () => {
  assert.deepEqual(formatEnergyRecord(energy({ value: 0 })), { value: '0 GWh/year', dailyAverage: '≈0 kWh/day average' });
  assert.deepEqual(formatEnergyRecord(solar({ value: 1 })), { value: '0.000001 GWh/year', dailyAverage: '<1 kWh/day average' });
  for (const value of [null, NaN, Infinity]) {
    assert.deepEqual(formatEnergyRecord(energy({ value })), { value: 'Unknown', dailyAverage: null });
    assert.deepEqual(formatEnergyRecord(solar({ value })), { value: 'Unknown', dailyAverage: null });
  }
});

test('energy display retains source units and values for unsupported units and nonannual periods', () => {
  for (const unit of ['kW', 'MWh', 'kWh/m²']) {
    assert.deepEqual(formatEnergyRecord(energy({ value: 1_234.567, unit })), { value: `1,234.57 ${unit}`, dailyAverage: null });
    assert.deepEqual(formatEnergyRecord(solar({ value: 1_234.567, unit })), { value: `1,234.57 ${unit}`, dailyAverage: null });
  }
  for (const period of [{ start: '2025-01-01', end: '2025-02-01' }, { start: 'invalid', end: '2026-01-01' }, { start: '2026-01-01', end: '2025-01-01' }]) {
    assert.deepEqual(formatEnergyRecord(energy({ value: 42, period })), { value: '42 kWh', dailyAverage: null });
  }
  assert.deepEqual(formatEnergyRecord(solar({ value: 42, calculationPeriod: 'unknown' })), { value: '42 kWh', dailyAverage: null });
});
