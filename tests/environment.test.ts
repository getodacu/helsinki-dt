import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeFmiObservations, discoverFmiQueries, parseFmiParameters, parseFmiXml } from '../src/lib/data/fmi.ts';

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const receivedAt = '2026-10-08T10:55:00.000Z';

test('real FMI metadata proves queries, parameter units and aggregation independently of timestep', async () => {
  const queries = discoverFmiQueries(await fixture('fmi-query-list.xml'), await fixture('fmi-query-description.xml'));
  assert.equal(queries.length, 2);
  const metadata = parseFmiParameters(await fixture('fmi-parameters.xml'));
  assert.deepEqual(metadata.ws_10min, { unit: 'm/s', label: 'Wind speed', aggregation: 'avg PT10M' });
  assert.equal(metadata.no2_pt1h_avg.unit, 'ug/m3');
  assert.equal(metadata.no2_pt1h_avg.aggregation, 'avg PT1H');
});
test('real weather reports preserve one station, response lat/lon order, time and unknown quality', async () => {
  const records = decodeFmiObservations(await fixture('fmi-weather.xml'), parseFmiParameters(await fixture('fmi-parameters.xml')), receivedAt, 'fmi-weather');
  assert.equal(records.length, 12);
  assert.deepEqual([...new Set(records.map((record) => record.stationId))], ['100971']);
  assert.equal(records[0].stationName, 'Helsinki Kaisaniemi');
  assert.equal(records[0].longitude, 24.94459);
  assert.equal(records[0].latitude, 60.17523);
  assert.equal(records[0].receivedAt, receivedAt);
  assert.equal(records[0].quality, 'unknown');
  assert.notEqual(records[0].observedAt, receivedAt);
});
test('real urban air quality retains observed values and explicitly missing NaN', async () => {
  const xml = await fixture('fmi-air-quality.xml');
  const metadata = parseFmiParameters(await fixture('fmi-parameters.xml'));
  const records = decodeFmiObservations(xml, metadata, receivedAt, 'fmi-air-quality');
  assert.equal(records.length, 4);
  assert.equal(records[0].stationId, '100742');
  assert.equal(records[0].longitude, 24.93924);
  assert.equal(records[0].aggregation, 'avg PT1H');
  assert.equal(records[0].value, 41.9);
  const missing = xml.replace('<wml2:value>41.9</wml2:value>', '<wml2:value>NaN</wml2:value>');
  assert.equal(decodeFmiObservations(missing, metadata, receivedAt, 'fmi-air-quality')[0].value, null);
});
test('HTTP success cannot turn FMI exceptions, malformed XML or unverified units into observations', async () => {
  assert.throws(() => parseFmiXml('<ExceptionReport><Exception>Bad query</Exception></ExceptionReport>'), /exception response/);
  assert.throws(() => parseFmiXml('<FeatureCollection>'), /Malformed/);
  assert.throws(() => parseFmiXml('<!DOCTYPE x [<!ENTITY x "boom">]><FeatureCollection/>'), /safe bounds/);
  const xml = await fixture('fmi-weather.xml');
  assert.throws(() => decodeFmiObservations(xml, {}, receivedAt, 'fmi-weather'), /verified parameter unit/);
});
