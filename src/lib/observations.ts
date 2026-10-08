import type { Observation } from './types.ts';

export type ObservationSourceId = 'fmi-weather' | 'fmi-air-quality';
export type ObservationState = 'current' | 'partial' | 'stale' | 'empty' | 'unavailable';
export const OBSERVATION_HISTORY_HOURS = 6;
export const OBSERVATION_PARAMETERS = [
  { id: 't2m', label: 'Temperature', sourceId: 'fmi-weather', staleAfterMs: 30 * 60_000, historyStepMs: 10 * 60_000 },
  { id: 'ws_10min', label: 'Wind speed', sourceId: 'fmi-weather', staleAfterMs: 30 * 60_000, historyStepMs: 10 * 60_000 },
  { id: 'wg_10min', label: 'Wind gust', sourceId: 'fmi-weather', staleAfterMs: 30 * 60_000, historyStepMs: 10 * 60_000 },
  { id: 'r_1h', label: 'Precipitation (1 h)', sourceId: 'fmi-weather', staleAfterMs: 2 * 3600_000, historyStepMs: 3600_000 },
  { id: 'NO2_PT1H_avg', label: 'Nitrogen dioxide', sourceId: 'fmi-air-quality', staleAfterMs: 2 * 3600_000, historyStepMs: 3600_000 }
] as const;

export interface ObservationSourceStatus {
  id: ObservationSourceId;
  state: ObservationState;
  message: string;
  provider: string;
  url: string;
  license: string;
  attribution: string;
  coverage: string;
  method: string;
  resolution: string;
  vintage: string | null;
  units: string[];
  parameters: string[];
  retrievedAt: string | null;
  requests: { url: string; retrievedAt: string; receivedAt: string }[];
  metadataRetrievedAt: string | null;
  observedAt: string | null;
  lastAttemptAt: string | null;
  nextRefreshAt: string | null;
  refreshMs: number;
  staleAfterMs: number;
  lastError: string | null;
}
export interface ObservationSnapshot {
  generatedAt: string;
  historyHours: number;
  observations: Observation[];
  sources: ObservationSourceStatus[];
}
export interface ObservationStation {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  sourceId: string;
  parameters: string[];
}
export interface NearbyObservation {
  parameter: string;
  observation: Observation | null;
  distanceMetres: number | null;
  state: 'current' | 'stale' | 'unavailable';
  reason: string | null;
}

export function groupObservationStations(snapshot: ObservationSnapshot): ObservationStation[] {
  const stations = new Map<string, ObservationStation>();
  for (const reading of snapshot.observations) {
    const key = `${reading.sourceId}/${reading.stationId}`;
    let station = stations.get(key);
    if (!station) {
      station = { id: reading.stationId, name: reading.stationName, longitude: reading.longitude,
        latitude: reading.latitude, sourceId: reading.sourceId, parameters: [] };
      stations.set(key, station);
    }
    if (!station.parameters.includes(reading.parameter)) station.parameters.push(reading.parameter);
  }
  return [...stations.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function distanceMetres(longitude: number, latitude: number, reading: Observation): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (reading.latitude - latitude) * radians;
  const longitudeDelta = (reading.longitude - longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(latitude * radians)
    * Math.cos(reading.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearestObservation(snapshot: ObservationSnapshot, longitude: number, latitude: number,
  parameter: string, now = Date.now()): NearbyObservation {
  const missing = (reason: string): NearbyObservation => ({ parameter, observation: null, distanceMetres: null, state: 'unavailable', reason });
  const definition = OBSERVATION_PARAMETERS.find(value => value.id === parameter);
  if (!definition) return missing('This parameter is outside the verified station coverage.');
  if (![longitude, latitude, now].every(Number.isFinite) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    return missing('The selected object has no valid position.');
  }
  const records = snapshot.observations.filter(value => value.parameter === parameter);
  const latestValid = new Map<string, Observation>();
  for (const record of records) {
    const time = Date.parse(record.observedAt);
    if (record.value === null || !Number.isFinite(record.value) || !Number.isFinite(time) || time > now
      || !Number.isFinite(record.longitude) || !Number.isFinite(record.latitude)
      || Math.abs(record.longitude) > 180 || Math.abs(record.latitude) > 90) continue;
    const key = `${record.sourceId}/${record.stationId}`;
    if (!latestValid.has(key) || Date.parse(latestValid.get(key)!.observedAt) < time) latestValid.set(key, record);
  }
  const candidates = [...latestValid.values()].map(observation => ({ observation, distance: distanceMetres(longitude, latitude, observation) }))
    .sort((a, b) => a.distance - b.distance || a.observation.stationId.localeCompare(b.observation.stationId));
  const nearest = candidates[0];
  if (!nearest) {
    const source = snapshot.sources.find(value => value.id === definition.sourceId);
    return missing(records.length ? `No valid ${definition.label.toLowerCase()} reading is available in this station window.`
      : source?.state === 'unavailable' ? `${definition.label} source unavailable: ${source.message}`
        : `No ${definition.label.toLowerCase()} observation was returned by the verified stations.`);
  }
  const source = snapshot.sources.find(value => value.id === nearest.observation.sourceId);
  const stale = now - Date.parse(nearest.observation.observedAt) > definition.staleAfterMs || !!source?.lastError;
  const newerMissing = records.some(value => value.stationId === nearest.observation.stationId
    && value.sourceId === nearest.observation.sourceId && Date.parse(value.observedAt) > Date.parse(nearest.observation.observedAt)
    && value.value === null);
  return { parameter, observation: nearest.observation, distanceMetres: nearest.distance, state: stale ? 'stale' : 'current',
    reason: source?.lastError ? `Refresh failed; showing the last dated ${definition.label.toLowerCase()} reading.`
      : stale ? `${definition.label} reading is older than the display freshness limit.`
        : newerMissing ? 'The newest reading is missing; showing the latest valid station reading.' : null };
}

export function observationHistory(observations: Observation[], stationId: string, parameter: string): Observation[] {
  return observations.filter(value => value.stationId === stationId && value.parameter === parameter)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

/** Null values and absent expected timestamps break a line; never bridge an unobserved period. */
export function chartSegments(history: Observation[]): Observation[][] {
  const segments: Observation[][] = [];
  let segment: Observation[] = [];
  let previous: Observation | null = null;
  for (const reading of history) {
    const time = Date.parse(reading.observedAt);
    const step = OBSERVATION_PARAMETERS.find(value => value.id === reading.parameter)?.historyStepMs;
    if (reading.value === null || !Number.isFinite(reading.value) || !Number.isFinite(time)) {
      segment = []; previous = null; continue;
    }
    if (!previous || reading.parameter !== previous.parameter || reading.stationId !== previous.stationId
      || reading.sourceId !== previous.sourceId || time <= Date.parse(previous.observedAt)
      || (step !== undefined && time - Date.parse(previous.observedAt) > step * 1.5)) {
      segment = []; segments.push(segment);
    }
    segment.push(reading); previous = reading;
  }
  return segments;
}
