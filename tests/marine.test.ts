import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMarineRestPosition, decodeMarineMqttPosition, decodeMarineMetadata, decodeMarineStatus, marineMmsi, mergeMarinePosition, withMarineMetadata } from '../src/lib/data/marine.ts';
import { compareMarinePositions, KNOTS_TO_METRES_PER_SECOND, MARINE_BUFFER_MS, MARINE_GAP_MS, MARINE_MAX_POINTS,
  MARINE_STALE_MS, MARINE_REMOVE_MS, MARINE_STATIONARY_STALE_MS, MARINE_STATIONARY_REMOVE_MS,
  marineDistanceMetres, marineFreshness, marineHeading, marineIsRemoved, marineMotionPlausible, marineNavigationLabel, marineTypeLabel } from '../src/lib/marine.ts';
import { TRAFFIC_STALE_MS, TRAFFIC_REMOVE_MS, trafficAge, trafficIsStale, trafficShouldRemove } from '../src/lib/traffic.ts';
import { decodeHfp } from '../src/lib/data/hfp.ts';
import { decodeRailPosition } from '../src/lib/data/rail.ts';

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/marine/${name}.json`, import.meta.url), 'utf8'));
const [restFixture, metadataFixture, mqttFixture, mqttMetadataFixture, statusFixture] = await Promise.all(
  ['rest-location', 'rest-metadata', 'mqtt-location', 'mqtt-metadata', 'mqtt-status'].map(fixture));
const NOW = Date.parse('2026-10-09T19:59:00Z'), receivedAt = new Date(NOW).toISOString(), MMSI = String(restFixture.mmsi);
// All mutations below are synthetic edge cases; fixture files are unmodified source excerpts.
const rest = (properties = {}, coordinates = restFixture.geometry.coordinates, now = NOW) => decodeMarineRestPosition({
  ...structuredClone(restFixture), geometry: { type: 'Point', coordinates }, properties: { ...restFixture.properties, ...properties }
}, receivedAt, now);
const mqtt = (payload = {}, topic = mqttFixture.topic, now = NOW) => decodeMarineMqttPosition(topic, { ...mqttFixture.payload, ...payload }, receivedAt, now);
const localMqtt = (time = NOW / 1000, lon = 24.95, extra = {}) => mqtt({ time, lon, lat: 60.17, ...extra }, `vessels-v2/${MMSI}/location`, NOW + 60_000);
const localRest = (time = NOW, lon = 24.95, extra = {}) => rest({ timestampExternal: time, ...extra }, [lon, 60.17], NOW + 60_000);

test('observed REST and MQTT decode their clock units and ship identity without invented transit fields', () => {
  const vessel = rest(), live = mqtt();
  assert.equal(vessel.reportedAt, new Date(restFixture.properties.timestampExternal).toISOString());
  assert.equal(vessel.marine?.positionSecond, 48);
  assert.equal(vessel.marine?.positionSource, 'rest');
  assert.equal(live.reportedAt, new Date(mqttFixture.payload.time * 1000).toISOString());
  assert.equal(live.marine?.positionSource, 'mqtt'); assert.equal(live.marine?.positionSecond, null);
  assert.equal(live.speedMetresPerSecond, 11.4 * KNOTS_TO_METRES_PER_SECOND);
  assert.equal(vessel.id, `ais:${MMSI}`); assert.equal(vessel.sourceId, 'digitraffic-marine'); assert.equal(vessel.mode, 'ship');
  for (const field of ['routeId', 'directionId', 'serviceDate', 'startTime', 'journeyReference', 'ownerOperatorId', 'operatingOperatorId', 'rawDeviationSeconds', 'delaySeconds'] as const) assert.equal(vessel[field], null);
  assert.equal(vessel.receivedAt, receivedAt);
});

test('MMSI must already be canonical and source identifiers must agree', () => {
  assert.equal(marineMmsi(230044550), MMSI); assert.equal(marineMmsi('002301234'), '002301234');
  for (const value of [0, -1, 1_000_000_000, 230044550.5, NaN, 2301234, '23004455', ' 230044550', '230044550x', '000000000']) assert.throws(() => marineMmsi(value), /MMSI/);
  assert.throws(() => decodeMarineRestPosition({ ...restFixture, mmsi: 230000001 }, receivedAt, NOW), /MMSI/);
  assert.throws(() => decodeMarineRestPosition({ ...restFixture, id: 230000001 }, receivedAt, NOW), /MMSI/);
  assert.throws(() => rest({ mmsi: 230000001 }), /MMSI/);
  for (const topic of ['vessels-v2/230044550/locations', 'vessels/230044550/location', 'vessels-v2/23004455/location', 'vessels-v2/230044550/location/extra']) assert.throws(() => mqtt({}, topic), /topic/);
  assert.throws(() => mqtt({ mmsi: 230000001 }), /MMSI/);
});

test('position coordinates and required record/receipt times are validated before geographic filtering', () => {
  for (const coordinates of [[181, 60.17], [24.95, 91], [NaN, 60.17], [24.95, null], [24.95], ['24.95', 60.17]]) assert.throws(() => rest({}, coordinates));
  assert.throws(() => mqtt({ lat: Infinity })); assert.throws(() => mqtt({ lon: null }));
  for (const timestampExternal of [null, '1791575688270', NaN, 0, -1]) assert.throws(() => rest({ timestampExternal }));
  assert.throws(() => rest({ timestampExternal: NOW + 5_001 })); assert.equal(rest({ timestampExternal: NOW + 5_000 }).reportedAt, new Date(NOW + 5_000).toISOString());
  assert.throws(() => mqtt({ time: (NOW + 6_000) / 1000 })); assert.throws(() => mqtt({ time: NOW }));
  assert.throws(() => decodeMarineRestPosition(restFixture, 'invalid', NOW));
});

test('sentinels remain unknown, capped speed is unusable, and booleans/enums are explicit', () => {
  const observed = rest(); assert.equal(observed.headingDegrees, null); assert.equal(observed.marine?.courseOverGroundDegrees, null);
  assert.equal(observed.marine?.positionAccuracy, true); assert.equal(observed.marine?.raim, true);
  for (const sog of [102.2, 102.3]) { const ship = rest({ sog }); assert.equal(ship.speedMetresPerSecond, null); assert.ok(ship.quality.includes(sog === 102.2 ? 'speed-capped' : 'speed-unavailable')); }
  const absent = rest({ sog: null, cog: null, heading: null, navStat: null, posAcc: null, raim: null });
  assert.equal(absent.speedMetresPerSecond, null); assert.equal(absent.headingDegrees, null); assert.equal(absent.marine?.navigationStatus, null); assert.equal(absent.marine?.positionAccuracy, null); assert.equal(absent.marine?.raim, null);
  assert.equal(rest({ navStat: 15 }).marine?.navigationStatus, null);
  for (const properties of [{ sog: -1 }, { sog: 102.4 }, { cog: 361 }, { heading: 360 }, { heading: 12.5 }, { navStat: 16 }, { navStat: '5' }, { posAcc: 1 }, { raim: 'true' }, { timestamp: 64 }]) assert.throws(() => rest(properties));
  assert.ok(rest({ posAcc: false, raim: false }).quality.includes('position-low-accuracy'));
});

test('REST position-second quality is distinct from record time and never invented for MQTT', () => {
  const flags = { 60: 'position-second-unavailable', 61: 'position-manual', 62: 'position-estimated', 63: 'position-inoperative' };
  for (const [timestamp, flag] of Object.entries(flags)) { const vessel = rest({ timestamp: Number(timestamp) }); assert.ok(vessel.quality.includes(flag)); assert.equal(vessel.reportedAt, new Date(restFixture.properties.timestampExternal).toISOString()); }
  assert.equal(marineHeading(rest({ timestamp: 63, heading: 90 })), null);
  assert.equal(mqtt({ timestamp: 63 }).marine?.positionSecond, null);
  assert.equal(mqtt().quality.includes('position-inoperative'), false);
});

test('both metadata sources retain milliseconds and normalize padded text/valid IMO/type', () => {
  const metadata = decodeMarineMetadata(metadataFixture, MMSI, receivedAt, NOW);
  assert.equal(metadata.reportedAt, new Date(metadataFixture.timestamp).toISOString()); assert.equal(metadata.imo, metadataFixture.imo === 0 ? null : String(metadataFixture.imo));
  assert.equal(decodeMarineMetadata({ ...metadataFixture, imo: 9113018 }, MMSI, receivedAt, NOW).imo, '9113018');
  const fromTopic = mqttMetadataFixture.topic.split('/')[1], live = decodeMarineMetadata(mqttMetadataFixture.payload, fromTopic, receivedAt, NOW);
  assert.equal(live.reportedAt, new Date(mqttMetadataFixture.payload.timestamp).toISOString()); assert.equal(live.shipType, mqttMetadataFixture.payload.type);
  const padding = decodeMarineMetadata({ ...metadataFixture, name: ' @ Example ship@@@ ', callSign: '@ OJGT@@ ', imo: 0 }, MMSI, receivedAt, NOW);
  assert.equal(padding.name, 'Example ship'); assert.equal(padding.callSign, 'OJGT'); assert.equal(padding.imo, null);
  const unknown = decodeMarineMetadata({ timestamp: NOW, name: '@@@ ', callSign: '', imo: 0, shipType: 0 }, MMSI, receivedAt, NOW);
  assert.equal(unknown.name, null); assert.equal(unknown.callSign, null); assert.equal(unknown.shipType, null);
});

test('bad optional metadata fields are unknown and cannot invalidate a valid position', () => {
  const metadata = decodeMarineMetadata({ ...metadataFixture, imo: 9113019, name: 'x'.repeat(81), callSign: [], shipType: 100 }, MMSI, receivedAt, NOW);
  assert.equal(metadata.imo, null); assert.equal(metadata.name, null); assert.equal(metadata.callSign, null); assert.equal(metadata.shipType, null);
  assert.equal(metadata.quality.length, 4); const position = rest(), enriched = withMarineMetadata(position, metadata);
  assert.equal(enriched.reportedAt, position.reportedAt); assert.equal(enriched.receivedAt, position.receivedAt); assert.equal(enriched.longitude, position.longitude);
  assert.throws(() => decodeMarineMetadata({ ...metadataFixture, mmsi: 230000001 }, MMSI, receivedAt, NOW), /MMSI/);
  assert.throws(() => decodeMarineMetadata({ ...metadataFixture, timestamp: NOW + 5_001 }, MMSI, receivedAt, NOW));
});

test('metadata revisions have their own clock and never refresh position time or receipt', () => {
  const original = localRest(NOW - MARINE_STALE_MS, 24.95, { navStat: 0, sog: 3 });
  const metadata = decodeMarineMetadata({ ...metadataFixture, timestamp: NOW, name: 'New name' }, MMSI, receivedAt, NOW);
  const enriched = withMarineMetadata(original, metadata);
  assert.equal(enriched.marine?.name, 'New name'); assert.equal(enriched.marine?.metadataReportedAt, receivedAt); assert.equal(enriched.marine?.metadataReceivedAt, receivedAt);
  assert.equal(enriched.reportedAt, original.reportedAt); assert.equal(enriched.receivedAt, original.receivedAt); assert.equal(trafficIsStale(enriched, NOW), true);
  for (const timestamp of [NOW, NOW - 1]) assert.equal(withMarineMetadata(enriched, decodeMarineMetadata({ ...metadataFixture, timestamp, name: 'Old or conflicting name' }, MMSI, receivedAt, NOW)), enriched);
  assert.equal(withMarineMetadata(enriched, { ...metadata, mmsi: '230000001' }), enriched);
  const next = mergeMarinePosition(enriched, localMqtt((NOW + 1000) / 1000));
  assert.equal(next.marine?.name, 'New name'); assert.equal(next.marine?.metadataReportedAt, receivedAt);
});

test('same-second REST precision wins in either startup order; conflicting samples are marked for snapping', () => {
  const live = localMqtt(), precise = localRest(NOW + 270, 24.9501);
  assert.equal(compareMarinePositions(live, precise), 'newer'); assert.equal(compareMarinePositions(precise, live), 'older');
  const preferred = mergeMarinePosition(live, precise); assert.equal(preferred.reportedAt, precise.reportedAt); assert.equal(preferred.marine?.positionSource, 'rest');
  assert.ok(preferred.quality.includes('position-same-second-conflict')); assert.equal(marineMotionPlausible(live, precise), true);
  assert.equal(mergeMarinePosition(preferred, live), preferred);
  assert.equal(compareMarinePositions(preferred, precise), 'duplicate');
  const later = localMqtt((NOW + 1000) / 1000); assert.equal(compareMarinePositions(preferred, later), 'newer'); assert.equal(mergeMarinePosition(preferred, later).reportedAt, later.reportedAt);
  assert.equal(compareMarinePositions(localMqtt(), localRest(NOW - 500)), 'older');
});

test('duplicates and conflicting exact-time revisions do not refresh receipt or move a ship backwards', () => {
  const original = localRest(), duplicate = { ...original, receivedAt: new Date(NOW + 10_000).toISOString() };
  assert.equal(compareMarinePositions(original, duplicate), 'duplicate'); assert.equal(mergeMarinePosition(original, duplicate), original);
  const conflict = localRest(NOW, 24.951); assert.equal(compareMarinePositions(original, conflict), 'conflict'); assert.equal(mergeMarinePosition(original, conflict), original);
  const older = localRest(NOW - 1); assert.equal(compareMarinePositions(original, older), 'older'); assert.equal(mergeMarinePosition(original, older), original);
  assert.throws(() => compareMarinePositions(original, mqtt()), /identity/);
});

test('marine motion rejects implausible short-gap displacement but accepts long-gap restart', () => {
  const original = localMqtt(), plausible = localMqtt((NOW + 10_000) / 1000, 24.9501), jump = localMqtt((NOW + 10_000) / 1000, 25.0);
  assert.ok(marineDistanceMetres(original, plausible) < 10); assert.equal(marineMotionPlausible(original, plausible), true); assert.equal(marineMotionPlausible(original, jump), false);
  assert.equal(marineMotionPlausible(original, localMqtt((NOW + MARINE_GAP_MS) / 1000, 25.0)), false);
  assert.equal(marineMotionPlausible(original, localMqtt((NOW + MARINE_GAP_MS + 1000) / 1000, 25.0)), true);
  assert.equal(MARINE_BUFFER_MS, 10_000); assert.equal(MARINE_MAX_POINTS, 64);
});

test('freshness uses long limits only for anchor/moored with known low speed, at exact boundaries', () => {
  for (const navStat of [0, null, 15, 5, 1]) for (const sog of [null, 0, .5, .6]) {
    const vessel = localRest(NOW, 24.95, { navStat, sog }), long = [1, 5].includes(navStat ?? -1) && sog !== null && sog <= .5;
    const policy = marineFreshness(vessel), staleMs = long ? MARINE_STATIONARY_STALE_MS : MARINE_STALE_MS, removeMs = long ? MARINE_STATIONARY_REMOVE_MS : MARINE_REMOVE_MS;
    assert.deepEqual(policy, { staleMs, removeMs }); assert.equal(trafficIsStale(vessel, NOW + staleMs - 1), false); assert.equal(trafficIsStale(vessel, NOW + staleMs), true);
    assert.equal(trafficShouldRemove(vessel, NOW + removeMs - 1), false); assert.equal(trafficShouldRemove(vessel, NOW + removeMs), true); assert.equal(marineIsRemoved(vessel, NOW + removeMs), true);
    assert.equal(trafficAge(vessel, NOW - 1), 0);
  }
  assert.deepEqual(marineFreshness(localRest(NOW, 24.95, { navStat: 5, sog: 102.2 })), { staleMs: MARINE_STALE_MS, removeMs: MARINE_REMOVE_MS });
});

test('orientation keeps heading distinct from course, and unknown direction stays unknown', () => {
  assert.equal(marineHeading(localMqtt(NOW / 1000, 24.95, { heading: 511, cog: 90, sog: 0 })), null);
  assert.equal(marineHeading(localMqtt(NOW / 1000, 24.95, { heading: 511, cog: 90, sog: .6 })), 90);
  assert.equal(marineHeading(localMqtt(NOW / 1000, 24.95, { heading: 0, cog: 90, sog: 0 })), 0);
  assert.equal(marineTypeLabel(70), 'Cargo ship'); assert.equal(marineTypeLabel(60), 'Passenger ship'); assert.equal(marineTypeLabel(null), 'Unknown type');
  assert.equal(marineNavigationLabel(5), 'Moored'); assert.equal(marineNavigationLabel(null), 'Unknown navigation status');
});

test('status time is seconds and independent of individual ship freshness', () => {
  assert.equal(decodeMarineStatus(statusFixture.payload, NOW), new Date(statusFixture.payload.updated * 1000).toISOString());
  const old = localRest(NOW - MARINE_STALE_MS, 24.95, { navStat: 0 });
  assert.equal(decodeMarineStatus({ updated: NOW / 1000 }, NOW), receivedAt); assert.equal(trafficIsStale(old, NOW), true);
  for (const updated of [null, '1791575875', NOW, NOW / 1000 + 6]) assert.throws(() => decodeMarineStatus({ updated }, NOW));
});

test('existing HSL and rail decoder contracts and transit freshness remain unchanged', async () => {
  const samples = JSON.parse(await readFile(new URL('./fixtures/hfp-samples.json', import.meta.url), 'utf8'));
  const first = samples[0], hsl = decodeHfp(first.topic, first.payload, first.receivedAt);
  const rail = decodeRailPosition({ trainNumber: 23, departureDate: '2026-10-09', timestamp: receivedAt, location: { type: 'Point', coordinates: [24.94, 60.19] } }, receivedAt);
  for (const vessel of [hsl, rail]) {
    const at = Date.parse(vessel.reportedAt); assert.equal(trafficIsStale(vessel, at + TRAFFIC_STALE_MS - 1), false); assert.equal(trafficIsStale(vessel, at + TRAFFIC_STALE_MS), true);
    assert.equal(trafficShouldRemove(vessel, at + TRAFFIC_REMOVE_MS - 1), false); assert.equal(trafficShouldRemove(vessel, at + TRAFFIC_REMOVE_MS), true);
    assert.equal(vessel.marine, undefined); assert.notEqual(vessel.routeId, null);
  }
});
