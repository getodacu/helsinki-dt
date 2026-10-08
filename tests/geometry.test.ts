import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { gk25ToScene, gk25ToWgs84, PROJECTED_ORIGIN, wgs84ToScene } from '../src/lib/geo.ts';
import { buildingIdForTriangle, prepareBuildingChunk, reconcileBuildings, triangulateSurface } from '../src/lib/data/geometry.ts';
import type { CityJson, SourceBuilding } from '../src/lib/data/geometry.ts';
import { SCENE_ORIGIN } from '../src/lib/area.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/building-cityhall.json', import.meta.url), 'utf8'));
const record = (key: string, gmlId = 'BID_test', attributes: Record<string, string | null> = {}): SourceBuilding =>
  ({ key, gmlId, longitude: 24.952, latitude: 60.1695, attributes });

test('projected axis order, local metric orientation, and N2000 elevations remain explicit', () => {
  const [east, north] = PROJECTED_ORIGIN;
  assert.deepEqual(gk25ToScene(east + 10, north + 20, -12.1), [10, -12.1, -20]);
  assert.deepEqual(wgs84ToScene(SCENE_ORIGIN.longitude, SCENE_ORIGIN.latitude, 7), [0, 7, -0]);
  const [longitude, latitude] = gk25ToWgs84(east, north);
  assert.ok(Math.abs(longitude - SCENE_ORIGIN.longitude) < 1e-8);
  assert.ok(Math.abs(latitude - SCENE_ORIGIN.latitude) < 1e-8);
  assert.throws(() => gk25ToScene(NaN, north, 0), /Non-finite/);
  assert.throws(() => wgs84ToScene(24.95, 190), /Invalid WGS84/);
});

test('actual Helsinki City Hall identifiers and attributes survive conversion', () => {
  const prepared = prepareBuildingChunk(fixture.cityJson, fixture.records);
  assert.equal(prepared.buildings.length, 1);
  const building = prepared.buildings[0];
  assert.equal(building.gmlId, 'BID_29d5c8c9-a6e1-439b-ad4e-cceab20d9f9e');
  assert.equal(building.vtjPrt, '103027184J');
  assert.equal(building.ratu, '216');
  assert.equal(building.attributes.GroundLevel, '-12.1');
  assert.equal(building.attributes.selectedLod, '2');
  assert.equal(building.attributes.sourceRecordCount, '2');
  assert.ok(prepared.chunk.positions.filter((_, index) => index % 3 === 1).every(Number.isFinite));
});

test('compatible duplicate LoDs merge attributes; conflicting identifiers stay distinct and deterministic', () => {
  const a = record('a', 'BID_test', { 'Rakennustunnus_(VTJ-PRT)': '001X', UUID: 'uuid', GroundLevel: '-2' });
  const b = record('b', 'BID_test', { 'Rakennustunnus_(VTJ-PRT)': '001X', UUID: 'uuid', HighestRoof: '20' });
  assert.deepEqual(reconcileBuildings([a, b]), reconcileBuildings([b, a]));
  assert.equal(reconcileBuildings([a, b]).length, 1);
  assert.equal(reconcileBuildings([a, b])[0].attributes.HighestRoof, '20');
  const conflict = record('c', 'BID_test', { 'Rakennustunnus_(VTJ-PRT)': '002Y', UUID: 'uuid' });
  const groups = reconcileBuildings([a, b, conflict]);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].key, groups[1].key);
  assert.ok(groups.every(group => group.attributes.identityConflict === 'true'));
});

test('highest usable LoD falls back after malformed higher geometry', () => {
  const [e, n] = PROJECTED_ORIGIN;
  const document: CityJson = { type: 'CityJSON', version: '2.0',
    vertices: [[e, n, 3], [e + 5, n, 3], [e, n + 5, 3]], CityObjects: {
      a: { type: 'Building', geometry: [
        { type: 'MultiSurface', lod: '1', boundaries: [[[0, 1, 2]]] },
        { type: 'MultiSurface', lod: '2', boundaries: [[[0, 999, 2]]] }
      ] } } };
  const result = prepareBuildingChunk(document, [record('a')]);
  assert.equal(result.buildings[0].attributes.selectedLod, '1');
  assert.equal(result.chunk.positions.length, 9);
  assert.equal(prepareBuildingChunk({ ...document, CityObjects: {} }, [record('a')]).rejected.length, 1);
  assert.throws(() => prepareBuildingChunk({ type: 'not-cityjson' } as CityJson, []), /Invalid CityJSON/);
});

test('surface triangulation handles holes and closing coordinates; rejects invalid vertices', () => {
  const [e, n] = PROJECTED_ORIGIN;
  const vertices = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0], [3, 3], [3, 7], [7, 7], [7, 3]]
    .map(([x, y]) => [e + x, n + y, 10]);
  const triangles = triangulateSurface([[0, 1, 2, 3, 4], [5, 6, 7, 8]], vertices);
  let area = 0;
  for (let i = 0; i < triangles.length; i += 9) {
    const a = triangles.slice(i, i + 3), b = triangles.slice(i + 3, i + 6), c = triangles.slice(i + 6, i + 9);
    area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2;
  }
  assert.ok(Math.abs(area - 84) < 1e-8);
  assert.throws(() => triangulateSurface([[0, 999, 2]], vertices), /invalid vertex/);
});

test('a real Three.js Raycaster triangle hit resolves to its stable building identity', () => {
  const prepared = prepareBuildingChunk(fixture.cityJson, fixture.records);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(prepared.chunk.positions, 3));
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  mesh.updateMatrixWorld(true);
  const p = prepared.chunk.positions;
  const a = new Vector3(...p.slice(0, 3) as [number, number, number]);
  const b = new Vector3(...p.slice(3, 6) as [number, number, number]);
  const c = new Vector3(...p.slice(6, 9) as [number, number, number]);
  const centre = a.clone().add(b).add(c).multiplyScalar(1 / 3);
  const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  const ray = new Raycaster(centre.clone().addScaledVector(normal, 10), normal.clone().negate());
  const hits = ray.intersectObject(mesh);
  assert.ok(hits.length >= 1);
  assert.equal(buildingIdForTriangle(prepared.chunk, hits[0].faceIndex), prepared.buildings[0].id);
  assert.equal(buildingIdForTriangle(prepared.chunk, -1), null);
  assert.equal(buildingIdForTriangle(prepared.chunk, 99_999), null);
  geometry.dispose(); (mesh.material as MeshBasicMaterial).dispose();
});

test('three independent official service locations align with actual source mesh extents and N2000 heights', async () => {
  const { verifyCoordinateControls } = await import('../src/lib/data/geometry.ts');
  const controls = JSON.parse(await readFile(new URL('./fixtures/coordinate-controls.json', import.meta.url), 'utf8'));
  const fixture = JSON.parse(await readFile(new URL('./fixtures/control-building-extents.json', import.meta.url), 'utf8'));
  const buildings = fixture.extents.map((extent: { building: import('../src/lib/types.ts').Building }) => extent.building);
  const chunk: import('../src/lib/types.ts').BuildingChunk = { id: 'controls', positions: [], ranges: [],
    coordinateReference: 'local metres', verticalReference: 'N2000 metres', origin: SCENE_ORIGIN };
  for (const extent of fixture.extents) {
    chunk.ranges.push({ buildingId: extent.building.id, firstTriangle: chunk.positions.length / 9, triangleCount: 1 });
    chunk.positions.push(...extent.min, ...extent.max, ...[extent.min[0], extent.max[1], extent.max[2]]);
  }
  const result = verifyCoordinateControls(buildings, chunk, controls);
  assert.equal(result.length, 3);
  assert.ok(result.every(control => control.distanceMetres <= 30 && control.verticalDifference <= 0.02));
  assert.throws(() => verifyCoordinateControls(buildings, { ...chunk,
    positions: chunk.positions.map((value, index) => index % 3 === 1 ? value + 1 : value) }, controls), /elevation/);
  assert.throws(() => verifyCoordinateControls(buildings, chunk, controls.slice(0, 2)), /Three distinct/);
});
