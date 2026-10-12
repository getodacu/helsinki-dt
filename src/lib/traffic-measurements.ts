import type { SceneStation } from './scene.ts';
import { formatDate } from './inspection.ts';

export const MEASUREMENT_RECENT_MS = 24 * 3600_000;
export const MEASUREMENT_REFRESH_MS = 5 * 60_000;
export const MEASUREMENT_MODES = [
  { key: 'vehicles', label: 'Vehicles' }, { key: 'cycling', label: 'Cycling' }, { key: 'walking', label: 'Walking' }
] as const;
export type MeasurementMode = typeof MEASUREMENT_MODES[number]['key'];
export type MeasurementState = 'loading' | 'ready' | 'partial' | 'dated' | 'unavailable';
export const TRAFFIC_MEASUREMENT_COLOUR = '#ef4444';
export interface TrafficCounter {
  id: string; upstreamId: string; name: string; source: string; sourceId: string | null;
  longitude: number; latitude: number; modes: MeasurementMode[];
  firstObservedAt: string | null; lastObservedAt: string | null;
}
export interface TrafficMeasurement {
  counterId: string; source: string; type: 'count' | 'speed'; mode: MeasurementMode | 'unknown';
  vehicleClass: string; direction: string; unit: string; value: number | null;
  durationSeconds: number; observedAt: string; retrievedAt: string;
}
export interface TrafficCount {
  counterId: string; mode: MeasurementMode | 'unknown'; observedAt: string; retrievedAt: string;
  durationSeconds: number; value: number | null; hourlyEquivalent: number | null; complete: boolean;
}
export interface TrafficCounterSummary {
  counterId: string; mode: MeasurementMode; latest: TrafficCount; maximum: TrafficCount; partial: boolean;
}
export interface MeasurementSourceStatus {
  name: string; description: string; license: string; state: MeasurementState;
  retrievedAt: string | null; observedAt: string | null; error: string | null;
}
export interface TrafficMeasurementSnapshot {
  generatedAt: string; state: MeasurementState; counters: TrafficCounter[]; summaries: TrafficCounterSummary[];
  sources: MeasurementSourceStatus[]; error: string | null;
}
export interface TrafficCounterDetail {
  generatedAt: string; state: MeasurementState; counter: TrafficCounter;
  measurements: TrafficMeasurement[]; counts: TrafficCount[]; summaries: TrafficCounterSummary[];
  window: { start: string; end: string } | null; retrievedAt: string | null; error: string | null;
}
const classification = (value: string) => value.trim().toLocaleLowerCase('fi').replace(/[_-]/g, ' ');
const totalClass = (value: string) => /^(all|total|vehicles?|kaikki|yhteensä)$/.test(classification(value));
const totalDirection = (value: string) => /^(all|total|both|kaikki|yhteensä)$/.test(classification(value));
export function measurementMode(vehicleClass: string, source: string): TrafficMeasurement['mode'] {
  const value = classification(vehicleClass);
  if (/bicycl|cyclist|cycle|polkupyör|pyörä/.test(value)) return 'cycling';
  if (/pedestrian|walking|foot|jalankulk|kävel/.test(value)) return 'walking';
  if (/auto|bussi|bus|car|truck|lorry|van|motor|tram|raitiovaunu|ajoneuvo|vehicle/.test(value)) return 'vehicles';
  if ((totalClass(value) || /^(määrittelemätön|unknown|unspecified|)$/.test(value)) && ['Fintraffic', 'HEL LAM', 'InfoTripla', 'LIVA', 'Marksman', 'SmartJunction'].includes(source)) return 'vehicles';
  return 'unknown';
}
/** Prefer provider totals to their classes; never add the same observation twice. */
export function aggregateTrafficCounts(measurements: readonly TrafficMeasurement[]): TrafficCount[] {
  const groups = new Map<string, TrafficMeasurement[]>();
  for (const row of measurements) {
    if (row.type !== 'count') continue;
    const key = JSON.stringify([row.counterId, row.mode, row.observedAt, row.durationSeconds]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  return [...groups.values()].map(rows => {
    const unique = new Map<string, TrafficMeasurement>(); let complete = true;
    for (const row of rows) {
      const key = JSON.stringify([row.source, row.direction, row.vehicleClass]);
      const previous = unique.get(key);
      if (previous && previous.value !== row.value) complete = false;
      unique.set(key, row);
    }
    const directions = new Map<string, TrafficMeasurement[]>();
    for (const row of unique.values()) {
      const group = directions.get(row.direction) ?? []; group.push(row); directions.set(row.direction, group);
    }
    const totals = [...directions].filter(([direction]) => totalDirection(direction));
    const selected = totals.length ? totals : [...directions];
    if (totals.length > 1) complete = false;
    let value = 0;
    for (const [, classes] of selected) {
      const totals = classes.filter(row => totalClass(row.vehicleClass));
      if (totals.length > 1) complete = false;
      const chosen = totals.length ? totals : classes;
      // Broad light/heavy categories can overlap detailed classes; keep their breakdown instead.
      const broad = (row: TrafficMeasurement) => /^(kevyt ajoneuvo|raskas ajoneuvo|light vehicles?|heavy vehicles?)$/.test(classification(row.vehicleClass));
      if (!totals.length && classes.some(broad) && classes.some(row => !broad(row))) complete = false;
      for (const row of chosen) {
        if (row.value === null || !['n', 'count', 'counts'].includes(row.unit) || !Number.isFinite(row.value) || row.value < 0) complete = false;
        else value += row.value;
      }
    }
    const first = rows[0];
    if (!Number.isSafeInteger(value)) complete = false;
    return { counterId: first.counterId, mode: first.mode, observedAt: first.observedAt,
      retrievedAt: rows.reduce((latest, row) => row.retrievedAt > latest ? row.retrievedAt : latest, first.retrievedAt),
      durationSeconds: first.durationSeconds, value: complete ? value : null,
      hourlyEquivalent: complete ? value * 3600 / first.durationSeconds : null, complete };
  }).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.counterId.localeCompare(b.counterId) || a.durationSeconds - b.durationSeconds);
}
export function latestTrafficCounts(counts: readonly TrafficCount[]): TrafficCount[] {
  const latest = new Map<string, TrafficCount>();
  for (const count of counts) {
    const key = `${count.counterId}:${count.mode}`, previous = latest.get(key);
    if (!previous || count.observedAt > previous.observedAt || (count.observedAt === previous.observedAt && count.durationSeconds > previous.durationSeconds)) latest.set(key, count);
  }
  return [...latest.values()];
}
export function trafficCountRecent(count: TrafficCount, now: number): boolean {
  const time = Date.parse(count.observedAt);
  return count.complete && count.value !== null && Number.isFinite(count.value) && count.hourlyEquivalent !== null
    && Number.isFinite(count.hourlyEquivalent) && time > now - MEASUREMENT_RECENT_MS && time <= now;
}
export function summarizeTrafficCounts(counts: readonly TrafficCount[], now: number, partial = false): TrafficCounterSummary[] {
  const summaries = new Map<string, TrafficCounterSummary>();
  for (const count of counts) {
    if (count.mode === 'unknown' || !trafficCountRecent(count, now)) continue;
    const key = `${count.counterId}:${count.mode}`, previous = summaries.get(key);
    if (!previous) { summaries.set(key, { counterId: count.counterId, mode: count.mode, latest: count, maximum: count, partial }); continue; }
    if (count.observedAt > previous.latest.observedAt || count.observedAt === previous.latest.observedAt && count.durationSeconds > previous.latest.durationSeconds) previous.latest = count;
    if (count.hourlyEquivalent! > previous.maximum.hourlyEquivalent! || count.hourlyEquivalent === previous.maximum.hourlyEquivalent && count.observedAt > previous.maximum.observedAt) previous.maximum = count;
  }
  return [...summaries.values()];
}
export const measurementTime = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export const countInterval = (count: TrafficCount) => `${count.value} / ${count.durationSeconds / 60} min`;
export function activeTrafficCounters(snapshot: TrafficMeasurementSnapshot | null, now: number): TrafficCounter[] {
  const modes = new Map<string, MeasurementMode[]>();
  for (const summary of snapshot?.summaries ?? []) if (trafficCountRecent(summary.latest, now)) {
    const values = modes.get(summary.counterId) ?? []; values.push(summary.mode); modes.set(summary.counterId, values);
  }
  return (snapshot?.counters ?? []).filter(counter => modes.has(counter.id)).map(counter => ({ ...counter, modes: modes.get(counter.id)! }));
}
export function trafficCounterStations(snapshot: TrafficMeasurementSnapshot | null, mode: MeasurementMode, now: number): SceneStation[] {
  if (!snapshot) return [];
  const readings = new Map(snapshot.summaries.filter(row => row.mode === mode && trafficCountRecent(row.latest, now)).map(row => [row.counterId, row]));
  return activeTrafficCounters(snapshot, now).filter(counter => readings.has(counter.id)).map(counter => {
    const summary = readings.get(counter.id)!;
    return { id: `traffic:${counter.id}`, name: `${counter.source} · counter ${counter.upstreamId}`, longitude: counter.longitude, latitude: counter.latitude,
      kind: 'traffic-counter', sourceIds: [counter.source], colour: TRAFFIC_MEASUREMENT_COLOUR, trafficSummary: summary,
      detail: `${counter.source} · ${countInterval(summary.latest)} · ${formatDate(summary.latest.observedAt)} · ${summary.partial ? 'Observed max' : 'Max'} 24 h ${Math.round(summary.maximum.hourlyEquivalent!)} / h · ${formatDate(summary.maximum.observedAt)}` };
  });
}
export const trafficCounterLocation = (counter: Pick<TrafficCounter, 'longitude' | 'latitude'>) => `${counter.longitude.toFixed(5)}:${counter.latitude.toFixed(5)}`;
export function colocatedCounters(counters: readonly TrafficCounter[], counter: TrafficCounter): TrafficCounter[] {
  const location = trafficCounterLocation(counter);
  return counters.filter(item => trafficCounterLocation(item) === location);
}
export function trafficHistorySegments(history: readonly TrafficCount[]): TrafficCount[][] {
  const segments: TrafficCount[][] = []; let previous: TrafficCount | undefined;
  for (const row of history) {
    if (row.value === null || !row.complete) { previous = undefined; continue; }
    if (!previous || row.durationSeconds !== previous.durationSeconds
      || Date.parse(row.observedAt) - Date.parse(previous.observedAt) > previous.durationSeconds * 1500) segments.push([]);
    segments.at(-1)!.push(row); previous = row;
  }
  return segments;
}
