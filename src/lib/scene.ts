import type { TrafficCounterSummary } from './traffic-measurements.ts';
import type { VehicleItinerary } from './itinerary.ts';
import type { RailCategory } from './rail.ts';
import * as THREE from 'three';
import { BuildingHighlight } from './building-highlight.ts';
import { CityAppearance } from './city-appearance.ts';
import { CityAssetCache } from './city-cache.ts';
import { AssetRetries, ViewLoading, type BackgroundProgress, type SceneLoadState } from './city-loading.ts';
export type { SceneLoadState } from './city-loading.ts';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CityChunkLoader, sampleTerrainHeight, type CityBase, type CityChunkEntry, type CityManifest } from './city-assets.ts';
import { buildingIdForTriangle } from './data/geometry.ts';
import { wgs84ToScene } from './geo.ts';
import { LiveFleet, vehicleVisible } from './live-fleet.ts';
import { VehicleFlags } from './vehicle-flags.ts';
import { StationFlags, stationVisible } from './station-flags.ts';
import { WEBCAMS, type Webcam } from './webcams.ts';
import { PORT_HARBOURS, type PortHarbour } from './port-cameras.ts';
import { RouteHighlight } from './route-highlight.ts';
export { routeGeometry } from './route-highlight.ts';
import { vehicleLabel } from './rail.ts';
import { buildingName } from './inspection.ts';
import type { RouteCatalog, RouteContext } from './route-context.ts';
import { trafficIsStale, trafficShouldRemove, type TrafficSnapshot } from './traffic.ts';
import type { Building, BuildingChunk, TransitMode, Vehicle } from './types.ts';
import { NO_ENERGY_COLOUR } from './energy-display.ts';

export type CameraPreset = 'city' | 'harbour' | 'suomenlinna' | 'energy' | 'central' | 'pasila';
export interface SceneStation {
  id: string; name: string; longitude: number; latitude: number; kind: 'weather' | 'air-quality' | 'rail' | 'camera' | 'port-camera' | 'traffic-counter'; sourceIds: string[]; colour?: string; detail?: string; trafficSummary?: TrafficCounterSummary;
}
export type Selection = { kind: 'building'; building: Building; unloaded?: boolean }
  | { kind: 'vehicle'; vehicle: Vehicle; removed?: boolean }
  | { kind: 'station'; station: SceneStation };
export type Layers = Record<TransitMode | 'buildings' | 'roads' | 'terrain' | 'weather' | 'airQuality' | 'imagery' | 'railStations' | 'trafficMeasurements' | RailCategory, boolean>;
export const INITIAL_LAYERS: Layers = { imagery: true, buildings: true, roads: true, terrain: true, tram: true, bus: true, ferry: true, train: true, ship: true, railStations: true, trafficMeasurements: true, commuter: true, 'long-distance': true, freight: true, other: true, weather: true, airQuality: true };
export type SceneStats = { fps: number; drawCalls: number; triangles: number; geometries: number;
  loadedChunks: number; vehicles: number; unplacedVehicles: number; lastReceiptLatencyMs: number | null };
type Callbacks = { onWebcamSelect?: (camera: Webcam) => void; onPortCameraSelect?: (harbour: PortHarbour) => void; onSelection: (selection: Selection | null, message?: string) => void;
  onBuildings: (buildings: Building[]) => void; onStats: (stats: SceneStats) => void;
  onHover: (label: string) => void; onError: (message: string) => void;
  onCameraInteraction: () => void; onReady: () => void; onAppearanceStatus: (message: string) => void; onLoadState: (state: SceneLoadState) => void; onScale?: (scale: SceneScale | null) => void; onCompassRotation?: (degrees: number) => void };
export type CitySceneController = ReturnType<typeof createCityScene>;
export type SceneScale = { metres: number; pixels: number };

/** Scene north is negative Z; positive SVG rotation moves north clockwise. */
export function measureCompassRotation(camera: THREE.PerspectiveCamera, target: THREE.Vector3): number {
  return Math.atan2(camera.position.x - target.x, camera.position.z - target.z) * 180 / Math.PI;
}

/** Perspective ground distance is local to the horizontal row through the view centre. */
export function measureGroundScale(camera: THREE.PerspectiveCamera, width: number, groundHeight: number): SceneScale | null {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(groundHeight) || camera.position.y <= groundHeight) return null;
  const span = Math.min(120, width / 3), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundHeight);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(-span / width, 0), camera);
  const left = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  raycaster.setFromCamera(new THREE.Vector2(span / width, 0), camera);
  const right = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  if (!left || !right) return null;
  const distance = Math.hypot(right.x - left.x, right.z - left.z);
  if (!Number.isFinite(distance) || distance <= 0) return null;
  const magnitude = 10 ** Math.floor(Math.log10(distance));
  const metres = (distance >= 5 * magnitude ? 5 : distance >= 2 * magnitude ? 2 : 1) * magnitude;
  return { metres, pixels: Math.round(span * metres / distance * 10) / 10 };
}

export function makeChunkGeometry(chunk: BuildingChunk) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(chunk.positions, 3));
  const features = new Float32Array(chunk.positions.length / 3);
  chunk.ranges.forEach((range, index) => features.fill(index, range.firstTriangle * 3, (range.firstTriangle + range.triangleCount) * 3));
  geometry.setAttribute('_feature_id_0', new THREE.BufferAttribute(features, 1));
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

/** Colours follow semantic triangle ranges, including disjoint parts of the same building. */
export function applyBuildingColours(geometry: THREE.BufferGeometry, chunk: BuildingChunk, colours: ReadonlyMap<string, string>) {
  const attribute = new THREE.Float32BufferAttribute(new Float32Array(chunk.positions.length), 3);
  const neutral = new THREE.Color(NO_ENERGY_COLOUR);
  for (let vertex = 0; vertex < attribute.count; vertex++) attribute.setXYZ(vertex, neutral.r, neutral.g, neutral.b);
  for (const range of chunk.ranges) {
    const colour = new THREE.Color(colours.get(range.buildingId) ?? NO_ENERGY_COLOUR);
    for (let vertex = range.firstTriangle * 3; vertex < (range.firstTriangle + range.triangleCount) * 3; vertex++) attribute.setXYZ(vertex, colour.r, colour.g, colour.b);
  }
  geometry.setAttribute('color', attribute);
}

/** Hidden texture-covered ranges still participate in semantic raycasts. */
export function applyTextureCoverage(geometry: THREE.BufferGeometry, chunk: BuildingChunk, ids: ReadonlySet<string>) {
  geometry.clearGroups();
  for (const range of chunk.ranges) {
    const materialIndex = ids.has(range.buildingId) ? 1 : 0, count = range.triangleCount * 3;
    const previous = geometry.groups.at(-1);
    if (previous?.materialIndex === materialIndex) previous.count += count;
    else geometry.addGroup(range.firstTriangle * 3, count, materialIndex);
  }
}

export function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
  root.clear();
}

export function visibleChunks(entries: CityChunkEntry[], target: THREE.Vector3, distance: number, frustum: THREE.Frustum) {
  return entries.map(entry => {
    const [minX, minZ, maxX, maxZ] = entry.bounds;
    const separation = Math.hypot(Math.max(minX - target.x, 0, target.x - maxX), Math.max(minZ - target.z, 0, target.z - maxZ));
    const box = new THREE.Box3(new THREE.Vector3(minX, -30, minZ), new THREE.Vector3(maxX, 300, maxZ));
    return { entry, separation, visible: frustum.intersectsBox(box) };
  }).filter(item => item.visible).sort((a, b) => a.separation - b.separation).map(item => item.entry.id);
}

function terrainGeometry(terrain: CityBase['terrain']) {
  const positions: number[] = [];
  const vertex = (index: number) => [terrain.origin[0] + index % terrain.width * terrain.step[0], terrain.elevations[index]!,
    terrain.origin[1] + Math.floor(index / terrain.width) * terrain.step[1]];
  for (let row = 0; row < terrain.height - 1; row++) for (let column = 0; column < terrain.width - 1; column++) {
    const a = row * terrain.width + column, b = a + 1, c = a + terrain.width, d = c + 1;
    for (const triangle of [[a, c, b], [b, c, d]]) if (triangle.every(index => terrain.elevations[index] !== null)) {
      for (const index of triangle) positions.push(...vertex(index));
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); return geometry;
}


/** Official land stays dry even below the sea display datum; unknown coverage is omitted. */
export function waterGeometry(base: CityBase) {
  const terrain = base.terrain, positions: number[] = [];
  for (let row = 0; row < terrain.height - 1; row++) for (let column = 0; column < terrain.width - 1; column++) {
    const a = row * terrain.width + column, b = a + 1, c = a + terrain.width, d = c + 1;
    for (const triangle of [[a, c, b], [b, c, d]]) if (triangle.every(index => base.landMask?.[index] === false)) {
      for (const index of triangle) positions.push(terrain.origin[0] + index % terrain.width * terrain.step[0],
        base.waterLevel, terrain.origin[1] + Math.floor(index / terrain.width) * terrain.step[1]);
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); return geometry;
}

/** Move across the ground without changing the orbit camera's height or viewing angle. */
export function panKeyboardCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3, keys: ReadonlySet<string>, elapsedSeconds: number) {
  const sideways = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
  const ahead = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
  if ((!sideways && !ahead) || elapsedSeconds <= 0) return;
  const forward = new THREE.Vector3().subVectors(target, camera.position); forward.y = 0; forward.normalize();
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const shift = forward.multiplyScalar(ahead).addScaledVector(right, sideways).normalize()
    .multiplyScalar(Math.max(120, camera.position.distanceTo(target) * 0.4) * Math.min(elapsedSeconds, 0.05));
  camera.position.add(shift); target.add(shift);
}

/** Frame one selected entity without changing the compass direction. */
export function frameSelection(camera: THREE.PerspectiveCamera, target: THREE.Vector3, point: THREE.Vector3) {
  const offset = camera.position.clone().sub(target); offset.y = 0;
  if (!offset.lengthSq()) offset.set(.48, 0, .85);
  offset.normalize().multiplyScalar(400);
  target.copy(point); camera.position.copy(point).add(offset);
  // shortcut: 350m clears the validated 300m city roofs; revisit if taller assets are accepted.
  camera.position.y = Math.max(350, point.y + 400);
}

export type VehicleFollowCamera = {
  heading: number; startedAt: number; cameraFrom: THREE.Vector3; targetFrom: THREE.Vector3;
};

/** Orbit behind the accepted vehicle heading while keeping several blocks in view. */
export function frameVehicleFollow(camera: THREE.PerspectiveCamera, target: THREE.Vector3,
  position: { x: number; y: number; z: number; heading: number | null }, follow: VehicleFollowCamera,
  now: number, elapsedSeconds: number, reducedMotion = false) {
  if (position.heading !== null) {
    const turn = THREE.MathUtils.euclideanModulo(position.heading - follow.heading + 180, 360) - 180;
    const amount = reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, Math.min(elapsedSeconds, .05)) / .3);
    follow.heading = THREE.MathUtils.euclideanModulo(follow.heading + turn * amount, 360);
  }
  const point = new THREE.Vector3(position.x, position.y + .5, position.z);
  // shortcut: 350m clears the validated 300m city roofs; revisit if taller assets are accepted.
  const altitude = Math.max(350, point.y + 400), behind = altitude - point.y;
  const radians = follow.heading * Math.PI / 180;
  const destination = new THREE.Vector3(point.x - Math.sin(radians) * behind, altitude, point.z + Math.cos(radians) * behind);
  const progress = reducedMotion ? 1 : THREE.MathUtils.clamp((now - follow.startedAt) / 800, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  target.lerpVectors(follow.targetFrom, point, eased);
  camera.position.lerpVectors(follow.cameraFrom, destination, eased);
  camera.position.y = Math.max(350, camera.position.y);
}

/** Keep source tiles that straddle the edge inside the rendered ground rectangle. */
export function mapClippingPlanes([west, south, east, north]: CityBase['bounds']) {
  return [new THREE.Plane(new THREE.Vector3(1, 0, 0), -west), new THREE.Plane(new THREE.Vector3(-1, 0, 0), east),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -south), new THREE.Plane(new THREE.Vector3(0, 0, -1), north)];
}

export function createCityRenderer() {
  // Preserve centimetre-scale separation between imagery and terrain across the city view.
  return new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
}

export function createCityScene(container: HTMLElement, manifest: CityManifest, base: CityBase, callbacks: Callbacks, cache: CityAssetCache = new CityAssetCache(), modelUrls: Record<Exclude<TransitMode, 'ship'>, string> = { bus: '/models/bus.glb', tram: '/models/tram.glb', ferry: '/models/ferry.glb', train: '/models/train.glb' }) {
  let disposed = false, frame = 0, layers = { ...INITIAL_LAYERS }, selected: Selection | null = null, hoverId: string | null = null;
  let followId: string | null = null, followCamera: VehicleFollowCamera | null = null, lastReceiptLatencyMs: number | null = null;
  let routeFilter: string | null = null, route: RouteContext | null = null, marinePaused = false, marineSourcePaused = false;
  let buildingColours: ReadonlyMap<string, string> = new Map(), buildingThemed = false;
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = reducedQuery.matches;
  const motionChange = () => { reducedMotion = reducedQuery.matches; controls.enableDamping = !reducedMotion; };
  reducedQuery.addEventListener('change', motionChange);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#0c202b');
  scene.fog = new THREE.Fog('#0c202b', 14_000, 32_000);
  const renderer = createCityRenderer();
  renderer.clippingPlanes = mapClippingPlanes(base.bounds);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75)); renderer.setClearColor('#0c202b');
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', 'Helsinki 3D city. Hold WASD to pan when keyboard navigation is enabled. Use search and station lists to select objects with the keyboard.');
  renderer.domElement.setAttribute('role', 'img');
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 40_000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !reducedMotion; controls.dampingFactor = 0.12;
  controls.minDistance = 45; controls.maxDistance = 18_000; controls.maxPolarAngle = Math.PI / 2 - 0.08;
  scene.add(new THREE.HemisphereLight('#edf9ff', '#697463', 2.2));
  const sun = new THREE.DirectionalLight('#fff0d4', 2.3); sun.position.set(-2000, 3500, 800); scene.add(sun);
  const land = new THREE.Group(), context = new THREE.Group(), buildings = new THREE.Group();
  scene.add(land, context, buildings);
  let stations: SceneStation[] = [];
  const routeHighlight = new RouteHighlight(container, base); scene.add(routeHighlight.root);
  land.add(new THREE.Mesh(terrainGeometry(base.terrain), new THREE.MeshStandardMaterial({ color: '#697c72', roughness: 1, side: THREE.DoubleSide })));
  const water = new THREE.Mesh(waterGeometry(base), new THREE.MeshStandardMaterial({ color: '#234d61', roughness: 0.78 }));
  scene.add(water);
  for (const [paths, colour, opacity] of [[base.shorelines, '#b9c6b4', 0.6], [base.roads, '#a7b1a7', 0.5], [base.rails, '#c7be9b', 0.7]] as const) {
    const positions: number[] = [];
    for (const path of paths) for (let i = 0; i + 5 < path.length; i += 3) positions.push(...path.slice(i, i + 6));
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity }));
    lines.position.y = 0.5; lines.userData.opacity = opacity; context.add(lines);
  }
  const fleet = new LiveFleet((x, z) => sampleTerrainHeight(base.terrain, x, z), base.waterLevel); scene.add(fleet.root);
  let hoveredVehicleId: string | null = null;
  const flags = new VehicleFlags(container, vehicle => { if (initiallyReady) select({ kind: 'vehicle', vehicle }); },
    (id, label) => { hoveredVehicleId = id; callbacks.onHover(label); });
  const stationFlags = new StationFlags(container, base, station => {
    if (!initiallyReady) return;
    if (station.kind === 'camera') { const camera = WEBCAMS.find(camera => camera.id === station.id); if (camera) callbacks.onWebcamSelect?.(camera); }
    else if (station.kind === 'port-camera') { const harbour = PORT_HARBOURS.find(harbour => harbour.id === station.id); if (harbour) callbacks.onPortCameraSelect?.(harbour); }
    else select({ kind: 'station', station });
  }, callbacks.onHover);
  const cameraPois: SceneStation[] = [...WEBCAMS.map(camera => ({ ...camera, kind: 'camera' as const, sourceIds: ['digitraffic-weathercam'] })),
    ...PORT_HARBOURS.map(harbour => ({ ...harbour, kind: 'port-camera' as const, sourceIds: ['port-of-helsinki'] }))];
  const updateStationFlags = () => stationFlags.setStations([...stations.filter(station => stationVisible(station, layers)), ...cameraPois]);
  updateStationFlags();
  void fleet.loadModels(modelUrls, callbacks.onError);
  void fleet.loadShipModels(callbacks.onError);
  const vehicleRing = new THREE.Mesh(new THREE.RingGeometry(12, 16, 40), new THREE.MeshBasicMaterial({ color: '#d5f6e6', side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.95 }));
  vehicleRing.rotation.x = -Math.PI / 2; vehicleRing.renderOrder = 4; vehicleRing.visible = false; scene.add(vehicleRing);
  const viewLoading = new ViewLoading();
  let viewKey = '', semanticRevision = 0, initiallyReady = false, loadSignature = '';
  let loadState: SceneLoadState = { phase: 'discovering', completed: 0, total: 0, failed: 0, cacheIssue: '', background: { phase: 'idle', completed: 0, total: 0, failed: 0 } };
  let background: BackgroundProgress = loadState.background;
  let backgroundRunning = false, serverCacheIssue = '';
  let cachePoll: ReturnType<typeof setTimeout> | undefined;
  const backgroundAbort = new AbortController();
  let reportLoad = () => {}, scheduleRetry = () => {};
  let retryTimer: ReturnType<typeof setTimeout> | undefined, retryAt = Infinity;
  const loader = new CityChunkLoader(manifest, fetch, cache), chunks = new Map<string, { chunk: BuildingChunk; mesh: THREE.Mesh; buildings: Building[]; highlight: BuildingHighlight }>();
  const identities = new Map<string, Building>();
  const refreshAppearance = () => {
    const textured = layers.imagery && !buildingThemed;
    appearance.setVisible(layers.imagery, layers.terrain, layers.buildings && !buildingThemed);
    for (const { chunk, mesh } of chunks.values()) applyTextureCoverage(mesh.geometry, chunk, textured ? appearance.buildingIds : new Set());
    context.visible = layers.roads;
    for (const object of context.children) { const lines = object as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>; lines.material.opacity = lines.userData.opacity * (layers.imagery ? 0.25 : 1); }
  };
  const appearance = new CityAppearance(renderer, base, () => { refreshAppearance(); reportLoad(); }, callbacks.onAppearanceStatus, cache);
  scene.add(appearance.aerial, appearance.buildings);
  const pending = new Map<string, AbortController>(), failedUntil = new AssetRetries();
  let wanted = new Set<string>();
  let itinerary: VehicleItinerary | null = null;
  const refreshContext = () => {
    const vehicle = selected?.kind === 'vehicle' ? selected : null;
    const mapped = route?.status === 'exact' && route.vehicleId === vehicle?.vehicle.id && route.routeId === vehicle.vehicle.routeId;
    const stops = itinerary?.vehicleId === vehicle?.vehicle.id && !!itinerary?.stops.length;
    routeHighlight.setVisible(Boolean(vehicle && (mapped || stops) && !vehicle.removed && vehicleVisible(vehicle.vehicle, layers, routeFilter)));
  };
  const refreshHighlights = () => {
    refreshContext();
    const id = selected?.kind === 'building' ? selected.building.id : null;
    const focus = selected?.kind === 'building' ? new THREE.Vector3(...wgs84ToScene(selected.building.longitude, selected.building.latitude)) : null;
    for (const item of chunks.values()) item.highlight.set(id, hoverId);
    appearance.setSelection(id, hoverId, focus);
  };
  const reportBuildings = () => {
    callbacks.onBuildings([...new Map([...chunks.values()].flatMap(item => item.buildings).map(building => [building.id, building])).values()]);
    if (selected?.kind === 'building') {
      const buildingId = selected.building.id;
      selected = { ...selected, unloaded: ![...chunks.values()].some(item => item.chunk.ranges.some(range => range.buildingId === buildingId)) };
      callbacks.onSelection(selected);
    }
    refreshHighlights();
  };
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4();
  const trimChunks = () => {
    let changed = false;
    for (const [id, item] of chunks) if (!wanted.has(id)) {
      item.mesh.removeFromParent(); item.mesh.geometry.dispose();
      (item.mesh.material as THREE.Material[]).forEach(material => material.dispose());
      chunks.delete(id); loader.unload(id); changed = true; semanticRevision++;
    }
    if (changed) reportBuildings();
  };
  const prefetch = async (start = false) => {
    if (disposed || document.hidden || backgroundAbort.signal.aborted) return;
    backgroundRunning = true;
    try {
      const response = await fetch('/api/city-cache', { method: start ? 'POST' : 'GET', signal: AbortSignal.any([backgroundAbort.signal, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new Error('Map cache status unavailable');
      const status = await response.json();
      if (!['idle', 'discovering', 'loading', 'complete', 'partial', 'stopped'].includes(status.phase)
        || ![status.completed, status.total, status.failed].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid map cache status');
      background = { phase: status.phase, completed: status.completed, total: status.total, failed: status.failed };
      serverCacheIssue = typeof status.cacheIssue === 'string' ? status.cacheIssue : '';
    } catch { if (!disposed) background = { ...background, phase: 'partial' }; }
    finally {
      backgroundRunning = false;
      if (!disposed) {
        reportLoad();
        if (!['complete', 'stopped'].includes(background.phase)) cachePoll = setTimeout(() => { void prefetch(background.phase === 'idle'); }, 10_000);
      }
    }
  };
  reportLoad = () => {
    if (disposed) return;
    const imagery = appearance.progress();
    const progress = { discovering: imagery.discovering, completed: [...wanted].filter(id => chunks.has(id)).length + imagery.completed,
      total: wanted.size + imagery.total, failed: [...wanted].filter(id => failedUntil.has(id)).length + imagery.failed };
    loadState = viewLoading.update(viewKey, semanticRevision + appearance.revision, progress, background, serverCacheIssue || cache.storageIssue);
    const usable = loadState.phase === 'ready' || loadState.phase === 'available';
    cache.setBackgroundAllowed(usable && !document.hidden);
    const signature = JSON.stringify(loadState);
    if (signature !== loadSignature) { loadSignature = signature; callbacks.onLoadState(loadState); scheduleRetry(); }
    if (usable && !initiallyReady) { initiallyReady = true; callbacks.onReady(); }
    if (usable && !backgroundRunning && background.phase === 'idle') void prefetch(true);
  };
  let appearanceDirty = false;
  const updateCameraView = () => {
    camera.updateMatrixWorld(); projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(projection);
  };
  const updateAppearance = () => {
    if (disposed || document.hidden) return;
    updateCameraView(); appearance.update(controls.target, camera.position.distanceTo(controls.target), frustum);
    scheduleRetry();
  };
  const updateChunks = () => {
    if (disposed || document.hidden || !cache.viewSettled) return;
    updateCameraView();
    viewKey = [layers.buildings, layers.terrain, layers.imagery, buildingThemed,
      ...projection.elements.map(value => value.toFixed(4))].join('/');
    wanted = new Set(layers.buildings ? visibleChunks(manifest.chunks, controls.target, camera.position.distanceTo(controls.target), frustum) : []);
    for (const [id, controller] of pending) if (!wanted.has(id)) { controller.abort(); pending.delete(id); }
    trimChunks();
    for (const id of wanted) if (!chunks.has(id) && !pending.has(id) && failedUntil.ready(id)) {
      const abort = new AbortController(); pending.set(id, abort);
      void loader.load(id, abort.signal).then(async result => {
        await cache.whenViewSettled(abort.signal);
        if (disposed || abort.signal.aborted || !wanted.has(id)) { loader.unload(id); return; }
        const geometry = makeChunkGeometry(result.chunk); applyBuildingColours(geometry, result.chunk, buildingColours);
        const material = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.92, side: THREE.DoubleSide });
        const hidden = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
        applyTextureCoverage(geometry, result.chunk, layers.imagery && !buildingThemed ? appearance.buildingIds : new Set());
        const mesh = new THREE.Mesh(geometry, [material, hidden]);
        const highlight = new BuildingHighlight(result.chunk.ranges.map(range => range.buildingId)); highlight.apply(mesh);
        mesh.userData.chunkId = id; buildings.add(mesh);
        chunks.set(id, { ...result, mesh, highlight }); semanticRevision++;
        result.buildings.forEach(building => identities.set(building.id, building)); reportBuildings();
        failedUntil.delete(id); trimChunks();
      }).catch(() => { if (!abort.signal.aborted && !disposed) failedUntil.fail(id); })
        .finally(() => { if (pending.get(id) === abort) pending.delete(id); reportLoad(); });
    }
    reportLoad(); scheduleRetry();
  };
  cache.onViewSettled = updateChunks;
  scheduleRetry = () => {
    const due = disposed || document.hidden ? Infinity
      : Math.min(cache.viewSettled ? failedUntil.nextDue([...wanted].filter(id => !pending.has(id))) : Infinity, appearance.nextRetryAt());
    if (due === retryAt) return;
    clearTimeout(retryTimer); retryAt = due;
    if (due < Infinity) retryTimer = setTimeout(() => { retryAt = Infinity; updateAppearance(); updateChunks(); }, Math.max(0, due - Date.now()));
  };
  const requestViewUpdate = () => {
    appearanceDirty = true;
    if (!initiallyReady && cache.viewSettled) { updateAppearance(); appearanceDirty = false; updateChunks(); }
    else { cache.viewChanged(); scheduleRetry(); }
  };
  const preset = (id: CameraPreset) => {
    followId = null;
    const location = id === 'central' ? [24.941444, 60.174, 750] : id === 'pasila' ? [24.933521, 60.198689, 1000] : id === 'energy' ? [24.952913, 60.168037, 850] : id === 'city' ? [24.952, 60.1695, 1450] : id === 'harbour' ? [24.957, 60.1607, 2000] : [24.986, 60.1466, 1150];
    const [x, , z] = wgs84ToScene(location[0], location[1]);
    controls.enableDamping = false; controls.update();
    controls.target.set(x, 8, z); camera.position.set(x + location[2] * 0.48, location[2] * 0.72, z + location[2] * 0.85);
    controls.update(); controls.enableDamping = !reducedMotion; requestViewUpdate();
  };
  let followViewDirty = false, scaleDirty = true;
  let lastScale: SceneScale | null = null;
  let keyboardNavigation = true, pointerInteracting = false;
  const heldKeys = new Set<string>();
  const keyboardBlocked = (target: EventTarget | null = document.activeElement) => !keyboardNavigation || !initiallyReady || document.hidden
    || (target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input, textarea, select, button, a[href], summary, [role="button"], [role="tabpanel"], [role="textbox"]')))
    || !!document.querySelector('dialog[open], [popover]:popover-open');
  const stopKeyboard = () => { if (!heldKeys.size) return; heldKeys.clear(); cache.setInteracting(pointerInteracting); };
  const windowBlur = () => { pointerInteracting = false; stopKeyboard(); cache.setInteracting(false); };
  const keyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || keyboardBlocked(event.target)) { stopKeyboard(); return; }
    if (event.defaultPrevented || !['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) return;
    event.preventDefault();
    if (!heldKeys.size) { followId = null; cache.setInteracting(true); scheduleRetry(); callbacks.onCameraInteraction(); }
    heldKeys.add(event.code);
  };
  const keyUp = (event: KeyboardEvent) => { if (heldKeys.delete(event.code) && !heldKeys.size) cache.setInteracting(pointerInteracting); };
  const focusChanged = () => { if (keyboardBlocked()) stopKeyboard(); };
  window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', windowBlur);
  document.addEventListener('focusin', focusChanged);
  const interaction = () => { pointerInteracting = true; followId = null; cache.setInteracting(true); scheduleRetry(); callbacks.onCameraInteraction(); };
  const interactionEnded = () => { pointerInteracting = false; cache.setInteracting(heldKeys.size > 0); };
  const cameraChanged = () => {
    callbacks.onCompassRotation?.(measureCompassRotation(camera, controls.target));
    scaleDirty = true; appearanceDirty = true; if (followId) followViewDirty = true; else requestViewUpdate();
  };
  controls.addEventListener('change', cameraChanged);
  controls.addEventListener('start', interaction);
  controls.addEventListener('end', interactionEnded);
  const resize = () => { if (disposed) return; scaleDirty = true; const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height);
    requestViewUpdate(); };
  const observer = new ResizeObserver(resize); observer.observe(container); resize(); preset('city');
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  function pick(event: PointerEvent): Selection | null {
    if (!initiallyReady) return null;
    const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const objects: THREE.Object3D[] = [...(layers.buildings ? buildings.children : []), ...[...fleet.meshes.values()].filter(mesh => mesh.visible)];
    for (const hit of raycaster.intersectObjects(objects, false)) {
      if (renderer.clippingPlanes.some(plane => plane.distanceToPoint(hit.point) < 0)) continue;
      const id = fleet.idForHit(hit);
      if (id) { const vehicle = fleet.motion.tracks.get(id)?.vehicle; if (vehicle) return { kind: 'vehicle', vehicle }; }
      const chunk = chunks.get(hit.object.userData.chunkId)?.chunk;
      const buildingId = chunk && buildingIdForTriangle(chunk, hit.faceIndex);
      if (buildingId && identities.has(buildingId)) return { kind: 'building', building: identities.get(buildingId)! };
    }
    return null;
  }
  const select = (selection: Selection | null, message?: string) => {
    if (selection?.kind !== 'vehicle' || selected?.kind !== 'vehicle' || selection.vehicle.id !== selected.vehicle.id) {
      route = null; itinerary = null; routeHighlight.setRoute(null, 'bus');
    }
    if (followId) callbacks.onCameraInteraction();
    selected = selection; followId = null; refreshHighlights(); callbacks.onSelection(selection, message);
  };
  const selectAndFocus = (selection: Selection | null) => {
    if (selection && !initiallyReady) return;
    let point: THREE.Vector3 | null = null;
    if (selection?.kind === 'building') {
      const building = selection.building;
      if (!manifest.chunks.some(chunk => chunk.id === building.chunkRef)) { select(null, 'This building is outside the available city coverage.'); return; }
      identities.set(building.id, building);
      const [x, , z] = wgs84ToScene(building.longitude, building.latitude);
      point = new THREE.Vector3(x, sampleTerrainHeight(base.terrain, x, z) ?? 0, z);
    } else if (selection?.kind === 'vehicle') {
      const now = Date.now(), vehicle = fleet.motion.tracks.get(selection.vehicle.id)?.vehicle ?? selection.vehicle;
      selection = { kind: 'vehicle', vehicle, removed: trafficShouldRemove(vehicle, now) };
      const position = fleet.motion.position(vehicle.id, now, reducedMotion || (vehicle.mode === 'ship' && (marinePaused || marineSourcePaused)));
      if (position) {
        const height = vehicle.mode === 'ferry' || vehicle.mode === 'ship' ? base.waterLevel : sampleTerrainHeight(base.terrain, position.x, position.z);
        if (height !== null) point = new THREE.Vector3(position.x, height, position.z);
      }
    } else if (selection?.kind === 'station') {
      const [x, , z] = wgs84ToScene(selection.station.longitude, selection.station.latitude);
      const height = sampleTerrainHeight(base.terrain, x, z);
      if (height !== null) point = new THREE.Vector3(x, height, z);
    }
    select(selection);
    if (!point) return;
    stopKeyboard(); controls.enableDamping = false; controls.update();
    frameSelection(camera, controls.target, point);
    controls.update(); controls.enableDamping = !reducedMotion; requestViewUpdate();
  };
  let down: { x: number; y: number } | null = null, hoverAt = 0;
  const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
  const pointerUp = (event: PointerEvent) => { if (down && initiallyReady && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5) select(pick(event)); down = null; };
  const pointerMove = (event: PointerEvent) => { if (event.buttons || performance.now() - hoverAt < 100) return; hoverAt = performance.now();
    const feature = pick(event), id = feature?.kind === 'building' ? feature.building.id : null;
    hoveredVehicleId = feature?.kind === 'vehicle' ? feature.vehicle.id : null;
    renderer.domElement.style.cursor = feature ? 'pointer' : 'grab';
    callbacks.onHover(feature?.kind === 'building' ? buildingName(feature.building) : feature?.kind === 'vehicle' ? `${feature.vehicle.mode} · ${vehicleLabel(feature.vehicle)}` : '');
    if (id !== hoverId) { hoverId = id; refreshHighlights(); } };
  const pointerLeave = () => { hoverId = null; hoveredVehicleId = null; refreshHighlights(); callbacks.onHover(''); };
  renderer.domElement.addEventListener('pointerdown', pointerDown); renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('pointermove', pointerMove); renderer.domElement.addEventListener('pointerleave', pointerLeave);
  let frames = 0, statsAt = performance.now(), followedAt = 0, navigationAt = performance.now();
  const animate = (now: number) => {
    if (disposed || document.hidden) return;
    frame = requestAnimationFrame(animate);
    const elapsedSeconds = (now - navigationAt) / 1000; navigationAt = now;
    if (heldKeys.size) {
      if (keyboardBlocked()) stopKeyboard();
      else panKeyboardCamera(camera, controls.target, heldKeys, elapsedSeconds);
    }
    fleet.update(Date.now(), layers, reducedMotion, routeFilter, marinePaused || marineSourcePaused);
    if (selected?.kind === 'vehicle') {
      const latest = fleet.motion.tracks.get(selected.vehicle.id)?.vehicle;
      const position = fleet.motion.position(selected.vehicle.id, Date.now(), reducedMotion || (selected.vehicle.mode === 'ship' && (marinePaused || marineSourcePaused)));
      if ((!latest || !position) && !selected.removed) { selected = { ...selected, removed: true }; followId = null; callbacks.onSelection(selected); }
      const height = position ? (selected.vehicle.mode === 'ferry' || selected.vehicle.mode === 'ship' ? base.waterLevel : sampleTerrainHeight(base.terrain, position.x, position.z)) : null;
      vehicleRing.visible = Boolean(position && height !== null && vehicleVisible(selected.vehicle, layers, routeFilter) && !selected.removed);
      if (position) {
        if (height !== null) vehicleRing.position.set(position.x, height + 0.5, position.z);
        vehicleRing.scale.setScalar(Math.max(1, camera.position.distanceTo(controls.target) / 1800));
        if (followId === selected.vehicle.id && followCamera) {
          if (height === null || selected.removed || !vehicleVisible(selected.vehicle, layers, routeFilter)) {
            followId = null; callbacks.onCameraInteraction();
          } else {
            const stationary = latest?.speedMetresPerSecond != null && latest.speedMetresPerSecond <= .5;
            frameVehicleFollow(camera, controls.target, { ...position, y: height, heading: stationary ? null : position.heading }, followCamera, now, elapsedSeconds, reducedMotion);
          }
        }
      }
    } else vehicleRing.visible = false;
    refreshContext(); controls.update();
    const selectedPlacement = selected?.kind === 'vehicle' && !selected.removed
      && !(selected.vehicle.mode === 'ship' && (marinePaused || marineSourcePaused)) ? fleet.placements.get(selected.vehicle.id) ?? null : null;
    routeHighlight.update(selectedPlacement, camera, container.clientWidth, container.clientHeight, now, reducedMotion);
    if (appearanceDirty) { appearanceDirty = false; updateAppearance(); }
    camera.updateMatrixWorld();
    if (scaleDirty && callbacks.onScale) {
      scaleDirty = false;
      const height = sampleTerrainHeight(base.terrain, controls.target.x, controls.target.z) ?? base.waterLevel;
      const scale = measureGroundScale(camera, container.clientWidth, height);
      if (scale?.metres !== lastScale?.metres || scale?.pixels !== lastScale?.pixels) { lastScale = scale; callbacks.onScale(scale); }
    }
    flags.update(fleet.placements, camera, container.clientWidth, container.clientHeight,
      selected?.kind === 'vehicle' && !selected.removed ? selected.vehicle.id : null, hoveredVehicleId);
    stationFlags.update(camera, container.clientWidth, container.clientHeight, selected?.kind === 'station' ? selected.station : null);
    const renderedRevision = semanticRevision + appearance.revision; renderer.render(scene, camera); frames++;
    viewLoading.rendered(renderedRevision); reportLoad();
    if (followId && followViewDirty && cache.viewSettled && now - followedAt >= 1500) {
      updateChunks(); followedAt = now; followViewDirty = false;
    }
    if (now - statsAt >= 1500) { callbacks.onStats({ fps: Math.round(frames * 1000 / (now - statsAt)), drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, loadedChunks: chunks.size, vehicles: fleet.visibleCount,
      unplacedVehicles: fleet.unplacedCount, lastReceiptLatencyMs }); frames = 0; statsAt = now; }
  };
  const visibility = () => {
    cancelAnimationFrame(frame); navigationAt = performance.now();
    if (document.hidden) windowBlur(); else stopKeyboard();
    cache.setPaused(document.hidden);
    clearTimeout(cachePoll); scheduleRetry();
    if (document.hidden) { appearance.pause(); for (const controller of pending.values()) controller.abort(); pending.clear(); }
    else { statsAt = performance.now(); frames = 0; requestViewUpdate(); frame = requestAnimationFrame(animate);
      if (initiallyReady && !backgroundRunning && !['complete', 'stopped'].includes(background.phase)) void prefetch(background.phase === 'idle'); }
  };
  document.addEventListener('visibilitychange', visibility); frame = requestAnimationFrame(animate);
  return {
    preset,
    retryLoad() { failedUntil.clear(); appearance.retry(); viewLoading.retry();
      if (!backgroundRunning && background.phase === 'partial') background = { ...background, phase: 'idle' };
      requestViewUpdate(); },
    openAvailableMap() { appearance.openAvailable(); viewLoading.openAvailable(); reportLoad(); },
    setLayers(next: Layers) { layers = { ...next }; updateStationFlags(); if (!layers.buildings) { hoverId = null; callbacks.onHover(''); } buildings.visible = layers.buildings; context.visible = layers.roads; land.visible = layers.terrain; water.visible = layers.terrain; refreshAppearance(); refreshHighlights(); requestViewUpdate(); },
    setMarinePaused(paused: boolean) { marinePaused = paused; },
    setStations(next: SceneStation[]) {
      stations = next; updateStationFlags();
      if (selected?.kind === 'station') {
        const previous = selected.station;
        const station = next.find(station => station.id === previous.id && station.kind === previous.kind);
        if (station) { selected = { kind: 'station', station }; callbacks.onSelection(selected); }
      }
      refreshContext();
    },
    setRoute(next: RouteContext | null) {
      route = next;
      routeHighlight.setRoute(next, selected?.kind === 'vehicle' ? selected.vehicle.mode : 'bus');
      refreshContext();
    },
    setItinerary(next: VehicleItinerary | null) {
      itinerary = next;
      if (selected?.kind === 'vehicle' && ['train', 'tram', 'bus'].includes(selected.vehicle.mode)) routeHighlight.setItinerary(next);
      refreshContext();
    },
    setBuildingColours(next: ReadonlyMap<string, string>, themed = false) { buildingColours = next; buildingThemed = themed; for (const { chunk, mesh } of chunks.values()) applyBuildingColours(mesh.geometry, chunk, next); semanticRevision++; refreshAppearance(); requestViewUpdate(); },
    setRouteFilter(next: string | null) { routeFilter = next; refreshContext(); },
    setTraffic(snapshot: TrafficSnapshot) {
      const now = Date.now(); fleet.setVehicles(snapshot.vehicles);
      marineSourcePaused = snapshot.sources?.marine?.state !== 'live' || !!snapshot.sources?.marine?.stale || !!snapshot.sources?.marine?.periodic;
      const receipts = snapshot.vehicles.map(vehicle => Date.parse(vehicle.receivedAt)).filter(at => Number.isFinite(at));
      lastReceiptLatencyMs = receipts.length ? Math.max(0, now - Math.max(...receipts)) : null;
      if (selected?.kind === 'vehicle') { const selectedId = selected.vehicle.id; const vehicle = snapshot.vehicles.find(vehicle => vehicle.id === selectedId);
        selected = vehicle ? { kind: 'vehicle', vehicle, removed: trafficShouldRemove(vehicle, now) } : { ...selected, removed: true };
        if (selected.removed) followId = null; callbacks.onSelection(selected); }
    },
    select: selectAndFocus,
    selectStation(id: string) {
      const station = stations.find(station => station.id === id);
      if (station) selectAndFocus({ kind: 'station', station });
    },
    selectBuilding(id: string) {
      if (!initiallyReady) return;
      const building = identities.get(id);
      if (!building) { select(null, 'This building is outside the available city coverage.'); return; }
      selectAndFocus({ kind: 'building', building });
    },
    selectVehicle(id: string) { const vehicle = fleet.motion.tracks.get(id)?.vehicle; if (vehicle) selectAndFocus({ kind: 'vehicle', vehicle }); },
    setRoutes(routes: RouteCatalog['routes']) { flags.setRoutes(routes); },
    setKeyboardNavigation(enabled: boolean) { keyboardNavigation = enabled; if (!enabled) stopKeyboard(); },
    followVehicle(id: string | null) {
      followId = null; followCamera = null;
      if (!id || !initiallyReady || selected?.kind !== 'vehicle' || selected.vehicle.id !== id || selected.removed) return false;
      const now = Date.now(), vehicle = fleet.motion.tracks.get(id)?.vehicle;
      if (!vehicle || trafficIsStale(vehicle, now) || !vehicleVisible(vehicle, layers, routeFilter)) return false;
      const position = fleet.motion.position(id, now, reducedMotion || (vehicle.mode === 'ship' && (marinePaused || marineSourcePaused)));
      if (!position) return false;
      const height = vehicle.mode === 'ferry' || vehicle.mode === 'ship' ? base.waterLevel : sampleTerrainHeight(base.terrain, position.x, position.z);
      if (height === null) return false;
      stopKeyboard();
      // Flush OrbitControls inertia before taking over the camera, as presets do.
      controls.enableDamping = false; controls.update(); controls.enableDamping = !reducedMotion;
      followId = id;
      followCamera = { heading: position.heading ?? THREE.MathUtils.radToDeg(Math.atan2(controls.target.x - camera.position.x, camera.position.z - controls.target.z)),
        startedAt: performance.now(), cameraFrom: camera.position.clone(), targetFrom: controls.target.clone() };
      return true;
    },
    clearSelection() { select(null); },
    dispose() {
      if (disposed) return; stopKeyboard(); disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', windowBlur);
      document.removeEventListener('focusin', focusChanged);
      document.removeEventListener('visibilitychange', visibility); reducedQuery.removeEventListener('change', motionChange);
      renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointermove', pointerMove); renderer.domElement.removeEventListener('pointerleave', pointerLeave);
      controls.removeEventListener('start', interaction); controls.removeEventListener('end', interactionEnded); controls.removeEventListener('change', cameraChanged); controls.dispose();
      clearTimeout(cachePoll); clearTimeout(retryTimer); backgroundAbort.abort(); cache.dispose();
      for (const controller of pending.values()) controller.abort(); pending.clear(); loader.dispose();
      appearance.aerial.removeFromParent(); appearance.buildings.removeFromParent(); appearance.dispose();
      routeHighlight.dispose(); routeHighlight.root.removeFromParent(); stationFlags.dispose(); flags.dispose(); fleet.root.removeFromParent(); fleet.dispose(); disposeTree(scene); chunks.clear(); identities.clear(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    }
  };
}
