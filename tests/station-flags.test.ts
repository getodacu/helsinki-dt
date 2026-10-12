import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { StationFlags, projectStationFlags, stationVisible } from '../src/lib/station-flags.ts';
import { INITIAL_LAYERS, type SceneStation } from '../src/lib/scene.ts';
import type { CityBase } from '../src/lib/city-assets.ts';

const station: SceneStation = { id: '00100742', name: 'Fixture air station', longitude: 24.952, latitude: 60.1695,
  kind: 'air-quality', sourceIds: ['fmi-air-quality'] };
const weather: SceneStation = { ...station, name: 'Fixture weather station', kind: 'weather', sourceIds: ['fmi-weather'] };
const webcam: SceneStation = { ...station, id: 'C01674', name: 'Ruoholahti', kind: 'camera', sourceIds: ['digitraffic-weathercam'] };
const rail: SceneStation = { ...station, id: 'rail:HKI', name: 'Helsinki', kind: 'rail', sourceIds: ['digitraffic'] };
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

test('station visibility follows each layer independently', () => {
  for (const [value, layer] of [[weather, 'weather'], [station, 'airQuality'], [rail, 'railStations']] as const) {
    assert.equal(stationVisible(value, INITIAL_LAYERS), true);
    const hidden = { ...INITIAL_LAYERS, [layer]: false };
    assert.equal(stationVisible(value, hidden), false);
    for (const other of [weather, station, rail].filter(item => item.kind !== value.kind)) {
      assert.equal(stationVisible(other, hidden), true);
    }
  }
});

test('viewport clipping fits taller environmental signs and retains the smaller rail signs', () => {
  const edge = new THREE.OrthographicCamera(-400, 400, 400, -400, 1, 1000);
  // Pole feet at y=100 fit rail signs (74px), but not environmental signs (120px).
  edge.position.set(0, -287.5, 100); edge.lookAt(0, -287.5, 0); edge.updateMatrixWorld();
  assert.deepEqual(projectStationFlags([weather, station, rail], base, edge, 800, 800).map(flag => flag.station), [rail]);
  for (const x of [375, -375]) {
    edge.position.set(x, 12.5, 100); edge.lookAt(x, 12.5, 0); edge.updateMatrixWorld();
    assert.deepEqual(projectStationFlags([weather, station, rail], base, edge, 800, 800).map(flag => flag.station), [rail]);
  }
});

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  style = { transform: '', backgroundColor: '', borderColor: '' };
  textContent = '';
  attributes = new Map<string, string>();
  className = ''; innerHTML = ''; title = ''; type = ''; tabIndex = 0;
  dataset: Record<string, string> = {};
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
    signs.setStations([station, weather, rail]); signs.update(camera, 800, 800, weather);
    const [air, sun, train] = container.children[0].children;
    const projected = projectStationFlags([station, weather, rail], base, camera, 800, 800);
    for (const [button, flag, pole] of [[air, projected[0], 60], [sun, projected[1], 60], [train, projected[2], 26]] as const) {
      assert.equal(button.style.transform, `translate3d(${flag.x}px,${flag.y - pole}px,0) translate(-50%,-100%)`);
    }
    assert.match(air.className, /air-quality/); assert.match(sun.className, /weather selected/);
    assert.notEqual(air.innerHTML, sun.innerHTML);
    assert.equal(air.attributes.get('aria-label'), 'Air quality station · Fixture air station');
    assert.equal(sun.attributes.get('aria-label'), 'Weather station · Fixture weather station');
    assert.equal(train.attributes.get('aria-label'), 'Railway station · Helsinki');
    assert.match(train.innerHTML, /<small>Rail<\/small>/);
    train.onclick!(); assert.equal(selections.pop(), rail);
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


test('camera posts stay visible independently, fit tall-post clipping and are keyboard-accessible', () => {
  const hidden = Object.fromEntries(Object.keys(INITIAL_LAYERS).map(key => [key, false])) as typeof INITIAL_LAYERS;
  assert.equal(stationVisible(webcam, hidden), true);
  assert.equal(stationVisible(weather, hidden), false);
  assert.equal(projectStationFlags([webcam], base, camera, 800, 800).length, 1);
  const edge = new THREE.OrthographicCamera(-400, 400, 400, -400, 1, 1000);
  edge.position.set(0, -287.5, 100); edge.lookAt(0, -287.5, 0); edge.updateMatrixWorld();
  assert.deepEqual(projectStationFlags([webcam], base, edge, 800, 800), []);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  const container = new Element(), selections: SceneStation[] = [];
  const signs = new StationFlags(container as unknown as HTMLElement, base, value => selections.push(value), () => {});
  try {
    signs.setStations([webcam]); signs.update(camera, 800, 800);
    const button = container.children[0].children[0], point = projectStationFlags([webcam], base, camera, 800, 800)[0];
    assert.equal(button.tabIndex, 0); assert.equal(button.attributes.get('aria-haspopup'), 'dialog');
    assert.equal(button.attributes.get('aria-label'), 'Camera · Ruoholahti');
    assert.match(button.className, /camera/); assert.match(button.innerHTML, /<circle.*r="4"/);
    assert.equal(button.style.transform, `translate3d(${point.x}px,${point.y - 60}px,0) translate(-50%,-100%)`);
    button.onclick!(); assert.equal(selections[0], webcam);
  } finally {
    signs.dispose();
    if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('port cameras reuse tall terrain posts with their own icon, independent visibility and click identity', () => {
  const port: SceneStation = { ...station, id: 'port-south', name: 'South Harbour', kind: 'port-camera', sourceIds: ['port-of-helsinki'] };
  const hidden = Object.fromEntries(Object.keys(INITIAL_LAYERS).map(key => [key, false])) as typeof INITIAL_LAYERS;
  assert.equal(stationVisible(port, hidden), true);
  const point = projectStationFlags([port], base, camera, 800, 800)[0];
  const edge = new THREE.OrthographicCamera(-400, 400, 400, -400, 1, 1000);
  edge.position.set(0, -287.5, 100); edge.lookAt(0, -287.5, 0); edge.updateMatrixWorld();
  assert.deepEqual(projectStationFlags([port], base, edge, 800, 800), []);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  const container = new Element(), selections: SceneStation[] = [];
  const signs = new StationFlags(container as unknown as HTMLElement, base, value => selections.push(value), () => {});
  try {
    signs.setStations([webcam, port]); signs.update(camera, 800, 800);
    const [road, button] = container.children[0].children;
    assert.equal(button.tabIndex, 0); assert.equal(button.attributes.get('aria-haspopup'), 'dialog');
    assert.equal(button.title, 'Port cameras · South Harbour'); assert.equal(button.attributes.get('aria-label'), button.title);
    assert.match(button.className, /port-camera/); assert.match(button.innerHTML, /<small>Port<\/small>/);
    assert.notEqual(button.innerHTML, road.innerHTML);
    assert.equal(button.style.transform, `translate3d(${point.x}px,${point.y - 60}px,0) translate(-50%,-100%)`);
    button.onclick!(); assert.equal(selections[0], port);
  } finally {
    signs.dispose(); if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('smaller traffic posts retain their vehicle icon, safe hover details and colocated counter identity', () => {
  const count = { counterId: 'HEL LAM:6373', mode: 'vehicles' as const, value: 38, durationSeconds: 900, hourlyEquivalent: 152,
    observedAt: '2026-10-10T20:45:00Z', retrievedAt: '2026-10-11T10:00:00Z', complete: true };
  const summary = { counterId: count.counterId, mode: 'vehicles' as const, latest: count, maximum: { ...count, value: 200, hourlyEquivalent: 800 }, partial: false };
  const counter: SceneStation = { ...station, name: '<unsafe>', id: 'traffic:HEL LAM:6373', kind: 'traffic-counter', colour: '#7858d4',
    detail: 'HEL LAM · 38 / 15 min · Max 24 h 800 / h', trafficSummary: summary, sourceIds: ['HEL LAM'] };
  const high = { ...counter, id: 'traffic:LIVA:6373', name: 'Higher peak', colour: '#af55ce', trafficSummary: { ...summary, maximum: { ...count, hourlyEquivalent: 1200 } } };
  assert.equal(stationVisible(counter, INITIAL_LAYERS), true);
  assert.equal(stationVisible(counter, { ...INITIAL_LAYERS, trafficMeasurements: false }), false);
  assert.equal(stationVisible(weather, { ...INITIAL_LAYERS, trafficMeasurements: false }), true);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  const container = new Element(), selections: SceneStation[] = [], hovers: string[] = [];
  const signs = new StationFlags(container as unknown as HTMLElement, base, value => selections.push(value), value => hovers.push(value));
  try {
    signs.setStations([counter, high]); signs.update(camera, 800, 800);
    assert.equal(container.children[0].children.length, 1);
    let button = container.children[0].children[0]; button.onclick!(); assert.equal(selections[0], high);
    signs.update(camera, 800, 800, counter); button = container.children[0].children[0];
    const point = projectStationFlags([counter], base, camera, 800, 800)[0];
    assert.equal(button.tabIndex, 0);
    assert.equal(button.style.transform, `translate3d(${point.x}px,${point.y - 14}px,0) translate(-50%,-100%)`);
    assert.match(button.className, /traffic-counter selected/); assert.match(button.attributes.get('aria-label')!, /800 \/ h/);
    assert.match(button.innerHTML, /<small>Vehicle<\/small>/); assert.match(button.innerHTML, /M3 18a10/);
    assert.doesNotMatch(button.innerHTML, /unsafe|800/); assert.deepEqual(button.children, []); button.onclick!(); assert.equal(selections[1], counter);
    button.onpointerenter!(); assert.match(hovers[0], /38 \/ 15 min/);
    const partial = { ...counter, trafficSummary: { ...summary, partial: true } };
    signs.setStations([partial]); signs.update(camera, 800, 800);
    assert.match(button.title, /38 \/ 15 min/);
    const edge = new THREE.OrthographicCamera(-400, 400, 400, -400, 1, 1000);
    edge.position.set(0, -287.5, 100); edge.lookAt(0, -287.5, 0); edge.updateMatrixWorld();
    assert.deepEqual(projectStationFlags([webcam, counter], base, edge, 800, 800).map(flag => flag.station), [counter]);
    edge.position.set(379, 12.5, 100); edge.lookAt(379, 12.5, 0); edge.updateMatrixWorld();
    assert.deepEqual(projectStationFlags([webcam, counter], base, edge, 800, 800), []);
    edge.position.set(373, 12.5, 100); edge.lookAt(373, 12.5, 0); edge.updateMatrixWorld();
    assert.deepEqual(projectStationFlags([webcam, counter], base, edge, 800, 800).map(flag => flag.station), [counter]);
    edge.position.set(0, -324.5, 100); edge.lookAt(0, -324.5, 0); edge.updateMatrixWorld();
    assert.deepEqual(projectStationFlags([webcam, counter], base, edge, 800, 800).map(flag => flag.station), [counter]);
    edge.position.set(0, -326.5, 100); edge.lookAt(0, -326.5, 0); edge.updateMatrixWorld();
    assert.deepEqual(projectStationFlags([counter], base, edge, 800, 800), []);
  } finally {
    signs.dispose(); if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('reused traffic posts update labels, icons and accessible descriptions for every mode, defaulting to vehicles', () => {
  const count = { counterId: 'EcoCounter:1', mode: 'vehicles' as const, value: 12, durationSeconds: 900, hourlyEquivalent: 48,
    observedAt: '2026-10-12T05:00:00Z', retrievedAt: '2026-10-12T05:00:00Z', complete: true };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  const container = new Element(), selections: SceneStation[] = [], hovers: string[] = [];
  const signs = new StationFlags(container as unknown as HTMLElement, base, value => selections.push(value), value => hovers.push(value));
  let button: Element | undefined;
  try {
    for (const [mode, label, icon] of [['vehicles', 'Vehicle', /M3 18a10/], ['cycling', 'Bicycle', /cx="5" cy="17"/], ['walking', 'Pedestrian', /cx="14" cy="4"/], ['vehicles', 'Vehicle', /M3 18a10/]] as const) {
      const current: SceneStation = { ...station, kind: 'traffic-counter', name: 'Mode fixture',
        trafficSummary: { counterId: count.counterId, mode, latest: { ...count, mode }, maximum: { ...count, mode }, partial: false } };
      signs.setStations([current]); signs.update(camera, 800, 800, current);
      const updated = container.children[0].children[0];
      if (button) assert.equal(updated, button);
      button = updated;
      assert.equal(button.dataset.mode, mode); assert.match(button.innerHTML, new RegExp(`<small>${label}</small>`)); assert.match(button.innerHTML, icon);
      assert.equal(button.attributes.get('aria-label'), `${label} counter · Mode fixture · No recent reading`);
      button.onpointerenter!(); assert.equal(hovers.at(-1), button.title);
      button.onclick!(); assert.equal(selections.at(-1), current); assert.equal(button.tabIndex, 0);
      const content = button.innerHTML; signs.update(camera, 800, 800, current); assert.equal(button.innerHTML, content);
    }
    signs.setStations([{ ...station, kind: 'traffic-counter' }]); signs.update(camera, 800, 800);
    assert.equal(container.children[0].children[0], button);
    assert.match(button!.innerHTML, /<small>Vehicle<\/small>/); assert.match(button!.innerHTML, /M3 18a10/);
  } finally {
    signs.dispose(); if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
});
