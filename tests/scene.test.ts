import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyBuildingColours, buildingHighlight, disposeTree, makeChunkGeometry, visibleChunks, waterGeometry, makeStationMarker, stationForHit, routeGeometry } from '../src/lib/scene.ts';
import { buildingIdForTriangle } from '../src/lib/data/geometry.ts';
import type { BuildingChunk } from '../src/lib/types.ts';
import type { SceneStation } from '../src/lib/scene.ts';
import type { RouteContext } from '../src/lib/route-context.ts';
import type { CityBase, CityChunkEntry } from '../src/lib/city-assets.ts';
const chunk: BuildingChunk = { id: 'test', positions: [0,0,0, 1,0,0, 0,0,1, 2,0,0, 3,0,0, 2,0,1, 4,0,0, 5,0,0, 4,0,1],
  ranges: [{buildingId:'source-A',firstTriangle:0,triangleCount:1},{buildingId:'source-B',firstTriangle:1,triangleCount:1},{buildingId:'source-A',firstTriangle:2,triangleCount:1}],
  coordinateReference:'test local metres',verticalReference:'N2000',origin:{longitude:24.952,latitude:60.1695,elevation:0} };

test('real Three raycast resolves original identity across disjoint render ranges and highlight batches', () => {
  const geometry = makeChunkGeometry(chunk), material = new THREE.MeshBasicMaterial({side:THREE.DoubleSide});
  const mesh = new THREE.Mesh(geometry,material); mesh.updateMatrixWorld();
  for (const [x, id] of [[0.1,'source-A'],[2.1,'source-B'],[4.1,'source-A']] as const) {
    const hits = new THREE.Raycaster(new THREE.Vector3(x,10,0.1),new THREE.Vector3(0,-1,0)).intersectObject(mesh);
    assert.equal(hits.length,1); assert.equal(buildingIdForTriangle(chunk,hits[0].faceIndex),id);
  }
  assert.deepEqual(buildingHighlight(chunk,'source-A'),[...chunk.positions.slice(0,9),...chunk.positions.slice(18)]);
  assert.deepEqual(buildingHighlight({...chunk,id:'other'},'source-A'),buildingHighlight(chunk,'source-A'));
  assert.deepEqual(buildingHighlight(chunk,'missing'),[]); geometry.dispose(); material.dispose();
});

test('disposal releases shared resources once and clears the render tree', () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial(), root = new THREE.Group();
  let geometryDisposed = 0, materialDisposed = 0;
  geometry.addEventListener('dispose',()=>geometryDisposed++); material.addEventListener('dispose',()=>materialDisposed++);
  root.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material)); disposeTree(root); disposeTree(root);
  assert.equal(geometryDisposed,1); assert.equal(materialDisposed,1); assert.equal(root.children.length,0);
});

test('view and distance bound chunk loading to twelve and reject offscreen far chunks', () => {
  const camera = new THREE.PerspectiveCamera(50,1,1,20000); camera.position.set(0,2000,2000); camera.lookAt(0,0,0); camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const entries: CityChunkEntry[] = Array.from({length:30},(_,i)=>({id:String(i),url:`/data/city/${i}.json`,buildingsUrl:`/data/city/${i}-buildings.json`,bounds:[i*50,0,i*50+50,50],buildingCount:1,triangleCount:1,bytes:20}));
  entries.push({...entries[0],id:'far',bounds:[10000,10000,10500,10500]});
  const result = visibleChunks(entries,new THREE.Vector3(0,0,0),2000,frustum);
  assert.equal(result.length,12); assert.ok(result.includes('0')); assert.ok(!result.includes('far'));
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


test('station markers retain string IDs, source/type and actual projected positions through real picking', () => {
  const station: SceneStation={id:'00100742',name:'Fixture air station',longitude:24.952,latitude:60.1695,kind:'air-quality',sourceIds:['fmi-air-quality']};
  const base: CityBase={terrain:{width:2,height:2,origin:[-100,-100],step:[200,200],elevations:[12,12,12,12]},shorelines:[],roads:[],rails:[],waterLevel:0,bounds:[-100,-100,100,100]};
  const marker=makeStationMarker(station,base)!; assert.ok(marker); assert.ok(Math.abs(marker.position.x)<0.01); assert.ok(Math.abs(marker.position.z)<0.01);
  assert.equal(marker.position.y,37); marker.updateMatrixWorld();
  const hits=new THREE.Raycaster(new THREE.Vector3(0,100,0),new THREE.Vector3(0,-1,0)).intersectObject(marker);
  assert.ok(hits.length); assert.equal(stationForHit(hits[0]),station); assert.equal(stationForHit(hits[0])!.id,'00100742');
  const weather=makeStationMarker({...station,id:'weather',kind:'weather'},base)!; assert.notEqual(weather.geometry.type,marker.geometry.type);
  assert.equal(makeStationMarker({...station,longitude:26},base),null);
  assert.equal(makeStationMarker(station,{...base,terrain:{...base.terrain,elevations:[null,null,null,null]}}),null);
  marker.geometry.dispose();(marker.material as THREE.Material).dispose();weather.geometry.dispose();(weather.material as THREE.Material).dispose();
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
