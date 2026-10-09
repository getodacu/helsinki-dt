import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingAddress, buildingName, buildingAttribute, knownValue, delayLabel, signedSeconds, matchesBuilding, matchesVehicle, formatDate } from '../src/lib/inspection.ts';
import type { Building, Vehicle } from '../src/lib/types.ts';

const building: Building = { id: 'BID_001', gmlId: 'BID_001', vtjPrt: '00123X', ratu: null, uuid: null,
  chunkRef: 'district', longitude: 24.95, latitude: 60.17, sourceId: 'fixture', attributes: {
    Address: '{"Street":"Mäntytie","HouseNumber":"7","PostalCode":"00270","City":"Helsinki"}', yearOfConstruction: null } };
test('delay convention keeps sign, exact seconds and missing values distinct', () => {
  assert.equal(delayLabel(61), '61 s late'); assert.equal(delayLabel(-61), '61 s early');
  assert.equal(delayLabel(60), 'Within ±60 s'); assert.equal(delayLabel(-60), 'Within ±60 s');
  assert.equal(delayLabel(null), 'Unknown delay'); assert.equal(delayLabel(NaN), 'Unknown delay');
  assert.equal(signedSeconds(61), '+61 s'); assert.equal(signedSeconds(-61), '-61 s'); assert.equal(signedSeconds(null), 'Unknown');
});
test('prepared address and original string IDs are searchable without guessed attributes', () => {
  assert.equal(buildingAddress(building), 'Mäntytie 7 00270 Helsinki');
  assert.equal(buildingName(building), 'Mäntytie 7 00270 Helsinki');
  assert.equal(matchesBuilding(building, 'mantytie 7'), true); assert.equal(matchesBuilding(building, '00123X'), true);
  assert.equal(matchesBuilding(building, 'unknown address'), false);
  assert.equal(buildingName({ ...building, attributes: {} }), 'Building');
  assert.equal(matchesBuilding({ ...building, attributes: {} }, 'BID_001'), true);
  assert.equal(matchesBuilding({ ...building, attributes: {} }, '00123X'), true);
  assert.equal(buildingAddress({ ...building, attributes: { Address: '{bad' } }), '{bad');
});
test('vehicle search includes public route label and operator-scoped identity', () => {
  const vehicle = { mode: 'tram', routeId: '1004', id: 'hsl:0040:001', ownerOperatorId: '0040', vehicleId: '001' } as Vehicle;
  assert.equal(matchesVehicle(vehicle, '4', '4'), true); assert.equal(matchesVehicle(vehicle, '0040/001'), true);
  assert.equal(matchesVehicle(vehicle, 'ferry'), false);
  assert.equal(formatDate(null), 'Unknown'); assert.match(formatDate('2026-10-08T10:00:00Z'), /13:00:00/);
});

test('building facts omit missing values and keep a real zero', () => {
  for (const value of [null, undefined, '', '  ', 'Unknown', 'unknown — not supplied', 'Unavailable', 'N/A']) assert.equal(knownValue(value), false);
  for (const value of ['0', '1975', 'Office', 'Unknown Street 3']) assert.equal(knownValue(value), true);
  assert.equal(buildingAttribute({ ...building, attributes: { yearOfConstruction: 'Unknown', rakennusvuosi: '1975', storeysAboveGround: '0' } }, ['yearOfConstruction', 'rakennusvuosi']), '1975');
  assert.equal(buildingAttribute({ ...building, attributes: { storeysAboveGround: '0' } }, ['storeysAboveGround']), '0');
  assert.equal(buildingName({ ...building, attributes: { name: 'Unavailable', Address: 'Unknown' } }), 'Building');
});
