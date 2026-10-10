import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { createRouteLines, routeGeometry, routeStopPositions, vehicleDirection, RouteHighlight } from '../src/lib/route-highlight.ts';
import { LiveFleet, MODE_COLOURS, type VehiclePlacement } from '../src/lib/live-fleet.ts';
import type { CityBase } from '../src/lib/city-assets.ts';
import type { RouteContext } from '../src/lib/route-context.ts';
import type { Vehicle } from '../src/lib/types.ts';

const base: CityBase = { terrain: { width: 2, height: 2, origin: [-100,-100], step: [200,200], elevations: [12,12,12,12] },
  shorelines: [], roads: [], rails: [], waterLevel: 2, bounds: [-100,-100,100,100] };
const route: RouteContext = { status: 'exact', vehicleId: 'fixture/bus', routeId: 'fixture/route', routeLabel: '24', destination: null,
  tripId: 'fixture', departureAt: null, candidates: ['fixture'], shape: [[[24.952,60.1695],[24.9521,60.1695]], [[24.9522,60.1695],[24.9523,60.1695]]],
  stops: [{ id: 'fixture/stop', name: 'Fixture station', sequence: 1, longitude: 24.952, latitude: 60.1695, arrivalAt: null, departureAt: null }],
  reason: null, sourceId: 'hsl-gtfs', generatedAt: null, source: null };
const at = Date.parse('2026-10-10T10:00:00Z');
const vehicle = (changes: Partial<Vehicle> = {}): Vehicle => ({ id: 'fixture/bus', mode: 'bus', ownerOperatorId: null, vehicleId: '1',
  operatingOperatorId: null, routeId: 'fixture/route', directionId: null, serviceDate: null, startTime: null, journeyReference: null,
  reportedAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString(), longitude: 24.952, latitude: 60.1695,
  speedMetresPerSecond: 4, headingDegrees: 0, rawDeviationSeconds: null, delaySeconds: null, quality: [], sourceId: 'test-fixture', ...changes });
const placement = (changes: Partial<VehiclePlacement> = {}): VehiclePlacement => ({ vehicle: vehicle(), x: 0, y: 12, z: 0,
  roofHeight: 3.3, heading: 0, frontExtent: 6, stale: false, ...changes });
const camera = new THREE.PerspectiveCamera(42, 1, 1, 40000); camera.position.set(0, 100, 100); camera.lookAt(0,0,0); camera.updateMatrixWorld();

 test('wide routes preserve separate segments, transport colour, pixel width and draw over buildings', () => {
  const lines = createRouteLines(route, base, 'bus');
  assert.equal(lines.children.length, 2);
  const [outline, stroke] = lines.children as LineSegments2[];
  assert.equal(outline.material.linewidth, 8); assert.equal(stroke.material.linewidth, 4);
  assert.equal(stroke.material.color.getHexString(), MODE_COLOURS.bus.slice(1));
  for (const line of [outline, stroke]) {
    assert.equal(line.material.depthTest, false); assert.equal(line.material.depthWrite, false); assert.equal(line.material.worldUnits, false);
    assert.equal(line.geometry.getAttribute('instanceStart').count, 2);
    assert.equal(line.geometry.getAttribute('instanceStart').getY(0), 13.5);
  }
  assert.ok(stroke.renderOrder > outline.renderOrder);
  outline.geometry.dispose(); outline.material.dispose(); stroke.material.dispose();
  for (const status of ['missing','ambiguous','unavailable'] as const) assert.equal(createRouteLines({ ...route, status }, base, 'bus').children.length, 0);
});

test('ferry routes and stops use the water datum; ground stops require covered terrain', () => {
  const unknown = { ...base, terrain: { ...base.terrain, elevations: [null,null,null,null] } };
  const geometry = routeGeometry(route, unknown, true);
  assert.equal(geometry.getAttribute('position').count, 4); assert.equal(geometry.getAttribute('position').getY(0), 3.5); geometry.dispose();
  assert.equal(routeStopPositions(route, unknown).length, 0);
  assert.equal(routeStopPositions(route, unknown, true)[0].y, 3.5);
  assert.equal(routeStopPositions({ ...route, status: 'ambiguous' }, base).length, 0);
  assert.equal(routeStopPositions({ ...route, stops: [{ ...route.stops[0], longitude: 25.5 }] }, base, true).length, 0);
});

test('direction is beyond the actual front, wraps around north, and pulses only while moving', () => {
  for (const heading of [0,90,180,270,360]) {
    const cue = vehicleDirection(placement({ heading }), camera, 800, 0, false)!;
    const radians = heading * Math.PI / 180;
    assert.ok(Math.abs(cue.x - Math.sin(radians) * (6 + cue.scale * 6)) < 1e-8);
    assert.ok(Math.abs(cue.z + Math.cos(radians) * (6 + cue.scale * 6)) < 1e-8);
  }
  const first = vehicleDirection(placement(), camera, 800, 0, false)!;
  const advanced = vehicleDirection(placement(), camera, 800, 500, false)!; assert.ok(advanced.z < first.z);
  assert.deepEqual(vehicleDirection(placement(), camera, 800, 0, true), vehicleDirection(placement(), camera, 800, 500, true));
  const stopped = placement({ vehicle: vehicle({ speedMetresPerSecond: 0 }) });
  assert.deepEqual(vehicleDirection(stopped, camera, 800, 0, false), vehicleDirection(stopped, camera, 800, 500, false));
  for (const hidden of [null, placement({ heading: null }), placement({ stale: true })]) assert.equal(vehicleDirection(hidden, camera, 800, 0, false), null);
});

test('fleet exposes buffered heading and model front; unknown and rejected train movement never imply north', () => {
  const fleet = new LiveFleet(() => 12, 2), modes = { bus: true, tram: true, train: true, ferry: true, ship: true };
  const train = vehicle({ mode: 'train', headingDegrees: null });
  fleet.setVehicles([train]); fleet.update(at, modes, true); assert.equal(fleet.placements.get(train.id)!.heading, null);
  fleet.setVehicles([{ ...train, longitude: 24.9521, reportedAt: new Date(at + 10000).toISOString() }]); fleet.update(at + 10000, modes, true);
  assert.ok(Math.abs(fleet.placements.get(train.id)!.heading! - 90) < 1);
  fleet.setVehicles([{ ...train, longitude: 24.962, reportedAt: new Date(at + 11000).toISOString() }]); fleet.update(at + 11000, modes, true);
  assert.equal(fleet.placements.get(train.id)!.heading, null);
  fleet.update(at + 42000, modes, true); assert.equal(fleet.placements.get(train.id)!.stale, true);
  fleet.setVehicles([]); fleet.update(at + 43000, modes, true); assert.equal(fleet.placements.size, 0); fleet.dispose();
  const bus = new LiveFleet(() => 12, 2);
  const geometry = new THREE.BoxGeometry(3,4,12); geometry.computeBoundingBox();
  bus.setModel('bus', { geometry, materials: [new THREE.MeshBasicMaterial()], roofHeight: 4 });
  bus.setVehicles([vehicle({ headingDegrees: 350 })]);
  bus.setVehicles([vehicle({ longitude: 24.9521, headingDegrees: 10, reportedAt: new Date(at + 1000).toISOString() })]);
  bus.update(at + 1700, modes, false);
  assert.equal(bus.placements.get('fixture/bus')!.heading, 360); assert.equal(bus.placements.get('fixture/bus')!.frontExtent, 6);
  bus.update(at + 1700, { ...modes, bus: false }, false); assert.equal(bus.placements.size, 0); bus.dispose();
});

class ElementFixture {
  children: ElementFixture[] = []; parent: ElementFixture | null = null; hidden = false;
  style = { setProperty() {}, transform: '' }; className = ''; type = ''; textContent = ''; title = '';
  attributes = new Map<string,string>();
  append(...children: ElementFixture[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
  setAttribute(name: string, value: string) { this.attributes.set(name,value); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
}

test('route replacement clears markers; hiding and disposal remove overlays and shared GPU resources', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new ElementFixture() } });
  try {
    const container = new ElementFixture(), highlight = new RouteHighlight(container as unknown as HTMLElement, base);
    highlight.setRoute(route, 'bus'); highlight.setVisible(true);
    const markers = container.children[0]; assert.equal(markers.children.length,1);
    assert.equal(markers.children[0].attributes.get('aria-label'), 'Stop 1: Fixture station');
    highlight.update(placement(), camera, 800, 800, 0, false); assert.equal(markers.hidden,false);
    highlight.setVisible(false); assert.equal(markers.hidden,true);
    const lines = highlight.root.children[0].children as LineSegments2[]; let disposed = 0;
    lines[0].geometry.addEventListener('dispose', () => disposed++);
    highlight.setRoute({ ...route, status: 'missing' }, 'bus'); assert.equal(disposed,1); assert.equal(markers.children.length,0);
    highlight.setRoute({ ...route, vehicleId: 'fixture/ferry' }, 'ferry'); assert.equal(markers.children.length,1);
    highlight.dispose(); assert.equal(container.children.length,0); assert.equal(highlight.root.children.length,0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});
