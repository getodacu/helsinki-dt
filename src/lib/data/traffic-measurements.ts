import { inBounds, RELEASE_BOUNDS } from '../area.ts';
import { measurementMode, type TrafficCounter, type TrafficMeasurement, type MeasurementSourceStatus } from '../traffic-measurements.ts';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a traffic measurement object');
  return value as Record<string, unknown>;
}
function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 4096) throw new Error('Invalid traffic measurement text');
  return value.trim();
}
export function counterId(value: unknown): string {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^\d{1,10}$/.test(value))) throw new Error('Invalid counter ID');
  const id = Number(value);
  if (id <= 0 || id > 2147483647) throw new Error('Invalid counter ID');
  return String(id);
}
export function trafficCounterKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Counter identity requires source and ID');
  const match = /^([A-Za-z][A-Za-z0-9 ]{0,31}):(\d{1,10})$/.exec(value);
  if (!match) throw new Error('Counter identity requires source and ID');
  return `${match[1]}:${counterId(match[2])}`;
}
function timestamp(value: unknown): string {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Invalid traffic timestamp');
  return new Date(date).toISOString();
}
export function decodeTrafficSources(value: unknown): MeasurementSourceStatus[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid traffic source metadata');
  const sources = value.map(row => {
    const source = object(row);
    return { name: text(source.name), description: text(source.description, true), license: text(source.license),
      state: 'loading' as const, retrievedAt: null, observedAt: null, error: null };
  });
  if (new Set(sources.map(source => source.name)).size !== sources.length) throw new Error('Duplicate traffic sources');
  return sources;
}
export function decodeTrafficCounters(value: unknown): { counters: TrafficCounter[]; next: string | null } {
  const page = object(value), collection = object(page.results);
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features) || collection.features.length > 1000) throw new Error('Invalid counter FeatureCollection');
  const counters: TrafficCounter[] = [];
  for (const value of collection.features) {
    const feature = object(value), properties = object(feature.properties);
    const id = counterId(feature.id);
    if (counterId(properties.id) !== id || feature.type !== 'Feature') throw new Error('Counter identity mismatch');
    if (feature.geometry === null) continue;
    const geometry = object(feature.geometry);
    if (geometry.type !== 'Point' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2
      || geometry.coordinates.some(value => typeof value !== 'number' || !Number.isFinite(value)) || properties.crsEpsg !== 4326) throw new Error('Invalid counter coordinates');
    const [longitude, latitude] = geometry.coordinates as number[];
    if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error('Invalid counter coordinates');
    if (!inBounds(longitude, latitude, RELEASE_BOUNDS)) continue;
    const source = text(properties.source);
    counters.push({ id: `${source}:${id}`, upstreamId: id, name: text(properties.name), source, sourceId: properties.sourceId == null ? null : String(properties.sourceId),
      longitude, latitude, modes: source === 'EcoCounter' ? ['cycling', 'walking'] : source === 'HEL LAM' ? ['vehicles', 'cycling'] : ['vehicles'],
      firstObservedAt: properties.firstStoredObservation == null ? null : timestamp(properties.firstStoredObservation),
      lastObservedAt: properties.lastStoredObservation == null ? null : timestamp(properties.lastStoredObservation) });
  }
  if (!(page.next === null || typeof page.next === 'string')) throw new Error('Invalid counter pagination');
  return { counters, next: page.next };
}
export function decodeTrafficMeasurements(value: unknown, retrievedAt: string): { measurements: TrafficMeasurement[]; next: string | null } {
  const page = object(value);
  if (!Array.isArray(page.results) || page.results.length > 5000 || !(page.next === null || typeof page.next === 'string')) throw new Error('Invalid observation page');
  const received = timestamp(retrievedAt);
  const measurements = page.results.flatMap(row => {
    const observation = object(row), type = text(observation.typeofmeasurement);
    if (!['count', 'speed'].includes(type)) return [];
    const durationSeconds = observation.phenomenondurationseconds;
    if (typeof durationSeconds !== 'number' || !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400) throw new Error('Invalid measurement duration');
    const value = observation.value;
    if (!(value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && (type !== 'count' || Number.isSafeInteger(value)))) throw new Error('Invalid measurement value');
    const source = text(observation.source), vehicleClass = text(observation.vehicletype, true);
    return [{ counterId: `${source}:${counterId(observation.counterId)}`, source, type: type as 'count' | 'speed',
      mode: measurementMode(vehicleClass, source), vehicleClass, direction: text(observation.direction, true),
      unit: text(observation.unit), value, durationSeconds, observedAt: timestamp(observation.datetime), retrievedAt: received }];
  });
  return { measurements, next: page.next };
}
