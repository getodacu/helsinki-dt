import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { buildingIdForTriangle } from '../src/lib/data/geometry.ts';
import { wgs84ToScene } from '../src/lib/geo.ts';
import type { CityManifest } from '../src/lib/city-assets.ts';
import type { Building, BuildingChunk } from '../src/lib/types.ts';

const manifest: CityManifest = JSON.parse(await readFile('static/data/city/manifest.json', 'utf8'));
const checksums: { path: string; bytes: number; sha256: string }[] = JSON.parse(await readFile('static' + manifest.baseUrl.replace('base.json', 'checksums.json'), 'utf8'));
for (const expected of checksums) {
  const bytes = await readFile('static' + expected.path);
  assert.equal(bytes.length, expected.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
}
const controls = [...JSON.parse(await readFile('tests/fixtures/coordinate-controls.json', 'utf8')),
  ...JSON.parse(await readFile('tests/fixtures/city-coordinate-controls.json', 'utf8'))];
const old: { buildings: Building[] } = JSON.parse(await readFile('.cache/task-a/geometry-result.json', 'utf8'));
const original = new Map(old.buildings.map(building => [building.id, building]));
const extents = new Map<string, { building: Building; min: number[]; max: number[] }>();
const picking: { buildingId: string; vtjPrt: string | null; chunkId: string; faceIndex: number }[] = [];
for (let chunkIndex = 0; chunkIndex < manifest.chunks.length; chunkIndex++) {
  const entry = manifest.chunks[chunkIndex], chunk: BuildingChunk = JSON.parse(await readFile('static' + entry.url, 'utf8'));
  const buildings: Building[] = JSON.parse(await readFile('static' + entry.buildingsUrl, 'utf8'));
  const byId = new Map(buildings.map(building => [building.id, building]));
  for (const range of chunk.ranges) {
    const building = byId.get(range.buildingId); assert.ok(building);
    const extent = extents.get(building.id) ?? { building, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let index = range.firstTriangle * 9; index < (range.firstTriangle + range.triangleCount) * 9; index++) {
      const axis = index % 3; extent.min[axis] = Math.min(extent.min[axis], chunk.positions[index]); extent.max[axis] = Math.max(extent.max[axis], chunk.positions[index]);
    }
    extents.set(building.id, extent);
  }
  if (picking.length < 10 && chunkIndex % Math.max(1, Math.floor(manifest.chunks.length / 10)) === 0) {
    const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(chunk.positions, 3));
    const material = new MeshBasicMaterial({ side: DoubleSide }), mesh = new Mesh(geometry, material); mesh.updateMatrixWorld(true);
    const positions = geometry.getAttribute('position');
    for (const range of chunk.ranges) {
      const index = range.firstTriangle * 3, a = new Vector3().fromBufferAttribute(positions, index),
        b = new Vector3().fromBufferAttribute(positions, index + 1), c = new Vector3().fromBufferAttribute(positions, index + 2);
      const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      if (!normal.lengthSq()) continue;
      const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      const hit = new Raycaster(center.clone().addScaledVector(normal, 0.1), normal.negate(), 0, 0.2).intersectObject(mesh)[0];
      if (!hit) continue;
      const id = buildingIdForTriangle(chunk, hit.faceIndex); assert.equal(id, range.buildingId);
      picking.push({ buildingId: id!, vtjPrt: byId.get(id!)!.vtjPrt, chunkId: chunk.id, faceIndex: hit.faceIndex! }); break;
    }
    geometry.dispose(); material.dispose();
  }
}
assert.equal(picking.length, 10);
const controlResults = controls.map(control => {
  const extent = extents.get(control.gmlId); assert.ok(extent, control.name + ' missing');
  const [x, , z] = wgs84ToScene(control.longitude, control.latitude);
  const dx = Math.max(extent.min[0] - x, 0, x - extent.max[0]), dz = Math.max(extent.min[2] - z, 0, z - extent.max[2]);
  const distanceMetres = Math.hypot(dx, dz); assert.ok(distanceMetres < 30, control.name + ' misplaced');
  const previous = original.get(control.gmlId);
  const heightDifferenceMetres = previous ? Math.max(Math.abs(Number(previous.attributes.sourceEnvelopeMinimumElevation) - extent.min[1]),
    Math.abs(Number(previous.attributes.sourceEnvelopeMaximumElevation) - extent.max[1])) : null;
  if (previous) assert.ok(Math.abs(Number(previous.attributes.sourceEnvelopeMaximumElevation) - extent.max[1]) <= 0.02,
    'N2000 roof control height mismatch: ' + control.name);
  return { ...control, distanceMetres, extentMinimum: extent.min, extentMaximum: extent.max, heightDifferenceMetres,
    vtjPrt: extent.building.vtjPrt, ratu: extent.building.ratu };
});
const sameGeometryHeightControls = [...extents.values()].filter(extent => {
  const previous = original.get(extent.building.id); return previous
    && Math.max(Math.abs(Number(previous.attributes.sourceEnvelopeMinimumElevation) - extent.min[1]),
      Math.abs(Number(previous.attributes.sourceEnvelopeMaximumElevation) - extent.max[1])) <= 0.02;
}).length;
assert.ok(sameGeometryHeightControls >= 10, 'At least ten original CityGML height extents must agree');
const result = { generatedAt: manifest.generatedAt, checkedAt: new Date().toISOString(), buildingCount: extents.size,
  islandBuildings: [...extents.values()].filter(extent => extent.building.latitude < 60.16 && extent.building.longitude > 24.975).length,
  checksumAssetCount: checksums.length, controlResults, sameGeometryHeightControls, picking };
await writeFile('.cache/task-b/city-checks.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
