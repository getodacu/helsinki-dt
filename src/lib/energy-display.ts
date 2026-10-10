import type { EnergyCatalog, EnergyCatalogState, EnergyProperty } from './energy-types.ts';
import type { DatasetSource, EnergyRecord, SolarRecord } from './types.ts';

export const NO_ENERGY_COLOUR = '#e6e8db';
export const ENERGY_COLOURS = ['#a4d9d0', '#efd480', '#d78662'] as const;
export interface EnergyThemeOption {
  key: string;
  kind: 'modeled-demand' | 'solar';
  metric: string;
  unit: string;
  sourceId: string;
  period: string;
  scenario: string | null;
}
/** Choose one supplied annual heat/DHW model; never relabel a projection as a baseline. */
export function closestHeatDemandTheme(options: EnergyThemeOption[], currentYear = new Date().getFullYear()): EnergyThemeOption | null {
  if (!Number.isFinite(currentYear)) return null;
  const annual = options.flatMap(option => {
    const period = /^(\d{4})-01-01 – (\d{4})-01-01$/.exec(option.period);
    if (option.kind !== 'modeled-demand' || option.metric !== 'heat_dhw_demand' || !period
      || Number(period[2]) !== Number(period[1]) + 1) return [];
    return [{ option, year: Number(period[1]) }];
  });
  annual.sort((a, b) => Math.abs(a.year - currentYear) - Math.abs(b.year - currentYear) || a.year - b.year);
  return annual[0]?.option ?? null;
}

const energyKey = (record: EnergyRecord) => JSON.stringify(['modeled-demand', record.sourceId, record.metric, record.unit, record.period.start, record.period.end, record.scenario]);
const solarKey = (record: SolarRecord) => JSON.stringify(['solar', record.sourceId, record.metric, record.unit, record.calculationPeriod, record.vintage, record.assumptions]);
export const exactBuildingEnergy = (record: EnergyRecord) => record.scope === 'building' && record.matchedBuildingIds.length === 1 && record.unmatchedSourceIds.length === 0;
export const exactBuildingSolar = (record: SolarRecord) => record.scope === 'building' && record.matchedBuildingIds.length === 1;
export const propertyIsShared = (property: EnergyProperty) => property.shared || property.memberSourceIds.length > 1 || property.matchedBuildingIds.length > 1;

export function energyThemeOptions(catalog: EnergyCatalog | null): EnergyThemeOption[] {
  const options = new Map<string, EnergyThemeOption>();
  for (const record of catalog?.energy ?? []) if (record.method === 'modeled' && exactBuildingEnergy(record) && record.value !== null && Number.isFinite(record.value)) {
    const key = energyKey(record);
    options.set(key, { key, kind: 'modeled-demand', metric: record.metric, unit: record.unit, sourceId: record.sourceId,
      period: `${record.period.start} – ${record.period.end}`, scenario: record.scenario });
  }
  for (const record of catalog?.solar ?? []) if (exactBuildingSolar(record) && record.value !== null && Number.isFinite(record.value)) {
    const key = solarKey(record);
    options.set(key, { key, kind: 'solar', metric: record.metric, unit: record.unit, sourceId: record.sourceId,
      period: record.calculationPeriod, scenario: null });
  }
  return [...options.values()];
}

export function buildingEnergyTheme(catalog: EnergyCatalog | null, option: EnergyThemeOption | null, releaseIds?: ReadonlySet<string>) {
  const candidates = option?.kind === 'modeled-demand'
    ? (catalog?.energy ?? []).filter(record => record.method === 'modeled' && exactBuildingEnergy(record) && energyKey(record) === option.key)
    : option?.kind === 'solar' ? (catalog?.solar ?? []).filter(record => exactBuildingSolar(record) && solarKey(record) === option.key) : [];
  const values = new Map<string, number>(), seen = new Set<string>(), ambiguous = new Set<string>();
  for (const record of candidates) {
    const id = record.matchedBuildingIds[0];
    if (releaseIds && !releaseIds.has(id)) continue;
    if (seen.has(id)) ambiguous.add(id);
    seen.add(id);
    if (record.value !== null && Number.isFinite(record.value)) values.set(id, record.value);
  }
  for (const id of ambiguous) values.delete(id);
  const minimum = values.size ? Math.min(...values.values()) : null, maximum = values.size ? Math.max(...values.values()) : null;
  const colours = new Map<string, string>();
  for (const [id, value] of values) {
    const fraction = maximum === minimum ? 0.5 : (value - minimum!) / (maximum! - minimum!);
    colours.set(id, ENERGY_COLOURS[Math.min(2, Math.floor(fraction * 3))]);
  }
  return { colours, minimum, maximum, count: colours.size };
}

const periodParts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function cadence(record: EnergyRecord): 'daily' | 'monthly' | 'annual' | null {
  const start = Date.parse(record.period.start), end = Date.parse(record.period.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const parts = (value: string, at: number): Record<string, string> => /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { year: value.slice(0, 4), month: value.slice(5, 7), day: value.slice(8, 10), hour: '00', minute: '00', second: '00' }
    : Object.fromEntries(periodParts.formatToParts(at).map(part => [part.type, part.value]));
  const a = parts(record.period.start, start), b = parts(record.period.end, end);
  if (a.hour !== b.hour || a.minute !== b.minute || a.second !== b.second) return null;
  const day = (value: Record<string, string>) => Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day));
  if (day(b) - day(a) === 86_400_000) return 'daily';
  if (a.day !== '01' || b.day !== '01') return null;
  const months = (Number(b.year) - Number(a.year)) * 12 + Number(b.month) - Number(a.month);
  if (months === 1) return 'monthly';
  if (months === 12 && a.month === '01' && b.month === '01') return 'annual';
  return null;
}

const energyUnits = new Map([['kWh', 1], ['MWh', 1_000], ['GWh', 1_000_000]]);
export function humanizeEnergyUsage(value: number, unit = 'kWh') {
  const scale = energyUnits.get(unit);
  if (!scale) return { value: value.toLocaleString('en-GB', { maximumFractionDigits: 2 }), unit };
  const kwh = value * scale, magnitude = Math.abs(kwh);
  const divisor = magnitude >= 1_000_000 ? 1_000_000 : magnitude >= 1_000 ? 1_000 : 1;
  return { value: (kwh / divisor).toLocaleString('en-GB', { maximumFractionDigits: 2 }),
    unit: divisor === 1_000_000 ? 'GWh' : divisor === 1_000 ? 'MWh' : 'kWh' };
}

export function formatEnergyRecord(record: EnergyRecord | SolarRecord) {
  if (record.value === null || !Number.isFinite(record.value)) return { value: 'Unknown', dailyAverage: null };
  const display = humanizeEnergyUsage(record.value, record.unit);
  const original = { value: `${display.value} ${display.unit}`, dailyAverage: null };
  const scale = energyUnits.get(record.unit);
  if (!scale || record.value < 0) return original;
  const days = 'period' in record
    ? cadence(record) === 'annual' ? (Date.parse(record.period.end) - Date.parse(record.period.start)) / 86_400_000 : null
    // shortcut: solar has no weather year; use 365 days until the source supplies its calculation year.
    : /^annual\b/i.test(record.calculationPeriod) ? 365 : null;
  if (!days) return original;
  const daily = record.value * scale / days, average = humanizeEnergyUsage(daily);
  return {
    value: `${original.value}/year`,
    dailyAverage: daily > 0 && daily < 1 ? '<1 kWh/day average' : `≈${average.value} ${average.unit}/day average`
  };
}

/** One boundary, metric, unit, scenario and calendar cadence; DST days and variable months stay valid. */
export function compatibleEnergyHistory(records: EnergyRecord[]): EnergyRecord[] {
  const first = records[0];
  if (!first) return [];
  const expectedCadence = cadence(first);
  if (!expectedCadence) return [];
  return records.filter(record => record.sourceId === first.sourceId && record.scope === first.scope && record.scopeId === first.scopeId
    && record.metric === first.metric && record.unit === first.unit && record.method === first.method && record.scenario === first.scenario && cadence(record) === expectedCadence)
    .sort((a, b) => Date.parse(a.period.start) - Date.parse(b.period.start));
}
/** Monthly recorded usage keeps unread days out of the sum and empty months as gaps. */
export function monthlyEnergyUsage(records: EnergyRecord[]) {
  const history = compatibleEnergyHistory(records), first = history[0];
  if (!first || cadence(first) !== 'daily' || first.method !== 'measured' || first.scope !== 'property'
    || first.metric !== 'electricity_consumption' || first.unit !== 'kWh') return [];
  const monthKey = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(0, 7)
    : periodParts.format(new Date(date)).slice(0, 7);
  const months = new Map<string, { month: string; value: number | null }>();
  const lastMonth = monthKey(history.at(-1)!.period.start);
  for (let date = new Date(`${monthKey(first.period.start)}-01T00:00:00Z`); date.toISOString().slice(0, 7) <= lastMonth; date.setUTCMonth(date.getUTCMonth() + 1)) {
    const month = date.toISOString().slice(0, 7);
    months.set(month, { month, value: null });
  }
  for (const record of history) {
    if (record.value === null || !Number.isFinite(record.value)) continue;
    const month = months.get(monthKey(record.period.start))!;
    month.value = (month.value ?? 0) + record.value;
  }
  return [...months.values()];
}

export function energyChartSegments(records: EnergyRecord[]): EnergyRecord[][] {
  const segments: EnergyRecord[][] = [];
  let segment: EnergyRecord[] = [], previous: EnergyRecord | null = null;
  for (const record of compatibleEnergyHistory(records)) {
    if (record.value === null || !Number.isFinite(record.value) || !Number.isFinite(Date.parse(record.period.start))
      || !Number.isFinite(Date.parse(record.period.end)) || Date.parse(record.period.end) <= Date.parse(record.period.start)) {
      segment = []; previous = null; continue;
    }
    if (!previous || previous.period.end !== record.period.start) { segment = []; segments.push(segment); }
    segment.push(record); previous = record;
  }
  return segments;
}

export function latestCompletedModeledDemand(records: EnergyRecord[], currentYear = new Date().getFullYear()): EnergyRecord | null {
  return records.filter(record => record.method === 'modeled' && cadence(record) === 'annual'
    && record.value !== null && Number.isFinite(record.value) && Number(record.period.start.slice(0, 4)) < currentYear)
    .sort((a, b) => Date.parse(b.period.start) - Date.parse(a.period.start))[0] ?? null;
}

/** The verified Helsinki workbook links its SQ baseline to five-year CC projections. */
export function modeledDemandSegments(records: EnergyRecord[], selected: EnergyRecord): EnergyRecord[][] {
  const years = [2020, 2025, 2030, 2035, 2040, 2045, 2050];
  const selectedYear = Number(selected.period.start.slice(0, 4));
  if (selected.method !== 'modeled' || !exactBuildingEnergy(selected) || selected.sourceId !== 'helsinki-modeled-demand' || selected.unit !== 'kWh'
    || cadence(selected) !== 'annual' || !years.includes(selectedYear)
    || selected.scenario !== (selectedYear === 2020 ? '2020 baseline (SQ)' : 'Climate change (CC)')) return [];
  const compatible = records.filter(record => record.method === 'modeled' && exactBuildingEnergy(record)
    && record.scopeId === selected.scopeId && record.matchedBuildingIds[0] === selected.matchedBuildingIds[0]
    && record.sourceId === selected.sourceId && record.metric === selected.metric && record.unit === selected.unit && cadence(record) === 'annual');
  const segments: EnergyRecord[][] = [];
  let segment: EnergyRecord[] = [];
  for (const year of years) {
    const matches = compatible.filter(record => record.period.start === `${year}-01-01`
      && record.scenario === (year === 2020 ? '2020 baseline (SQ)' : 'Climate change (CC)'));
    const record = matches[0];
    if (matches.length !== 1 || record.value === null || !Number.isFinite(record.value) || record.value < 0) {
      segment = []; continue;
    }
    if (!segment.length) segments.push(segment);
    segment.push(record);
  }
  return segments;
}

/** Provider calendar dates are displayed without inventing a time-of-day boundary. */
export function formatEnergyDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', { timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'UTC' : 'Europe/Helsinki', dateStyle: 'medium' }).format(new Date(value));
}

/** A loaded scene can lag the server's newly published city generation. */
export function energyForCity(state: EnergyCatalogState, city: { generatedAt: string; sources: DatasetSource[] } | null): EnergyCatalogState {
  if (!state.catalog) return state;
  const prepared = state.catalog.sources.find(source => source.id === 'helsinki-semantic-tiles');
  const displayed = city?.sources.find(source => source.id === 'helsinki-semantic-tiles');
  if (state.catalog.cityGeneratedAt === city?.generatedAt && prepared?.checksum && prepared.checksum === displayed?.checksum) return state;
  return { ...state, status: 'unavailable', catalog: null, message: 'Energy records and the displayed city have different source versions. Prepare energy data for this city generation before attaching records.' };
}
