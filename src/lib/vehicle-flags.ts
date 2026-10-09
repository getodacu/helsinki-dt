import { vehicleSourceLabel } from './inspection.ts';
import { vehicleLabel } from './rail.ts';
import * as THREE from 'three';
import { MODE_COLOURS, type VehiclePlacement } from './live-fleet.ts';
import type { RouteCatalog } from './route-context.ts';
import type { TransitMode, Vehicle } from './types.ts';

const WIDTH = 44, HEIGHT = 48, POLE = 14, MAX_FLAGS = 80;
const icons: Record<TransitMode, string> = {
  bus: '<rect x="5" y="3" width="14" height="17" rx="3"/><path d="M5 11h14M9 3v8M8 15h1M15 15h1M7 20v2M17 20v2"/>',
  tram: '<rect x="5" y="6" width="14" height="13" rx="2"/><path d="m9 6 3-4 3 4M5 12h14M12 6v6M8 16h1M15 16h1M8 19l-2 3M16 19l2 3"/>',
  train: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 10h14M8 18l-2 3M16 18l2 3M8 14h1M15 14h1"/>',
  ferry: '<path d="M6 12V6h12v6M9 6V3h6v3M9 9h1M14 9h1M3 12h18l-3 7H6Z M3 22l3-2 3 2 3-2 3 2 3-2 3 2"/>',
  ship: '<path d="M4 12V8h6v4M7 8V4h3M10 12V9h4v3M14 12V9h5v3M2 12h20l-4 7H6Z M3 22l3-2 3 2 3-2 3 2 3-2 3 2"/>'
};
type Flag = { placement: VehiclePlacement; x: number; y: number; distance: number };

/** Screen-sized banners stay legible without enlarging the actual vehicles. */
export function projectVehicleFlags(placements: Iterable<VehiclePlacement>, camera: THREE.Camera,
  width: number, height: number, selectedId: string | null = null, hoveredId: string | null = null): Flag[] {
  const point = new THREE.Vector3(), candidates: Flag[] = [];
  for (const placement of placements) {
    point.set(placement.x, placement.y + placement.roofHeight + .5, placement.z);
    const distance = point.distanceToSquared(camera.position);
    point.project(camera);
    if (point.z < -1 || point.z > 1) continue;
    const x = (point.x + 1) * width / 2, y = (1 - point.y) * height / 2;
    if (x < WIDTH / 2 || x > width - WIDTH / 2 || y < HEIGHT + POLE || y > height) continue;
    candidates.push({ placement, x, y, distance });
  }
  const priority = (id: string) => id === selectedId ? 0 : id === hoveredId ? 1 : 2;
  candidates.sort((a, b) => priority(a.placement.vehicle.id) - priority(b.placement.vehicle.id) || a.distance - b.distance);
  const visible: Flag[] = [];
  for (const flag of candidates) {
    if (visible.some(other => Math.abs(flag.x - other.x) < WIDTH + 4 && Math.abs(flag.y - other.y) < HEIGHT + POLE + 4)) continue;
    visible.push(flag);
    if (visible.length === MAX_FLAGS) break;
  }
  return visible;
}

export class VehicleFlags {
  private root = document.createElement('div');
  private buttons = new Map<string, HTMLButtonElement>();
  private routeLabels = new Map<string, string>();
  private onSelect: (vehicle: Vehicle) => void;
  private onHover: (id: string | null, label: string) => void;
  constructor(container: HTMLElement, onSelect: (vehicle: Vehicle) => void,
    onHover: (id: string | null, label: string) => void) {
    this.onSelect = onSelect; this.onHover = onHover;
    this.root.className = 'vehicle-flags'; container.append(this.root);
  }
  setRoutes(routes: RouteCatalog['routes']) { this.routeLabels = new Map(routes.map(route => [route.routeId, route.label])); }
  update(placements: ReadonlyMap<string, VehiclePlacement>, camera: THREE.Camera, width: number, height: number,
    selectedId: string | null = null, hoveredId: string | null = null) {
    const flags = projectVehicleFlags(placements.values(), camera, width, height, selectedId, hoveredId);
    const visible = new Set(flags.map(flag => flag.placement.vehicle.id));
    for (const [id, button] of this.buttons) if (!visible.has(id)) { button.remove(); this.buttons.delete(id); }
    for (const { placement, x, y } of flags) {
      const { vehicle, stale } = placement, publicLabel = this.routeLabels.get(vehicle.routeId ?? ''), line = vehicleLabel(vehicle, publicLabel);
      let button = this.buttons.get(vehicle.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></svg><strong></strong><small></small>';
        button.onclick = () => { const current = placements.get(vehicle.id); if (current) this.onSelect(current.vehicle); };
        button.onpointerenter = () => {
          const current = placements.get(vehicle.id)?.vehicle;
          if (current) this.onHover(current.id, `${current.mode} · ${vehicleLabel(current, this.routeLabels.get(current.routeId ?? ''))}`);
        };
        button.onpointerleave = () => this.onHover(null, '');
        this.root.append(button); this.buttons.set(vehicle.id, button);
      }
      if (button.dataset.mode !== vehicle.mode) {
        button.firstElementChild!.innerHTML = icons[vehicle.mode]; button.dataset.mode = vehicle.mode;
      }
      button.className = `vehicle-flag${stale ? ' stale' : ''}${selectedId === vehicle.id ? ' selected' : ''}`;
      button.style.transform = `translate3d(${x}px,${y - POLE}px,0) translate(-50%,-100%)`;
      button.style.setProperty('--flag-colour', MODE_COLOURS[vehicle.mode]);
      button.children[1].textContent = line;
      button.lastElementChild!.textContent = vehicle.mode === 'ship' ? stale ? 'AIS · stale' : 'AIS' : stale ? 'stale' : vehicle.rail?.cancelled ? 'cancelled' : vehicle.mode === 'train' && !vehicle.rail?.timetableStale && vehicle.rail?.timetableAt && Date.now() - Date.parse(vehicle.rail.timetableAt) < 60_000 && vehicle.delaySeconds != null && vehicle.delaySeconds > 60 ? `+${Math.round(vehicle.delaySeconds / 60)} min` : '';
      button.title = `${vehicleSourceLabel(vehicle)} · ${vehicle.mode === 'ship' ? '' : publicLabel ? 'Line ' : 'Route ID '}${line} · ${vehicle.id}${vehicle.rail?.destination ? ` · ${vehicle.rail.destination}` : ''}${stale ? ' · stale position' : ''}`;
      button.setAttribute('aria-label', button.title);
    }
  }
  dispose() { this.root.remove(); this.buttons.clear(); }
}
