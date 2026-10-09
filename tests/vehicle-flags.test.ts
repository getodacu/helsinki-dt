import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { projectVehicleFlags } from '../src/lib/vehicle-flags.ts';
import type { VehiclePlacement } from '../src/lib/live-fleet.ts';
import type { Vehicle } from '../src/lib/types.ts';
const placement = (id: string, x = 0, z = 0): VehiclePlacement => ({ vehicle: { id, mode: 'bus' } as Vehicle,
  x, y: 0, z, roofHeight: 3.3, stale: false });
const camera = new THREE.PerspectiveCamera(42, 1, 1, 1000);
camera.position.set(0, 60, 100); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();

test('flags exclude offscreen/behind-camera vehicles and prioritize selected and hovered overlaps', () => {
  const placements = [placement('a'), placement('b'), placement('offscreen', 10000), placement('behind', 0, 300)];
  assert.deepEqual(projectVehicleFlags(placements, camera, 800, 800).map(flag => flag.placement.vehicle.id), ['a']);
  assert.deepEqual(projectVehicleFlags(placements, camera, 800, 800, 'b').map(flag => flag.placement.vehicle.id), ['b']);
  assert.deepEqual(projectVehicleFlags(placements, camera, 800, 800, null, 'b').map(flag => flag.placement.vehicle.id), ['b']);
  assert.deepEqual(projectVehicleFlags([], camera, 800, 800), []);
});

test('dense views keep a bounded set of separated flags', () => {
  const wide = new THREE.OrthographicCamera(-1000, 1000, 1000, -1000, 1, 5000);
  wide.position.set(0, 2000, 0); wide.lookAt(0, 0, 0); wide.updateMatrixWorld();
  const placements = Array.from({ length: 400 }, (_, i) => placement(String(i), i % 20 * 90 - 850, Math.floor(i / 20) * 90 - 850));
  const flags = projectVehicleFlags(placements, wide, 3000, 3000, '399');
  assert.equal(flags.length, 80); assert.equal(flags[0].placement.vehicle.id, '399');
  for (let i = 0; i < flags.length; i++) for (let j = i + 1; j < flags.length; j++) {
    assert.ok(Math.abs(flags[i].x - flags[j].x) >= 48 || Math.abs(flags[i].y - flags[j].y) >= 66);
  }
});

test('compact posts fit nearby vehicles and reserve enough room above the roof for the panel and stem', () => {
  const view = new THREE.OrthographicCamera(-400, 400, 400, -400, 1, 5000);
  view.position.set(0, 2000, 0); view.lookAt(0, 0, 0); view.updateMatrixWorld();
  assert.deepEqual(projectVehicleFlags([placement('a'), placement('b', 50)], view, 800, 800)
    .map(flag => flag.placement.vehicle.id), ['a', 'b']);
  assert.equal(projectVehicleFlags([placement('near-top', 0, -330)], view, 800, 800).length, 1);
  assert.equal(projectVehicleFlags([placement('clipped', 0, -350)], view, 800, 800).length, 0);
});
