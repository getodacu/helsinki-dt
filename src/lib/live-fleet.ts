import type { RailCategory } from './rail.ts';
import * as THREE from 'three';
import { wgs84ToScene } from './geo.ts';
import type { TransitMode, Vehicle } from './types.ts';
import { trafficIsStale, trafficShouldRemove } from './traffic.ts';
import { marineHeading, MARINE_BUFFER_MS, MARINE_GAP_MS, MARINE_MAX_DISTANCE_METRES, MARINE_MAX_SPEED_METRES_PER_SECOND, MARINE_MAX_POINTS } from './marine.ts';
import { parseVehicleModel, disposeVehicleModel, type VehicleModel } from './vehicle-models.ts';

export const MODE_COLOURS = { tram: '#49b69d', bus: '#dfa96b', ferry: '#66a9d0', train: '#b29bd8', ship: '#79cbd7' };
export const VEHICLE_DISPLAY_SCALE = 1;
export function vehicleVisible(vehicle: Pick<Vehicle, 'mode' | 'routeId' | 'rail'>, modes: Record<TransitMode, boolean> & Partial<Record<RailCategory, boolean>>, routeId: string | null = null): boolean {
  return modes[vehicle.mode] && (vehicle.mode !== 'train' || modes[vehicle.rail?.category ?? 'other'] !== false) && (vehicle.mode === 'ship' || routeId === null || vehicle.routeId === routeId);
}
const BUFFER_MS = 1_200;
const GAP_MS = 10_000;
type Position = { x: number; z: number; heading: number | null; at: number };
type Track = { vehicle: Vehicle; positions: Position[] };

/** A small report-time buffer; its last position is a hard stop, never a prediction. */
export class ReceivedPositions {
  tracks = new Map<string, Track>();
  upsert(vehicle: Vehicle) {
    const at = Date.parse(vehicle.reportedAt);
    const ship = vehicle.mode === 'ship';
    if (ship && vehicle.marine?.positionSecond === 63) return;
    if (vehicle.longitude === null || vehicle.latitude === null || !Number.isFinite(at)
      || !Number.isFinite(vehicle.longitude) || !Number.isFinite(vehicle.latitude)
      || Math.abs(vehicle.longitude) > 180 || Math.abs(vehicle.latitude) > 90) return;
    const old = this.tracks.get(vehicle.id);
    const last = old?.positions.at(-1);
    if (last && at < last.at) return;
    if (last && at === last.at) {
      if (ship) {
        const [x, , z] = wgs84ToScene(vehicle.longitude, vehicle.latitude), heading = marineHeading(vehicle);
        const newConflict = vehicle.quality.includes('position-same-second-conflict') && !old!.vehicle.quality.includes('position-same-second-conflict');
        if (x !== last.x || z !== last.z || heading !== last.heading || newConflict) old!.positions = [{ x, z, heading, at }];
      }
      old!.vehicle = vehicle;
      return;
    }
    const [x, , z] = wgs84ToScene(vehicle.longitude, vehicle.latitude);
    const movement = last ? Math.hypot(x - last.x, z - last.z) : 0;
    const bearing = vehicle.mode === 'train' && last && movement >= 3 ? (Math.atan2(x - last.x, last.z - z) * 180 / Math.PI + 360) % 360 : null;
    const next = { x, z, heading: ship ? marineHeading(vehicle) : vehicle.headingDegrees ?? bearing ?? last?.heading ?? 0, at };
    const distance = last ? Math.hypot(next.x - last.x, next.z - last.z) : 0;
    const gap = last ? at - last.at : 0;
    const train = vehicle.mode === 'train';
    const sameSecond = ship && last && old?.vehicle.marine?.positionSource !== vehicle.marine?.positionSource && Math.floor(at / 1000) === Math.floor(last.at / 1000);
    const snap = gap > (ship ? MARINE_GAP_MS : train ? 25_000 : GAP_MS)
      || distance > (ship ? MARINE_MAX_DISTANCE_METRES : train ? 1500 : 200)
      || (gap > 0 && distance / (gap / 1000) > (ship ? MARINE_MAX_SPEED_METRES_PER_SECOND : train ? 100 : 60))
      || (ship && (sameSecond || vehicle.quality.includes('position-same-second-conflict')));
    if (ship && gap > 0 && gap <= MARINE_GAP_MS && !sameSecond && distance / (gap / 1000) > MARINE_MAX_SPEED_METRES_PER_SECOND) {
      vehicle = { ...vehicle, quality: [...new Set([...vehicle.quality, 'position-implausible-motion'])] };
    }
    if (train && bearing !== null && old?.positions.length === 1 && !snap) old.positions[0].heading = bearing;
    if (train && snap) next.heading = last?.heading ?? 0;
    const history = [...(old?.positions ?? []), next];
    this.tracks.set(vehicle.id, { vehicle, positions: snap ? [next] : train || ship
      ? history.filter((point, index) => point.at >= at - (ship ? MARINE_GAP_MS : 25_000) || (history[index + 1]?.at ?? 0) >= at - (ship ? MARINE_GAP_MS : 25_000)).slice(-(ship ? MARINE_MAX_POINTS : 64))
      : history.slice(-5) });
  }
  setSnapshot(vehicles: Vehicle[]) {
    const ids = new Set(vehicles.map(vehicle => vehicle.id));
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
    for (const vehicle of vehicles) this.upsert(vehicle);
  }
  position(id: string, now: number, reducedMotion = false): Position | null {
    const track = this.tracks.get(id), positions = track?.positions;
    const last = positions?.at(-1);
    if (!positions || !last || !track || trafficShouldRemove(track.vehicle, now)) return null;
    if (reducedMotion || trafficIsStale(track.vehicle, now) || positions.length === 1) return last;
    const time = now - (track.vehicle.mode === 'ship' ? MARINE_BUFFER_MS : track.vehicle.mode === 'train' ? 12_000 : BUFFER_MS);
    if (time >= last.at) return last;
    if (time <= positions[0].at) return positions[0];
    const index = positions.findIndex(position => position.at >= time);
    const a = positions[index - 1], b = positions[index];
    const t = Math.max(0, Math.min(1, (time - a.at) / (b.at - a.at)));
    const heading = a.heading === null || b.heading === null ? null : a.heading + (((b.heading - a.heading + 540) % 360) - 180) * t;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
      heading, at: time };
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
  private shipDirection: THREE.InstancedMesh | null = null;
  private shipDirectionGeometry = new THREE.ConeGeometry(2.2, 5, 3).rotateX(-Math.PI / 2).translate(0, 2.5, -2);
  private shipDirectionMaterial = new THREE.MeshBasicMaterial({ color: '#ecffff' });
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
    this.models.set('ship', { geometry: new THREE.CylinderGeometry(7, 7, 2, 16).translate(0, 1, 0),
      materials: [new THREE.MeshStandardMaterial({ color: MODE_COLOURS.ship, roughness: .65 })], roofHeight: 3 });
  }
  async loadModels(urls: Record<Exclude<TransitMode, 'ship'>, string>, onError: (message: string) => void) {
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
  update(now: number, modes: Record<TransitMode, boolean>, reducedMotion: boolean, routeId: string | null = null, marinePaused = false) {
    if (this.disposed) return;
    this.visibleCount = 0; this.unplacedCount = 0; this.placements.clear();
    // Showing the latest fix retires earlier points so resuming the display delay cannot rewind it.
    if (marinePaused || reducedMotion) for (const track of this.motion.tracks.values()) {
      if (track.vehicle.mode === 'ship' && track.positions.length > 1) track.positions = track.positions.slice(-1);
    }
    for (const mode of ['tram', 'bus', 'ferry', 'train', 'ship'] as const) {
      const entries: { id: string; position: Position; height: number; stale: boolean }[] = [];
      for (const [id, track] of this.motion.tracks) {
        if (track.vehicle.mode !== mode || !vehicleVisible(track.vehicle, modes, routeId)) continue;
        const position = this.motion.position(id, now, reducedMotion || (mode === 'ship' && marinePaused));
        if (!position) continue;
        const height = mode === 'ferry' || mode === 'ship' ? this.waterHeight : this.groundHeight(position.x, position.z);
        if (height === null) { this.unplacedCount++; continue; }
        entries.push({ id, position, height, stale: trafficIsStale(track.vehicle, now) });
      }
      const mesh = this.mesh(mode, entries.length);
      if (mode === 'ship' && (!this.shipDirection || this.shipDirection.instanceMatrix.count < mesh.instanceMatrix.count)) {
        this.shipDirection?.removeFromParent(); this.shipDirection?.dispose();
        this.shipDirection = new THREE.InstancedMesh(this.shipDirectionGeometry, this.shipDirectionMaterial, mesh.instanceMatrix.count);
        this.shipDirection.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.shipDirection.frustumCulled = false;
        this.root.add(this.shipDirection);
      }
      if (mode === 'ship' && this.shipDirection) { this.shipDirection.count = entries.length; this.shipDirection.visible = modes.ship; }
      mesh.count = entries.length; mesh.visible = modes[mode];
      this.instanceIds.set(mode, entries.map(entry => entry.id));
      entries.forEach((entry, index) => {
        const y = entry.height + (mode === 'ferry' || mode === 'ship' ? 0 : .08);
        this.dummy.position.set(entry.position.x, y, entry.position.z);
        this.dummy.rotation.set(0, -(entry.position.heading ?? 0) * Math.PI / 180, 0);
        this.dummy.scale.setScalar(VEHICLE_DISPLAY_SCALE); this.dummy.updateMatrix();
        mesh.setMatrixAt(index, this.dummy.matrix);
        mesh.setColorAt(index, new THREE.Color().setScalar(entry.stale ? .4 : 1));
        if (mode === 'ship' && this.shipDirection) {
          this.dummy.scale.setScalar(entry.position.heading === null ? 0 : VEHICLE_DISPLAY_SCALE); this.dummy.updateMatrix();
          this.shipDirection.setMatrixAt(index, this.dummy.matrix);
          this.shipDirection.setColorAt(index, new THREE.Color().setScalar(entry.stale ? .4 : 1));
        }
        this.placements.set(entry.id, { vehicle: this.motion.tracks.get(entry.id)!.vehicle, x: entry.position.x, y,
          z: entry.position.z, roofHeight: this.models.get(mode)!.roofHeight, stale: entry.stale });
      });
      if (mode === 'ship' && this.shipDirection) {
        this.shipDirection.instanceMatrix.needsUpdate = true;
        if (this.shipDirection.instanceColor) this.shipDirection.instanceColor.needsUpdate = true;
      }
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
    this.shipDirection?.dispose(); this.shipDirectionGeometry.dispose(); this.shipDirectionMaterial.dispose(); this.shipDirection = null;
    for (const model of this.models.values()) disposeVehicleModel(model);
    this.models.clear(); this.placements.clear();
    this.meshes.clear(); this.instanceIds.clear(); this.motion.tracks.clear(); this.root.clear();
  }
}
