import type { DatasetSource, GateResult, Observation, ProbeEvidence } from '../src/lib/types.ts';
import { requestText } from '../src/lib/server/io.ts';
import { decodeFmiObservations, discoverFmiQueries, parseFmiParameters } from '../src/lib/data/fmi.ts';

export interface ObservationProbeResult {
  observations: Observation[];
  sources: DatasetSource[];
  evidence: ProbeEvidence[];
  gates: Record<string, GateResult>;
  rawResponses: Record<string, string>;
}
const WFS = 'https://opendata.fmi.fi/wfs';
const PARAMETERS = 't2m,ws_10min,wg_10min,NO2_PT1H_avg';
export async function probeObservations(): Promise<ObservationProbeResult> {
  const result: ObservationProbeResult = { observations: [], sources: [], evidence: [], gates: {}, rawResponses: {} };
  const base = { service: 'WFS', version: '2.0.0' };
  const queryUrl = (parameters: Record<string, string>) => `${WFS}?${new URLSearchParams({ ...base, ...parameters })}`;
  const fetchXml = async (id: string, url: string): Promise<{ xml: string; receivedAt: string }> => {
    const response = await requestText(url, { maxBytes: 2 * 1024 ** 2, timeoutMs: 30_000 });
    result.rawResponses[id] = response.body;
    result.evidence.push({ id, url, queriedAt: response.retrievedAt, durationMs: response.durationMs,
      status: response.status, decodedCount: 0, bytes: Buffer.byteLength(response.body), freshness: null,
      authentication: 'Anonymous WFS; no API key', notes: [] });
    return { xml: response.body, receivedAt: new Date().toISOString() };
  };
  try {
    const list = await fetchXml('fmi-query-list', queryUrl({ request: 'ListStoredQueries' }));
    const describe = await fetchXml('fmi-query-description', queryUrl({ request: 'DescribeStoredQueries', storedquery_id: 'fmi::observations::weather::timevaluepair,urban::observations::airquality::hourly::timevaluepair' }));
    const queries = discoverFmiQueries(list.xml, describe.xml);
    result.evidence.find((entry) => entry.id === 'fmi-query-description')!.decodedCount = queries.length;
    const meta = await fetchXml('fmi-parameters', `https://opendata.fmi.fi/meta?${new URLSearchParams({ observableProperty: 'observation', param: PARAMETERS, language: 'eng' })}`);
    const metadata = parseFmiParameters(meta.xml);
    result.evidence.find((entry) => entry.id === 'fmi-parameters')!.decodedCount = Object.keys(metadata).length;
    const end = new Date(Math.floor(Date.now() / 3600_000) * 3600_000 - 3600_000);
    const start = new Date(end.getTime() - 3 * 3600_000);
    for (const [gate, sourceId, query, station, parameters, provider] of [
      ['weather', 'fmi-weather', queries[0], '100971', 't2m,ws_10min,wg_10min', 'Finnish Meteorological Institute'],
      ['air_quality', 'fmi-air-quality', queries[1], '100742', 'NO2_PT1H_avg', 'HSY via Finnish Meteorological Institute']
    ] as const) {
      const url = queryUrl({ request: 'GetFeature', storedquery_id: query, fmisid: station, parameters, timestep: '60', starttime: start.toISOString(), endtime: end.toISOString() });
      try {
        const response = await fetchXml(sourceId, url);
        const observations = decodeFmiObservations(response.xml, metadata, response.receivedAt, sourceId);
        if (observations.some((observation) => observation.stationId !== station)) throw new Error('Unexpected FMI station');
        result.observations.push(...observations);
        const entry = result.evidence.find((value) => value.id === sourceId)!;
        entry.decodedCount = observations.length;
        entry.freshness = observations.length ? `${Math.round((Date.parse(response.receivedAt) - Math.max(...observations.map((value) => Date.parse(value.observedAt)))) / 1000)} seconds since latest observed value` : null;
        entry.notes = ['EPSG:4258 response positions are latitude longitude; station observations only', 'No quality flags exposed by selected timevaluepair response; normalized quality unknown', 'Hourly query timestep does not override parameter aggregation metadata'];
        result.sources.push({ id: sourceId, provider, url, license: 'CC BY 4.0', attribution: `${provider}; FMI Open Data`, retrievedAt: response.receivedAt,
          vintage: `${start.toISOString()}–${end.toISOString()}`, units: [...new Set(observations.map((value) => value.unit))],
          coverage: `Station ${station}; ${observations.length} parameter/time observations`, method: 'station observation', checksum: null,
          coordinateReference: 'EPSG:4258', axisOrder: 'latitude longitude in upstream gml:pos; normalized longitude latitude', verticalReference: null });
        result.gates[gate] = { status: observations.some((value) => value.value !== null) ? 'pass' : 'blocked',
          evidence: [`${sourceId}: ${observations.length} decoded observations at station ${station}, units ${[...new Set(observations.map((value) => value.unit))].join(', ')}`], nextAction: observations.some((value) => value.value !== null) ? null : 'Retry recent station window; all returned values are missing' };
      } catch (error) { result.gates[gate] = { status: 'blocked', evidence: [String(error)], nextAction: `Inspect/retry ${url}` }; }
    }
  } catch (error) {
    for (const gate of ['weather', 'air_quality']) result.gates[gate] ??= { status: 'blocked', evidence: [String(error)], nextAction: 'Retry/inspect FMI discovery and parameter metadata' };
  }
  return result;
}
