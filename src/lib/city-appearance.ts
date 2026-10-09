import * as THREE from 'three';
import { BuildingHighlight } from './building-highlight.ts';
import { CityAssetCache } from './city-cache.ts';
import { AssetRetries, type AssetProgress } from './city-loading.ts';
import proj4 from 'proj4';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { wgs84ToScene } from './geo.ts';
import { type CityBase } from './city-assets.ts';

export { TEXTURED_BUILDINGS_URL, ORTHOPHOTO_LAYER, imageryUrl, tileLocation, texturedBuildingIds } from './city-source.ts';
import { aerialEntries, discoverTexturedEntries, validateTileIndex, texturedBuildingFeatures, type Bounds, type Tile, type AppearanceEntry } from './city-source.ts';
export type { AppearanceEntry } from './city-source.ts';
const GEOCENTRIC = '+proj=geocent +ellps=WGS84 +units=m';
const toWgs84 = proj4(GEOCENTRIC, 'EPSG:4326');

export function projectTexturedModel(root: THREE.Object3D, transform: THREE.Matrix4) {
  root.updateMatrixWorld(true);
  const rotate = new THREE.Matrix4().makeRotationX(Math.PI / 2), point = new THREE.Vector3();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    if (!positions || positions.count > 600_000) throw new Error('Invalid textured vertices');
    for (let index = 0; index < positions.count; index++) {
      point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).applyMatrix4(rotate).applyMatrix4(transform);
      const [longitude, latitude, height] = toWgs84.forward(point.toArray());
      if (!Number.isFinite(height) || height < -30 || height > 300) throw new Error('Invalid textured height');
      positions.setXYZ(index, ...wgs84ToScene(longitude, latitude, height));
    }
    const previous = Array.isArray(object.material) ? object.material : [object.material];
    const materials = previous.map(material => { const source = material as THREE.MeshStandardMaterial; return source.map ? new THREE.MeshBasicMaterial({ color: source.color, map: source.map, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ color: source.color, roughness: 1, side: THREE.DoubleSide }); });
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
      const heights = triangle.map(index => base.landMask?.[index] === false ? base.waterLevel : grid.elevations[index]);
      if (heights.some(height => height === null)) continue;
      for (const [vertex, index] of triangle.entries()) {
        const x = grid.origin[0] + index % grid.width * grid.step[0], z = grid.origin[1] + Math.floor(index / grid.width) * grid.step[1];
        positions.push(x, heights[vertex]! + 0.08, z); uv.push((x - west) / (east - west), 1 - (z - south) / (north - south));
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
  private models = new Map<string, { root: THREE.Group; ids: Set<string>; bounds: Bounds; ancestors: string[]; highlight: BuildingHighlight }>();
  private photos = new Map<string, THREE.Mesh>();
  private pending = new Map<string, AbortController>();
  private failed = new AssetRetries();
  private index = new Map<string, Tile>();
  private desired: AppearanceEntry[] = [];
  private discovery: AbortController | null = null;
  private view = '';
  private latestView: [THREE.Vector3, number, THREE.Frustum] | null = null;
  private discovered = false;
  private blocked = new Set<string>();
  private selected: string | null = null;
  private hovered: string | null = null;
  private focus: THREE.Vector3 | null = null;
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
  nextRetryAt() {
    return Math.min(this.failed.nextDue(this.desired.filter(entry => !this.pending.has(entry.url)).map(entry => entry.url)),
      this.enabled && this.modelEnabled && !this.discovered && !this.discovery ? this.failed.nextDue(['index']) : Infinity);
  }
  setSelection(selected: string | null, hovered: string | null, focus: THREE.Vector3 | null) {
    const changed = this.selected !== selected;
    this.selected = selected; this.hovered = hovered;
    for (const model of this.models.values()) model.highlight.set(selected, hovered);
    if (changed) {
      this.focus = focus?.clone() ?? null; this.view = '';
      if (this.latestView) this.update(...this.latestView);
    }
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
    const tile = await this.cache.read(url, 2_000_000, bytes => validateTileIndex(bytes, url), signal, 'foreground', true, 'map');
    this.index.set(url, tile); return tile;
  }
  update(target: THREE.Vector3, distance: number, frustum: THREE.Frustum) {
    if (this.disposed || document.hidden || !this.cache.workAllowed) return;
    target = target.clone(); frustum = frustum.clone(); this.latestView = [target, distance, frustum];
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
    const nearSelection = ([west, south, east, north]: Bounds) => !!this.focus
      && Math.hypot(Math.max(west - this.focus.x, 0, this.focus.x - east), Math.max(south - this.focus.z, 0, this.focus.z - north)) <= 100;
    const discover = () => {
      const abort = new AbortController(); this.discovery = abort;
      void discoverTexturedEntries(this.base, url => this.readIndex(url, abort.signal), visible, bounds => nearSelection(bounds) ? 2.6 : Math.max(2.6, (distance + separation(bounds) * 3) / 180), abort.signal)
        .then(async ({ entries, failed, blocked }) => {
          await this.cache.whenActive(abort.signal);
          if (this.disposed || abort.signal.aborted) return;
          if (failed.length) this.failed.fail('index'); else this.failed.delete('index');
          if (this.view !== view) return;
          this.discovered = !failed.length; this.blocked = blocked;
          this.desired = [...this.desired.filter(entry => !entry.transform), ...entries.sort((a, b) => Number(nearSelection(b.bounds)) - Number(nearSelection(a.bounds)) || separation(a.bounds) - separation(b.bounds))];
        }).catch(() => { if (!abort.signal.aborted && !this.disposed) this.failed.fail('index'); })
        .finally(() => {
          if (this.discovery !== abort) return;
          this.discovery = null;
          if (!this.disposed && this.view !== view && this.latestView) this.update(...this.latestView);
          else if (!this.disposed) this.synchronize();
        });
    };
    if (view !== this.view) {
      this.view = view;
      this.discovered = !this.enabled || !this.modelEnabled;
      if (this.discovered) { this.discovery?.abort(); this.discovery = null; }
      this.desired = [
        ...(this.aerial.visible ? aerialEntries(this.base).filter(entry => visible(entry.bounds)) : []),
        ...(this.buildings.visible ? this.desired.filter(entry => entry.transform && visible(entry.bounds)) : [])
      ].sort((a, b) => separation(a.bounds) - separation(b.bounds));
      this.revision++;
      if (!this.discovered && !this.discovery && this.failed.ready('index')) discover();
    } else if (this.enabled && this.modelEnabled && !this.discovered && !this.discovery && this.failed.ready('index')) {
      discover();
    }
    this.synchronize();
  }
  private commit() {
    if (this.discovery) return;
    const desired = this.desired.filter(entry => entry.transform), wanted = new Set(this.desired.map(entry => entry.url));
    for (const [url, photo] of this.photos) if (!wanted.has(url)) { photo.removeFromParent(); disposeMapObject(photo); this.photos.delete(url); this.revision++; }
    const related = (url: string, model: { ancestors: string[] }, entry: AppearanceEntry) => entry.ancestors?.includes(url) || model.ancestors.includes(entry.url);
    const remove = (url: string, root: THREE.Group) => { root.removeFromParent(); disposeMapObject(root); this.models.delete(url); this.revision++; };
    for (const entry of desired) {
      const model = this.models.get(entry.url);
      if (!model || model.root.parent) continue;
      const replaced = [...this.models].filter(([url, old]) => old.root.parent === this.buildings && !wanted.has(url) && related(url, old, entry));
      // Swap an entire parent together, but never wait for an unrelated tile or aerial image.
      if (replaced.some(([url, old]) => this.blocked.has(url) || desired.some(next => related(url, old, next) && !this.models.has(next.url)))) continue;
      for (const [url, old] of replaced) remove(url, old.root);
      this.buildings.add(model.root); this.revision++;
    }
    for (const [url, model] of this.models) {
      if (!wanted.has(url) && (!model.root.parent || this.discovered && !desired.some(entry => related(url, model, entry)))) remove(url, model.root);
    }
  }

  private synchronize() {
    if (this.disposed || !this.cache.workAllowed) return;
    const wanted = new Set(this.desired.map(entry => entry.url));
    for (const [url, abort] of this.pending) if (!wanted.has(url) && !this.cache.hasStarted(url)) { abort.abort(); this.pending.delete(url); }
    this.commit();
    for (const entry of this.desired) {
      if (this.models.has(entry.url) || this.photos.has(entry.url) || this.pending.has(entry.url) || !this.failed.ready(entry.url)) continue;
      const abort = new AbortController(); this.pending.set(entry.url, abort);
      void this.cache.read(entry.url, 8_000_000, async bytes => {
        let root: THREE.Group | THREE.Mesh, ids = new Set<string>(), highlight: BuildingHighlight | null = null;
        if (entry.transform) {
          const features = texturedBuildingFeatures(bytes); ids = new Set(features.filter(id => id.startsWith('BID_')));
          highlight = new BuildingHighlight(features); root = (await this.loader.parseAsync(bytes, '')).scene;
          try { await this.cache.whenActive(abort.signal); projectTexturedModel(root, entry.transform); highlight.apply(root); }
          catch (error) { disposeMapObject(root); throw error; }
        } else {
          const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'flipY' });
          if (bitmap.width > 2048 || bitmap.height > 2048) { bitmap.close(); throw new Error('Oversized aerial image'); }
          try { await this.cache.whenActive(abort.signal); } catch (error) { bitmap.close(); throw error; }
          const texture = new THREE.Texture(bitmap); texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false; texture.needsUpdate = true;
          root = new THREE.Mesh(aerialGeometry(this.base, entry.bounds), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
        }
        return { root, ids, highlight };
      }, abort.signal, 'foreground', true, 'map').then(async ({ root, ids, highlight }) => {
        try { await this.cache.whenActive(abort.signal); } catch (error) { disposeMapObject(root); throw error; }
        if (this.disposed || abort.signal.aborted || !this.desired.some(item => item.url === entry.url)) { disposeMapObject(root); return; }
        if (root instanceof THREE.Mesh) { root.userData.bounds = entry.bounds; this.photos.set(entry.url, root); this.aerial.add(root); this.revision++; }
        else {
          highlight!.set(this.selected, this.hovered);
          this.models.set(entry.url, { root, ids, bounds: entry.bounds, ancestors: entry.ancestors ?? [], highlight: highlight! });
        }
        this.failed.delete(entry.url);
      }).catch(() => { if (!abort.signal.aborted && !this.disposed) this.failed.fail(entry.url); })
        .finally(() => { if (this.pending.get(entry.url) === abort) this.pending.delete(entry.url); if (!this.disposed) this.synchronize(); });
    }
    this.refresh();
  }
  retry() {
    this.discovery?.abort(); this.discovery = null;
    this.failed.clear();
    this.index.clear(); this.view = '';
  }
  openAvailable() { this.commit(); this.refresh(); }
  pause() { this.discovery?.abort(); for (const abort of this.pending.values()) abort.abort(); this.pending.clear(); }
  dispose() {
    this.disposed = true; this.pause(); this.decoder.dispose();
    for (const model of this.models.values()) if (!model.root.parent) disposeMapObject(model.root);
    disposeMapObject(this.aerial); disposeMapObject(this.buildings);
    this.models.clear(); this.photos.clear(); this.index.clear(); this.buildingIds.clear();
    if (this.ownsCache) this.cache.dispose();
  }
}
