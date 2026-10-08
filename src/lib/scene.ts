import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CityChunkLoader, sampleTerrainHeight, type CityBase, type CityChunkEntry, type CityManifest } from './city-assets.ts';
import { buildingIdForTriangle } from './data/geometry.ts';
import { wgs84ToScene } from './geo.ts';
import { LiveFleet, vehicleVisible } from './live-fleet.ts';
import { RELEASE_BOUNDS, inBounds } from './area.ts';
import type { RouteContext } from './route-context.ts';
import { TRAFFIC_REMOVE_MS, type TrafficSnapshot } from './traffic.ts';
import type { Building, BuildingChunk, TransitMode, Vehicle } from './types.ts';
import { NO_ENERGY_COLOUR } from './energy-display.ts';

export type CameraPreset = 'city' | 'harbour' | 'suomenlinna' | 'energy';
export interface SceneStation {
  id: string; name: string; longitude: number; latitude: number; kind: 'weather' | 'air-quality'; sourceIds: string[];
}
export type Selection = { kind: 'building'; building: Building; unloaded?: boolean }
  | { kind: 'vehicle'; vehicle: Vehicle; removed?: boolean }
  | { kind: 'station'; station: SceneStation };
export type Layers = Record<TransitMode | 'buildings' | 'roads' | 'terrain' | 'weather' | 'airQuality', boolean>;
export const INITIAL_LAYERS: Layers = { buildings: true, roads: true, terrain: true, tram: true, bus: true, ferry: true, weather: true, airQuality: true };
export type SceneStats = { fps: number; drawCalls: number; triangles: number; geometries: number;
  loadedChunks: number; vehicles: number; unplacedVehicles: number; lastReceiptLatencyMs: number | null };
type Callbacks = { onSelection: (selection: Selection | null, message?: string) => void;
  onBuildings: (buildings: Building[]) => void; onStats: (stats: SceneStats) => void;
  onHover: (label: string) => void; onError: (message: string) => void;
  onCameraInteraction: () => void; onReady: () => void };
export type CitySceneController = ReturnType<typeof createCityScene>;

export function makeChunkGeometry(chunk: BuildingChunk) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(chunk.positions, 3));
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

/** Chunk identities are kept independently of their disposable render geometry. */
export function buildingHighlight(chunk: BuildingChunk, id: string) {
  const positions: number[] = [];
  for (const range of chunk.ranges) if (range.buildingId === id) {
    for (let i = range.firstTriangle * 9; i < (range.firstTriangle + range.triangleCount) * 9; i++) positions.push(chunk.positions[i]);
  }
  return positions;
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
  const radius = Math.min(3_200, Math.max(650, distance * 1.15));
  return entries.map(entry => {
    const [minX, minZ, maxX, maxZ] = entry.bounds;
    const separation = Math.hypot(Math.max(minX - target.x, 0, target.x - maxX), Math.max(minZ - target.z, 0, target.z - maxZ));
    const box = new THREE.Box3(new THREE.Vector3(minX, -5, minZ), new THREE.Vector3(maxX, 120, maxZ));
    return { entry, separation, visible: separation < 400 || frustum.intersectsBox(box) };
  }).filter(item => item.separation < radius && item.visible).sort((a, b) => a.separation - b.separation)
    .slice(0, 12).map(item => item.entry.id);
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

/** Station glyphs keep provider string identity and use only known terrain. */
export function makeStationMarker(station: SceneStation, base: CityBase): THREE.Mesh | null {
  if (!station.id || !inBounds(station.longitude, station.latitude, RELEASE_BOUNDS)) return null;
  const [x, , z] = wgs84ToScene(station.longitude, station.latitude), height = sampleTerrainHeight(base.terrain, x, z);
  if (height === null) return null;
  const geometry = station.kind === 'weather' ? new THREE.SphereGeometry(13, 12, 8) : new THREE.OctahedronGeometry(16);
  const marker = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: station.kind === 'weather' ? '#88c9eb' : '#d8b5e8', roughness: 0.6 }));
  marker.position.set(x, height + 25, z); marker.userData.station = station;
  return marker;
}
export function stationForHit(hit: Pick<THREE.Intersection, 'object'>): SceneStation | null {
  return hit.object.userData.station ?? null;
}
export function routeGeometry(route: RouteContext, base: CityBase, ferry = false): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const path of route.status === 'exact' ? route.shape : []) for (let i = 1; i < path.length; i++) {
    const pair = [path[i - 1], path[i]].map(point => {
      const [x, , z] = wgs84ToScene(...point), height = ferry ? base.waterLevel : sampleTerrainHeight(base.terrain, x, z);
      return height === null ? null : [x, height + 1.5, z];
    });
    if (pair.every(point => point !== null)) positions.push(...pair[0]!, ...pair[1]!);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
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

export function createCityScene(container: HTMLElement, manifest: CityManifest, base: CityBase, callbacks: Callbacks) {
  let disposed = false, frame = 0, layers = { ...INITIAL_LAYERS }, selected: Selection | null = null, hoverId: string | null = null;
  let followId: string | null = null, lastReceiptLatencyMs: number | null = null;
  let routeFilter: string | null = null, route: RouteContext | null = null;
  let buildingColours: ReadonlyMap<string, string> = new Map();
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = reducedQuery.matches;
  const motionChange = () => { reducedMotion = reducedQuery.matches; controls.enableDamping = !reducedMotion; };
  reducedQuery.addEventListener('change', motionChange);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#0c202b');
  scene.fog = new THREE.Fog('#0c202b', 7_000, 16_000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75)); renderer.setClearColor('#0c202b');
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', 'Helsinki 3D city. Use search and station lists to select objects with the keyboard.');
  renderer.domElement.setAttribute('role', 'img');
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 24_000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !reducedMotion; controls.dampingFactor = 0.12;
  controls.minDistance = 45; controls.maxDistance = 10_000; controls.maxPolarAngle = Math.PI / 2 - 0.08;
  scene.add(new THREE.HemisphereLight('#edf9ff', '#697463', 2.2));
  const sun = new THREE.DirectionalLight('#fff0d4', 2.3); sun.position.set(-2000, 3500, 800); scene.add(sun);
  const land = new THREE.Group(), context = new THREE.Group(), buildings = new THREE.Group();
  scene.add(land, context, buildings);
  const stations = new THREE.Group(), routeHighlight = new THREE.Group(); scene.add(stations, routeHighlight);
  land.add(new THREE.Mesh(terrainGeometry(base.terrain), new THREE.MeshStandardMaterial({ color: '#697c72', roughness: 1, side: THREE.DoubleSide })));
  const water = new THREE.Mesh(waterGeometry(base), new THREE.MeshStandardMaterial({ color: '#234d61', roughness: 0.78 }));
  scene.add(water);
  for (const [paths, colour, opacity] of [[base.shorelines, '#b9c6b4', 0.6], [base.roads, '#a7b1a7', 0.5], [base.rails, '#c7be9b', 0.7]] as const) {
    const positions: number[] = [];
    for (const path of paths) for (let i = 0; i + 5 < path.length; i += 3) positions.push(...path.slice(i, i + 6));
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity }));
    lines.position.y = 0.5; context.add(lines);
  }
  const fleet = new LiveFleet((x, z) => sampleTerrainHeight(base.terrain, x, z), base.waterLevel); scene.add(fleet.root);
  const selectedHighlight = new THREE.Group(), hoverHighlight = new THREE.Group(); scene.add(selectedHighlight, hoverHighlight);
  const vehicleRing = new THREE.Mesh(new THREE.RingGeometry(12, 16, 40), new THREE.MeshBasicMaterial({ color: '#d5f6e6', side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.95 }));
  vehicleRing.rotation.x = -Math.PI / 2; vehicleRing.renderOrder = 4; vehicleRing.visible = false; scene.add(vehicleRing);
  const loader = new CityChunkLoader(manifest), chunks = new Map<string, { chunk: BuildingChunk; mesh: THREE.Mesh; buildings: Building[] }>();
  const identities = new Map<string, Building>();
  const pending = new Map<string, AbortController>(), failedUntil = new Map<string, number>();
  let wanted = new Set<string>(), initialLoad = true;
  const refreshContext = () => {
    for (const marker of stations.children) {
      const station = marker.userData.station as SceneStation;
      marker.visible = station.kind === 'weather' ? layers.weather : layers.airQuality;
      marker.scale.setScalar(selected?.kind === 'station' && selected.station.id === station.id && selected.station.kind === station.kind ? 1.6 : 1);
    }
    routeHighlight.visible = Boolean(route?.status === 'exact' && selected?.kind === 'vehicle'
      && route.vehicleId === selected.vehicle.id && route.routeId === selected.vehicle.routeId && !selected.removed && vehicleVisible(selected.vehicle, layers, routeFilter));
  };
  const refreshHighlights = () => {
    refreshContext();
    for (const [group, id, colour] of [[selectedHighlight, selected?.kind === 'building' ? selected.building.id : null, '#82e3be'], [hoverHighlight, hoverId, '#efd4a2']] as const) {
      disposeTree(group);
      if (!id) continue;
      for (const { chunk } of chunks.values()) {
        const positions = buildingHighlight(chunk, id);
        if (!positions.length) continue;
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const overlay = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.72,
          depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
        group.add(overlay);
      }
      group.visible = layers.buildings;
    }
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
  const updateChunks = () => {
    if (disposed || document.hidden) return;
    camera.updateMatrixWorld(); projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(projection);
    wanted = new Set(initialLoad ? manifest.initialChunkIds : visibleChunks(manifest.chunks, controls.target, camera.position.distanceTo(controls.target), frustum));
    initialLoad = false;
    callbacks.onError([...wanted].some(id => failedUntil.has(id)) ? 'Some city geometry could not load. Retrying.' : '');
    for (const [id, controller] of pending) if (!wanted.has(id)) { controller.abort(); pending.delete(id); }
    let changed = false;
    for (const [id, item] of chunks) if (!wanted.has(id)) { item.mesh.removeFromParent(); item.mesh.geometry.dispose(); (item.mesh.material as THREE.Material).dispose(); chunks.delete(id); loader.unload(id); changed = true; }
    if (changed) reportBuildings();
    for (const id of wanted) if (!chunks.has(id) && !pending.has(id) && (failedUntil.get(id) ?? 0) < Date.now()) {
      const abort = new AbortController(); pending.set(id, abort);
      void loader.load(id, abort.signal).then(result => {
        if (disposed || abort.signal.aborted || !wanted.has(id)) { loader.unload(id); return; }
        const geometry = makeChunkGeometry(result.chunk); applyBuildingColours(geometry, result.chunk, buildingColours);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }));
        mesh.userData.chunkId = id; buildings.add(mesh);
        chunks.set(id, { ...result, mesh }); result.buildings.forEach(building => identities.set(building.id, building)); reportBuildings();
        failedUntil.delete(id);
        if (![...wanted].some(id => failedUntil.has(id))) callbacks.onError('');
        callbacks.onReady();
      }).catch(error => { if (!abort.signal.aborted && !disposed) { failedUntil.set(id, Date.now() + 30_000); callbacks.onError(error instanceof Error ? error.message : 'City chunk could not be loaded'); } })
        .finally(() => { if (pending.get(id) === abort) pending.delete(id); });
    }
  };
  const preset = (id: CameraPreset) => {
    followId = null;
    const location = id === 'energy' ? [24.952913, 60.168037, 850] : id === 'city' ? [24.952, 60.1695, 1450] : id === 'harbour' ? [24.957, 60.1607, 2000] : [24.986, 60.1466, 1150];
    const [x, , z] = wgs84ToScene(location[0], location[1]);
    controls.enableDamping = false; controls.update();
    controls.target.set(x, 8, z); camera.position.set(x + location[2] * 0.48, location[2] * 0.72, z + location[2] * 0.85);
    controls.update(); controls.enableDamping = !reducedMotion; updateChunks();
  };
  const interaction = () => { followId = null; callbacks.onCameraInteraction(); };
  controls.addEventListener('start', interaction);
  const resize = () => { if (disposed) return; const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); };
  const observer = new ResizeObserver(resize); observer.observe(container); resize(); preset('city');
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  function pick(event: PointerEvent): Selection | null {
    const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const objects: THREE.Object3D[] = [...(layers.buildings ? buildings.children : []), ...[...fleet.meshes.values()].filter(mesh => mesh.visible), ...stations.children.filter(marker => marker.visible)];
    for (const hit of raycaster.intersectObjects(objects, false)) {
      const station = stationForHit(hit); if (station) return { kind: 'station', station };
      const id = fleet.idForHit(hit);
      if (id) { const vehicle = fleet.motion.tracks.get(id)?.vehicle; if (vehicle) return { kind: 'vehicle', vehicle }; }
      const chunk = chunks.get(hit.object.userData.chunkId)?.chunk;
      const buildingId = chunk && buildingIdForTriangle(chunk, hit.faceIndex);
      if (buildingId && identities.has(buildingId)) return { kind: 'building', building: identities.get(buildingId)! };
    }
    return null;
  }
  const select = (selection: Selection | null, message?: string) => { selected = selection; followId = null; refreshHighlights(); callbacks.onSelection(selection, message); };
  let down: { x: number; y: number } | null = null, hoverAt = 0;
  const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
  const pointerUp = (event: PointerEvent) => { if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5) select(pick(event)); down = null; };
  const pointerMove = (event: PointerEvent) => { if (event.buttons || performance.now() - hoverAt < 100) return; hoverAt = performance.now();
    const feature = pick(event), id = feature?.kind === 'building' ? feature.building.id : null;
    renderer.domElement.style.cursor = feature ? 'pointer' : 'grab';
    callbacks.onHover(feature?.kind === 'building' ? feature.building.gmlId : feature?.kind === 'station' ? `${feature.station.kind === 'weather' ? 'Weather' : 'Air quality'} station · ${feature.station.name}` : feature ? `${feature.vehicle.mode} · ${feature.vehicle.routeId}` : '');
    if (id !== hoverId) { hoverId = id; refreshHighlights(); } };
  const pointerLeave = () => { hoverId = null; refreshHighlights(); callbacks.onHover(''); };
  renderer.domElement.addEventListener('pointerdown', pointerDown); renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('pointermove', pointerMove); renderer.domElement.addEventListener('pointerleave', pointerLeave);
  let frames = 0, statsAt = performance.now(), chunksAt = 0;
  const animate = (now: number) => {
    if (disposed || document.hidden) return;
    frame = requestAnimationFrame(animate);
    fleet.update(Date.now(), layers, reducedMotion, routeFilter);
    if (selected?.kind === 'vehicle') {
      const latest = fleet.motion.tracks.get(selected.vehicle.id)?.vehicle;
      const position = fleet.motion.position(selected.vehicle.id, Date.now(), reducedMotion);
      if ((!latest || !position) && !selected.removed) { selected = { ...selected, removed: true }; followId = null; callbacks.onSelection(selected); }
      const height = position ? (selected.vehicle.mode === 'ferry' ? base.waterLevel : sampleTerrainHeight(base.terrain, position.x, position.z)) : null;
      vehicleRing.visible = Boolean(position && height !== null && vehicleVisible(selected.vehicle, layers, routeFilter) && !selected.removed);
      if (position) {
        if (height !== null) vehicleRing.position.set(position.x, height + 0.5, position.z);
        vehicleRing.scale.setScalar(Math.max(1, camera.position.distanceTo(controls.target) / 1800));
        if (followId) { const shift = new THREE.Vector3(position.x, controls.target.y, position.z).sub(controls.target); camera.position.add(shift); controls.target.add(shift); }
      }
    } else vehicleRing.visible = false;
    refreshContext(); controls.update(); renderer.render(scene, camera); frames++;
    if (now - chunksAt > 700) { updateChunks(); chunksAt = now; }
    if (now - statsAt >= 1500) { callbacks.onStats({ fps: Math.round(frames * 1000 / (now - statsAt)), drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, loadedChunks: chunks.size, vehicles: fleet.visibleCount,
      unplacedVehicles: fleet.unplacedCount, lastReceiptLatencyMs }); frames = 0; statsAt = now; }
  };
  const visibility = () => {
    cancelAnimationFrame(frame);
    if (document.hidden) { for (const controller of pending.values()) controller.abort(); pending.clear(); }
    else { statsAt = performance.now(); frames = 0; updateChunks(); frame = requestAnimationFrame(animate); }
  };
  document.addEventListener('visibilitychange', visibility); frame = requestAnimationFrame(animate);
  return {
    preset,
    setLayers(next: Layers) { layers = { ...next }; if (!layers.buildings) { hoverId = null; callbacks.onHover(''); } buildings.visible = layers.buildings; context.visible = layers.roads; land.visible = layers.terrain; refreshHighlights(); },
    setStations(next: SceneStation[]) {
      disposeTree(stations);
      for (const station of next) { const marker = makeStationMarker(station, base); if (marker) stations.add(marker); }
      if (selected?.kind === 'station') {
        const previous = selected.station;
        const station = next.find(station => station.id === previous.id && station.kind === previous.kind);
        if (station) { selected = { kind: 'station', station }; callbacks.onSelection(selected); }
      }
      refreshContext();
    },
    setRoute(next: RouteContext | null) {
      route = next; disposeTree(routeHighlight);
      if (next?.status === 'exact') {
        const ferry = selected?.kind === 'vehicle' && selected.vehicle.mode === 'ferry';
        routeHighlight.add(new THREE.LineSegments(routeGeometry(next, base, ferry), new THREE.LineBasicMaterial({ color: '#9cf4cf', transparent: true, opacity: 0.9 })));
        for (const stop of next.stops) {
          const [x, , z] = wgs84ToScene(stop.longitude, stop.latitude), height = sampleTerrainHeight(base.terrain, x, z);
          if (height === null && !ferry) continue;
          const marker = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 6), new THREE.MeshBasicMaterial({ color: '#e1ffee' }));
          marker.position.set(x, (height ?? base.waterLevel) + 5, z); routeHighlight.add(marker);
        }
      }
      refreshContext();
    },
    setBuildingColours(next: ReadonlyMap<string, string>) { buildingColours = next; for (const { chunk, mesh } of chunks.values()) applyBuildingColours(mesh.geometry, chunk, next); },
    setRouteFilter(next: string | null) { routeFilter = next; refreshContext(); },
    setTraffic(snapshot: TrafficSnapshot) {
      const now = Date.now(); fleet.setVehicles(snapshot.vehicles);
      const receipts = snapshot.vehicles.map(vehicle => Date.parse(vehicle.receivedAt)).filter(at => Number.isFinite(at));
      lastReceiptLatencyMs = receipts.length ? Math.max(0, now - Math.max(...receipts)) : null;
      if (selected?.kind === 'vehicle') { const selectedId = selected.vehicle.id; const vehicle = snapshot.vehicles.find(vehicle => vehicle.id === selectedId);
        selected = vehicle ? { kind: 'vehicle', vehicle, removed: now - Date.parse(vehicle.reportedAt) >= TRAFFIC_REMOVE_MS } : { ...selected, removed: true };
        if (selected.removed) followId = null; callbacks.onSelection(selected); }
    },
    select(selection: Selection | null) {
      if (selection?.kind === 'building') {
        const building = selection.building;
        if (!manifest.chunks.some(chunk => chunk.id === building.chunkRef)) { select(null, 'This building is outside the available city coverage.'); return; }
        identities.set(building.id, building); select(selection);
        const [x, , z] = wgs84ToScene(building.longitude, building.latitude);
        const offset = camera.position.clone().sub(controls.target); controls.target.set(x, sampleTerrainHeight(base.terrain, x, z) ?? 0, z);
        camera.position.copy(controls.target).add(offset); controls.update(); updateChunks();
      } else if (selection?.kind === 'vehicle') {
        const vehicle = fleet.motion.tracks.get(selection.vehicle.id)?.vehicle;
        if (vehicle) select({ kind: 'vehicle', vehicle });
      } else select(selection);
    },
    selectStation(id: string) {
      const station = stations.children.map(marker => marker.userData.station as SceneStation).find(station => station.id === id);
      if (station) select({ kind: 'station', station });
    },
    selectBuilding(id: string) {
      const building = identities.get(id);
      if (!building || !manifest.chunks.some(chunk => chunk.id === building.chunkRef)) { select(null, 'This building is outside the available city coverage.'); return; }
      select({ kind: 'building', building });
      const [x, , z] = wgs84ToScene(building.longitude, building.latitude);
      const offset = camera.position.clone().sub(controls.target); controls.target.set(x, sampleTerrainHeight(base.terrain, x, z) ?? 0, z);
      camera.position.copy(controls.target).add(offset); controls.update(); updateChunks();
    },
    selectVehicle(id: string) { const vehicle = fleet.motion.tracks.get(id)?.vehicle; if (vehicle) select({ kind: 'vehicle', vehicle }); },
    followVehicle(id: string | null) { followId = id; },
    clearSelection() { select(null); },
    dispose() {
      if (disposed) return; disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility); reducedQuery.removeEventListener('change', motionChange);
      renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointermove', pointerMove); renderer.domElement.removeEventListener('pointerleave', pointerLeave);
      controls.removeEventListener('start', interaction); controls.dispose();
      for (const controller of pending.values()) controller.abort(); pending.clear(); loader.dispose();
      fleet.root.removeFromParent(); fleet.dispose(); disposeTree(scene); chunks.clear(); identities.clear(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    }
  };
}
