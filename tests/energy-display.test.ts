import test from 'node:test';
import assert from 'node:assert/strict';
import { energyThemeOptions, closestHeatDemandTheme, buildingEnergyTheme, compatibleEnergyHistory, monthlyEnergyUsage, energyChartSegments, modeledDemandSegments, latestCompletedModeledDemand, propertyIsShared, formatEnergyDate, formatEnergyRecord, humanizeEnergyUsage, energyForCity } from '../src/lib/energy-display.ts';
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
    { value: '4.32 GWh/year', dailyAverage: '≈11.83 MWh/day average' });
  assert.deepEqual(formatEnergyRecord(energy({ value: 366_000 })),
    { value: '366 MWh/year', dailyAverage: '≈1 MWh/day average' });
  assert.deepEqual(formatEnergyRecord(solar({ value: 4_317_983.99 })),
    { value: '4.32 GWh/year', dailyAverage: '≈11.83 MWh/day average' });
});

test('annual energy display preserves zero, small totals and missing values', () => {
  assert.deepEqual(formatEnergyRecord(energy({ value: 0 })), { value: '0 kWh/year', dailyAverage: '≈0 kWh/day average' });
  assert.deepEqual(formatEnergyRecord(solar({ value: 1 })), { value: '1 kWh/year', dailyAverage: '<1 kWh/day average' });
  for (const value of [null, NaN, Infinity]) {
    assert.deepEqual(formatEnergyRecord(energy({ value })), { value: 'Unknown', dailyAverage: null });
    assert.deepEqual(formatEnergyRecord(solar({ value })), { value: 'Unknown', dailyAverage: null });
  }
});

test('energy display retains source units and values for unsupported units and nonannual periods', () => {
  for (const unit of ['kW', 'kWh/m²']) {
    assert.deepEqual(formatEnergyRecord(energy({ value: 1_234.567, unit })), { value: `1,234.57 ${unit}`, dailyAverage: null });
    assert.deepEqual(formatEnergyRecord(solar({ value: 1_234.567, unit })), { value: `1,234.57 ${unit}`, dailyAverage: null });
  }
  for (const period of [{ start: '2025-01-01', end: '2025-02-01' }, { start: 'invalid', end: '2026-01-01' }, { start: '2026-01-01', end: '2025-01-01' }]) {
    assert.deepEqual(formatEnergyRecord(energy({ value: 42, period })), { value: '42 kWh', dailyAverage: null });
  }
  assert.deepEqual(formatEnergyRecord(solar({ value: 42, calculationPeriod: 'unknown' })), { value: '42 kWh', dailyAverage: null });
});

const projection = (year: number, value: number | null = 100_000, overrides: Partial<EnergyRecord> = {}) => energy({
  id: `model-${year}`, sourceId: 'helsinki-modeled-demand', metric: 'heat_dhw_demand',
  period: { start: `${year}-01-01`, end: `${year + 1}-01-01` },
  scenario: year === 2020 ? '2020 baseline (SQ)' : 'Climate change (CC)', value, ...overrides
});

test('modeled demand connects the supplied SQ baseline and CC estimates in chronological order', () => {
  const records = [2020, 2025, 2030, 2035, 2040, 2045, 2050].map(year => projection(year));
  const segments = modeledDemandSegments([...records].reverse(), records[3]);
  assert.deepEqual(segments, [records]);
  assert.equal(formatEnergyRecord(records[0]).value, '100 MWh/year');
});

test('modeled demand breaks at absent, null, invalid and duplicate estimates, retaining zero and single points', () => {
  const first = projection(2020, 0), second = projection(2025, 90_000), afterGap = projection(2035, 70_000);
  assert.deepEqual(modeledDemandSegments([first, second, afterGap], first), [[first, second], [afterGap]]);
  for (const value of [null, NaN, Infinity, -1]) {
    assert.deepEqual(modeledDemandSegments([first, second, projection(2030, value), afterGap], first), [[first, second], [afterGap]]);
  }
  assert.deepEqual(modeledDemandSegments([first, second, projection(2030), projection(2030, 80_000, { id: 'duplicate' }), afterGap], first), [[first, second], [afterGap]]);
  assert.deepEqual(modeledDemandSegments([first], first), [[first]]);
  assert.deepEqual(modeledDemandSegments([projection(2020, null)], first), []);
  assert.deepEqual(modeledDemandSegments([], first), []);
});

test('modeled demand excludes incompatible boundaries, methods, sources, metrics, units, cadence and scenarios', () => {
  const first = projection(2020), last = projection(2030);
  const incompatible = [
    projection(2025, 100, { scopeId: 'B', matchedBuildingIds: ['B'] }),
    projection(2025, 100, { matchedBuildingIds: ['B'] }),
    projection(2025, 100, { scopeId: 'B' }),
    projection(2025, 100, { scope: 'property' }),
    projection(2025, 100, { unmatchedSourceIds: ['missing'] }),
    projection(2025, 100, { matchedBuildingIds: ['A', 'B'] }),
    projection(2025, 100, { method: 'measured' }),
    projection(2025, 100, { sourceId: 'another-model' }),
    projection(2025, 100, { metric: 'electricity_consumption' }),
    projection(2025, 100, { unit: 'MWh' }),
    projection(2025, 100, { period: { start: '2025-01-01', end: '2025-02-01' } }),
    projection(2025, 100, { period: { start: 'invalid', end: 'invalid' } }),
    projection(2025, 100, { scenario: 'Refurbishment (BAU)' }),
    projection(2025, 100, { scenario: '2020 baseline (SQ)' }),
    projection(2026)
  ];
  assert.deepEqual(modeledDemandSegments([first, ...incompatible, last], first), [[first], [last]]);
  for (const selected of [energy(), projection(2025, 100, { method: 'measured' }), projection(2025, 100, { unit: 'MWh' }),
    projection(2025, 100, { scenario: 'Refurbishment (BAU)' }), projection(2026)]) {
    assert.deepEqual(modeledDemandSegments([first, last], selected), []);
  }
});


test('monthly electricity bars sum recorded days chronologically across years, preserving zero and empty months', () => {
  const records = [day('2026-03-01', '2026-03-02', 0), day('2025-12-31', '2026-01-01', 12.5),
    day('2026-01-01', '2026-01-02', 3), day('2026-01-03', '2026-01-04', 4.25),
    day('2026-01-04', '2026-01-05', null), day('2026-04-01', '2026-04-02', null),
    day('2026-04-02', '2026-04-03', NaN), day('2026-04-03', '2026-04-04', Infinity)];
  assert.deepEqual(monthlyEnergyUsage(records), [
    { month: '2025-12', value: 12.5 }, { month: '2026-01', value: 7.25 },
    { month: '2026-02', value: null }, { month: '2026-03', value: 0 },
    { month: '2026-04', value: null }
  ]);
  assert.deepEqual(monthlyEnergyUsage([]), []);
  assert.deepEqual(monthlyEnergyUsage([day('2026-01-01', '2026-01-02', null)]), [{ month: '2026-01', value: null }]);
});

test('monthly electricity bars respect Helsinki midnight, DST and leap-year days', () => {
  assert.deepEqual(monthlyEnergyUsage([
    day('2024-02-29', '2024-03-01', 5), day('2024-03-01', '2024-03-02', 7)
  ]), [{ month: '2024-02', value: 5 }, { month: '2024-03', value: 7 }]);
  assert.deepEqual(monthlyEnergyUsage([
    day('2026-02-28T22:00:00Z', '2026-03-01T22:00:00Z', 9),
    day('2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z', 11)
  ]), [{ month: '2026-03', value: 20 }]);
});

test('monthly electricity bars exclude incompatible boundaries, metrics, units, scenarios, sources and cadence', () => {
  const first = day('2026-01-01', '2026-01-02', 2);
  const overrides: Partial<EnergyRecord>[] = [{ scope: 'building' }, { scopeId: 'other-property' }, { metric: 'heating_demand' },
    { unit: 'MWh' }, { method: 'modeled' }, { sourceId: 'other' }, { scenario: 'projection' },
    { period: { start: '2026-02-01', end: '2026-03-01' } }, { period: { start: 'invalid', end: 'invalid' } }];
  assert.deepEqual(monthlyEnergyUsage([first, ...overrides.map(override => day('2026-02-01', '2026-02-02', 100, override))]),
    [{ month: '2026-01', value: 2 }]);
  for (const override of overrides.filter(override => !override.scopeId && !override.sourceId && !override.scenario)) {
    assert.deepEqual(monthlyEnergyUsage([day('2026-01-01', '2026-01-02', 2, override)]), []);
  }
});


test('electricity chart values use readable energy units without changing the underlying readings', () => {
  for (const [kwh, value, unit] of [[0, '0', 'kWh'], [42.567, '42.57', 'kWh'], [999, '999', 'kWh'],
    [1_000, '1', 'MWh'], [300_000, '300', 'MWh'], [173_390.33, '173.39', 'MWh'],
    [1_000_000, '1', 'GWh'], [4_317_983.99, '4.32', 'GWh']] as const) {
    assert.deepEqual(humanizeEnergyUsage(kwh), { value, unit });
  }
});


test('heat, solar and electricity use the same unit thresholds for totals and daily averages', () => {
  assert.deepEqual(formatEnergyRecord(energy({ value: 59_100 })), { value: '59.1 MWh/year', dailyAverage: '≈161.48 kWh/day average' });
  assert.deepEqual(formatEnergyRecord(solar({ value: 366_000 })), { value: '366 MWh/year', dailyAverage: '≈1 MWh/day average' });
  assert.deepEqual(formatEnergyRecord(day('2026-10-01', '2026-10-02', 6_520.9)), { value: '6.52 MWh', dailyAverage: null });
  assert.deepEqual(formatEnergyRecord(energy({ value: 48_458.48, period: { start: '2026-10-01', end: '2026-11-01' } })),
    { value: '48.46 MWh', dailyAverage: null });
  assert.deepEqual(humanizeEnergyUsage(300, 'MWh'), { value: '300', unit: 'MWh' });
  assert.deepEqual(humanizeEnergyUsage(1_000, 'MWh'), { value: '1', unit: 'GWh' });
  assert.deepEqual(humanizeEnergyUsage(0.0005, 'GWh'), { value: '500', unit: 'kWh' });
  assert.deepEqual(humanizeEnergyUsage(0, 'GWh'), { value: '0', unit: 'kWh' });
  assert.deepEqual(formatEnergyRecord(energy({ value: 366, unit: 'MWh' })), { value: '366 MWh/year', dailyAverage: '≈1 MWh/day average' });
});


test('modeled demand defaults to the latest available completed year without selecting current or future years', () => {
  const records = [2030, 2020, 2025, 2026].map(year => projection(year));
  const original = [...records];
  assert.equal(latestCompletedModeledDemand(records, 2026)?.id, 'model-2025');
  assert.equal(latestCompletedModeledDemand(records, 2025)?.id, 'model-2020');
  assert.equal(latestCompletedModeledDemand(records, 2031)?.id, 'model-2030');
  assert.deepEqual(records, original);
  assert.equal(latestCompletedModeledDemand([projection(2020), projection(2025, null)], 2026)?.id, 'model-2020');
  assert.equal(latestCompletedModeledDemand([projection(2025, 0)], 2026)?.value, 0);
  assert.equal(latestCompletedModeledDemand([], 2026), null);
  assert.equal(latestCompletedModeledDemand([projection(2030)], 2026), null);
  for (const record of [projection(2025, NaN), projection(2025, Infinity), projection(2025, 1, { method: 'measured' }),
    projection(2025, 1, { period: { start: 'invalid', end: 'invalid' } }),
    projection(2025, 1, { period: { start: '2025-01-01', end: '2025-02-01' } })]) {
    assert.equal(latestCompletedModeledDemand([record], 2026), null);
  }
});


test('heat-demand shortcut selects the closest supplied annual year and keeps its scenario', () => {
  const choices = energyThemeOptions(catalog([2020, 2025, 2030].map(year => energy({
    id: String(year), metric: 'heat_dhw_demand', period: { start: `${year}-01-01`, end: `${year + 1}-01-01` },
    scenario: year === 2020 ? '2020 baseline (SQ)' : 'Climate change (CC)'
  }))));
  assert.equal(closestHeatDemandTheme(choices, 2026)?.period, '2025-01-01 – 2026-01-01');
  assert.equal(closestHeatDemandTheme(choices, 2026)?.scenario, 'Climate change (CC)');
  assert.equal(closestHeatDemandTheme(choices, 2022.5)?.period, '2020-01-01 – 2021-01-01');
  assert.equal(closestHeatDemandTheme([...choices].reverse(), 2022.5)?.period, '2020-01-01 – 2021-01-01');
  assert.equal(closestHeatDemandTheme(choices, 2035)?.period, '2030-01-01 – 2031-01-01');
});

test('heat-demand shortcut rejects missing, malformed and unrelated themes', () => {
  const choice = energyThemeOptions(catalog([energy({ metric: 'heat_dhw_demand' })]))[0];
  assert.equal(closestHeatDemandTheme([], 2026), null);
  assert.equal(closestHeatDemandTheme([choice], NaN), null);
  for (const period of ['invalid', '2025-13-01 – 2026-01-01', '2025-01-01 – 2027-01-01', '2025-02-01 – 2026-02-01']) {
    assert.equal(closestHeatDemandTheme([{ ...choice, period }], 2026), null);
  }
  assert.equal(closestHeatDemandTheme([{ ...choice, kind: 'solar' }], 2026), null);
  assert.equal(closestHeatDemandTheme([{ ...choice, metric: 'electricity_consumption' }], 2026), null);
});
