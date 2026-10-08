import * as THREE from 'three';
import { wgs84ToScene } from './geo.ts';
import type { TransitMode, Vehicle } from './types.ts';
import { TRAFFIC_STALE_MS, TRAFFIC_REMOVE_MS } from './traffic.ts';

export const MODE_COLOURS = { tram: '#49b69d', bus: '#dfa96b', ferry: '#66a9d0' };
export const VEHICLE_DISPLAY_SCALE = 2;
export function vehicleVisible(vehicle: Pick<Vehicle, 'mode' | 'routeId'>, modes: Record<TransitMode, boolean>, routeId: string | null = null): boolean {
  return modes[vehicle.mode] && (routeId === null || vehicle.routeId === routeId);
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
    const next = { x, z, heading: vehicle.headingDegrees ?? last?.heading ?? 0, at };
    const distance = last ? Math.hypot(next.x - last.x, next.z - last.z) : 0;
    const gap = last ? at - last.at : 0;
    const snap = gap > GAP_MS || distance > 200 || (gap > 0 && distance / (gap / 1000) > 60);
    this.tracks.set(vehicle.id, { vehicle, positions: snap ? [next] : [...(old?.positions ?? []), next].slice(-5) });
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
    const time = now - BUFFER_MS;
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

export class LiveFleet {
  root = new THREE.Group();
  motion = new ReceivedPositions();
  meshes = new Map<TransitMode, THREE.InstancedMesh>();
  instanceIds = new Map<TransitMode, string[]>();
  visibleCount = 0;
  unplacedCount = 0;
  private dummy = new THREE.Object3D();
  private groundHeight: (x: number, z: number) => number | null;
  private waterHeight: number;
  constructor(groundHeight: (x: number, z: number) => number | null, waterHeight = 0) {
    this.groundHeight = groundHeight; this.waterHeight = waterHeight;
  }
  setVehicles(vehicles: Vehicle[]) { this.motion.setSnapshot(vehicles); }
  private mesh(mode: TransitMode, size: number) {
    let mesh = this.meshes.get(mode);
    if (!mesh || mesh.instanceMatrix.count < size) {
      if (mesh) { mesh.removeFromParent(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose(); }
      const dimensions = mode === 'tram' ? [2.5, 3.4, 26] : mode === 'bus' ? [2.5, 3.2, 12] : [8, 5, 30];
      mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(...dimensions as [number, number, number]),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65 }), Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(size, 1)))));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // ponytail: moving instances span the release; add spatial fleet batches if fleet draw becomes a measured bottleneck.
      mesh.frustumCulled = false;
      mesh.userData.mode = mode;
      this.meshes.set(mode, mesh); this.root.add(mesh);
    }
    return mesh;
  }
  update(now: number, modes: Record<TransitMode, boolean>, reducedMotion: boolean, routeId: string | null = null) {
    this.visibleCount = 0; this.unplacedCount = 0;
    for (const mode of ['tram', 'bus', 'ferry'] as const) {
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
        const height = mode === 'ferry' ? 5 : mode === 'tram' ? 3.4 : 3.2;
        this.dummy.position.set(entry.position.x, entry.height + height * VEHICLE_DISPLAY_SCALE / 2 + 0.3, entry.position.z);
        this.dummy.rotation.set(0, -entry.position.heading * Math.PI / 180, 0);
        this.dummy.scale.setScalar(VEHICLE_DISPLAY_SCALE); this.dummy.updateMatrix();
        mesh.setMatrixAt(index, this.dummy.matrix);
        mesh.setColorAt(index, new THREE.Color(MODE_COLOURS[mode]).multiplyScalar(entry.stale ? 0.4 : 1));
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
    for (const mesh of this.meshes.values()) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose(); }
    this.meshes.clear(); this.instanceIds.clear(); this.motion.tracks.clear(); this.root.clear();
  }
}
