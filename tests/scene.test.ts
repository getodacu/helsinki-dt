import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { INITIAL_LAYERS, mapClippingPlanes, measureCompassRotation, measureGroundScale, panKeyboardCamera, applyBuildingColours, disposeTree, makeChunkGeometry, visibleChunks, waterGeometry, routeGeometry } from '../src/lib/scene.ts';
import { buildingIdForTriangle } from '../src/lib/data/geometry.ts';
import type { BuildingChunk } from '../src/lib/types.ts';
import type { RouteContext } from '../src/lib/route-context.ts';
import type { CityBase, CityChunkEntry } from '../src/lib/city-assets.ts';
const chunk: BuildingChunk = { id: 'test', positions: [0,0,0, 1,0,0, 0,0,1, 2,0,0, 3,0,0, 2,0,1, 4,0,0, 5,0,0, 4,0,1],
  ranges: [{buildingId:'source-A',firstTriangle:0,triangleCount:1},{buildingId:'source-B',firstTriangle:1,triangleCount:1},{buildingId:'source-A',firstTriangle:2,triangleCount:1}],
  coordinateReference:'test local metres',verticalReference:'N2000',origin:{longitude:24.952,latitude:60.1695,elevation:0} };

test('real Three raycast resolves original identity across disjoint render ranges and feature indices', () => {
  const geometry = makeChunkGeometry(chunk), material = new THREE.MeshBasicMaterial({side:THREE.DoubleSide});
  const mesh = new THREE.Mesh(geometry,material); mesh.updateMatrixWorld();
  for (const [x, id] of [[0.1,'source-A'],[2.1,'source-B'],[4.1,'source-A']] as const) {
    const hits = new THREE.Raycaster(new THREE.Vector3(x,10,0.1),new THREE.Vector3(0,-1,0)).intersectObject(mesh);
    assert.equal(hits.length,1); assert.equal(buildingIdForTriangle(chunk,hits[0].faceIndex),id);
  }
  assert.deepEqual(Array.from(geometry.getAttribute('_feature_id_0').array), [0,0,0,1,1,1,2,2,2]);
  geometry.dispose(); material.dispose();
});

test('disposal releases shared resources once and clears the render tree', () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial(), root = new THREE.Group();
  let geometryDisposed = 0, materialDisposed = 0;
  geometry.addEventListener('dispose',()=>geometryDisposed++); material.addEventListener('dispose',()=>materialDisposed++);
  root.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material)); disposeTree(root); disposeTree(root);
  assert.equal(geometryDisposed,1); assert.equal(materialDisposed,1); assert.equal(root.children.length,0);
});

test('every visible chunk is selected without a twelve-chunk cap; offscreen chunks stay excluded', () => {
  const camera = new THREE.PerspectiveCamera(50,1,1,20000); camera.position.set(0,2000,2000); camera.lookAt(0,0,0); camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const entries: CityChunkEntry[] = Array.from({length:30},(_,i)=>({id:String(i),url:`/data/city/${i}.json`,buildingsUrl:`/data/city/${i}-buildings.json`,bounds:[i*50,0,i*50+50,50],buildingCount:1,triangleCount:1,bytes:20}));
  entries.push({...entries[0],id:'far',bounds:[10000,10000,10500,10500]});
  const result = visibleChunks(entries,new THREE.Vector3(0,0,0),2000,frustum);
  assert.equal(result.length,27); assert.ok(result.includes('0')); assert.ok(!result.includes('far'));
});


test('sea triangles include reported sea and never cover negative or unknown official land', () => {
  const base: CityBase = { terrain: { width:3,height:2,origin:[100,200],step:[20,20],elevations:[-4.92,null,null,-3,null,null] },
    landMask:[true,false,false,true,false,false], shorelines:[],roads:[],rails:[],waterLevel:0,bounds:[100,200,140,220] };
  const geometry = waterGeometry(base), mesh = new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  mesh.updateMatrixWorld();
  assert.equal(geometry.getAttribute('position').count,6);
  assert.equal(new THREE.Raycaster(new THREE.Vector3(105,10,205),new THREE.Vector3(0,-1,0)).intersectObject(mesh).length,0);
  const seaHits = new THREE.Raycaster(new THREE.Vector3(135,10,205),new THREE.Vector3(0,-1,0)).intersectObject(mesh);
  assert.ok(seaHits.length > 0); assert.equal(seaHits[0].point.y,base.waterLevel);
  base.terrain.elevations[0] = null;
  const unknownLand = waterGeometry(base); assert.equal(unknownLand.getAttribute('position').count,6);
  const noMask = waterGeometry({...base,landMask:undefined}); assert.equal(noMask.getAttribute('position').count,0);
  geometry.dispose(); (mesh.material as THREE.Material).dispose(); unknownLand.dispose(); noMask.dispose();
});


test('scheduled route rendering leaves unknown terrain and explicit unavailable paths empty', () => {
  const base: CityBase={terrain:{width:2,height:2,origin:[-100,-100],step:[200,200],elevations:[12,12,12,12]},shorelines:[],roads:[],rails:[],waterLevel:0,bounds:[-100,-100,100,100]};
  const route: RouteContext={status:'exact',vehicleId:'0040/00001',routeId:'1002',routeLabel:'2',destination:null,tripId:'fixture',departureAt:null,candidates:['fixture'],
    shape:[[[24.952,60.1695],[24.9521,60.1695]]],stops:[],reason:null,sourceId:'hsl-gtfs',generatedAt:null,source:null};
  const known=routeGeometry(route,base); assert.equal(known.getAttribute('position').count,2); assert.equal(known.getAttribute('position').getY(0),13.5);
  const unknown=routeGeometry(route,{...base,terrain:{...base.terrain,elevations:[null,null,null,null]}});assert.equal(unknown.getAttribute('position').count,0);
  const ambiguous=routeGeometry({...route,status:'ambiguous'},base); assert.equal(ambiguous.getAttribute('position').count,0);
  known.dispose();unknown.dispose();ambiguous.dispose();
});


test('building thematic colours follow semantic ranges, keep no-data neutral and reset every loaded part', () => {
  const geometry = makeChunkGeometry(chunk);
  const red = new THREE.Color('#d78662'), neutral = new THREE.Color('#e6e8db');
  applyBuildingColours(geometry, chunk, new Map([['source-A', '#d78662']]));
  const colour = geometry.getAttribute('color');
  for (const first of [0, 6]) for (let vertex = first; vertex < first + 3; vertex++) {
    assert.ok(Math.abs(colour.getX(vertex) - red.r) < 1e-6); assert.ok(Math.abs(colour.getY(vertex) - red.g) < 1e-6); assert.ok(Math.abs(colour.getZ(vertex) - red.b) < 1e-6);
  }
  assert.ok(Math.abs(colour.getX(3) - neutral.r) < 1e-6);
  applyBuildingColours(geometry, chunk, new Map());
  for (let vertex = 0; vertex < geometry.getAttribute('color').count; vertex++) assert.ok(Math.abs(geometry.getAttribute('color').getX(vertex) - neutral.r) < 1e-6);
  geometry.dispose();
});


test('WASD pans relative to the orbit heading while preserving altitude and camera offset', () => {
  for (const position of [new THREE.Vector3(0, 400, 400), new THREE.Vector3(400, 400, 0)]) {
    const forward = new THREE.Vector3(-position.x, 0, -position.z).normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    for (const [key, direction] of [['KeyW', forward], ['KeyS', forward.clone().negate()], ['KeyD', right], ['KeyA', right.clone().negate()]] as const) {
      const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(0, 8, 0);
      camera.position.copy(position); const offset = camera.position.clone().sub(target);
      const expected = direction.clone().multiplyScalar(offset.length() * 0.4 * 0.02);
      panKeyboardCamera(camera, target, new Set([key]), 0.02);
      assert.ok(target.clone().sub(new THREE.Vector3(0, 8, 0)).distanceTo(expected) < 1e-10, key);
      assert.ok(camera.position.clone().sub(target).distanceTo(offset) < 1e-10, key);
      assert.equal(camera.position.y, position.y); assert.equal(target.y, 8);
    }
  }
});

test('WASD diagonals keep cardinal speed and opposite keys cancel', () => {
  const move = (keys: string[]) => {
    const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(); camera.position.set(0, 100, 100);
    panKeyboardCamera(camera, target, new Set(keys), 0.02); return target;
  };
  assert.ok(Math.abs(move(['KeyW']).length() - move(['KeyW', 'KeyD']).length()) < 1e-10);
  assert.deepEqual(move(['KeyW', 'KeyS']), new THREE.Vector3());
  assert.deepEqual(move(['KeyA', 'KeyD']), new THREE.Vector3());
  assert.deepEqual(move(['KeyW', 'KeyS', 'KeyA', 'KeyD']), new THREE.Vector3());
  assert.deepEqual(move(['ArrowUp']), new THREE.Vector3());
});

test('WASD speed scales with elapsed time and overview distance, with a 50 ms frame cap', () => {
  const move = (elapsed: number, scale = 1) => {
    const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(); camera.position.set(0, 400 * scale, 400 * scale);
    panKeyboardCamera(camera, target, new Set(['KeyW']), elapsed); return target.length();
  };
  assert.ok(Math.abs(move(0.04) - move(0.02) * 2) < 1e-10);
  assert.ok(Math.abs(move(0.02, 2) - move(0.02) * 2) < 1e-10);
  assert.equal(move(0.5), move(0.05)); assert.equal(move(0), 0); assert.equal(move(-0.01), 0);
  const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(); camera.position.set(0, 100, 0);
  panKeyboardCamera(camera, target, new Set(['KeyW', 'KeyD']), 0.02);
  assert.ok(camera.position.toArray().every(Number.isFinite)); assert.deepEqual(target, new THREE.Vector3());
});


test('WASD stays responsive at maximum zoom without slowing down the overview', () => {
  const speed = (distance: number) => {
    const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3();
    camera.position.set(0, distance * 0.6, distance * 0.8);
    panKeyboardCamera(camera, target, new Set(['KeyW']), 0.05);
    return target.length() / 0.05;
  };
  assert.ok(speed(45) >= 120 - 1e-10, `Maximum zoom is too slow: ${speed(45)} m/s`);
  assert.ok(Math.abs(speed(150) - speed(45)) < 1e-10, 'Close zoom levels keep the same minimum speed');
  assert.ok(Math.abs(speed(600) - 240) < 1e-10, 'Overview keeps its existing distance-scaled speed');
});


test('compass follows cardinal views and keeps its orientation through pan, zoom and tilt', () => {
  const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(350, 8, -200);
  for (const [x, z, rotation] of [[0, 100, 0], [100, 0, 90], [0, -100, 180], [-100, 0, -90], [100, 100, 45]]) {
    for (const distance of [1, 10]) for (const height of [45, 1000]) {
      camera.position.copy(target).add(new THREE.Vector3(x * distance, height, z * distance));
      assert.ok(Math.abs(measureCompassRotation(camera, target) - rotation) < 1e-10);
      panKeyboardCamera(camera, target, new Set(['KeyW', 'KeyD']), 0.02);
      assert.ok(Math.abs(measureCompassRotation(camera, target) - rotation) < 1e-10);
    }
  }
});

test('metric scale represents ground metres through perspective zoom, rotation and viewport changes', () => {
  const camera = new THREE.PerspectiveCamera(42, 2, 1, 40000);
  const width = 1200, height = 600;
  for (const position of [new THREE.Vector3(0,1000,1000),new THREE.Vector3(1000,1000,0),new THREE.Vector3(0,10000,10000)]) {
    camera.position.copy(position); camera.lookAt(0,0,0); camera.updateMatrixWorld();
    const scale=measureGroundScale(camera,width,0)!; assert.ok(scale);
    const metresPerPixel = 2 * position.length() * Math.tan(42 * Math.PI / 360) / height;
    assert.ok(Math.abs(scale.pixels - scale.metres / metresPerPixel) <= 0.051);
    assert.ok(scale.pixels <= 120 && scale.pixels >= 47);
    assert.ok([1,2,5].includes(scale.metres / 10 ** Math.floor(Math.log10(scale.metres))));
  }
  camera.position.set(0,1000,1000); camera.lookAt(0,0,0); camera.updateMatrixWorld();
  const full=measureGroundScale(camera,width,0)!;
  const wide=measureGroundScale(camera,width*2,0)!;
  assert.ok(Math.abs(wide.metres / wide.pixels - full.metres / full.pixels / 2) < 0.01);
  camera.aspect=4; camera.updateProjectionMatrix();
  assert.deepEqual(measureGroundScale(camera,width*2,0),full);
  const elevated=measureGroundScale(camera,width*2,100)!;
  assert.ok(Math.abs(elevated.metres / elevated.pixels / (full.metres / full.pixels) - 0.9) < 0.002);
  camera.aspect=0.5; camera.updateProjectionMatrix();
  assert.ok(measureGroundScale(camera,200,0)!.pixels<=200/3);
});

test('metric scale omits invalid viewport and ground intersections', () => {
  const camera=new THREE.PerspectiveCamera(42,1,1,40000); camera.position.set(0,100,0);
  camera.lookAt(0,100,-1); camera.updateMatrixWorld();
  assert.equal(measureGroundScale(camera,1000,0),null);
  camera.lookAt(0,200,0); camera.updateMatrixWorld();
  assert.equal(measureGroundScale(camera,1000,0),null);
  camera.lookAt(0,0,0); camera.updateMatrixWorld();
  for (const width of [0,-1,NaN,Infinity]) assert.equal(measureGroundScale(camera,width,0),null);
  for (const ground of [NaN,Infinity,100,101]) assert.equal(measureGroundScale(camera,1000,ground),null);
});


test('map clipping follows all four terrain edges at every building height', () => {
  const planes = mapClippingPlanes([-100, -200, 300, 400]);
  const visible = (x: number, z: number, y = 30) => planes.every(plane => plane.distanceToPoint(new THREE.Vector3(x, y, z)) >= 0);
  for (const height of [-30, 0, 300]) {
    for (const [x, z] of [[0, 0], [-100, -200], [300, 400]]) assert.ok(visible(x, z, height));
    for (const [x, z] of [[-100.01, 0], [300.01, 0], [0, -200.01], [0, 400.01]]) assert.equal(visible(x, z, height), false);
  }
});

test('ships start enabled alongside transit without a model asset requirement', () => { assert.equal(INITIAL_LAYERS.ship, true); });
