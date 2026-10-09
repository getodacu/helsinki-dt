import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import proj4 from 'proj4';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { discoverTexturedEntries } from '../src/lib/city-source.ts';
import { CityAppearance, aerialGeometry, disposeMapObject, imageryUrl, projectTexturedModel, texturedBuildingIds, tileLocation, TEXTURED_BUILDINGS_URL } from '../src/lib/city-appearance.ts';
import { applyTextureCoverage, makeChunkGeometry } from '../src/lib/scene.ts';
import { buildingIdForTriangle } from '../src/lib/data/geometry.ts';
import { PROJECTED_ORIGIN } from '../src/lib/geo.ts';
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

test('model replacement waits for the final texture decode and releases offscreen surfaces', async () => {
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
  const appearance = new CityAppearance({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer, base, () => {}, () => {});
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    appearance.setVisible(true, false, true); appearance.update(new THREE.Vector3(), 1450, new THREE.Frustum());
    for (let i = 0; i < 10 && decodes.length < 2; i++) await tick();
    assert.equal(decodes.length, 2);
    const first = new THREE.Group(), last = new THREE.Group();
    decodes[0]({ scene: first } as unknown as GLTF); await tick();
    assert.equal(appearance.progress().completed, 1); assert.equal(appearance.buildings.children.length, 0);
    decodes[1]({ scene: last } as unknown as GLTF); await tick();
    assert.equal(appearance.progress().completed, 2); assert.equal(appearance.buildings.children.length, 2);
    const clipped = new THREE.Frustum(...Array.from({ length: 6 }, () => new THREE.Plane(new THREE.Vector3(1, 0, 0), -10_000)));
    appearance.update(new THREE.Vector3(10_000, 0, 0), 1450, clipped); await tick();
    assert.equal(appearance.buildings.children.length, 0); assert.equal(first.parent, null); assert.equal(last.parent, null);
  } finally {
    appearance.dispose(); fetchMock.mock.restore(); decodeMock.mock.restore();
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
