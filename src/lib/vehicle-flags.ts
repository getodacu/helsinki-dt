import * as THREE from 'three';
import { MODE_COLOURS, type VehiclePlacement } from './live-fleet.ts';
import type { RouteCatalog } from './route-context.ts';
import type { Vehicle } from './types.ts';

const WIDTH = 58, HEIGHT = 98, MAX_FLAGS = 80;
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
    if (x < WIDTH / 2 || x > width - WIDTH / 2 || y < HEIGHT || y > height) continue;
    candidates.push({ placement, x, y, distance });
  }
  const priority = (id: string) => id === selectedId ? 0 : id === hoveredId ? 1 : 2;
  candidates.sort((a, b) => priority(a.placement.vehicle.id) - priority(b.placement.vehicle.id) || a.distance - b.distance);
  const visible: Flag[] = [];
  for (const flag of candidates) {
    if (visible.some(other => Math.abs(flag.x - other.x) < WIDTH + 4 && Math.abs(flag.y - other.y) < HEIGHT + 4)) continue;
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
      const { vehicle, stale } = placement, publicLabel = this.routeLabels.get(vehicle.routeId), line = publicLabel || vehicle.routeId;
      let button = this.buttons.get(vehicle.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
        button.append(document.createElement('strong'), document.createElement('small'));
        button.onclick = () => { const current = placements.get(vehicle.id); if (current) this.onSelect(current.vehicle); };
        button.onpointerenter = () => {
          const current = placements.get(vehicle.id)?.vehicle;
          if (current) this.onHover(current.id, `${current.mode} · ${this.routeLabels.get(current.routeId) || current.routeId}`);
        };
        button.onpointerleave = () => this.onHover(null, '');
        this.root.append(button); this.buttons.set(vehicle.id, button);
      }
      button.className = `vehicle-flag${stale ? ' stale' : ''}${selectedId === vehicle.id ? ' selected' : ''}`;
      button.style.transform = `translate3d(${x}px,${y - 26}px,0) translate(-50%,-100%)`;
      button.style.setProperty('--flag-colour', MODE_COLOURS[vehicle.mode]);
      button.firstElementChild!.textContent = line;
      (button.firstElementChild as HTMLElement).style.fontSize = line.length > 3 ? '13px' : '20px';
      button.lastElementChild!.textContent = vehicle.mode;
      button.title = `${vehicle.mode} · ${publicLabel ? 'Line' : 'Route ID'} ${line} · ${vehicle.id}${stale ? ' · stale position' : ''}`;
      button.setAttribute('aria-label', button.title);
    }
  }
  dispose() { this.root.remove(); this.buttons.clear(); }
}
