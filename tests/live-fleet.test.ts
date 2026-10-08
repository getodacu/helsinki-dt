import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LiveFleet, ReceivedPositions, VEHICLE_DISPLAY_SCALE, vehicleVisible } from '../src/lib/live-fleet.ts';
import { wgs84ToScene } from '../src/lib/geo.ts';
import type { Vehicle } from '../src/lib/types.ts';
const at = Date.parse('2026-10-08T11:00:00Z');
const vehicle = (changes: Partial<Vehicle> = {}): Vehicle => ({ id: '0040/00001', mode: 'tram', ownerOperatorId: '0040', vehicleId: '00001',
  operatingOperatorId: '0040', routeId: '1002', directionId: '1', serviceDate: '2026-10-08', startTime: '14:00', journeyReference: null,
  reportedAt: new Date(at).toISOString(), receivedAt: new Date(at + 100).toISOString(), longitude: 24.952, latitude: 60.1695,
  speedMetresPerSecond: 4, headingDegrees: 350, rawDeviationSeconds: -20, delaySeconds: 20, quality: [], sourceId: 'test-fixture', ...changes });
const modes = { tram: true, bus: true, ferry: true };

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
  tram.getMatrixAt(0, matrix); assert.ok(Math.abs(matrix.elements[13] - (12 + 3.4 * VEHICLE_DISPLAY_SCALE / 2 + 0.3)) < 0.001);
  ferry.getMatrixAt(0, matrix); assert.ok(Math.abs(matrix.elements[13] - (5 * VEHICLE_DISPLAY_SCALE / 2 + 0.3)) < 0.001);
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
