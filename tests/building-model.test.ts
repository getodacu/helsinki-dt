import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CityAssetCache } from '../src/lib/city-cache.ts';
import { TEXTURED_BUILDINGS_URL } from '../src/lib/city-source.ts';
import type { CityBase } from '../src/lib/city-assets.ts';
import type { Building } from '../src/lib/types.ts';
import { extractTexturedBuilding, loadTexturedBuilding } from '../src/lib/building-model.ts';

function source(positions: number[], features: number[], materials: THREE.MeshBasicMaterial | THREE.MeshBasicMaterial[], indexed = false) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('_feature_id_0', new THREE.Float32BufferAttribute(features, 1));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(features.flatMap((_, i) => [i % 3 === 1 ? 1 : 0, i % 3 === 2 ? 1 : 0]), 2));
  if (indexed) geometry.setIndex(features.map((_, i) => i));
  if (Array.isArray(materials)) {
    geometry.addGroup(0, 3, 0); geometry.addGroup(3, features.length - 3, 1);
  }
  const root = new THREE.Group(); root.add(new THREE.Mesh(geometry, materials));
  return { root, features: ['chosen', 'neighbour'], geometry };
}
const wall = [0, 0, 0, 2, 0, 0, 0, 3, 0];
const roof = [0, 3, 0, 2, 3, 0, 0, 3, 2];

test('selected textured facades keep every matched part, material and UV, excluding neighbours', () => {
  const texture = new THREE.Texture(), material = new THREE.MeshBasicMaterial({ map: texture });
  const other = new THREE.MeshBasicMaterial({ map: texture });
  const first = source([...wall, ...wall.map((v, i) => i % 3 === 0 ? v + 100 : v), ...roof], [0, 0, 0, 1, 1, 1, 0, 0, 0], [material, other], true);
  const second = source(wall.map((v, i) => i % 3 === 2 ? v + 2 : v), [0, 0, 0], material);
  let disposed = 0; texture.addEventListener('dispose', () => disposed++);
  const model = extractTexturedBuilding([first, second], 'chosen')!;
  assert.ok(model); assert.equal(model.root.children.length, 2);
  const mesh = model.root.children[0] as THREE.Mesh;
  assert.equal(mesh.geometry.getAttribute('position').count, 6);
  assert.deepEqual(mesh.geometry.groups.map(group => group.materialIndex), [0, 1]);
  assert.equal(mesh.material, (first.root.children[0] as THREE.Mesh).material);
  assert.deepEqual(Array.from(mesh.geometry.getAttribute('uv').array), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const bounds = new THREE.Box3().setFromObject(model.root);
  assert.equal(bounds.getSize(new THREE.Vector3()).x, 2); assert.deepEqual(bounds.getCenter(new THREE.Vector3()).toArray(), [0, 0, 0]);
  let geometryDisposed = 0; mesh.geometry.addEventListener('dispose', () => geometryDisposed++);
  const scene = new THREE.Scene(); scene.add(model.root);
  model.dispose(); model.dispose(); assert.equal(disposed, 1); assert.equal(geometryDisposed, 1); assert.equal(scene.children.length, 0);
});

test('plain walls, roof-only textures, incomplete facades and unknown identities have no preview', () => {
  for (const kind of ['plain', 'roof', 'incomplete', 'unknown', 'missing-uv', 'collapsed-uv']) {
    const texture = new THREE.Texture(), textured = new THREE.MeshBasicMaterial({ map: texture }), plain = new THREE.MeshBasicMaterial();
    const item = kind === 'roof' ? source(roof, [0, 0, 0], textured)
      : kind === 'incomplete' ? source([...wall, ...wall], [0, 0, 0, 0, 0, 0], [textured, plain])
      : source(wall, [0, 0, 0], kind === 'plain' ? plain : textured);
    if (kind === 'missing-uv') item.geometry.deleteAttribute('uv');
    if (kind === 'collapsed-uv') item.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(6), 2));
    let disposed = 0; item.geometry.addEventListener('dispose', () => disposed++);
    assert.equal(extractTexturedBuilding([item], kind === 'unknown' ? 'unknown' : 'chosen'), null, kind);
    assert.equal(disposed, 1);
    plain.dispose(); textured.dispose(); texture.dispose();
  }
});

test('corrupt feature and triangle attributes fail safely and release decoded resources', () => {
  for (const kind of ['feature', 'index']) {
    const item = source(wall, [0, 0, 0], new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
    if (kind === 'feature') item.geometry.deleteAttribute('_feature_id_0'); else item.geometry.setIndex([0, 1, 99]);
    let disposed = 0; item.geometry.addEventListener('dispose', () => disposed++);
    assert.throws(() => extractTexturedBuilding([item], 'chosen'), /building (feature|triangle)/);
    assert.equal(disposed, 1);
  }
});

const base: CityBase = { bounds: [-1000, -1000, 1000, 1000], waterLevel: 0, roads: [], rails: [], shorelines: [],
  terrain: { width: 2, height: 2, origin: [0, 0], step: [1, 1], elevations: [0, 0, 0, 0] } };
const building: Building = { id: 'BID_730f6007-d7b7-487c-9381-cd32aae1e296', gmlId: 'test', sourceId: 'test',
  chunkRef: 'test', vtjPrt: null, ratu: null, uuid: null, attributes: {}, longitude: 24.952, latitude: 60.1695 };
async function assets(failedIndex = false) {
  const fixture = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
  return new CityAssetCache((async url => {
    const upstream = new URL(String(url), 'http://localhost').searchParams.get('url');
    if (upstream === TEXTURED_BUILDINGS_URL) return failedIndex ? new Response(null, { status: 503 }) : Response.json({ root: {
      boundingVolume: { region: [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]) },
      geometricError: 0, content: { uri: '16/100/1.glb' }
    } });
    return new Response(fixture);
  }) as typeof fetch, undefined);
}

test('missing facade identities and incomplete discovery never load a substitute model', async () => {
  let parses = 0;
  const loader = { parseAsync: async () => { parses++; throw new Error('Unexpected model parse'); } } as unknown as GLTFLoader;
  for (const failure of [false, true]) {
    const cache = await assets(failure);
    try {
      const pending = loadTexturedBuilding({ ...building, id: 'absent' }, base, loader, cache, new AbortController().signal);
      if (failure) await assert.rejects(pending, /coverage unavailable/); else assert.equal(await pending, null);
      assert.equal(parses, 0);
    } finally { cache.dispose(); }
  }
});

test('closing the viewer during decode disposes its own assets before projection', async () => {
  const cache = await assets(), abort = new AbortController();
  const decoded = source(wall, [0, 0, 0], new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
  let disposed = 0; decoded.geometry.addEventListener('dispose', () => disposed++);
  const loader = { parseAsync: async () => { abort.abort(); return { scene: decoded.root }; } } as unknown as GLTFLoader;
  try {
    await assert.rejects(loadTexturedBuilding(building, base, loader, cache, abort.signal), { name: 'AbortError' });
    assert.equal(disposed, 1);
  } finally { cache.dispose(); }
});
