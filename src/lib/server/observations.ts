import { RELEASE_BOUNDS, inBounds } from '../area.ts';
import { decodeFmiObservations, parseFmiParameters, type ParameterMetadata } from '../data/fmi.ts';
import { OBSERVATION_HISTORY_HOURS, OBSERVATION_PARAMETERS,
  type ObservationSnapshot, type ObservationSourceId, type ObservationSourceStatus } from '../observations.ts';
import type { Observation } from '../types.ts';
import { requestText, type RequestOptions } from './io.ts';

const WFS = 'https://opendata.fmi.fi/wfs';
export const OBSERVATION_MAX_BYTES = 2 * 1024 ** 2;
export const OBSERVATION_TIMEOUT_MS = 30_000;
export const OBSERVATION_MAX_RECORDS = 5_000;
const METADATA_REFRESH_MS = 24 * 3600_000;
const SOURCES = [
  { id: 'fmi-weather', query: 'fmi::observations::weather::timevaluepair', stationId: '100971',
    provider: 'Finnish Meteorological Institute', stationName: 'Helsinki Kaisaniemi', refreshMs: 5 * 60_000, timestep: '10', staleAfterMs: 30 * 60_000 },
  { id: 'fmi-air-quality', query: 'urban::observations::airquality::hourly::timevaluepair', stationId: '100742',
    provider: 'HSY via Finnish Meteorological Institute', stationName: 'Helsinki Mannerheimintie', refreshMs: 15 * 60_000, timestep: '60', staleAfterMs: 2 * 3600_000 }
] as const;
type SourceConfig = typeof SOURCES[number];
type FetchXml = (url: string, options: RequestOptions) => Promise<{ body: string; retrievedAt: string }>;
interface CacheEntry { observations: Observation[]; source: ObservationSourceStatus; dueAt: number; pending: Promise<void> | null }

function initialSource(config: SourceConfig): ObservationSourceStatus {
  return { id: config.id, state: 'unavailable', message: 'Observations have not been fetched yet.', provider: config.provider,
    url: WFS, license: 'CC BY 4.0', attribution: `${config.provider}; FMI Open Data`,
    coverage: `${config.stationName} (${config.stationId}) only; selected central Helsinki station coverage.`,
    method: 'Station observations; no interpolation or AQI.',
    resolution: `Requested every ${config.timestep} minutes; each value retains its provider aggregation period.`,
    vintage: null, units: [], requests: [], parameters: OBSERVATION_PARAMETERS.filter(value => value.sourceId === config.id).map(value => value.id),
    retrievedAt: null, metadataRetrievedAt: null, observedAt: null, lastAttemptAt: null, nextRefreshAt: null,
    refreshMs: config.refreshMs, staleAfterMs: config.staleAfterMs, lastError: null };
}

/** One fixed station/window cache per process; browsers cannot expand the upstream query. */
export class ObservationCache {
  private readonly fetchXml: FetchXml;
  private readonly now: () => number;
  private entries: Map<ObservationSourceId, CacheEntry>;
  private metadata: { parameters: Record<string, ParameterMetadata>; retrievedAt: string; dueAt: number } | null = null;
  private metadataPending: Promise<NonNullable<ObservationCache['metadata']>> | null = null;

  constructor(fetchXml: FetchXml = requestText, now: () => number = Date.now) {
    this.fetchXml = fetchXml; this.now = now;
    this.entries = new Map(SOURCES.map(config => [config.id, { observations: [], source: initialSource(config), dueAt: 0, pending: null }]));
  }

  async snapshot(): Promise<ObservationSnapshot> {
    await Promise.all(SOURCES.map(config => this.refresh(config)));
    const now = this.now();
    const sources = SOURCES.map(config => {
      const entry = this.entries.get(config.id)!;
      const source = { ...entry.source, parameters: [...entry.source.parameters], units: [...entry.source.units], requests: entry.source.requests.map(value => ({ ...value })) };
      if (source.lastError) return source;
      if (!entry.observations.length) return source;
      const latest = source.parameters.map(parameter => entry.observations.filter(value => value.parameter === parameter)
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]);
      const missing = latest.filter(value => !value || value.value === null).length;
      const latestValid = source.parameters.map(parameter => entry.observations.filter(value => value.parameter === parameter && value.value !== null)
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]);
      const stale = latestValid.filter(value => value && now - Date.parse(value.observedAt)
        > OBSERVATION_PARAMETERS.find(parameter => parameter.id === value.parameter)!.staleAfterMs).length;
      source.state = stale ? 'stale' : missing ? 'partial' : 'current';
      source.message = stale ? `Dated station observations; ${stale} parameter(s) exceed their display freshness limit.`
        : missing ? `${missing} requested parameter(s) have no current valid reading; missing values stay empty.`
          : 'Station observations available; measurement times are independent of live traffic.';
      return source;
    });
    return { generatedAt: new Date(now).toISOString(), historyHours: OBSERVATION_HISTORY_HOURS,
      observations: [...this.entries.values()].flatMap(entry => entry.observations.map(value => ({ ...value }))), sources };
  }

  private parameters(): Promise<NonNullable<ObservationCache['metadata']>> {
    if (this.metadata && this.now() < this.metadata.dueAt) return Promise.resolve(this.metadata);
    if (this.metadataPending) return this.metadataPending;
    const url = `https://opendata.fmi.fi/meta?${new URLSearchParams({ observableProperty: 'observation',
      param: OBSERVATION_PARAMETERS.map(value => value.id).join(','), language: 'eng' })}`;
    this.metadataPending = this.fetchXml(url, { maxBytes: OBSERVATION_MAX_BYTES, timeoutMs: OBSERVATION_TIMEOUT_MS }).then(response => {
      const parameters = parseFmiParameters(response.body);
      for (const parameter of OBSERVATION_PARAMETERS) {
        if (!parameters[parameter.id.toLowerCase()]) throw new Error(`Missing verified metadata for ${parameter.id}`);
      }
      if (!Number.isFinite(Date.parse(response.retrievedAt))) throw new Error('Invalid metadata retrieval time');
      this.metadata = { parameters, retrievedAt: new Date(response.retrievedAt).toISOString(), dueAt: this.now() + METADATA_REFRESH_MS };
      return this.metadata;
    }).finally(() => { this.metadataPending = null; });
    return this.metadataPending;
  }

  private refresh(config: SourceConfig): Promise<void> {
    const entry = this.entries.get(config.id)!;
    if (entry.pending) return entry.pending;
    if (this.now() < entry.dueAt) return Promise.resolve();
    const attemptAt = this.now();
    entry.source.lastAttemptAt = new Date(attemptAt).toISOString();
    // ponytail: Two A-verified stations bound coverage; expand only after new station/parameter evidence.
    entry.pending = (async () => {
      try {
        const metadata = await this.parameters();
        const end = new Date(attemptAt);
        const start = new Date(attemptAt - OBSERVATION_HISTORY_HOURS * 3600_000);
        const groups = config.id === 'fmi-weather'
          ? [{ parameters: entry.source.parameters.filter(value => value !== 'r_1h'), timestep: '10' }, { parameters: ['r_1h'], timestep: '60' }]
          : [{ parameters: entry.source.parameters, timestep: config.timestep }];
        const responses = await Promise.all(groups.map(async group => {
          const url = `${WFS}?${new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature',
            storedquery_id: config.query, fmisid: config.stationId, parameters: group.parameters.join(','),
            timestep: group.timestep, starttime: start.toISOString(), endtime: end.toISOString() })}`;
          const response = await this.fetchXml(url, { maxBytes: OBSERVATION_MAX_BYTES, timeoutMs: OBSERVATION_TIMEOUT_MS });
          const receivedAt = new Date(this.now()).toISOString();
          if (!Number.isFinite(Date.parse(response.retrievedAt))) throw new Error('Invalid FMI retrieval time');
          const values = decodeFmiObservations(response.body, metadata.parameters, receivedAt, config.id);
          if (values.some(value => !group.parameters.includes(value.parameter))) throw new Error('Unexpected FMI parameter');
          return { url, retrievedAt: new Date(response.retrievedAt).toISOString(), receivedAt, values };
        }));
        const observations = responses.flatMap(response => response.values);
        if (observations.length > OBSERVATION_MAX_RECORDS) throw new Error('Excessive FMI observations');
        const keys = new Set<string>();
        for (const reading of observations) {
          const time = Date.parse(reading.observedAt);
          const key = `${reading.stationId}/${reading.parameter}/${reading.observedAt}`;
          if (reading.stationId !== config.stationId || !entry.source.parameters.includes(reading.parameter)
            || !inBounds(reading.longitude, reading.latitude, RELEASE_BOUNDS) || time < start.getTime() || time > end.getTime()
            || keys.has(key)) throw new Error('FMI response exceeds the fixed station, parameter or time bounds');
          keys.add(key);
        }
        entry.observations = observations;
        entry.source = { ...entry.source, state: observations.length ? 'current' : 'empty',
          message: observations.length ? 'Station observations available.' : 'The station returned no observations in this six-hour window.',
          url: responses[0].url, requests: responses.map(({ url, retrievedAt, receivedAt }) => ({ url, retrievedAt, receivedAt })), vintage: `${start.toISOString()}–${end.toISOString()}`, retrievedAt: new Date(Math.max(...responses.map(response => Date.parse(response.retrievedAt)))).toISOString(),
          metadataRetrievedAt: metadata.retrievedAt,
          observedAt: observations.length ? new Date(Math.max(...observations.map(value => Date.parse(value.observedAt)))).toISOString() : null,
          units: [...new Set(entry.source.parameters.map(parameter => metadata.parameters[parameter.toLowerCase()].unit))], lastError: null };
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 250) : 'Unknown upstream error';
        entry.source = { ...entry.source, state: entry.observations.length ? 'stale' : 'unavailable', lastError: message,
          message: entry.observations.length ? `Refresh failed; retaining dated station observations. ${message}` : `Station source unavailable. ${message}` };
      } finally {
        entry.dueAt = this.now() + config.refreshMs;
        entry.source.nextRefreshAt = new Date(entry.dueAt).toISOString();
        entry.pending = null;
      }
    })();
    return entry.pending;
  }
}

export function validateObservationRequest(url: URL): string | null {
  return url.searchParams.size ? 'This endpoint serves a fixed six-hour station window and accepts no query parameters.' : null;
}
export const observationCache = new ObservationCache();
