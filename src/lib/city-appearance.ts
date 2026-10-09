import * as THREE from 'three';
import { CityAssetCache } from './city-cache.ts';
import { AssetRetries, type AssetProgress } from './city-loading.ts';
import proj4 from 'proj4';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { wgs84ToScene } from './geo.ts';
import { type CityBase } from './city-assets.ts';

export { TEXTURED_BUILDINGS_URL, ORTHOPHOTO_LAYER, imageryUrl, tileLocation, texturedBuildingIds } from './city-source.ts';
import { aerialEntries, discoverTexturedEntries, validateTileIndex, texturedBuildingIds, type Bounds, type Tile, type AppearanceEntry } from './city-source.ts';
export type { AppearanceEntry } from './city-source.ts';
const GEOCENTRIC = '+proj=geocent +ellps=WGS84 +units=m';

export function projectTexturedModel(root: THREE.Object3D, transform: THREE.Matrix4) {
  root.updateMatrixWorld(true);
  const rotate = new THREE.Matrix4().makeRotationX(Math.PI / 2), point = new THREE.Vector3();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    if (!positions || positions.count > 600_000) throw new Error('Invalid textured vertices');
    for (let index = 0; index < positions.count; index++) {
      point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).applyMatrix4(rotate).applyMatrix4(transform);
      const [longitude, latitude, height] = proj4(GEOCENTRIC, 'EPSG:4326', point.toArray());
      if (!Number.isFinite(height) || height < -30 || height > 300) throw new Error('Invalid textured height');
      positions.setXYZ(index, ...wgs84ToScene(longitude, latitude, height));
    }
    const previous = Array.isArray(object.material) ? object.material : [object.material];
    const materials = previous.map(material => { const source = material as THREE.MeshStandardMaterial; return new THREE.MeshBasicMaterial({ color: source.color, map: source.map, side: THREE.DoubleSide }); });
    object.material = Array.isArray(object.material) ? materials : materials[0]; previous.forEach(material => material.dispose());
    positions.needsUpdate = true; object.geometry.computeVertexNormals(); object.geometry.computeBoundingSphere();
  });
  root.traverse(object => { object.matrixAutoUpdate = true; object.position.set(0, 0, 0); object.quaternion.identity(); object.scale.set(1, 1, 1); object.updateMatrix(); });
  root.updateMatrixWorld(true);
}

export function aerialGeometry(base: CityBase, bounds: Bounds) {
  const [west, south, east, north] = bounds, grid = base.terrain, positions: number[] = [], uv: number[] = [];
  const firstColumn = Math.max(0, Math.round((west - grid.origin[0]) / grid.step[0])), lastColumn = Math.min(grid.width - 1, Math.round((east - grid.origin[0]) / grid.step[0]));
  const firstRow = Math.max(0, Math.round((south - grid.origin[1]) / grid.step[1])), lastRow = Math.min(grid.height - 1, Math.round((north - grid.origin[1]) / grid.step[1]));
  for (let row = firstRow; row < lastRow; row++) for (let column = firstColumn; column < lastColumn; column++) {
    const a = row * grid.width + column, b = a + 1, c = a + grid.width, d = c + 1;
    for (const triangle of [[a, c, b], [b, c, d]]) {
      const sea = triangle.every(index => base.landMask?.[index] === false);
      if (!sea && !triangle.every(index => grid.elevations[index] !== null)) continue;
      for (const index of triangle) {
        const x = grid.origin[0] + index % grid.width * grid.step[0], z = grid.origin[1] + Math.floor(index / grid.width) * grid.step[1];
        positions.push(x, (sea ? base.waterLevel : grid.elevations[index]!) + 0.08, z); uv.push((x - west) / (east - west), 1 - (z - south) / (north - south));
      }
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.computeBoundingSphere(); return geometry;
}

export function disposeMapObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach(texture => { texture.dispose(); if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close(); });
  geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); root.clear();
}

/** View-bounded municipal imagery; raw assets persist independently of GPU resources. */
export class CityAppearance {
  readonly aerial = new THREE.Group();
  readonly buildings = new THREE.Group();
  readonly buildingIds = new Set<string>();
  revision = 0;
  private models = new Map<string, { root: THREE.Group; ids: Set<string>; bounds: Bounds }>();
  private photos = new Map<string, THREE.Mesh>();
  private pending = new Map<string, AbortController>();
  private failed = new AssetRetries();
  private index = new Map<string, Tile>();
  private desired: AppearanceEntry[] = [];
  private discovery: AbortController | null = null;
  private view = '';
  private discovered = false;
  private partial = false;
  private disposed = false;
  private enabled = true;
  private modelEnabled = true;
  private decoder: KTX2Loader;
  private loader: GLTFLoader;
  private base: CityBase;
  private changed: () => void;
  private status: (message: string) => void;
  private cache: CityAssetCache;
  private ownsCache: boolean;
  constructor(renderer: THREE.WebGLRenderer, base: CityBase, changed: () => void, status: (message: string) => void, cache?: CityAssetCache) {
    this.base = base; this.changed = changed; this.status = status;
    this.cache = cache ?? new CityAssetCache(); this.ownsCache = !cache;
    this.decoder = new KTX2Loader().setWorkerLimit(2).detectSupport(renderer);
    this.loader = new GLTFLoader().setKTX2Loader(this.decoder);
  }
  setVisible(enabled: boolean, terrain: boolean, buildings: boolean) {
    this.enabled = enabled; this.modelEnabled = buildings; this.aerial.visible = enabled && terrain; this.buildings.visible = enabled && buildings;
  }
  progress(): AssetProgress {
    if (!this.enabled) return { discovering: false, completed: 0, total: 0, failed: 0 };
    const failed = this.desired.filter(entry => this.failed.has(entry.url)).length + Number(this.modelEnabled && this.failed.has('index'));
    return { discovering: this.modelEnabled && !this.discovered && !!this.discovery,
      completed: this.desired.filter(entry => this.photos.has(entry.url) || this.models.has(entry.url)).length,
      total: this.desired.length + Number(this.modelEnabled && this.failed.has('index')), failed };
  }
  private refresh() {
    this.buildingIds.clear();
    for (const model of this.models.values()) if (model.root.parent === this.buildings) for (const id of model.ids) this.buildingIds.add(id);
    this.status('');
    this.changed();
  }
  private async readIndex(url: string, signal: AbortSignal) {
    const saved = this.index.get(url);
    if (saved) return saved;
    const tile = await this.cache.read(url, 2_000_000, bytes => validateTileIndex(bytes, url), signal);
    this.index.set(url, tile); return tile;
  }
  update(target: THREE.Vector3, distance: number, frustum: THREE.Frustum) {
    if (this.disposed || document.hidden) return;
    const separation = ([west, south, east, north]: Bounds) => Math.hypot(Math.max(west - target.x, 0, target.x - east), Math.max(south - target.z, 0, target.z - north));
    const visible = (bounds: Bounds) => frustum.intersectsBox(new THREE.Box3(new THREE.Vector3(bounds[0], -30, bounds[1]), new THREE.Vector3(bounds[2], 300, bounds[3])));
    for (const [url, photo] of this.photos) if (!this.aerial.visible || !visible(photo.userData.bounds)) {
      photo.removeFromParent(); disposeMapObject(photo); this.photos.delete(url); this.revision++;
    }
    for (const [url, model] of this.models) if (!this.buildings.visible || !visible(model.bounds)) {
      model.root.removeFromParent(); disposeMapObject(model.root); this.models.delete(url); this.revision++;
    }
    const view = [this.enabled, this.aerial.visible, this.buildings.visible, target.x.toFixed(0), target.z.toFixed(0), distance.toFixed(0),
      ...frustum.planes.map(plane => [...plane.normal.toArray().map(value => value.toFixed(2)), plane.constant.toFixed(0)].join(','))].join('/');
    const discover = () => {
      const abort = new AbortController(); this.discovery = abort;
      void discoverTexturedEntries(this.base, url => this.readIndex(url, abort.signal), visible, bounds => Math.max(2.6, (distance + separation(bounds) * 3) / 180), abort.signal)
        .then(({ entries, failed }) => {
          if (this.disposed || abort.signal.aborted || this.view !== view) return;
          this.discovered = !failed.length; if (failed.length) this.failed.fail('index'); else this.failed.delete('index');
          this.desired = [...this.desired.filter(entry => !entry.transform), ...entries.sort((a, b) => separation(a.bounds) - separation(b.bounds))];
        }).catch(() => { if (!abort.signal.aborted && !this.disposed) this.failed.fail('index'); })
        .finally(() => { if (this.discovery === abort) { this.discovery = null; if (!this.disposed) this.synchronize(); } });
    };
    if (view !== this.view) {
      this.view = view; this.partial = false; this.discovery?.abort(); this.discovery = null;
      this.discovered = !this.enabled || !this.modelEnabled;
      this.desired = this.aerial.visible ? aerialEntries(this.base).filter(entry => visible(entry.bounds)).sort((a, b) => separation(a.bounds) - separation(b.bounds)) : [];
      this.revision++;
      if (this.enabled && this.modelEnabled) {
        discover();
      }
    } else if (this.enabled && this.modelEnabled && !this.discovered && !this.discovery && this.failed.ready('index')) {
      discover();
    }
    this.synchronize();
  }
  private commit() {
    const progress = this.progress();
    const complete = !progress.discovering && !progress.failed && progress.completed === progress.total;
    if (!complete && (!this.partial || this.buildings.children.length)) return;
    const wanted = new Set(this.desired.map(entry => entry.url));
    for (const [url, photo] of this.photos) if (!wanted.has(url)) { photo.removeFromParent(); disposeMapObject(photo); this.photos.delete(url); this.revision++; }
    for (const [url, model] of this.models) {
      if (!wanted.has(url)) { model.root.removeFromParent(); disposeMapObject(model.root); this.models.delete(url); this.revision++; }
      else if (!model.root.parent) { this.buildings.add(model.root); this.revision++; }
    }
  }
  private synchronize() {
    if (this.disposed) return;
    const wanted = new Set(this.desired.map(entry => entry.url));
    for (const [url, abort] of this.pending) if (!wanted.has(url)) { abort.abort(); this.pending.delete(url); }
    const progress = this.progress();
    if (!progress.discovering && progress.failed && progress.completed + progress.failed === progress.total) this.partial = true;
    this.commit();
    for (const entry of this.desired) {
      if (this.pending.size >= 4) break;
      if (this.models.has(entry.url) || this.photos.has(entry.url) || this.pending.has(entry.url) || !this.failed.ready(entry.url)) continue;
      const abort = new AbortController(); this.pending.set(entry.url, abort);
      void this.cache.read(entry.url, 8_000_000, async bytes => {
        let root: THREE.Group | THREE.Mesh, ids = new Set<string>();
        if (entry.transform) {
          ids = texturedBuildingIds(bytes); root = (await this.loader.parseAsync(bytes, '')).scene;
          try { projectTexturedModel(root, entry.transform); } catch (error) { disposeMapObject(root); throw error; }
        } else {
          const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'flipY' });
          if (bitmap.width > 2048 || bitmap.height > 2048) { bitmap.close(); throw new Error('Oversized aerial image'); }
          const texture = new THREE.Texture(bitmap); texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false; texture.needsUpdate = true;
          root = new THREE.Mesh(aerialGeometry(this.base, entry.bounds), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
        }
        return { root, ids };
      }, abort.signal).then(({ root, ids }) => {
        if (this.disposed || abort.signal.aborted || !this.desired.some(item => item.url === entry.url)) { disposeMapObject(root); return; }
        if (root instanceof THREE.Mesh) { root.userData.bounds = entry.bounds; this.photos.set(entry.url, root); this.aerial.add(root); this.revision++; }
        else this.models.set(entry.url, { root, ids, bounds: entry.bounds });
        this.failed.delete(entry.url);
      }).catch(() => { if (!abort.signal.aborted && !this.disposed) this.failed.fail(entry.url); })
        .finally(() => { if (this.pending.get(entry.url) === abort) this.pending.delete(entry.url); if (!this.disposed) this.synchronize(); });
    }
    this.refresh();
  }
  retry() {
    this.failed.clear();
    this.index.clear(); this.view = '';
  }
  openAvailable() { this.partial = true; this.commit(); this.refresh(); }
  pause() { this.discovery?.abort(); for (const abort of this.pending.values()) abort.abort(); this.pending.clear(); }
  dispose() {
    this.disposed = true; this.pause(); this.decoder.dispose();
    for (const model of this.models.values()) if (!model.root.parent) disposeMapObject(model.root);
    disposeMapObject(this.aerial); disposeMapObject(this.buildings);
    this.models.clear(); this.photos.clear(); this.index.clear(); this.buildingIds.clear();
    if (this.ownsCache) this.cache.dispose();
  }
}
