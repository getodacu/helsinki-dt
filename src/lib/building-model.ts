import * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CityAssetCache } from './city-cache.ts';
import { disposeMapObject, projectTexturedModel } from './city-appearance.ts';
import { discoverTexturedEntries, texturedBuildingFeatures, validateTileIndex } from './city-source.ts';
import { wgs84ToScene } from './geo.ts';
import type { CityBase } from './city-assets.ts';
import type { Building } from './types.ts';

/** Extract only the chosen identity, keeping its UVs and original materials. */
export function extractTexturedBuilding(sources: { root: THREE.Group; features: string[] }[], id: string) {
  const root = new THREE.Group(), resources = new THREE.Group();
  const dispose = () => { resources.add(root); disposeMapObject(resources); root.clear(); };
  resources.add(root, ...sources.map(source => source.root));
  let facade = false, missingFacade = false;
  try {
    for (const source of sources) source.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const geometry = object.geometry, position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
      const feature = geometry.getAttribute('_feature_id_0'), index = geometry.index;
      if (!position || !feature || feature.itemSize !== 1 || feature.count !== position.count) throw new Error('Missing building feature indices');
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const groups = Array.isArray(object.material) ? geometry.groups : [{ start: 0, count: index?.count ?? position.count, materialIndex: 0 }];
      const positions: number[] = [], uvs: number[] = [], filtered = new THREE.BufferGeometry();
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (const group of groups) {
        const start = positions.length / 3, material = materials[group.materialIndex ?? 0] as THREE.MeshBasicMaterial;
        for (let offset = group.start; offset < group.start + group.count; offset += 3) {
          const vertices = [0, 1, 2].map(step => index ? index.getX(offset + step) : offset + step);
          if (vertices.some(vertex => !Number.isInteger(vertex) || vertex < 0 || vertex >= position.count)) throw new Error('Invalid building triangle');
          if (!vertices.every(vertex => source.features[feature.getX(vertex)] === id)) continue;
          a.fromBufferAttribute(position, vertices[0]); b.fromBufferAttribute(position, vertices[1]); c.fromBufferAttribute(position, vertices[2]);
          const normal = b.sub(a).cross(c.sub(a));
          if (normal.lengthSq() > 1e-8 && Math.abs(normal.y) / normal.length() < .35) {
            const textured = !!material?.map && !!uv && uv.count === position.count
              && Math.abs((uv.getX(vertices[1]) - uv.getX(vertices[0])) * (uv.getY(vertices[2]) - uv.getY(vertices[0]))
                - (uv.getX(vertices[2]) - uv.getX(vertices[0])) * (uv.getY(vertices[1]) - uv.getY(vertices[0]))) > 1e-10;
            if (textured) facade = true; else missingFacade = true;
          }
          for (const vertex of vertices) {
            positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
            uvs.push(uv?.getX(vertex) ?? 0, uv?.getY(vertex) ?? 0);
          }
        }
        const count = positions.length / 3 - start;
        if (count) filtered.addGroup(start, count, group.materialIndex ?? 0);
      }
      if (!positions.length) { filtered.dispose(); return; }
      filtered.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      filtered.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      filtered.computeVertexNormals(); root.add(new THREE.Mesh(filtered, object.material));
    });
    if (!facade || missingFacade) { dispose(); return null; }
    root.position.sub(new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3()));
    return { root, dispose };
  } catch (error) { dispose(); throw error; }
}

export async function loadTexturedBuilding(building: Building, base: CityBase, loader: GLTFLoader, cache: CityAssetCache | undefined, signal: AbortSignal) {
  const assets = cache ?? new CityAssetCache(), sources: { root: THREE.Group; features: string[] }[] = [];
  const [x, , z] = wgs84ToScene(building.longitude, building.latitude);
  try {
    const { entries, failed } = await discoverTexturedEntries(base,
      url => assets.read(url, 2_000_000, bytes => validateTileIndex(bytes, url), signal, 'foreground', true, 'map'),
      ([west, south, east, north]) => Math.hypot(Math.max(west - x, 0, x - east), Math.max(south - z, 0, z - north)) <= 100,
      () => 2.6, signal);
    if (failed.length) throw new Error('Textured building coverage unavailable');
    for (const entry of entries) {
      await assets.read(entry.url, 8_000_000, async bytes => {
        const features = texturedBuildingFeatures(bytes);
        if (!features.includes(building.id)) return;
        const root = (await loader.parseAsync(bytes, '')).scene;
        try { signal.throwIfAborted(); projectTexturedModel(root, entry.transform); }
        catch (error) { disposeMapObject(root); throw error; }
        sources.push({ root, features });
      }, signal, 'foreground', true, 'map');
    }
    signal.throwIfAborted();
    return extractTexturedBuilding(sources.splice(0), building.id);
  } catch (error) {
    const resources = new THREE.Group(); for (const source of sources) resources.add(source.root); disposeMapObject(resources);
    throw error;
  } finally { if (!cache) assets.dispose(); }
}
