import { SHIP_MODEL_TYPES, shipModelType } from '../src/lib/ship-models.ts';
import test, { mock } from 'node:test';
import { readFile } from 'node:fs/promises';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { parseVehicleModel, disposeVehicleModel } from '../src/lib/vehicle-models.ts';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LiveFleet, ReceivedPositions, VEHICLE_DISPLAY_SCALE, vehicleVisible } from '../src/lib/live-fleet.ts';
import { decodeMarineMqttPosition, decodeMarineRestPosition, mergeMarinePosition, withMarineMetadata } from '../src/lib/data/marine.ts';
import { wgs84ToScene } from '../src/lib/geo.ts';
import type { Vehicle } from '../src/lib/types.ts';
const at = Date.parse('2026-10-08T11:00:00Z');
const vehicle = (changes: Partial<Vehicle> = {}): Vehicle => ({ id: '0040/00001', mode: 'tram', ownerOperatorId: '0040', vehicleId: '00001',
  operatingOperatorId: '0040', routeId: '1002', directionId: '1', serviceDate: '2026-10-08', startTime: '14:00', journeyReference: null,
  reportedAt: new Date(at).toISOString(), receivedAt: new Date(at + 100).toISOString(), longitude: 24.952, latitude: 60.1695,
  speedMetresPerSecond: 4, headingDegrees: 350, rawDeviationSeconds: -20, delaySeconds: 20, quality: [], sourceId: 'test-fixture', ...changes });
const modes = { tram: true, bus: true, ferry: true, train: true, ship: true };

test('buffer interpolates received coordinates and shortest heading, never extrapolates', () => {
  const buffer = new ReceivedPositions(); const first = vehicle(), second = vehicle({ longitude: 24.9521, headingDegrees: 10, reportedAt: new Date(at + 1000).toISOString() });
  buffer.upsert(first); buffer.upsert(second);
  const [x] = wgs84ToScene(second.longitude!, second.latitude!);
  const midpoint = buffer.position(first.id, at + 1700)!;
  assert.ok(Math.abs(midpoint.x - x / 2) < 0.01); assert.equal(midpoint.heading, 360);
  assert.equal(buffer.position(first.id, at + 5000)!.x, x);
  assert.equal(buffer.position(first.id, at + 5000)!.z, wgs84ToScene(second.longitude!, second.latitude!)[2]);
  assert.equal(buffer.position(first.id, at + 31_000)!.x, x);
  assert.equal(buffer.position(first.id, at + 121_000), null);
  assert.equal(buffer.position(first.id, at + 1700, true)!.x, x);
});

test('implausible jumps, fast jumps and long gaps snap; metadata and old reports cannot refresh a position', () => {
  const buffer = new ReceivedPositions(); buffer.upsert(vehicle());
  buffer.upsert(vehicle({ longitude: 24.96, reportedAt: new Date(at + 1000).toISOString() }));
  assert.equal(buffer.tracks.get('0040/00001')!.positions.length, 1);
  const x = buffer.position('0040/00001', at + 1000)!.x;
  buffer.upsert(vehicle({ reportedAt: new Date(at - 1000).toISOString() }));
  assert.equal(buffer.position('0040/00001', at + 1000)!.x, x);
  buffer.upsert(vehicle({ longitude: 24.90, reportedAt: new Date(at + 1000).toISOString(), receivedAt: new Date(at + 20_000).toISOString() }));
  assert.equal(buffer.position('0040/00001', at + 1000)!.x, x);
  assert.equal(buffer.position('0040/00001', at + 121_000), null);
  buffer.upsert(vehicle({ longitude: 24.9601, reportedAt: new Date(at + 15_000).toISOString() }));
  assert.equal(buffer.tracks.get('0040/00001')!.positions.length, 1);
  const fast = new ReceivedPositions(); fast.upsert(vehicle()); fast.upsert(vehicle({ longitude: 24.953, reportedAt: new Date(at + 500).toISOString() }));
  assert.equal(fast.tracks.get('0040/00001')!.positions.length, 1);
});

test('full snapshots remove absent identities and the buffer remains bounded', () => {
  const buffer = new ReceivedPositions();
  for (let i = 0; i < 1000; i++) buffer.upsert(vehicle({ longitude: 24.952 + i / 100_000_000, reportedAt: new Date(at + i * 1000).toISOString() }));
  assert.equal(buffer.tracks.get('0040/00001')!.positions.length, 5);
  buffer.setSnapshot([vehicle({ id: 'test/second', longitude: null })]); assert.equal(buffer.tracks.size, 0);
});

test('instanced mode filters, source identity, terrain height and explicit display scale survive reallocation', () => {
  const fleet = new LiveFleet(() => 12, 0); fleet.setVehicles([vehicle(), vehicle({ id: 'ferry/1', mode: 'ferry' })]); fleet.update(at, modes, true);
  const tram = fleet.meshes.get('tram')!, ferry = fleet.meshes.get('ferry')!, matrix = new THREE.Matrix4();
  tram.getMatrixAt(0, matrix); assert.ok(Math.abs(matrix.elements[13] - (12.08)) < 0.001);
  ferry.getMatrixAt(0, matrix); assert.ok(Math.abs(matrix.elements[13] - (0)) < 0.001);
  assert.equal(VEHICLE_DISPLAY_SCALE, 1);
  assert.equal(matrix.getMaxScaleOnAxis(), 1);
  assert.equal(fleet.idForHit({ object: ferry, instanceId: 0 }), 'ferry/1');
  fleet.update(at, { ...modes, tram: false }, true); assert.equal(tram.count, 0); assert.equal(fleet.visibleCount, 1);
  const many = Array.from({ length: 450 }, (_, index) => vehicle({ id: `test/${index}` })); fleet.setVehicles(many); fleet.update(at, modes, false);
  assert.equal(fleet.meshes.get('tram')!.count, 450); assert.ok(fleet.meshes.get('tram')!.instanceMatrix.count >= 450);
  fleet.setVehicles([many[449]]); fleet.update(at, modes, true);
  assert.equal(fleet.idForHit({ object: fleet.meshes.get('tram')!, instanceId: 0 }), 'test/449');
  fleet.dispose(); assert.equal(fleet.root.children.length, 0); assert.equal(fleet.motion.tracks.size, 0);
  const unknown = new LiveFleet(() => null); unknown.setVehicles([vehicle(), vehicle({ mode: 'ferry', id: 'ferry/1' })]); unknown.update(at, modes, true);
  assert.equal(unknown.visibleCount, 1); assert.equal(unknown.unplacedCount, 1); unknown.dispose();
});


test('moving instanced vehicle remains raycast selectable after its bounds change', () => {
  const fleet = new LiveFleet(() => 0);
  fleet.setVehicles([vehicle()]); fleet.update(at, modes, true);
  const moved = vehicle({longitude:24.97,reportedAt:new Date(at+3000).toISOString()});
  fleet.setVehicles([moved]); fleet.update(at+3000,modes,true); fleet.root.updateMatrixWorld(true);
  const [x,,z] = wgs84ToScene(moved.longitude!,moved.latitude!);
  const hits = new THREE.Raycaster(new THREE.Vector3(x,50,z),new THREE.Vector3(0,-1,0)).intersectObject(fleet.meshes.get('tram')!);
  assert.ok(hits.length > 0); assert.equal(fleet.idForHit(hits[0]),moved.id); fleet.dispose();
});


test('route filtering hides unrelated instances without discarding live tracks and clearing restores them', () => {
  const fleet = new LiveFleet(() => 0), first = vehicle(), other = vehicle({id:'0040/00002',routeId:'1009'});
  fleet.setVehicles([first,other]); fleet.update(at,modes,true,'1009');
  assert.equal(fleet.visibleCount,1); assert.equal(fleet.idForHit({object:fleet.meshes.get('tram')!,instanceId:0}),other.id);
  assert.equal(fleet.motion.tracks.size,2); assert.equal(vehicleVisible(first,modes,'1009'),false);
  assert.equal(vehicleVisible(other,{...modes,tram:false},'1009'),false);
  fleet.update(at,modes,true,null); assert.equal(fleet.visibleCount,2); fleet.dispose();
});


for (const [mode, length] of [['bus', 12], ['tram', 27.7], ['ferry', 36], ['train', 44.466]] as const) {
  test(`${mode} Blender export has real dimensions, coloured detail and correct contact datum`, async () => {
    const bytes = await readFile(new URL(`../static/models/${mode}.glb`, import.meta.url));
    const model = await parseVehicleModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const box = model.geometry.boundingBox!, size = box.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.z - length) < .15);
    assert.ok(size.x > 2 && size.x < 10); assert.ok(model.roofHeight > 3);
    assert.equal(model.materials.length, 3); assert.equal(model.geometry.groups.length, 3);
    assert.ok(model.geometry.getAttribute('color')); assert.ok(model.geometry.getAttribute('normal'));
    assert.ok(model.geometry.index!.count / 3 < 18_000);
    assert.ok(mode === 'ferry' ? box.min.y < -1 : Math.abs(box.min.y) < .001);
    const fleet = new LiveFleet(() => 12, 2); fleet.setModel(mode, model);
    fleet.setVehicles([vehicle({ mode, headingDegrees: 90 })]); fleet.update(at, modes, true);
    const mesh = fleet.meshes.get(mode)!, matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(matrix);
    assert.ok(Math.abs(forward.x - 1) < .001); assert.ok(Math.abs(forward.z) < .001);
    assert.equal(matrix.getMaxScaleOnAxis(), 1);
    assert.ok(Math.abs(matrix.elements[13] - (mode === 'ferry' ? 2 : 12.08)) < .001);
    let disposed = 0; model.geometry.addEventListener('dispose', () => disposed++);
    fleet.setVehicles(Array.from({ length: 450 }, (_, i) => vehicle({ mode, id: `fixture/${i}` })));
    fleet.update(at, modes, true);
    assert.equal(disposed, 0); assert.equal(fleet.meshes.get(mode)!.geometry, model.geometry);
    fleet.root.updateMatrixWorld(true);
    const [x, , z] = wgs84ToScene(24.952, 60.1695);
    const hit = new THREE.Raycaster(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0)).intersectObject(fleet.meshes.get(mode)!)[0];
    assert.ok(hit); assert.equal(fleet.idForHit(hit), 'fixture/0');
    fleet.update(at + 31_000, modes, true); const colour = new THREE.Color();
    fleet.meshes.get(mode)!.getColorAt(0, colour); assert.ok(Math.abs(colour.r - .4) < .001);
    assert.equal(fleet.placements.get('fixture/0')!.stale, true);
    fleet.update(at + 121_000, modes, true); assert.equal(fleet.placements.size, 0);
    fleet.dispose(); fleet.dispose(); assert.equal(disposed, 1);
  });
}

test('missing model assets preserve selectable fallback markers and report failures', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  try {
    const fleet = new LiveFleet(() => 0), errors: string[] = [];
    await fleet.loadModels({ tram: '/missing', bus: '/missing', ferry: '/missing', train: '/missing' }, message => errors.push(message));
    assert.equal(errors.length, 4);
    fleet.setVehicles([vehicle()]); fleet.update(at, modes, true);
    assert.equal(fleet.visibleCount, 1); assert.equal(fleet.placements.size, 1); fleet.dispose();
  } finally { fetchMock.mock.restore(); }
});

test('a decode completing after disposal releases its model instead of resurrecting the fleet', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(new ArrayBuffer(1)));
  const pending: ((value: GLTF) => void)[] = [];
  const parseMock = mock.method(GLTFLoader.prototype, 'parseAsync', () => new Promise<GLTF>(resolve => pending.push(resolve)));
  try {
    const fleet = new LiveFleet(() => 0), errors: string[] = [];
    const loading = fleet.loadModels({ bus: '/', tram: '/', ferry: '/', train: '/' }, error => errors.push(error));
    while (pending.length < 4) await new Promise(resolve => setImmediate(resolve));
    fleet.dispose(); let materialsDisposed = 0;
    for (const resolve of pending) {
      const scene = new THREE.Group(), geometry = new THREE.BoxGeometry(2.5, 3, 12).translate(0, 1.5, 0);
      const material = new THREE.MeshStandardMaterial(); material.addEventListener('dispose', () => materialsDisposed++);
      scene.add(new THREE.Mesh(geometry, material)); resolve({ scene } as unknown as GLTF);
    }
    await loading; assert.equal(fleet.root.children.length, 0); assert.equal(fleet.meshes.size, 0);
    assert.equal(materialsDisposed, 4); assert.deepEqual(errors, []);
  } finally { fetchMock.mock.restore(); parseMock.mock.restore(); }
});

const ship = (changes: Partial<Vehicle> = {}): Vehicle => vehicle({ id: 'ais:230123456', mode: 'ship', routeId: null,
  headingDegrees: null, speedMetresPerSecond: 1, vehicleId: '230123456', sourceId: 'digitraffic-marine',
  marine: { mmsi: '230123456', positionSource: 'mqtt', name: null, imo: null, callSign: null, shipType: null,
    navigationStatus: null, courseOverGroundDegrees: null, positionAccuracy: null, raim: null, positionSecond: null,
    metadataReportedAt: null, metadataReceivedAt: null }, ...changes });

test('ships buffer ten seconds, use their freshness clock and never extrapolate', () => {
  const buffer = new ReceivedPositions(), first = ship(), second = ship({ longitude: 24.9521, reportedAt: new Date(at + 10_000).toISOString() });
  buffer.upsert(first); buffer.upsert(second);
  const last = buffer.position(first.id, at + 15_000, true)!;
  assert.ok(Math.abs(buffer.position(first.id, at + 15_000)!.x - last.x / 2) < .01);
  assert.equal(buffer.position(first.id, at + 15_000)!.heading, null);
  assert.equal(buffer.position(first.id, at + 100_000)!.x, last.x);
  assert.equal(buffer.position(first.id, at + 130_000)!.x, last.x);
  assert.equal(buffer.position(first.id, at + 610_000), null);
  const stationary = ship({ speedMetresPerSecond: 0 }); stationary.marine!.navigationStatus = 5;
  const stationaryBuffer = new ReceivedPositions(); stationaryBuffer.setSnapshot([stationary]);
  assert.ok(stationaryBuffer.position(first.id, at + 1_799_999)); assert.equal(stationaryBuffer.position(first.id, at + 1_800_000), null);
});

test('ship gaps, excessive displacement, conflicts and implausible motion cannot animate', () => {
  for (const [seconds, longitude] of [[31, 24.9521], [30, 24.98], [1, 24.953]] as const) {
    const buffer = new ReceivedPositions(); buffer.upsert(ship());
    buffer.upsert(ship({ longitude, reportedAt: new Date(at + seconds * 1000).toISOString() }));
    assert.equal(buffer.tracks.get('ais:230123456')!.positions.length, 1);
    if (seconds === 1) assert.ok(buffer.tracks.get('ais:230123456')!.vehicle.quality.includes('position-implausible-motion'));
  }
  const buffer = new ReceivedPositions(); buffer.upsert(ship());
  buffer.upsert(ship({ longitude: 24.9521, reportedAt: new Date(at + 10_000).toISOString() }));
  buffer.upsert(ship({ longitude: 24.95211, reportedAt: new Date(at + 10_400).toISOString(), quality: ['position-same-second-conflict'] }));
  assert.equal(buffer.tracks.get('ais:230123456')!.positions.length, 1);
  buffer.upsert(ship({ longitude: 24.9522, reportedAt: new Date(at + 20_000).toISOString() }));
  buffer.upsert(ship({ longitude: 24.9523, headingDegrees: 90, reportedAt: new Date(at + 20_000).toISOString(),
    marine: { ...ship().marine!, positionSource: 'rest' }, quality: ['position-same-second-conflict'] }));
  assert.equal(buffer.tracks.get('ais:230123456')!.positions.length, 1);
  assert.equal(buffer.position('ais:230123456', at + 20_000)!.x, wgs84ToScene(24.9523, 60.1695)[0]);
  assert.equal(buffer.position('ais:230123456', at + 20_000)!.heading, 90);
});

test('ship tracks reject inoperative fixes, keep ordered bounded history and separate metadata receipt', () => {
  const buffer = new ReceivedPositions();
  for (let i = 0; i < 1000; i++) buffer.upsert(ship({ longitude: 24.952 + i / 100_000_000, reportedAt: new Date(at + i * 100).toISOString() }));
  const track = buffer.tracks.get('ais:230123456')!;
  assert.equal(track.positions.length, 64);
  assert.ok(track.positions.at(-1)!.at - track.positions[0].at <= 30_100);
  const latest = track.vehicle;
  const metadata = { ...latest, receivedAt: new Date(at + 1_000_000).toISOString(), marine: { ...latest.marine!, name: 'New metadata' } };
  buffer.upsert(metadata); assert.equal(buffer.position(latest.id, at + 700_000), null);
  buffer.upsert({ ...ship({ reportedAt: new Date(at + 800_000).toISOString() }), marine: { ...ship().marine!, positionSecond: 63 } });
  assert.equal(buffer.tracks.get(latest.id)!.vehicle.reportedAt, latest.reportedAt);
  const invalid = new ReceivedPositions(); invalid.upsert({ ...ship(), marine: { ...ship().marine!, positionSecond: 63 } });
  assert.equal(invalid.tracks.size, 0);
});

test('ships stay at water height, remain selectable through transit filtering and hide unknown orientation', () => {
  const unknown = ship(), known = ship({ id: 'ais:230123457', longitude: 24.9523, headingDegrees: 90 });
  const fleet = new LiveFleet(() => 99, 2); fleet.setVehicles([unknown, known, vehicle()]); fleet.update(at, modes, true, 'different-route');
  assert.equal(vehicleVisible(unknown, modes, 'different-route'), true); assert.equal(fleet.visibleCount, 2);
  const base = fleet.meshes.get('ship')!, cue = fleet.root.children.find(mesh => mesh !== base && ![...fleet.meshes.values()].includes(mesh as THREE.InstancedMesh)) as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4(); base.getMatrixAt(0, matrix); assert.equal(matrix.elements[13], 2);
  cue.getMatrixAt(0, matrix); assert.equal(matrix.getMaxScaleOnAxis(), 0);
  cue.getMatrixAt(1, matrix); assert.equal(matrix.getMaxScaleOnAxis(), 1);
  assert.ok(Math.abs(new THREE.Vector3(0, 0, -1).transformDirection(matrix).x - 1) < .001);
  fleet.root.updateMatrixWorld(true);
  const [x, , z] = wgs84ToScene(unknown.longitude!, unknown.latitude!);
  const hit = new THREE.Raycaster(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0)).intersectObject(base)[0];
  assert.ok(hit); assert.equal(fleet.idForHit(hit), unknown.id);
  fleet.update(at, { ...modes, ship: false }, true); assert.equal(base.count, 0); assert.equal(cue.count, 0);
  let disposed = 0; cue.geometry.addEventListener('dispose', () => disposed++); fleet.dispose(); fleet.dispose(); assert.equal(disposed, 1);
});

test('a paused marine source holds the latest ship fix without changing transit interpolation', () => {
  const fleet = new LiveFleet(() => 0), first = ship(), second = ship({ longitude: 24.9521, reportedAt: new Date(at + 10_000).toISOString() });
  fleet.setVehicles([first]); fleet.setVehicles([second]); fleet.update(at + 15_000, modes, false);
  const buffered = fleet.placements.get(first.id)!.x;
  fleet.update(at + 15_000, modes, false, null, true);
  assert.ok(fleet.placements.get(first.id)!.x > buffered); fleet.dispose();
});


test('accepted same-time REST orientation corrections snap while metadata-only updates preserve motion history', () => {
  const time = at + 10_000, reportedAt = new Date(time).toISOString();
  const mqtt = decodeMarineMqttPosition('vessels-v2/230123456/location', { time: time / 1000,
    lon: 24.9521, lat: 60.1695, sog: 0, heading: 511 }, reportedAt, time);
  const rest = decodeMarineRestPosition({ type: 'Feature', id: 230123456,
    geometry: { type: 'Point', coordinates: [24.9521, 60.1695] },
    properties: { mmsi: 230123456, timestampExternal: time, timestamp: 0, sog: 0, heading: 90 } }, reportedAt, time);
  const buffer = new ReceivedPositions(); buffer.upsert(ship({ speedMetresPerSecond: 0 })); buffer.upsert(mqtt);
  const history = buffer.tracks.get(mqtt.id)!.positions;
  assert.equal(history.length, 2); assert.equal(history.at(-1)!.heading, null);
  const metadata = withMarineMetadata(mqtt, { mmsi: '230123456', imo: null, name: 'Vessel metadata', callSign: null, shipType: 70,
    reportedAt: new Date(time + 1000).toISOString(), receivedAt: new Date(time + 2000).toISOString(), quality: [] });
  buffer.upsert(metadata);
  assert.equal(buffer.tracks.get(mqtt.id)!.positions, history);
  assert.equal(buffer.tracks.get(mqtt.id)!.vehicle.marine!.name, 'Vessel metadata');
  const corrected = mergeMarinePosition(metadata, rest);
  assert.equal(corrected.marine!.positionSource, 'rest'); assert.equal(corrected.quality.includes('position-same-second-conflict'), false);
  buffer.upsert(corrected);
  assert.equal(buffer.tracks.get(mqtt.id)!.positions.length, 1);
  assert.equal(buffer.position(mqtt.id, time)!.heading, 90);
  assert.equal(buffer.position(mqtt.id, time)!.x, history.at(-1)!.x);
});


for (const reducedMotion of [false, true]) test(`brief ${reducedMotion ? 'reduced motion' : 'marine pause'} and resume cannot rewind a displayed fix before the report buffer drains`, () => {
  const fleet = new LiveFleet(() => 0), first = ship(), second = ship({ longitude: 24.9521, reportedAt: new Date(at + 10_000).toISOString() });
  fleet.setVehicles([first, vehicle()]); fleet.setVehicles([second, vehicle({ longitude: 24.9521, reportedAt: second.reportedAt })]);
  fleet.update(at + 15_000, modes, reducedMotion, null, !reducedMotion);
  const latest = fleet.placements.get(first.id)!.x;
  fleet.update(at + 16_000, modes, false, null, false);
  assert.equal(fleet.placements.get(first.id)!.x, latest);
  assert.equal(fleet.motion.tracks.get('0040/00001')!.positions.length, 2);
  const third = ship({ longitude: 24.9522, reportedAt: new Date(at + 20_000).toISOString() });
  fleet.setVehicles([third]); fleet.update(at + 21_000, modes, reducedMotion, null, !reducedMotion);
  const duringPause = fleet.placements.get(first.id)!.x;
  fleet.update(at + 22_000, modes, false, null, false);
  assert.equal(fleet.placements.get(first.id)!.x, duringPause);
  const fourth = ship({ longitude: 24.9523, reportedAt: new Date(at + 30_000).toISOString() });
  fleet.setVehicles([fourth]); fleet.update(at + 35_000, modes, false);
  assert.ok(fleet.placements.get(first.id)!.x > duringPause);
  assert.ok(fleet.placements.get(first.id)!.x < wgs84ToScene(fourth.longitude!, fourth.latitude!)[0]);
  fleet.dispose();
});


test('AIS ship model families include all hazard subclasses and tug codes', () => {
  for (const [start, end, expected] of [[60, 69, 'passenger'], [70, 79, 'cargo'], [80, 89, 'tanker']] as const) {
    for (let code = start; code <= end; code++) assert.equal(shipModelType(code), expected);
  }
  for (const code of [31, 32, 52]) assert.equal(shipModelType(code), 'tug');
  assert.equal(shipModelType(30), 'fishing'); assert.equal(shipModelType(36), 'sailing'); assert.equal(shipModelType(37), 'pleasure');
  for (const code of [null, 0, 20, 29, 33, 34, 35, 38, 40, 49, 50, 51, 53, 59, 90, 99, -1, 256, 60.5, NaN]) {
    assert.equal(shipModelType(code), 'generic');
  }
});

const shipLengths = { passenger: 160, cargo: 140, tanker: 160, tug: 28, fishing: 24, sailing: 12, pleasure: 15, generic: 40 };
const shipCodes = [60, 70, 80, 52, 30, 36, 37, null];
for (const type of SHIP_MODEL_TYPES) test(`${type} ship export has detailed metre-scale geometry and a waterline`, async () => {
  const bytes = await readFile(new URL(`../static/models/ship-${type}.glb`, import.meta.url));
  assert.ok(bytes.byteLength < 2 * 1024 ** 2);
  const model = await parseVehicleModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'ship');
  try {
    const box = model.geometry.boundingBox!, size = box.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.z - shipLengths[type]) < .15);
    assert.ok(size.x >= 1 && size.x <= 60); assert.ok(model.roofHeight > 3 && size.y <= 80);
    assert.ok(box.min.y < 0 && box.min.y >= -12);
    assert.equal(model.materials.length, 3); assert.equal(model.geometry.groups.length, 3);
    assert.ok(model.geometry.getAttribute('color')); assert.ok(model.geometry.getAttribute('normal'));
    assert.ok(model.geometry.index!.count / 3 < 18_000);
  } finally { disposeVehicleModel(model); }
});

test('ship validation permits marine envelopes without widening transit bounds', async () => {
  const scene = new THREE.Group();
  const parseMock = mock.method(GLTFLoader.prototype, 'parseAsync', async () => ({ scene } as unknown as GLTF));
  try {
    for (const [width, height, length, bottom, accepted] of [
      [60, 80, 300, -12, true], [61, 10, 50, -2, false], [10, 81, 50, -2, false],
      [10, 10, 301, -2, false], [10, 20, 50, -13, false], [10, 10, 50, 0, false], [10, 2, 50, -3, false]
    ] as const) {
      const geometry = new THREE.BoxGeometry(width, height, length).translate(0, bottom + height / 2, 0);
      scene.clear(); scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
      if (accepted) disposeVehicleModel(await parseVehicleModel(new ArrayBuffer(0), 'ship'));
      else await assert.rejects(parseVehicleModel(new ArrayBuffer(0), 'ship'), /operating envelope/);
    }
    scene.clear(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(23, 20, 140).translate(0, 8, 0), new THREE.MeshStandardMaterial()));
    await assert.rejects(parseVehicleModel(new ArrayBuffer(0)), /operating envelope/);
  } finally { parseMock.mock.restore(); }
});

const shipAssetFetch = async (input: RequestInfo | URL) => new Response(new Uint8Array(
  await readFile(new URL('../static' + String(input), import.meta.url))));

test('mixed ship variants stay selectable, use the right roof, and switch type without resetting motion', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', shipAssetFetch);
  const fleet = new LiveFleet(() => 99, 2), errors: string[] = [];
  try {
    const ships = SHIP_MODEL_TYPES.map((type, index) => ship({ id: `ais:${230123400 + index}`,
      longitude: 24.94 + index * .004, headingDegrees: 90,
      marine: { ...ship().marine!, shipType: shipCodes[index] } }));
    const unknown = ship({ id: 'ais:230123499', longitude: 24.98 });
    fleet.setVehicles([...ships, unknown]); fleet.update(at, modes, true);
    assert.equal(fleet.meshes.get('ship')!.count, 9);
    await fleet.loadShipModels(message => errors.push(message)); assert.deepEqual(errors, []);
    fleet.update(at, modes, true); assert.equal(fleet.meshes.get('ship')!.count, 1);
    assert.equal(fleet.visibleCount, 9);
    fleet.root.updateMatrixWorld(true);
    SHIP_MODEL_TYPES.forEach((type, index) => {
      const mesh = fleet.meshes.get(`ship-${type}`)!, matrix = new THREE.Matrix4();
      assert.equal(mesh.count, 1); assert.equal(fleet.idForHit({ object: mesh, instanceId: 0 }), ships[index].id);
      mesh.getMatrixAt(0, matrix); assert.equal(matrix.elements[13], 2); assert.equal(matrix.getMaxScaleOnAxis(), 1);
      assert.ok(Math.abs(new THREE.Vector3(0, 0, -1).transformDirection(matrix).x - 1) < .001);
      assert.equal(fleet.placements.get(ships[index].id)!.roofHeight, mesh.geometry.boundingBox!.max.y);
      const [x, , z] = wgs84ToScene(ships[index].longitude!, ships[index].latitude!);
      const hits = new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0)).intersectObject(mesh);
      assert.ok(hits.length); assert.equal(fleet.idForHit(hits[0]), ships[index].id);
    });
    const history = fleet.motion.tracks.get(ships[0].id)!.positions;
    const changed = { ...ships[0], marine: { ...ships[0].marine!, shipType: 80 } };
    fleet.setVehicles([changed, ...ships.slice(1), unknown]); fleet.update(at, modes, true);
    assert.equal(fleet.motion.tracks.get(changed.id)!.positions, history);
    assert.equal(fleet.meshes.get('ship-passenger')!.count, 0); assert.equal(fleet.meshes.get('ship-tanker')!.count, 2);
    assert.equal(fleet.idForHit({ object: fleet.meshes.get('ship-tanker')!, instanceId: 0 }), changed.id);
    fleet.setVehicles([{ ...changed, headingDegrees: null }]); fleet.update(at, modes, true);
    assert.equal(fleet.meshes.get('ship')!.count, 1); assert.equal(fleet.meshes.get('ship-tanker')!.count, 0);
    fleet.setVehicles([changed]); fleet.update(at, modes, true);
    assert.equal(fleet.meshes.get('ship-tanker')!.count, 1); assert.equal(fleet.meshes.get('ship')!.count, 0);
    fleet.update(at + 130_000, modes, true);
    const colour = new THREE.Color(); fleet.meshes.get('ship-tanker')!.getColorAt(0, colour);
    assert.ok(Math.abs(colour.r - .4) < .001); assert.equal(fleet.placements.get(changed.id)!.stale, true);
    fleet.update(at, { ...modes, ship: false }, true); assert.equal(fleet.visibleCount, 0);
    assert.ok([...fleet.meshes.values()].every(mesh => mesh.count === 0));
    let disposed = 0;
    for (const type of SHIP_MODEL_TYPES) fleet.meshes.get(`ship-${type}`)!.geometry.addEventListener('dispose', () => disposed++);
    fleet.dispose(); fleet.dispose(); assert.equal(disposed, 8);
  } finally { fleet.dispose(); fetchMock.mock.restore(); }
});

test('failed, oversized and invalid ship assets retain selectable markers and heading cues', async () => {
  for (const response of [() => new Response('', { status: 404 }),
    () => new Response(new ArrayBuffer(2 * 1024 ** 2 + 1)), () => new Response(new ArrayBuffer(1))]) {
    const fetchMock = mock.method(globalThis, 'fetch', async () => response());
    const fleet = new LiveFleet(() => 0), errors: string[] = [];
    try {
      await fleet.loadShipModels(message => errors.push(message)); assert.equal(errors.length, 8);
      fleet.setVehicles([ship({ headingDegrees: 90, marine: { ...ship().marine!, shipType: 70 } })]); fleet.update(at, modes, true);
      const base = fleet.meshes.get('ship')!;
      assert.equal(base.count, 1); assert.equal(fleet.idForHit({ object: base, instanceId: 0 }), 'ais:230123456');
      const cue = fleet.root.children.find(mesh => ![...fleet.meshes.values()].includes(mesh as THREE.InstancedMesh)) as THREE.InstancedMesh;
      const matrix = new THREE.Matrix4(); cue.getMatrixAt(0, matrix); assert.equal(matrix.getMaxScaleOnAxis(), 1);
    } finally { fleet.dispose(); fetchMock.mock.restore(); }
  }
});

test('ship models completing after disposal are released without resurrecting instances', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(new ArrayBuffer(1)));
  const pending: ((value: GLTF) => void)[] = [];
  const parseMock = mock.method(GLTFLoader.prototype, 'parseAsync', () => new Promise<GLTF>(resolve => pending.push(resolve)));
  const fleet = new LiveFleet(() => 0), errors: string[] = [];
  try {
    const loading = fleet.loadShipModels(message => errors.push(message));
    while (pending.length < 8) await new Promise(resolve => setImmediate(resolve));
    fleet.dispose(); let disposed = 0;
    for (const resolve of pending) {
      const scene = new THREE.Group(), material = new THREE.MeshStandardMaterial();
      material.addEventListener('dispose', () => disposed++);
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 12).translate(0, 1, 0), material));
      resolve({ scene } as unknown as GLTF);
    }
    await loading; assert.equal(disposed, 8); assert.equal(fleet.root.children.length, 0);
    assert.equal(fleet.meshes.size, 0); assert.deepEqual(errors, []);
  } finally { fleet.dispose(); fetchMock.mock.restore(); parseMock.mock.restore(); }
});
