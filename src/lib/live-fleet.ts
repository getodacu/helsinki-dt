import type { RailCategory } from './rail.ts';
import * as THREE from 'three';
import { wgs84ToScene } from './geo.ts';
import type { TransitMode, Vehicle } from './types.ts';
import { TRAFFIC_STALE_MS, TRAFFIC_REMOVE_MS } from './traffic.ts';
import { parseVehicleModel, disposeVehicleModel, type VehicleModel } from './vehicle-models.ts';

export const MODE_COLOURS = { tram: '#49b69d', bus: '#dfa96b', ferry: '#66a9d0', train: '#b29bd8' };
export const VEHICLE_DISPLAY_SCALE = 1;
export function vehicleVisible(vehicle: Pick<Vehicle, 'mode' | 'routeId' | 'rail'>, modes: Record<TransitMode, boolean> & Partial<Record<RailCategory, boolean>>, routeId: string | null = null): boolean {
  return modes[vehicle.mode] && (vehicle.mode !== 'train' || modes[vehicle.rail?.category ?? 'other'] !== false) && (routeId === null || vehicle.routeId === routeId);
}
const BUFFER_MS = 1_200;
const GAP_MS = 10_000;
type Position = { x: number; z: number; heading: number; at: number };
type Track = { vehicle: Vehicle; positions: Position[] };

/** A small report-time buffer; its last position is a hard stop, never a prediction. */
export class ReceivedPositions {
  tracks = new Map<string, Track>();
  upsert(vehicle: Vehicle) {
    const at = Date.parse(vehicle.reportedAt);
    if (vehicle.longitude === null || vehicle.latitude === null || !Number.isFinite(at)
      || !Number.isFinite(vehicle.longitude) || !Number.isFinite(vehicle.latitude)
      || Math.abs(vehicle.longitude) > 180 || Math.abs(vehicle.latitude) > 90) return;
    const old = this.tracks.get(vehicle.id);
    const last = old?.positions.at(-1);
    if (last && at < last.at) return;
    if (last && at === last.at) { old!.vehicle = vehicle; return; }
    const [x, , z] = wgs84ToScene(vehicle.longitude, vehicle.latitude);
    const movement = last ? Math.hypot(x - last.x, z - last.z) : 0;
    const bearing = vehicle.mode === 'train' && last && movement >= 3 ? (Math.atan2(x - last.x, last.z - z) * 180 / Math.PI + 360) % 360 : null;
    const next = { x, z, heading: vehicle.headingDegrees ?? bearing ?? last?.heading ?? 0, at };
    const distance = last ? Math.hypot(next.x - last.x, next.z - last.z) : 0;
    const gap = last ? at - last.at : 0;
    const train = vehicle.mode === 'train';
    const snap = gap > (train ? 25_000 : GAP_MS) || distance > (train ? 1500 : 200) || (gap > 0 && distance / (gap / 1000) > (train ? 100 : 60));
    if (train && bearing !== null && old?.positions.length === 1 && !snap) old.positions[0].heading = bearing;
    if (train && snap) next.heading = last?.heading ?? 0;
    const history = [...(old?.positions ?? []), next];
    this.tracks.set(vehicle.id, { vehicle, positions: snap ? [next] : train
      ? history.filter((point, index) => point.at >= at - 25_000 || (history[index + 1]?.at ?? 0) >= at - 25_000).slice(-64)
      : history.slice(-5) });
  }
  setSnapshot(vehicles: Vehicle[]) {
    const ids = new Set(vehicles.map(vehicle => vehicle.id));
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
    for (const vehicle of vehicles) this.upsert(vehicle);
  }
  position(id: string, now: number, reducedMotion = false): Position | null {
    const positions = this.tracks.get(id)?.positions;
    const last = positions?.at(-1);
    if (!positions || !last || now - last.at >= TRAFFIC_REMOVE_MS) return null;
    if (reducedMotion || now - last.at >= TRAFFIC_STALE_MS || positions.length === 1) return last;
    const time = now - (this.tracks.get(id)?.vehicle.mode === 'train' ? 12_000 : BUFFER_MS);
    if (time >= last.at) return last;
    if (time <= positions[0].at) return positions[0];
    const index = positions.findIndex(position => position.at >= time);
    const a = positions[index - 1], b = positions[index];
    const t = Math.max(0, Math.min(1, (time - a.at) / (b.at - a.at)));
    const headingDelta = ((b.heading - a.heading + 540) % 360) - 180;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
      heading: a.heading + headingDelta * t, at: time };
  }
}

export type VehiclePlacement = { vehicle: Vehicle; x: number; y: number; z: number; roofHeight: number; stale: boolean };

export class LiveFleet {
  root = new THREE.Group();
  motion = new ReceivedPositions();
  meshes = new Map<TransitMode, THREE.InstancedMesh>();
  instanceIds = new Map<TransitMode, string[]>();
  placements = new Map<string, VehiclePlacement>();
  private models = new Map<TransitMode, VehicleModel>();
  private loadAbort = new AbortController();
  private disposed = false;
  visibleCount = 0;
  unplacedCount = 0;
  private dummy = new THREE.Object3D();
  private groundHeight: (x: number, z: number) => number | null;
  private waterHeight: number;
  constructor(groundHeight: (x: number, z: number) => number | null, waterHeight = 0) {
    this.groundHeight = groundHeight; this.waterHeight = waterHeight;
    for (const mode of ['tram', 'bus', 'ferry', 'train'] as const) {
      const [width, height, length] = mode === 'tram' ? [2.4, 3.8, 27.6] : mode === 'bus' ? [2.5, 3.3, 12] : mode === 'train' ? [2.9, 4.1, 44] : [9, 7.8, 36];
      const roofHeight = mode === 'ferry' ? height - 1.7 : height;
      this.models.set(mode, { geometry: new THREE.BoxGeometry(width, height, length).translate(0, roofHeight - height / 2, 0),
        materials: [new THREE.MeshStandardMaterial({ color: MODE_COLOURS[mode], roughness: .65 })], roofHeight });
    }
  }
  async loadModels(urls: Record<TransitMode, string>, onError: (message: string) => void) {
    await Promise.all((['tram', 'bus', 'ferry', 'train'] as const).map(async mode => {
      try {
        const response = await fetch(urls[mode], { signal: AbortSignal.any([this.loadAbort.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 2 * 1024 ** 2) throw new Error('Model exceeds byte budget');
        const model = await parseVehicleModel(bytes);
        this.setModel(mode, model);
      } catch (error) {
        if (!this.disposed) onError(`${mode[0].toUpperCase() + mode.slice(1)} model unavailable; showing a simple marker. ${error instanceof Error ? error.message : ''}`);
      }
    }));
  }
  setModel(mode: TransitMode, model: VehicleModel) {
    if (this.disposed) { disposeVehicleModel(model); return; }
    const mesh = this.meshes.get(mode);
    if (mesh) { mesh.removeFromParent(); mesh.dispose(); this.meshes.delete(mode); }
    disposeVehicleModel(this.models.get(mode)!);
    this.models.set(mode, model);
  }
  setVehicles(vehicles: Vehicle[]) { this.motion.setSnapshot(vehicles); }
  private mesh(mode: TransitMode, size: number) {
    let mesh = this.meshes.get(mode);
    if (!mesh || mesh.instanceMatrix.count < size) {
      if (mesh) { mesh.removeFromParent(); mesh.dispose(); }
      const model = this.models.get(mode)!;
      mesh = new THREE.InstancedMesh(model.geometry, model.materials.length === 1 ? model.materials[0] : model.materials, Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(size, 1)))));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // shortcut: moving instances span the release, add spatial batches if fleet drawing becomes a measured bottleneck.
      mesh.frustumCulled = false;
      mesh.userData.mode = mode;
      this.meshes.set(mode, mesh); this.root.add(mesh);
    }
    return mesh;
  }
  update(now: number, modes: Record<TransitMode, boolean>, reducedMotion: boolean, routeId: string | null = null) {
    if (this.disposed) return;
    this.visibleCount = 0; this.unplacedCount = 0; this.placements.clear();
    for (const mode of ['tram', 'bus', 'ferry', 'train'] as const) {
      const entries: { id: string; position: Position; height: number; stale: boolean }[] = [];
      for (const [id, track] of this.motion.tracks) {
        if (track.vehicle.mode !== mode || !vehicleVisible(track.vehicle, modes, routeId)) continue;
        const position = this.motion.position(id, now, reducedMotion);
        if (!position) continue;
        const height = mode === 'ferry' ? this.waterHeight : this.groundHeight(position.x, position.z);
        if (height === null) { this.unplacedCount++; continue; }
        entries.push({ id, position, height, stale: now - Date.parse(track.vehicle.reportedAt) >= TRAFFIC_STALE_MS });
      }
      const mesh = this.mesh(mode, entries.length);
      mesh.count = entries.length; mesh.visible = modes[mode];
      this.instanceIds.set(mode, entries.map(entry => entry.id));
      entries.forEach((entry, index) => {
        const y = entry.height + (mode === 'ferry' ? 0 : .08);
        this.dummy.position.set(entry.position.x, y, entry.position.z);
        this.dummy.rotation.set(0, -entry.position.heading * Math.PI / 180, 0);
        this.dummy.scale.setScalar(VEHICLE_DISPLAY_SCALE); this.dummy.updateMatrix();
        mesh.setMatrixAt(index, this.dummy.matrix);
        mesh.setColorAt(index, new THREE.Color().setScalar(entry.stale ? .4 : 1));
        this.placements.set(entry.id, { vehicle: this.motion.tracks.get(entry.id)!.vehicle, x: entry.position.x, y,
          z: entry.position.z, roofHeight: this.models.get(mode)!.roofHeight, stale: entry.stale });
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.visibleCount += entries.length;
    }
  }
  idForHit(hit: Pick<THREE.Intersection, 'object' | 'instanceId'>): string | null {
    return hit.instanceId == null ? null : this.instanceIds.get(hit.object.userData.mode)?.[hit.instanceId] ?? null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.loadAbort.abort();
    for (const mesh of this.meshes.values()) mesh.dispose();
    for (const model of this.models.values()) disposeVehicleModel(model);
    this.models.clear(); this.placements.clear();
    this.meshes.clear(); this.instanceIds.clear(); this.motion.tracks.clear(); this.root.clear();
  }
}
