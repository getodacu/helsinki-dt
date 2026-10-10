import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EnergyCatalogState, EnergyProperty, MeasuredEnergySeries } from '../energy-types.ts';
import type { DatasetSource, EnergyRecord } from '../types.ts';
import { day, loadEnergyCatalog, object, timestamp } from './energy-catalog.ts';
import { requestText, type RequestOptions } from './io.ts';

export const ENERGY_UPSTREAM = 'https://helsinki-openapi.nuuka.cloud/api/v1.0/EnergyData/Daily/ListByProperty';
export const ENERGY_CACHE_DIRECTORY = resolve('.cache/energy/runtime');
export const ENERGY_MAX_BYTES = 256 * 1024;
export const ENERGY_MAX_ROWS = 397;
export const ENERGY_MAX_ENTRIES = 64;
export const ENERGY_REFRESH_MS = 6 * 3600_000;
export const ENERGY_MAX_INFLIGHT = 4;
export const ENERGY_MAX_REQUESTS_PER_MINUTE = 24;
type FetchEnergy = (url: string, options: RequestOptions) => Promise<{ body: string; retrievedAt: string }>;
interface DailyRow { timestamp: string; reportingGroup: string; locationName: string; value: number | null; unit: string }
interface SavedSeries { version: 1; fingerprint: string; window: { start: string; end: string }; retrievedAt: string; requestUrl: string; rowsSha256: string; rows: DailyRow[] }
interface CacheEntry { saved: SavedSeries | null; dueAt: number; lastAttemptAt: string | null; error: string | null; refreshFailed: boolean; pending: Promise<void> | null }
export interface EnergyQuery { propertyId: string; month: string | null }
export class EnergyRequestError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function shiftMonth(month: string, offset: number): string {
  const date = new Date(month + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
function energyDay(now: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function completedEnergyMonths(now = Date.now()): string[] {
  const current = energyDay(now).slice(0, 7);
  return Array.from({ length: 12 }, (_, index) => shiftMonth(current, -index - 1));
}
export function validateEnergyRequest(url: URL, now = Date.now()): EnergyQuery {
  if ([...url.searchParams.keys()].some(key => !['property', 'month'].includes(key))
    || url.searchParams.getAll('property').length !== 1 || url.searchParams.getAll('month').length > 1) throw new EnergyRequestError('Use one prepared property and an optional calendar month.');
  const propertyId = url.searchParams.get('property')!;
  if (!/^\d{3}-\d{3}-\d{4}-\d{4}$/.test(propertyId)) throw new EnergyRequestError('Invalid measured property identifier.');
  const month = url.searchParams.get('month');
  if (month !== null && month !== energyDay(now).slice(0, 7) && !completedEnergyMonths(now).includes(month)) throw new EnergyRequestError('Energy selection is limited to the current and previous twelve calendar months.');
  return { propertyId, month };
}
function nextDay(value: string): string { return new Date(Date.parse(value) + 86400_000).toISOString().slice(0, 10); }
function queryUrl(property: EnergyProperty, window: SavedSeries['window']): string {
  return ENERGY_UPSTREAM + '?' + new URLSearchParams({ Record: 'PropertyCode', SearchString: property.id, ReportingGroup: 'Electricity',
    StartTime: window.start, EndTime: new Date(Date.parse(window.end) - 86400_000).toISOString().slice(0, 10) });
}
export function decodeMeasuredDays(payload: unknown, property: EnergyProperty, window: SavedSeries['window']): DailyRow[] {
  if (!Array.isArray(payload) || payload.length > ENERGY_MAX_ROWS) throw new Error('Nuuka daily response exceeds its row bound');
  const seen = new Set<string>();
  let total = 0;
  for (const value of payload) {
    const row = object(value), date = typeof row.timestamp === 'string' ? row.timestamp.slice(0, 10) : '';
    if (!day(date) || row.timestamp !== date + 'T00:00:00' || date < window.start || date >= window.end
      || row.reportingGroup !== 'Electricity' || row.locationName !== property.name || row.unit !== 'kWh'
      || !(row.value === null || typeof row.value === 'number' && Number.isFinite(row.value)) || seen.has(date)) throw new Error('Invalid Nuuka daily date, unit, scope, value or duplicate');
    seen.add(date); total += (row.value as number | null) ?? 0;
    if (!Number.isFinite(total)) throw new Error('Nuuka daily values exceed the finite total bound');
  }
  return payload as DailyRow[];
}
function fingerprint(property: EnergyProperty, source: DatasetSource, cityGeneratedAt: string): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, cityGeneratedAt, property, sourceId: source.id, sourceVersion: source.checksum, vintage: source.vintage })).digest('hex');
}
function rowsForPeriod(rows: DailyRow[], property: EnergyProperty, start: string, end: string): EnergyRecord[] {
  const byDay = new Map(rows.map(row => [row.timestamp.slice(0, 10), row.value]));
  const records: EnergyRecord[] = [];
  for (let date = start; date < end; date = nextDay(date)) records.push({
    id: `nuuka:${property.id}:Electricity:${date}`, scope: 'property', scopeId: property.id,
    matchedBuildingIds: [...property.matchedBuildingIds], unmatchedSourceIds: [...property.unmatchedSourceIds],
    metric: 'electricity_consumption', period: { start: date, end: nextDay(date) }, value: byDay.get(date) ?? null,
    unit: 'kWh', method: 'measured', scenario: null, sourceId: 'helsinki-nuuka' });
  return records;
}
function complete(records: EnergyRecord[]): boolean { return records.length > 0 && records.every(record => record.value !== null); }

/** Fixed Nuuka endpoint, one bounded daily window, and one process-wide request budget. */
export class EnergyCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = 0;
  private attempts: number[] = [];
  private fetchEnergy: FetchEnergy;
  private catalog: () => Promise<EnergyCatalogState>;
  private now: () => number;
  private directory: string;
  private diskWrites: Promise<void> = Promise.resolve();
  constructor(options: { fetchEnergy?: FetchEnergy; loadCatalog?: () => Promise<EnergyCatalogState>; now?: () => number; cacheDirectory?: string } = {}) {
    this.fetchEnergy = options.fetchEnergy ?? requestText; this.catalog = options.loadCatalog ?? loadEnergyCatalog;
    this.now = options.now ?? Date.now; this.directory = options.cacheDirectory ?? ENERGY_CACHE_DIRECTORY;
  }
  async series(query: EnergyQuery): Promise<MeasuredEnergySeries> {
    const state = await this.catalog();
    if (!state.catalog) throw new EnergyRequestError(state.message ?? 'The prepared energy catalog is unavailable.', 503);
    const property = state.catalog.properties.find(property => property.id === query.propertyId);
    if (!property) throw new EnergyRequestError('This property is not in the prepared energy catalog.');
    const now = this.now(), today = energyDay(now), currentMonth = today.slice(0, 7);
    const allowed = [currentMonth, ...completedEnergyMonths(now)];
    if (query.month !== null && !allowed.includes(query.month)) throw new EnergyRequestError('Energy month is outside the bounded selection.');
    const source = state.catalog.sources.find(source => source.id === 'helsinki-nuuka')!;
    const version = fingerprint(property, source, state.catalog.cityGeneratedAt);
    const key = createHash('sha256').update(version + ':latest').digest('hex');
    const window = { start: allowed.at(-1)! + '-01', end: nextDay(today) };
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= ENERGY_MAX_ENTRIES) {
        const oldest = [...this.entries].find(([, value]) => !value.pending);
        if (!oldest) throw new EnergyRequestError('The energy cache is busy; retry shortly.', 503);
        this.entries.delete(oldest[0]);
      }
      entry = { saved: null, dueAt: 0, lastAttemptAt: null, error: null, refreshFailed: false, pending: null };
      this.entries.set(key, entry);
      entry.pending = this.readSaved(key, version, property, window).then(saved => {
        entry!.saved = saved;
        entry!.dueAt = saved && saved.window.end === window.end ? Date.parse(saved.retrievedAt) + ENERGY_REFRESH_MS : 0;
      }).finally(() => { entry!.pending = null; });
    }
    if (entry.pending) await entry.pending;
    if (entry.saved && entry.saved.window.end !== window.end && !entry.refreshFailed) entry.dueAt = 0;
    if (this.now() >= entry.dueAt && !entry.pending) entry.pending = this.refresh(key, version, property, window, entry).finally(() => { entry!.pending = null; });
    if (entry.pending) await entry.pending;
    const rows = entry.saved?.rows.filter(row => allowed.includes(row.timestamp.slice(0, 7))) ?? [];
    const availableMonths = [...new Set(rows.map(row => row.timestamp.slice(0, 7)))].sort().reverse();
    const historyRecords = rowsForPeriod(rows, property, window.start, window.end);
    const availableCompleteMonths = availableMonths.filter(month => month !== currentMonth
      && complete(historyRecords.filter(record => record.period.start.startsWith(month))));
    const month = query.month ?? availableMonths.find(month => rows.some(row => row.timestamp.startsWith(month) && row.value !== null)) ?? availableMonths[0] ?? currentMonth;
    const records = historyRecords.filter(record => record.period.start.startsWith(month));
    const isComplete = month !== currentMonth && complete(records);
    const empty = !records.some(record => record.value !== null);
    const messages = [state.status === 'stale' ? state.message : null, entry.error,
      !isComplete && !empty ? 'This month has missing daily readings; its total is unavailable.' : null,
      empty && entry.saved ? 'No finite daily electricity readings are available for this month.' : null];
    return { status: !entry.saved ? 'unavailable' : entry.refreshFailed || state.status === 'stale' ? 'stale' : empty ? 'empty' : 'current',
      property, metric: 'electricity_consumption', unit: 'kWh', method: 'measured', scope: 'property',
      period: { start: month + '-01', end: shiftMonth(month, 1) + '-01' }, timezone: 'Europe/Helsinki', resolution: 'daily', records, historyRecords,
      complete: isComplete, total: isComplete ? records.reduce((sum, record) => sum + record.value!, 0) : null,
      availableMonths, availableCompleteMonths,
      source: entry.saved ? { ...source, url: entry.saved.requestUrl, retrievedAt: entry.saved.retrievedAt,
        checksum: entry.saved.rowsSha256, units: ['kWh'],
        coverage: `Property ${property.id}; ${property.memberSourceIds.length} declared members, including unresolved associations.`,
        method: 'Measured daily property electricity; no building allocation. Daily source calendar labels have no timezone suffix; displayed in Europe/Helsinki. Successful requests are cached for six hours; failures retry after one minute and a new Helsinki calendar day or city/source version triggers a new lookup. Provider publication cadence is unknown.' } : source,
      retrievedAt: entry.saved?.retrievedAt ?? null, lastAttemptAt: entry.lastAttemptAt,
      message: messages.filter(Boolean).join(' ') || null };
  }
  private async readSaved(key: string, version: string, property: EnergyProperty, window: SavedSeries['window']): Promise<SavedSeries | null> {
    try {
      const path = resolve(this.directory, key + '.json');
      if ((await stat(path)).size > ENERGY_MAX_BYTES) return null;
      const bytes = await readFile(path);
      if (bytes.length > ENERGY_MAX_BYTES) return null;
      const value = object(JSON.parse(bytes.toString('utf8'))), savedWindow = object(value.window);
      if (value.version !== 1 || value.fingerprint !== version || !timestamp(value.retrievedAt)
        || Date.parse(value.retrievedAt as string) > this.now() + 60000 || !day(savedWindow.start) || !day(savedWindow.end)
        || savedWindow.start >= savedWindow.end || Date.parse(savedWindow.end) - Date.parse(savedWindow.start) > ENERGY_MAX_ROWS * 86400_000
        || savedWindow.end > window.end || savedWindow.start < shiftMonth(window.start.slice(0, 7), -1) + '-01'
        || value.requestUrl !== queryUrl(property, savedWindow as SavedSeries['window'])) return null;
      decodeMeasuredDays(value.rows, property, savedWindow as SavedSeries['window']);
      if (value.rowsSha256 !== createHash('sha256').update(JSON.stringify(value.rows)).digest('hex')) return null;
      return value as unknown as SavedSeries;
    } catch { return null; }
  }
  private async refresh(key: string, version: string, property: EnergyProperty, window: SavedSeries['window'], entry: CacheEntry) {
    const now = this.now(); entry.lastAttemptAt = new Date(now).toISOString();
    this.attempts = this.attempts.filter(attempt => now - attempt < 60000);
    if (this.inflight >= ENERGY_MAX_INFLIGHT || this.attempts.length >= ENERGY_MAX_REQUESTS_PER_MINUTE) {
      entry.refreshFailed = true; entry.error = 'The energy request budget is busy; dated readings are retained when available.'; entry.dueAt = now + 60000; return;
    }
    this.inflight++; this.attempts.push(now);
    try {
      const url = queryUrl(property, window);
      const response = await this.fetchEnergy(url, { maxBytes: ENERGY_MAX_BYTES, timeoutMs: 15000 });
      if (Buffer.byteLength(response.body) > ENERGY_MAX_BYTES || !timestamp(response.retrievedAt)) throw new Error('Invalid or oversized Nuuka response');
      const rows = decodeMeasuredDays(JSON.parse(response.body), property, window);
      entry.saved = { version: 1, fingerprint: version, window, requestUrl: url, retrievedAt: response.retrievedAt, rowsSha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), rows };
      entry.refreshFailed = false; entry.error = null; entry.dueAt = now + ENERGY_REFRESH_MS;
      try {
        const saved = entry.saved;
        const write = this.diskWrites.then(() => this.writeSaved(key, saved));
        this.diskWrites = write.catch(() => {}); await write;
      } catch { entry.error = 'The dated energy cache could not be saved to disk; these readings are retained in memory.'; }
    } catch (error) {
      entry.refreshFailed = true; entry.error = 'Municipal energy refresh failed; ' + (error instanceof Error ? error.message : 'upstream unavailable') + (entry.saved ? '. Dated readings are retained.' : '. No dated readings are cached.');
      entry.dueAt = now + 60000;
    } finally { this.inflight--; }
  }
  private async writeSaved(key: string, saved: SavedSeries) {
    await mkdir(this.directory, { recursive: true });
    const path = resolve(this.directory, key + '.json'), temporary = path + '.' + randomUUID() + '.tmp';
    try {
      const bytes = JSON.stringify(saved);
      if (Buffer.byteLength(bytes) > ENERGY_MAX_BYTES) throw new Error('Energy cache exceeds its byte bound');
      await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path);
      const files = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      const dated = await Promise.all(files.map(async name => ({ name, mtime: (await stat(resolve(this.directory, name))).mtimeMs })));
      dated.sort((a, b) => b.mtime - a.mtime);
      await Promise.all(dated.slice(ENERGY_MAX_ENTRIES).map(file => rm(resolve(this.directory, file.name), { force: true })));
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
export const energyCache = new EnergyCache();
