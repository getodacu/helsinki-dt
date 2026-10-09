import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import proj4 from 'proj4';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { CityAssetCache } from '../src/lib/city-cache.ts';
import { discoverTexturedEntries, texturedBuildingFeatures } from '../src/lib/city-source.ts';
import { CityAppearance, aerialGeometry, disposeMapObject, imageryUrl, projectTexturedModel, texturedBuildingIds, tileLocation, TEXTURED_BUILDINGS_URL } from '../src/lib/city-appearance.ts';
import { applyTextureCoverage, makeChunkGeometry } from '../src/lib/scene.ts';
import { buildingIdForTriangle } from '../src/lib/data/geometry.ts';
import { GK25, PROJECTED_ORIGIN } from '../src/lib/geo.ts';
import type { BuildingChunk } from '../src/lib/types.ts';
import type { CityBase } from '../src/lib/city-assets.ts';

test('orthophoto request preserves projected east/north bounds and image orientation', () => {
  const url = new URL(imageryUrl([-500, -1000, 500, 1000]));
  assert.equal(url.searchParams.get('SRS'), 'EPSG:3879');
  assert.equal(url.searchParams.get('LAYERS'), 'avoindata:Ortoilmakuva_2025_5cm');
  assert.deepEqual(url.searchParams.get('BBOX')!.split(',').map(Number), [PROJECTED_ORIGIN[0] - 500, PROJECTED_ORIGIN[1] - 1000, PROJECTED_ORIGIN[0] + 500, PROJECTED_ORIGIN[1] + 1000]);
  assert.throws(() => imageryUrl([0, 0, NaN, 1]));
  const base: CityBase = {terrain:{width:2,height:2,origin:[0,0],step:[20,20],elevations:[12,12,12,12]},roads:[],rails:[],shorelines:[],waterLevel:0,bounds:[0,0,20,20]};
  const geometry = aerialGeometry(base, base.bounds), uv = geometry.getAttribute('uv');
  assert.deepEqual([uv.getX(0),uv.getY(0)], [0,1]); assert.deepEqual([uv.getX(1),uv.getY(1)], [0,0]);
  assert.ok(Math.abs(geometry.getAttribute('position').getY(0) - 12.08) < 1e-5);
  geometry.dispose();
  const sea = aerialGeometry({...base,terrain:{...base.terrain,elevations:[null,null,null,null]},landMask:[false,false,false,false]},base.bounds);
  assert.equal(sea.getAttribute('position').count,6); sea.dispose();
  const unknown = aerialGeometry({...base,terrain:{...base.terrain,elevations:[null,null,null,null]},landMask:[true,true,true,true]},base.bounds);
  assert.equal(unknown.getAttribute('position').count,0); unknown.dispose();
});

test('coastal imagery bridges land and sea without hiding known land elevations', () => {
  const base: CityBase = { terrain: { width: 2, height: 2, origin: [0, 0], step: [20, 20], elevations: [-2, null, 4, null] },
    landMask: [true, false, true, false], roads: [], rails: [], shorelines: [], waterLevel: 0, bounds: [0, 0, 20, 20] };
  const geometry = aerialGeometry(base, base.bounds), positions = geometry.getAttribute('position');
  assert.equal(positions.count, 6);
  assert.ok(Math.abs(positions.getY(0) - (-2 + 0.08)) < 1e-5);
  assert.ok(Math.abs(positions.getY(2) - 0.08) < 1e-5);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  for (const [x, z] of [[5, 5], [15, 15]]) {
    assert.ok(new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0)).intersectObject(mesh).length > 0);
  }
  geometry.dispose(); mesh.material.dispose();
});

test('tile references stay on the official layer and accumulate parent transforms', () => {
  const tile = {boundingVolume:{region:[24.95,60.16,24.96,60.17,-1,80].map((value,index)=>index<4?value*Math.PI/180:value)},geometricError:5,
    transform:new THREE.Matrix4().makeTranslation(1,2,3).toArray(),content:{uri:'../../16/37310/18968.glb'}};
  const source = new URL('15/18655/9484.json',TEXTURED_BUILDINGS_URL).href;
  const entry = tileLocation(tile,new THREE.Matrix4().makeTranslation(10,20,30),source);
  assert.equal(entry.url,new URL('16/37310/18968.glb',TEXTURED_BUILDINGS_URL).href);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(entry.transform).toArray(),[11,22,33]);
  assert.ok(entry.bounds[0]<entry.bounds[2] && entry.bounds[1]<entry.bounds[3]);
  for (const uri of ['https://example.org/tile.glb','../../../../private.glb','../../16/37310/18968.glb?token=x']) assert.throws(()=>tileLocation({...tile,content:{uri}},new THREE.Matrix4(),source));
  assert.throws(()=>tileLocation({...tile,transform:[1]},new THREE.Matrix4(),source));
});

test('original municipal textured IDs decode from bounded embedded metadata and reject corrupt offsets', async () => {
  // Two source ID strings from Helsinki tile 16/37310/18968.glb, City of Helsinki, CC BY 4.0; no textures/geometry redistributed.
  const fixture = await readFile(new URL('./fixtures/textured-building-identities.glb',import.meta.url));
  const bytes = fixture.buffer.slice(fixture.byteOffset,fixture.byteOffset+fixture.byteLength);
  assert.deepEqual([...texturedBuildingIds(bytes)],['BID_730f6007-d7b7-487c-9381-cd32aae1e296','BID_77021cac-6094-4163-81d3-a30f94e27b3a']);
  const corrupt = bytes.slice(0), view = new DataView(corrupt);
  view.setUint32(28+view.getUint32(12,true)+4,10000,true); assert.throws(()=>texturedBuildingIds(corrupt));
  const badHeader = bytes.slice(0); new DataView(badHeader).setUint32(8,1,true); assert.throws(()=>texturedBuildingIds(badHeader));
});

test('textured glTF Y-up and tile transforms preserve the calibrated local origin and height', () => {
  const center = proj4('EPSG:4326','+proj=geocent +ellps=WGS84 +units=m',[24.952,60.1695,12]);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0, 0,0,0, 0,0,0],3));
  const root = new THREE.Group(), nested = new THREE.Group(), mesh = new THREE.Mesh(geometry,new THREE.MeshStandardMaterial());
  nested.position.set(2,3,4); mesh.position.set(-2,-3,-4); nested.add(mesh);root.add(nested);
  projectTexturedModel(root,new THREE.Matrix4().makeTranslation(...center as [number,number,number]));
  const positions = geometry.getAttribute('position');
  assert.ok(Math.abs(positions.getX(0))<0.01); assert.ok(Math.abs(positions.getZ(0))<0.01); assert.ok(Math.abs(positions.getY(0)-12)<0.01);
  assert.deepEqual(mesh.position.toArray(),[0,0,0]); assert.deepEqual(nested.position.toArray(),[0,0,0]); disposeMapObject(root);
});

test('texture-covered semantic geometry remains pickable and resets to the analytic view', () => {
  const chunk: BuildingChunk={id:'test',positions:[0,0,0,1,0,0,0,0,1, 2,0,0,3,0,0,2,0,1],ranges:[{buildingId:'A',firstTriangle:0,triangleCount:1},{buildingId:'B',firstTriangle:1,triangleCount:1}],coordinateReference:'test',verticalReference:'N2000',origin:{longitude:24.952,latitude:60.1695,elevation:0}};
  const geometry=makeChunkGeometry(chunk), material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),hidden=new THREE.MeshBasicMaterial({visible:false,side:THREE.DoubleSide});
  applyTextureCoverage(geometry,chunk,new Set(['A'])); assert.deepEqual(geometry.groups.map(group=>group.materialIndex),[1,0]);
  const mesh=new THREE.Mesh(geometry,[material,hidden]);mesh.updateMatrixWorld();
  const hits=new THREE.Raycaster(new THREE.Vector3(0.1,10,0.1),new THREE.Vector3(0,-1,0)).intersectObject(mesh);
  assert.equal(buildingIdForTriangle(chunk,hits[0].faceIndex),'A');
  applyTextureCoverage(geometry,chunk,new Set());assert.deepEqual(geometry.groups,[{start:0,count:6,materialIndex:0}]);
  disposeMapObject(mesh);
});

test('appearance disposal releases shared GPU textures, materials and geometry exactly once', () => {
  const root=new THREE.Group(),geometry=new THREE.BoxGeometry(),texture=new THREE.Texture(),material=new THREE.MeshBasicMaterial({map:texture});
  let disposed=0;texture.addEventListener('dispose',()=>disposed++);
  root.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material));disposeMapObject(root);disposeMapObject(root);
  assert.equal(disposed,1);assert.equal(root.children.length,0);
});


test('appearance bounds concurrent requests, retries source failures quietly and aborts every request on disposal', async () => {
  const base: CityBase={terrain:{width:201,height:201,origin:[0,0],step:[20,20],elevations:Array(201*201).fill(10)},roads:[],rails:[],shorelines:[],waterLevel:0,bounds:[0,0,4000,4000]};
  const requests: { signal: AbortSignal; reject: (error: Error) => void }[]=[];
  const previousDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{value:{hidden:false},configurable:true});
  const fetchMock=mock.method(globalThis,'fetch',(_url: string,options: RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    const signal=options.signal!; signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}); requests.push({signal,reject});
  }));
  const statuses: string[]=[],renderer={extensions:{has:()=>false}} as unknown as THREE.WebGLRenderer;
  const appearance=new CityAppearance(renderer,base,()=>{},message=>statuses.push(message));
  try {
    appearance.setVisible(true,true,false);
    const target=new THREE.Vector3(2000,0,2000),frustum=new THREE.Frustum();
    appearance.update(target,3000,frustum); appearance.update(target,3000,frustum); await new Promise(resolve=>setTimeout(resolve,0)); assert.equal(requests.length,4);
    requests[0].reject(new Error('source offline')); await new Promise(resolve=>setTimeout(resolve,0));
    assert.ok(statuses.every(message=>message === ''));assert.equal(appearance.progress().failed,1);assert.equal(appearance.buildingIds.size,0);
    appearance.update(target,3000,frustum);assert.equal(requests.length,5);
    appearance.dispose();await new Promise(resolve=>setTimeout(resolve,0));
    assert.ok(requests.slice(1).every(request=>request.signal.aborted));assert.equal(appearance.aerial.children.length,0);assert.equal(appearance.buildings.children.length,0);
  } finally { appearance.dispose();fetchMock.mock.restore();if(previousDocument)Object.defineProperty(globalThis,'document',previousDocument);else Reflect.deleteProperty(globalThis,'document'); }
});


test('appearance discovers every visible model and aerial cell beyond the old 48/24 limits', async () => {
  const base: CityBase = { terrain: { width: 401, height: 401, origin: [-4000, -4000], step: [20, 20], elevations: Array(401 * 401).fill(10) },
    roads: [], rails: [], shorelines: [], waterLevel: 0, bounds: [-4000, -4000, 4000, 4000] };
  const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
  const tile = { boundingVolume: { region }, geometricError: 1000, children: Array.from({ length: 60 }, (_, i) => ({
    boundingVolume: { region }, geometricError: 0, content: { uri: `16/100/${i}.glb` }
  })) };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const fetchMock = mock.method(globalThis, 'fetch', (url: string, options: RequestInit) => {
    if (new URL(url, 'http://localhost').searchParams.get('url') === TEXTURED_BUILDINGS_URL) return Promise.resolve(new Response(JSON.stringify({ root: tile })));
    return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
  });
  const renderer = { extensions: { has: () => false } } as unknown as THREE.WebGLRenderer;
  const appearance = new CityAppearance(renderer, base, () => {}, () => {});
  try {
    appearance.setVisible(true, false, true);
    appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum());
    for (let i = 0; i < 5 && appearance.progress().discovering; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(appearance.progress().discovering, false); assert.equal(appearance.progress().total, 60);
    appearance.setVisible(true, true, false); appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum());
    assert.equal(appearance.progress().total, 40);
    appearance.setVisible(false, false, false); appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum());
    assert.deepEqual(appearance.progress(), { discovering: false, completed: 0, total: 0, failed: 0 });
  } finally {
    appearance.dispose(); fetchMock.mock.restore();
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('official empty-content markers do not make an otherwise valid subtree fail discovery', () => {
  const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
  const source = TEXTURED_BUILDINGS_URL.replace('tileset.json', '12/2331/1186.json');
  assert.equal(tileLocation({ boundingVolume: { region }, geometricError: 0, content: { uri: '../../emptyContent.glb' } }, new THREE.Matrix4(), source).url, null);
  assert.throws(() => tileLocation({ boundingVolume: { region }, geometricError: 0, content: { uri: '../../emptyContent.glb?evil=1' } }, new THREE.Matrix4(), source), /Unsafe/);
});

test('independent models attach as each decode finishes during held movement', async () => {
  const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
  const base: CityBase = { terrain: { width: 2, height: 2, origin: [-4000, -4000], step: [8000, 8000], elevations: [10, 10, 10, 10] },
    roads: [], rails: [], shorelines: [], waterLevel: 0, bounds: [-4000, -4000, 4000, 4000] };
  const tile = { boundingVolume: { region }, geometricError: 1000, children: [1, 2].map(id => ({ boundingVolume: { region }, geometricError: 0, content: { uri: `16/100/${id}.glb` } })) };
  const bytes = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const fetchMock = mock.method(globalThis, 'fetch', (url: string) => Promise.resolve(new Response(new URL(url).searchParams.get('url') === TEXTURED_BUILDINGS_URL ? JSON.stringify({ root: tile }) : bytes)));
  const decodes: ((gltf: GLTF) => void)[] = [];
  const decodeMock = mock.method(GLTFLoader.prototype, 'parseAsync', () => new Promise<GLTF>(resolve => decodes.push(resolve)));
  const cache = new CityAssetCache(); cache.setInteracting(true);
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer, base, () => {}, () => {}, cache);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    appearance.setVisible(true, false, true); appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum());
    for (let i = 0; i < 10 && decodes.length < 2; i++) await tick();
    assert.equal(decodes.length, 2);
    appearance.update(new THREE.Vector3(1, 0, 0), 1450, new THREE.Frustum()); await tick();
    assert.equal(decodes.length, 2); assert.equal(cache.viewSettled, false);
    const first = new THREE.Group(), last = new THREE.Group();
    decodes[0]({ scene: first } as unknown as GLTF); await tick();
    assert.equal(appearance.progress().completed, 1); assert.equal(appearance.buildings.children.length, 1);
    decodes[1]({ scene: last } as unknown as GLTF); await tick();
    assert.equal(appearance.progress().completed, 2); assert.equal(appearance.buildings.children.length, 2);
    const clipped = new THREE.Frustum(...Array.from({ length: 6 }, () => new THREE.Plane(new THREE.Vector3(1, 0, 0), -10_000)));
    appearance.update(new THREE.Vector3(10_000, 0, 0), 1450, clipped); await tick();
    assert.equal(appearance.buildings.children.length, 0); assert.equal(first.parent, null); assert.equal(last.parent, null);
  } finally {
    appearance.dispose(); cache.dispose(); fetchMock.mock.restore(); decodeMock.mock.restore();
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('failed subtree discovery retains healthy models and cancellation is never reported as a source gap', async () => {
  const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
  const base = { bounds: [-4000, -4000, 4000, 4000] } as CityBase;
  const root = { boundingVolume: { region }, geometricError: 1000, children: [
    { boundingVolume: { region }, geometricError: 0, content: { uri: '16/100/1.glb' } },
    { boundingVolume: { region }, geometricError: 100, content: { uri: '15/100/2.json' } }
  ] };
  const read = async (url: string) => { if (url === TEXTURED_BUILDINGS_URL) return root; throw new Error('Offline subtree'); };
  const result = await discoverTexturedEntries(base, read, () => true, () => 10, new AbortController().signal);
  assert.equal(result.entries.length, 1); assert.equal(result.failed.length, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(discoverTexturedEntries(base, read, () => true, () => 10, abort.signal), { name: 'AbortError' });
});

test('the same view automatically retries a missing index without exposing a warning', async () => {
  const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
  const base = { terrain: { width: 2, height: 2, origin: [-4000, -4000], step: [8000, 8000], elevations: [10, 10, 10, 10] },
    roads: [], rails: [], shorelines: [], waterLevel: 0, bounds: [-4000, -4000, 4000, 4000] } as CityBase;
  let now = 0, indexAttempts = 0;
  const clock = mock.method(Date, 'now', () => now), messages: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const fetchMock = mock.method(globalThis, 'fetch', () => {
    indexAttempts++;
    return Promise.resolve(indexAttempts === 1 ? new Response(null, { status: 503 }) : Response.json({ root: { boundingVolume: { region }, geometricError: 0 } }));
  });
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer, base, () => {}, message => messages.push(message));
  const update = () => appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum());
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    appearance.setVisible(true, false, true); update(); await tick();
    assert.equal(appearance.progress().failed, 1); assert.equal(indexAttempts, 1);
    now = 999; update(); await tick(); assert.equal(indexAttempts, 1);
    now = 1000; update(); await tick();
    assert.equal(indexAttempts, 2); assert.equal(appearance.progress().failed, 0); assert.equal(appearance.progress().discovering, false);
    assert.ok(messages.every(message => !message));
  } finally {
    appearance.dispose(); clock.mock.restore(); fetchMock.mock.restore();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('aerial batches start during held movement without exceeding four downloads', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const requests: { signal: AbortSignal }[] = [];
  const cache = new CityAssetCache(((_url, options) => new Promise<Response>((_resolve, reject) => {
    const signal = options!.signal!; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); requests.push({ signal });
  })) as typeof fetch, { open: async () => ({ match: async () => undefined }) } as unknown as CacheStorage);
  const base: CityBase = { terrain: { width: 201, height: 201, origin: [0, 0], step: [20, 20], elevations: Array(201 * 201).fill(10) },
    roads: [], rails: [], shorelines: [], waterLevel: 0, bounds: [0, 0, 4000, 4000] };
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer, base, () => {}, () => {}, cache);
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  try {
    appearance.setVisible(true, true, false);
    cache.setInteracting(true);
    appearance.update(new THREE.Vector3(2000, 0, 2000), 3000, new THREE.Frustum());
    await flush(); assert.equal(appearance.progress().total, 16); assert.equal(requests.length, 4);
    t.mock.timers.tick(4000); await flush(); assert.equal(requests.length, 4); assert.equal(cache.viewSettled, false);
  } finally {
    appearance.dispose(); cache.dispose(); await flush();
    assert.ok(requests.every(request => request.signal.aborted));
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('cached discovery starts model downloads immediately during held movement', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
  const index = { root: { boundingVolume: { region }, geometricError: 1000,
    children: Array.from({ length: 8 }, (_, id) => ({ boundingVolume: { region }, geometricError: 0, content: { uri: `16/100/${id}.glb` } })) } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const requests: string[] = [];
  const cache = new CityAssetCache(((url, options) => new Promise<Response>((_resolve, reject) => {
    requests.push(String(url)); options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
  })) as typeof fetch, { open: async () => ({ match: async (url: string) => url === TEXTURED_BUILDINGS_URL
    ? new Response(JSON.stringify(index), { headers: { 'x-helsinki-cached-at': '10000' } }) : undefined }) } as unknown as CacheStorage);
  const base = { bounds: [-4000, -4000, 4000, 4000] } as CityBase;
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer, base, () => {}, () => {}, cache);
  const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };
  try {
    appearance.setVisible(true, false, true);
    cache.setInteracting(true);
    appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum()); await flush();
    assert.equal(cache.viewSettled, false);
    assert.equal(appearance.progress().total, 8); assert.equal(requests.length, 4);
    assert.ok(requests.every(url => new URL(url).searchParams.get('url')?.endsWith('.glb')));
  } finally {
    appearance.dispose(); cache.dispose(); await flush();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('camera changes reuse in-flight discovery and rescan the latest view from its cached index', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
  const index = { root: { boundingVolume: { region }, geometricError: 0, content: { uri: '16/100/1.glb' } } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const requests: { url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const cache = new CityAssetCache(((url, options) => new Promise<Response>((resolve, reject) => {
    const signal = options!.signal!; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    requests.push({ url: String(url), signal, resolve });
  })) as typeof fetch, { open: async () => ({ match: async () => undefined, put: async () => {} }) } as unknown as CacheStorage);
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer,
    { bounds: [-4000, -4000, 4000, 4000] } as CityBase, () => {}, () => {}, cache);
  const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };
  try {
    cache.setInteracting(true); appearance.setVisible(true, false, true);
    appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum()); await flush();
    assert.equal(requests.length, 1);
    const clipped = new THREE.Frustum(...Array.from({ length: 6 }, () => new THREE.Plane(new THREE.Vector3(1, 0, 0), -10_000)));
    appearance.update(new THREE.Vector3(10_000, 0, 0), 1450, clipped); await flush();
    assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, false);
    requests[0].resolve(Response.json(index)); await flush();
    assert.deepEqual(appearance.progress(), { discovering: false, completed: 0, total: 0, failed: 0 });
    assert.equal(requests.length, 1, 'outdated discovery must not fetch offscreen models');
    appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum()); await flush();
    assert.equal(requests.length, 2); assert.equal(appearance.progress().total, 1);
    assert.ok(new URL(requests[1].url).searchParams.get('url')?.endsWith('.glb'));
    assert.equal(cache.viewSettled, false);
  } finally {
    appearance.dispose(); cache.dispose(); await flush();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('obsolete queued imagery is pruned while started imagery finishes caching without attaching', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
  let closed = 0, saved = 0;
  class Bitmap { width = 1024; height = 1024; close() { closed++; } }
  Object.defineProperty(globalThis, 'ImageBitmap', { value: Bitmap, configurable: true });
  Object.defineProperty(globalThis, 'createImageBitmap', { value: async () => new Bitmap(), configurable: true });
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const cache = new CityAssetCache(((_url, options) => new Promise<Response>((resolve, reject) => {
    const signal = options!.signal!; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); requests.push({ signal, resolve });
  })) as typeof fetch, { open: async () => ({ match: async () => undefined, put: async () => { saved++; } }) } as unknown as CacheStorage);
  const base: CityBase = { terrain: { width: 201, height: 201, origin: [0, 0], step: [20, 20], elevations: Array(201 * 201).fill(10) },
    roads: [], rails: [], shorelines: [], waterLevel: 0, bounds: [0, 0, 4000, 4000] };
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer, base, () => {}, () => {}, cache);
  const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };
  try {
    cache.setInteracting(true); appearance.setVisible(true, true, false);
    appearance.update(new THREE.Vector3(2000, 0, 2000), 3000, new THREE.Frustum()); await flush();
    assert.equal(requests.length, 4);
    const clipped = new THREE.Frustum(...Array.from({ length: 6 }, () => new THREE.Plane(new THREE.Vector3(1, 0, 0), -10_000)));
    appearance.update(new THREE.Vector3(10_000, 0, 0), 3000, clipped); await flush();
    assert.ok(requests.every(request => !request.signal.aborted));
    for (const request of requests) request.resolve(new Response('imagery fixture'));
    await flush();
    assert.equal(requests.length, 4); assert.equal(saved, 4); assert.equal(closed, 4);
    assert.equal(appearance.aerial.children.length, 0); assert.equal(cache.viewSettled, false);
  } finally {
    appearance.dispose(); cache.dispose(); await flush();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
    if (bitmapDescriptor) Object.defineProperty(globalThis, 'createImageBitmap', bitmapDescriptor); else Reflect.deleteProperty(globalThis, 'createImageBitmap');
    if (imageDescriptor) Object.defineProperty(globalThis, 'ImageBitmap', imageDescriptor); else Reflect.deleteProperty(globalThis, 'ImageBitmap');
  }
});


test('reused textured projections match the original conversion across the prepared area', () => {
  const center = proj4('EPSG:4326', '+proj=geocent +ellps=WGS84 +units=m', [24.952, 60.1695, 12]);
  const transform = new THREE.Matrix4().makeTranslation(...center as [number, number, number]);
  const values = [[24.952, 60.1695, 12], [24.93, 60.15, 45], [24.97, 60.19, -5], [24.99, 60.14, 120]]
    .flatMap(coordinate => {
      const [x, y, z] = proj4('EPSG:4326', '+proj=geocent +ellps=WGS84 +units=m', coordinate).map((value, i) => value - center[i]);
      return [x, z, -y];
    });
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(new Float64Array(values), 3));
  const root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  projectTexturedModel(root, transform);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < values.length / 3; i++) {
    const point = new THREE.Vector3(...values.slice(i * 3, i * 3 + 3) as [number, number, number])
      .applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2)).applyMatrix4(transform);
    const [longitude, latitude, height] = proj4('+proj=geocent +ellps=WGS84 +units=m', 'EPSG:4326', point.toArray());
    const [east, north] = proj4('EPSG:4326', GK25, [longitude, latitude]);
    assert.ok(Math.abs(positions.getX(i) - (east - PROJECTED_ORIGIN[0])) < 1e-6);
    assert.ok(Math.abs(positions.getZ(i) + north - PROJECTED_ORIGIN[1]) < 1e-6);
    assert.ok(Math.abs(positions.getY(i) - height) < 1e-6);
  }
  disposeMapObject(root);
});


test('outdated discovery failures retain their retry deadline across camera changes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const responses: ((response: Response) => void)[] = [];
  const cache = new CityAssetCache(((_url, options) => new Promise<Response>((resolve, reject) => {
    responses.push(resolve); options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
  })) as typeof fetch, { open: async () => ({ match: async () => undefined, put: async () => {} }) } as unknown as CacheStorage);
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer,
    { bounds: [-4000, -4000, 4000, 4000] } as CityBase, () => {}, () => {}, cache);
  const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };
  const update = (x: number) => appearance.update(new THREE.Vector3(x, 0, 0), 1450, new THREE.Frustum());
  try {
    cache.setInteracting(true); appearance.setVisible(true, false, true);
    update(0); await flush(); update(1);
    responses[0](new Response(null, { status: 503 })); await flush();
    assert.equal(responses.length, 1); assert.equal(appearance.nextRetryAt(), 11_000);
    t.mock.timers.tick(999); update(2); await flush(); assert.equal(responses.length, 1);
    t.mock.timers.tick(1); update(3); await flush(); assert.equal(responses.length, 2);
    const region = [24.951, 60.169, 24.953, 60.171].map(value => value * Math.PI / 180).concat([0, 80]);
    responses[1](Response.json({ root: { boundingVolume: { region }, geometricError: 0 } })); await flush();
    assert.equal(appearance.progress().failed, 0); assert.equal(appearance.progress().discovering, false);
  } finally {
    appearance.dispose(); cache.dispose(); await flush();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('metadata feature order survives non-building rows', async () => {
  const fixture = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
  const original = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
  const ids = texturedBuildingFeatures(original);
  assert.equal(ids.length, 2);
  const altered = Buffer.from(fixture);
  altered.write(ids[0].replace('BID_', 'obj_'), altered.indexOf(ids[0]));
  const bytes = altered.buffer.slice(altered.byteOffset, altered.byteOffset + altered.byteLength);
  assert.deepEqual(texturedBuildingFeatures(bytes), [ids[0].replace('BID_', 'obj_'), ids[1]]);
  assert.deepEqual([...texturedBuildingIds(bytes)], [ids[1]]);
});

test('plain source surfaces retain lighting while photographic surfaces stay unlit', () => {
  const root = new THREE.Group(), texture = new THREE.Texture();
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3));
  const plain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#cccccc' }));
  const photo = new THREE.Mesh(geometry.clone(), new THREE.MeshStandardMaterial({ map: texture }));
  root.add(plain, photo);
  const center = proj4('EPSG:4326', '+proj=geocent +ellps=WGS84 +units=m', [24.952,60.1695,12]);
  projectTexturedModel(root, new THREE.Matrix4().makeTranslation(...center as [number,number,number]));
  assert.ok(plain.material instanceof THREE.MeshStandardMaterial);
  assert.ok(photo.material instanceof THREE.MeshBasicMaterial);
  assert.equal(photo.material.map, texture); assert.equal(plain.material.color.getHexString(), 'cccccc');
  disposeMapObject(root);
});

test('discovery retains model ancestry and marks only the failed replacement branch', async () => {
  const region = [24.951,60.169,24.953,60.171].map(value => value*Math.PI/180).concat([0,80]);
  const child = (uri: string, error: number) => ({ boundingVolume: { region }, geometricError: error, content: { uri } });
  const root = { ...child('15/100/1.glb', 10), children: [child('16/200/2.glb', 0), child('16/200/3.json', 10)] };
  const result = await discoverTexturedEntries({ bounds: [-4000,-4000,4000,4000] } as CityBase,
    async url => { if (url === TEXTURED_BUILDINGS_URL) return root; throw new Error('Unavailable'); }, () => true, () => 2.6, new AbortController().signal);
  const parent = new URL('15/100/1.glb', TEXTURED_BUILDINGS_URL).href;
  assert.deepEqual(result.entries[0].ancestors, [parent]); assert.deepEqual([...result.blocked], [parent]);
});

test('selected buildings refine nearby tiles without refining unrelated coverage', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const region = [24.951,60.169,24.953,60.171].map(value => value*Math.PI/180).concat([0,80]);
  const remote = [25.01,60.169,25.012,60.171].map(value => value*Math.PI/180).concat([0,80]);
  const node = (region: number[], id: number) => ({ boundingVolume: { region }, geometricError: 10, content: { uri: `15/100/${id}.glb` },
    children: [{ boundingVolume: { region }, geometricError: 0, content: { uri: `16/200/${id}.glb` } }] });
  const index = { root: { boundingVolume: { region: [region[0],region[1],remote[2],remote[3],0,80] }, geometricError: 1000, children: [node(region,1),node(remote,2)] } };
  const requests: string[] = [];
  const cache = new CityAssetCache(((url, options) => {
    const source = new URL(String(url)).searchParams.get('url')!;
    if (source === TEXTURED_BUILDINGS_URL) return Promise.resolve(Response.json(index));
    requests.push(source);
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
  }) as typeof fetch);
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer,
    { bounds: [-4000,-4000,4000,4000] } as CityBase, () => {}, () => {}, cache);
  const tick = () => new Promise(resolve => setTimeout(resolve,0));
  try {
    appearance.setVisible(true,false,true); appearance.update(new THREE.Vector3(),3000,new THREE.Frustum());
    for (let i=0;i<10 && requests.length<2;i++) await tick();
    assert.ok(requests.some(url => url.endsWith('/15/100/1.glb')));
    appearance.setSelection('selected', null, new THREE.Vector3());
    for (let i=0;i<10 && requests.length<3;i++) await tick();
    assert.ok(requests.some(url => url.endsWith('/16/200/1.glb')));
    assert.ok(!requests.some(url => url.endsWith('/16/200/2.glb')));
  } finally { appearance.dispose(); cache.dispose(); if (previous) Object.defineProperty(globalThis,'document',previous); else Reflect.deleteProperty(globalThis,'document'); }
});


test('replacement swaps each parent atomically while unrelated tiles fail, then coarsens without overlap', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  const region = [24.951,60.169,24.953,60.171].map(value => value*Math.PI/180).concat([0,80]);
  const tile = (uri: string, error: number) => ({ boundingVolume: { region }, geometricError: error, content: { uri } });
  const index = { root: { boundingVolume: { region }, geometricError: 1000, children: [
    { ...tile('15/100/1.glb',10), children: [tile('16/200/1.glb',0),tile('16/200/2.glb',0)] },
    { ...tile('15/100/2.glb',10), children: [tile('16/200/3.glb',0)] }
  ] } };
  const bytes = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
  const pending = new Map<string,(response: Response) => void>();
  const cache = new CityAssetCache(((url, options) => {
    const source = new URL(String(url)).searchParams.get('url')!;
    if (source === TEXTURED_BUILDINGS_URL) return Promise.resolve(Response.json(index));
    return new Promise<Response>((resolve,reject) => {
      pending.set(source,resolve); options!.signal!.addEventListener('abort',() => reject(options!.signal!.reason),{once:true});
    });
  }) as typeof fetch);
  const decoded: THREE.Group[] = [];
  const decode = mock.method(GLTFLoader.prototype,'parseAsync',async () => { const scene = new THREE.Group(); decoded.push(scene); return { scene } as GLTF; });
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer,
    { bounds: [-4000,-4000,4000,4000] } as CityBase, () => {}, () => {}, cache);
  const url = (path: string) => new URL(path,TEXTURED_BUILDINGS_URL).href;
  const flush = async () => { for (let i=0;i<5;i++) await new Promise(resolve=>setTimeout(resolve,0)); };
  const resolve = (path: string, response = new Response(bytes)) => { assert.ok(pending.has(url(path)), path); pending.get(url(path))!(response); pending.delete(url(path)); };
  try {
    appearance.setVisible(true,false,true); appearance.update(new THREE.Vector3(),3000,new THREE.Frustum()); await flush();
    resolve('15/100/1.glb'); resolve('15/100/2.glb'); await flush();
    assert.equal(appearance.buildings.children.length,2);
    const [oldA,oldB] = appearance.buildings.children;
    appearance.update(new THREE.Vector3(),100,new THREE.Frustum()); await flush();
    resolve('16/200/1.glb'); await flush();
    assert.deepEqual(appearance.buildings.children,[oldA,oldB], 'a partial child set must not overlap or replace its parent');
    resolve('16/200/3.glb',new Response(null,{status:503})); resolve('16/200/2.glb'); await flush();
    assert.equal(appearance.progress().failed,1); assert.equal(oldA.parent,null); assert.equal(oldB.parent,appearance.buildings);
    assert.equal(appearance.buildings.children.length,3,'both ready children attach despite another branch failing');
    const children = appearance.buildings.children.filter(root=>root!==oldB);
    appearance.update(new THREE.Vector3(),3000,new THREE.Frustum()); await flush();
    resolve('15/100/1.glb'); await flush();
    assert.equal(appearance.buildings.children.length,2); assert.ok(children.every(root=>root.parent===null));
    assert.equal(oldB.parent,appearance.buildings);
    appearance.update(new THREE.Vector3(),100,new THREE.Frustum()); await flush();
    resolve('16/200/1.glb'); await flush();
    const abandoned = decoded.at(-1)!; abandoned.add(new THREE.Object3D());
    assert.equal(abandoned.parent,null);
    appearance.update(new THREE.Vector3(),3000,new THREE.Frustum()); await flush();
    assert.equal(abandoned.children.length,0,'abandoned staged detail releases its objects on zoom out');
    assert.equal(appearance.buildings.children.length,2);
  } finally {
    appearance.dispose(); cache.dispose(); decode.mock.restore();
    if (previous) Object.defineProperty(globalThis,'document',previous); else Reflect.deleteProperty(globalThis,'document');
  }
});


test('detailed municipal models accept more than eight embedded atlases while bounding resources', async () => {
  const fixture = await readFile(new URL('./fixtures/textured-building-identities.glb', import.meta.url));
  const oldLength = fixture.readUInt32LE(12), document = JSON.parse(fixture.subarray(20, 20 + oldLength).toString());
  const model = (count: number, external = false) => {
    document.images = Array.from({ length: count }, () => external ? { uri: 'https://example.org/texture.ktx2' } : { bufferView: 0, mimeType: 'image/ktx2' });
    const text = Buffer.from(JSON.stringify(document)), json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20); text.copy(json);
    const bytes = Buffer.concat([fixture.subarray(0, 12), Buffer.alloc(8), json, fixture.subarray(20 + oldLength)]);
    bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
    return Uint8Array.from(bytes).buffer;
  };
  for (const count of [12, 64]) assert.equal(texturedBuildingIds(model(count)).size, 2);
  assert.throws(() => texturedBuildingIds(model(65)), /Unsupported textured resources/);
  assert.throws(() => texturedBuildingIds(model(1, true)), /Unsupported textured resources/);
});
