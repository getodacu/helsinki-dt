import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface VehicleModel {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  roofHeight: number;
}

/** Flatten Blender node transforms once, then instance all material groups together. */
export async function parseVehicleModel(bytes: ArrayBuffer): Promise<VehicleModel> {
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.push(object.geometry.applyMatrix4(object.matrixWorld));
    materials.push(...(Array.isArray(object.material) ? object.material : [object.material]));
  });
  const geometry = geometries.length ? mergeGeometries(geometries, true) : null;
  geometries.forEach(part => part.dispose());
  if (!geometry) {
    materials.forEach(material => material.dispose());
    throw new Error('Vehicle model has no compatible mesh geometry');
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const box = geometry.boundingBox!, size = box.getSize(new THREE.Vector3());
  if (![size.x, size.y, size.z, box.min.y].every(Number.isFinite) || size.x < 1 || size.x > 15
    || size.y < 1 || size.y > 15 || size.z < 5 || size.z > 60 || box.min.y < -5 || box.min.y > .1) {
    disposeVehicleModel({ geometry, materials, roofHeight: 0 });
    throw new Error('Vehicle model is outside the metre-sized operating envelope');
  }
  return { geometry, materials, roofHeight: box.max.y };
}

export function disposeVehicleModel(model: VehicleModel) {
  model.geometry.dispose();
  new Set(model.materials).forEach(material => material.dispose());
}
