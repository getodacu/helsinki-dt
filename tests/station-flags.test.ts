import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { StationFlags, projectStationFlags } from '../src/lib/station-flags.ts';
import type { SceneStation } from '../src/lib/scene.ts';
import type { CityBase } from '../src/lib/city-assets.ts';

const station: SceneStation = { id: '00100742', name: 'Fixture air station', longitude: 24.952, latitude: 60.1695,
  kind: 'air-quality', sourceIds: ['fmi-air-quality'] };
const weather: SceneStation = { ...station, name: 'Fixture weather station', kind: 'weather', sourceIds: ['fmi-weather'] };
const base: CityBase = { terrain: { width: 2, height: 2, origin: [-100, -100], step: [200, 200], elevations: [12, 12, 12, 12] },
  shorelines: [], roads: [], rails: [], waterLevel: 0, bounds: [-100, -100, 100, 100] };
const camera = new THREE.PerspectiveCamera(42, 1, 1, 1000);
camera.position.set(0, 60, 100); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();

test('station signs retain provider identity/type and anchor at known terrain in screen coordinates', () => {
  const flags = projectStationFlags([station, weather], base, camera, 800, 800);
  assert.equal(flags.length, 2); assert.equal(flags[0].station, station); assert.equal(flags[0].station.id, '00100742');
  assert.equal(flags[1].station.kind, 'weather');
  const anchor = new THREE.Vector3(0, 12.5, 0).project(camera);
  assert.ok(Math.abs(flags[0].x - (anchor.x + 1) * 400) < .01);
  assert.ok(Math.abs(flags[0].y - (1 - anchor.y) * 400) < .01);
  assert.deepEqual(projectStationFlags([{ ...station, longitude: 26 }, { ...station, id: '' }], base, camera, 800, 800), []);
  assert.deepEqual(projectStationFlags([station], { ...base, terrain: { ...base.terrain, elevations: [null, null, null, null] } }, camera, 800, 800), []);
  const behind = camera.clone(); behind.lookAt(0, 60, 200); behind.updateMatrixWorld();
  assert.deepEqual(projectStationFlags([station], base, behind, 800, 800), []);
  const offscreen = camera.clone(); offscreen.lookAt(500, 0, 0); offscreen.updateMatrixWorld();
  assert.deepEqual(projectStationFlags([station], base, offscreen, 800, 800), []);
  assert.deepEqual(projectStationFlags([station], base, camera, 20, 20), []);
});

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  style = { transform: '' };
  attributes = new Map<string, string>();
  className = ''; innerHTML = ''; title = ''; type = ''; tabIndex = 0;
  onclick: (() => void) | null = null;
  onpointerenter: (() => void) | null = null;
  onpointerleave: (() => void) | null = null;
  append(child: Element) { this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

test('station signs distinguish kinds, select refreshed records, show names, and clean up', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  const container = new Element(), selections: SceneStation[] = [], hovers: string[] = [];
  const signs = new StationFlags(container as unknown as HTMLElement, base, value => selections.push(value), value => hovers.push(value));
  try {
    signs.setStations([station, weather]); signs.update(camera, 800, 800, weather);
    const [air, sun] = container.children[0].children;
    assert.match(air.className, /air-quality/); assert.match(sun.className, /weather selected/);
    assert.notEqual(air.innerHTML, sun.innerHTML);
    assert.equal(air.attributes.get('aria-label'), 'Air quality station · Fixture air station');
    assert.equal(sun.attributes.get('aria-label'), 'Weather station · Fixture weather station');
    air.onclick!(); assert.equal(selections[0], station);
    const fresh = { ...station, name: 'Updated air station' };
    signs.setStations([fresh, weather]); signs.update(camera, 800, 800, fresh);
    assert.equal(container.children[0].children[0], air); assert.match(air.className, /selected/);
    air.onclick!(); assert.equal(selections[1], fresh);
    air.onpointerenter!(); air.onpointerleave!();
    assert.deepEqual(hovers, ['Air quality station · Updated air station', '']);
    assert.equal(air.title, 'Air quality station · Updated air station');
    signs.setStations([fresh]); signs.update(camera, 800, 800);
    assert.equal(container.children[0].children.length, 1);
    signs.setStations([]); signs.update(camera, 800, 800);
    assert.equal(container.children[0].children.length, 0);
    signs.dispose(); assert.equal(container.children.length, 0);
  } finally {
    signs.dispose();
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
