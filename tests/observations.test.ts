import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeFmiObservations, parseFmiParameters } from '../src/lib/data/fmi.ts';
import { ObservationCache, OBSERVATION_MAX_BYTES, OBSERVATION_TIMEOUT_MS, validateObservationRequest } from '../src/lib/server/observations.ts';
import { chartSegments, groupObservationStations, nearestObservation, observationHistory, type ObservationSnapshot } from '../src/lib/observations.ts';
import { GET } from '../src/routes/api/observations/+server.ts';
import type { Observation } from '../src/lib/types.ts';

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const START = Date.parse('2026-10-08T12:50:10.677Z');
const emptyXml = '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0" numberReturned="0"/>';
const selectedMembers = (xml: string, parameter: string, include: boolean) => xml.replace(/<wfs:member>[\s\S]*?<\/wfs:member>/g,
  member => member.includes(`param=${parameter}`) === include ? member : '');

async function harness() {
  let now = START;
  let failure: Error | null = null;
  let weather = selectedMembers(await fixture('fmi-c-weather.xml'), 'r_1h', false);
  let precipitation = await fixture('fmi-c-precipitation.xml');
  let airQuality = await fixture('fmi-c-air-quality.xml');
  const metadata = await fixture('fmi-c-parameters.xml');
  const requests: URL[] = [];
  const cache = new ObservationCache(async (url, options) => {
    requests.push(new URL(url));
    assert.equal(options.maxBytes, OBSERVATION_MAX_BYTES);
    assert.equal(options.timeoutMs, OBSERVATION_TIMEOUT_MS);
    await Promise.resolve();
    if (failure) throw failure;
    const parsed = new URL(url);
    let body = parsed.pathname === '/meta' ? metadata
      : parsed.searchParams.get('storedquery_id')?.startsWith('urban::') ? airQuality
        : parsed.searchParams.get('parameters') === 'r_1h' ? precipitation : weather;
    // Synthetic refresh responses omit points outside the newer request window.
    if (parsed.pathname === '/wfs') body = body.replace(/<wml2:point>[\s\S]*?<\/wml2:point>/g, point => {
      const time = Date.parse(point.match(/<wml2:time>(.*?)<\/wml2:time>/)![1]);
      return time < Date.parse(parsed.searchParams.get('starttime')!) ? '' : point;
    });
    return { retrievedAt: new Date(now - 200).toISOString(), body };
  }, () => now);
  return { cache, requests, setNow: (value: number) => { now = value; }, fail: (error = new Error('Deliberate offline source failure')) => { failure = error; },
    setWeather: (value: string) => { weather = value; }, setPrecipitation: (value: string) => { precipitation = value; },
    setAirQuality: (value: string) => { airQuality = value; } };
}

const reading = (overrides: Partial<Observation> = {}): Observation => ({ stationId: '100971', stationName: 'Helsinki Kaisaniemi',
  longitude: 24.94459, latitude: 60.17523, parameter: 't2m', value: 8.8, unit: 'degC', observedAt: '2026-10-08T12:40:00.000Z',
  receivedAt: '2026-10-08T12:50:10.677Z', quality: 'unknown', aggregation: 'avg PT1M', sourceId: 'fmi-weather', ...overrides });
const snapshot = (observations: Observation[]): ObservationSnapshot => ({ generatedAt: new Date(START).toISOString(), historyHours: 6, observations, sources: [] });

test('single flight shares bounded queries and refreshes weather at five minutes, air at fifteen', async () => {
  const h = await harness();
  const [first, concurrent] = await Promise.all([h.cache.snapshot(), h.cache.snapshot()]);
  assert.deepEqual(first, concurrent);
  assert.equal(h.requests.length, 4); // One metadata request, two weather queries, one NO2 query.
  assert.equal(first.sources.length, 2);
  assert.equal(first.sources[0].metadataRetrievedAt, new Date(START - 200).toISOString());
  assert.equal(first.sources[0].retrievedAt, new Date(START - 200).toISOString());
  assert.equal(first.observations[0].receivedAt, new Date(START).toISOString());
  for (const request of h.requests.filter(value => value.pathname === '/wfs')) {
    assert.equal(Date.parse(request.searchParams.get('endtime')!) - Date.parse(request.searchParams.get('starttime')!), 6 * 3600_000);
    assert.ok(['100971', '100742'].includes(request.searchParams.get('fmisid')!));
    assert.ok(['10', '60'].includes(request.searchParams.get('timestep')!));
  }
  await h.cache.snapshot();
  assert.equal(h.requests.length, 4);
  h.setNow(START + 5 * 60_000 - 1);
  await h.cache.snapshot();
  assert.equal(h.requests.length, 4);
  h.setNow(START + 5 * 60_000);
  await h.cache.snapshot();
  assert.equal(h.requests.length, 6);
  assert.equal(h.requests.filter(value => value.searchParams.get('fmisid') === '100742').length, 1);
  h.setNow(START + 15 * 60_000);
  await h.cache.snapshot();
  assert.equal(h.requests.filter(value => value.searchParams.get('fmisid') === '100742').length, 2);
  assert.equal(h.requests.filter(value => value.pathname === '/meta').length, 1);
});

test('a failed refresh keeps observations and original retrieval times, and never turns them fresh', async () => {
  const h = await harness();
  const first = await h.cache.snapshot();
  h.fail(); h.setNow(START + 5 * 60_000);
  const failed = await h.cache.snapshot();
  assert.deepEqual(failed.observations, first.observations);
  assert.equal(failed.sources[0].state, 'stale');
  assert.equal(failed.sources[0].retrievedAt, first.sources[0].retrievedAt);
  assert.equal(failed.sources[0].observedAt, first.sources[0].observedAt);
  assert.match(failed.sources[0].message, /retaining dated/);
  const nearest = nearestObservation(failed, 24.95, 60.17, 't2m', START + 5 * 60_000);
  assert.equal(nearest.state, 'stale');
  assert.ok(nearest.observation);
  assert.match(nearest.reason!, /Refresh failed/);
  const before = h.requests.length;
  await h.cache.snapshot();
  assert.equal(h.requests.length, before);
});

test('cold unavailable, empty coverage, partial missing parameters and observed staleness are distinct', async () => {
  const cold = await harness(); cold.fail();
  const unavailable = await cold.cache.snapshot();
  assert.equal(unavailable.observations.length, 0);
  assert.ok(unavailable.sources.every(value => value.state === 'unavailable'));
  assert.match(nearestObservation(unavailable, 24.95, 60.17, 't2m', START).reason!, /unavailable/);
  const empty = await harness(); empty.setWeather(emptyXml); empty.setPrecipitation(emptyXml); empty.setAirQuality(emptyXml);
  assert.ok((await empty.cache.snapshot()).sources.every(value => value.state === 'empty'));
  const partial = await harness(); partial.setPrecipitation(emptyXml);
  const mixed = await partial.cache.snapshot();
  assert.equal(mixed.sources[0].state, 'partial');
  assert.equal(nearestObservation(mixed, 24.95, 60.17, 'r_1h', START).observation, null);
  assert.match(nearestObservation(mixed, 24.95, 60.17, 'r_1h', START).reason!, /No precipitation/);
  assert.ok(mixed.observations.some(value => value.sourceId === 'fmi-air-quality'));
  partial.setNow(START + 29 * 60_000);
  assert.equal((await partial.cache.snapshot()).sources[0].state, 'stale');
});

test('actual station precipitation metadata, aggregation, nulls and UTC history survive normalization', async () => {
  const h = await harness();
  const values = await h.cache.snapshot();
  const rain = observationHistory(values.observations, '100971', 'r_1h');
  assert.equal(rain.length, 6);
  assert.ok(rain.every(value => value.unit === 'mm' && value.aggregation === 'acc PT1H' && value.quality === 'unknown'));
  assert.equal(chartSegments(rain).length, 1);
  assert.equal(groupObservationStations(values).length, 2);
  assert.equal(groupObservationStations(values)[1].name, 'Helsinki Kaisaniemi');
  assert.ok(values.observations.some(value => value.value === null));
  assert.ok(values.observations.every(value => value.observedAt.endsWith('Z')));
  const currentRain = nearestObservation(values, 24.95, 60.17, 'r_1h', START);
  assert.equal(currentRain.observation?.observedAt, '2026-10-08T12:00:00.000Z');
  assert.equal(currentRain.state, 'current');
});

test('nearest station is chosen separately for every parameter and skips missing/nonfinite/future readings', () => {
  const closer = reading({ stationId: 'near', longitude: 24.95, latitude: 60.17, value: null });
  const far = reading({ stationId: 'far', longitude: 24.96, latitude: 60.18 });
  const wind = reading({ stationId: 'near', longitude: 24.95, latitude: 60.17, parameter: 'ws_10min', value: 2.8, unit: 'm/s' });
  const invalid = reading({ stationId: 'invalid', longitude: 24.95, latitude: 60.17, value: Infinity });
  const future = reading({ stationId: 'future', longitude: 24.95, latitude: 60.17, observedAt: '2026-10-09T00:00:00.000Z' });
  const values = snapshot([closer, far, wind, invalid, future]);
  assert.equal(nearestObservation(values, 24.95, 60.17, 't2m', START).observation?.stationId, 'far');
  assert.equal(nearestObservation(values, 24.95, 60.17, 'ws_10min', START).observation?.stationId, 'near');
  assert.ok(nearestObservation(values, 24.95, 60.17, 't2m', START).distanceMetres! > 0);
  assert.equal(nearestObservation(values, NaN, 60.17, 't2m', START).observation, null);
  assert.equal(nearestObservation(values, 24.95, 60.17, 'AQI', START).observation, null);
  assert.equal(nearestObservation(snapshot([far]), 24.95, 60.17, 't2m', START + 3600_000).state, 'stale');
});

test('latest valid fallback has a reason and chart lines break at nulls and absent observation intervals', () => {
  const old = reading({ observedAt: '2026-10-08T12:40:00.000Z' });
  const nullValue = reading({ observedAt: '2026-10-08T12:50:00.000Z', value: null });
  assert.match(nearestObservation(snapshot([old, nullValue]), 24.95, 60.17, 't2m', START).reason!, /newest reading is missing/);
  const sequence = [reading({ observedAt: '2026-10-08T11:00:00.000Z' }), reading({ observedAt: '2026-10-08T11:10:00.000Z' }),
    reading({ observedAt: '2026-10-08T11:20:00.000Z', value: null }), reading({ observedAt: '2026-10-08T11:30:00.000Z' }),
    reading({ observedAt: '2026-10-08T12:00:00.000Z' })];
  const history = observationHistory([...sequence].reverse(), '100971', 't2m');
  assert.deepEqual(history, sequence);
  assert.deepEqual(chartSegments(history).map(value => value.length), [2, 1, 1]);
});

test('upstream stations, parameters, coordinates, timestamps, duplicate rows and excessive payloads are bounded', async () => {
  const base = selectedMembers(await fixture('fmi-c-weather.xml'), 'r_1h', false);
  const mutations = [base.replaceAll('100971', '999999'), base.replaceAll('60.17523 24.94459', '61.17523 24.94459'),
    base.replaceAll('param=t2m', 'param=r_1h'), base.replaceAll('2026-10-08T07:00:00Z', '2026-10-09T07:00:00Z'),
    base.replaceAll('2026-10-08T07:10:00Z', '2026-10-08T07:00:00Z')];
  for (const mutation of mutations) {
    const h = await harness(); h.setWeather(mutation);
    const value = await h.cache.snapshot();
    assert.equal(value.sources[0].state, 'unavailable');
    assert.ok(value.observations.every(reading => reading.sourceId === 'fmi-air-quality'));
  }
  const h = await harness(); h.setWeather('x'.repeat(OBSERVATION_MAX_BYTES + 1));
  assert.match((await h.cache.snapshot()).sources[0].lastError!, /safe bounds/);
  const metadata = parseFmiParameters(await fixture('fmi-c-parameters.xml'));
  const point = '<wml2:point><wml2:MeasurementTVP><wml2:time>2026-10-08T12:00:00Z</wml2:time><wml2:value>1</wml2:value></wml2:MeasurementTVP></wml2:point>';
  const oneMember = base.match(/<wfs:member>[\s\S]*?<\/wfs:member>/)![0].replace(/<wml2:point>[\s\S]*?<\/wml2:point>/g, '')
    .replace('</wml2:MeasurementTimeseries>', point.repeat(5001) + '</wml2:MeasurementTimeseries>');
  assert.throws(() => decodeFmiObservations(`<wfs:FeatureCollection>${oneMember}</wfs:FeatureCollection>`, metadata, new Date(START).toISOString(), 'fmi-weather'), /observation limit/);
});

test('browser request arguments cannot request alternate stations, time windows, upstream URLs or duplicate parameters', async () => {
  assert.equal(validateObservationRequest(new URL('https://local/api/observations')), null);
  for (const query of ['station=999999', 'start=2000-01-01', 'url=https://example.com', 'parameter=t2m&parameter=r_1h']) {
    const response = await GET({ url: new URL(`https://local/api/observations?${query}`) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /fixed six-hour/);
  }
});


test('malformed FMI refresh retains original dates and network recovery replaces its failure status', async () => {
  const h = await harness(), first = await h.cache.snapshot();
  const weather = selectedMembers(await fixture('fmi-c-weather.xml'), 'r_1h', false);
  h.setWeather('<invalid'); h.setNow(START + 5 * 60_000);
  const malformed = await h.cache.snapshot();
  assert.equal(malformed.sources[0].state, 'stale');
  assert.deepEqual(malformed.observations, first.observations);
  assert.equal(malformed.sources[0].retrievedAt, first.sources[0].retrievedAt);
  assert.equal(malformed.sources[0].observedAt, first.sources[0].observedAt);
  assert.match(malformed.sources[0].message, /retaining dated/);
  h.setWeather(weather); h.setNow(START + 10 * 60_000);
  const restored = await h.cache.snapshot();
  assert.equal(restored.sources[0].lastError, null); assert.equal(restored.sources[0].state, first.sources[0].state);
  assert.equal(restored.sources[0].retrievedAt, new Date(START + 10 * 60_000 - 200).toISOString());
  assert.equal(restored.sources[0].observedAt, first.sources[0].observedAt);
});


test('FMI request timeout retains validated station dates and respects its next attempt cadence', async () => {
  const h = await harness(), first = await h.cache.snapshot();
  h.fail(new DOMException('Deliberate request deadline', 'TimeoutError')); h.setNow(START + 5 * 60_000);
  const timedOut = await h.cache.snapshot();
  assert.deepEqual(timedOut.observations, first.observations);
  assert.equal(timedOut.sources[0].state, 'stale');
  assert.equal(timedOut.sources[0].retrievedAt, first.sources[0].retrievedAt);
  assert.equal(timedOut.sources[0].observedAt, first.sources[0].observedAt);
  assert.equal(timedOut.sources[0].lastError, 'Deliberate request deadline');
  const requests = h.requests.length; h.setNow(START + 10 * 60_000 - 1);
  await h.cache.snapshot(); assert.equal(h.requests.length, requests);
  h.setNow(START + 10 * 60_000); await h.cache.snapshot(); assert.equal(h.requests.length, requests + 2);
});
