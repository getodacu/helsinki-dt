import * as THREE from 'three';
import { inBounds, RELEASE_BOUNDS } from './area.ts';
import { sampleTerrainHeight, type CityBase } from './city-assets.ts';
import { wgs84ToScene } from './geo.ts';
import type { SceneStation } from './scene.ts';

const WIDTH = 44, HEIGHT = 48, POLE = 26;
const key = (station: SceneStation) => `${station.kind}:${station.id}`;
const stationLabel = (station: SceneStation) => `${station.kind === 'weather' ? 'Weather' : station.kind === 'rail' ? 'Railway' : 'Air quality'} station · ${station.name}`;
const icons = {
  rail: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 10h14M8 18l-2 3M16 18l2 3M8 14h1M15 14h1"/>',
  weather: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M1 8h2M3 3l1.5 1.5M13 3l-1.5 1.5M3 13l1.5-1.5M8 19h10a4 4 0 0 0 .5-8 5 5 0 0 0-9.5 1A3.5 3.5 0 0 0 8 19Z"/>',
  'air-quality': '<path d="M2 8h13a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M2 16h6a3 3 0 1 1-3 3"/>'
};

/** Screen-sized signs put the foot of each pole at the actual station location. */
export function projectStationFlags(stations: readonly SceneStation[], base: CityBase, camera: THREE.Camera, width: number, height: number) {
  const point = new THREE.Vector3(), flags: { station: SceneStation; x: number; y: number }[] = [];
  for (const station of stations) {
    if (!station.id || !inBounds(station.longitude, station.latitude, RELEASE_BOUNDS)) continue;
    const [x, , z] = wgs84ToScene(station.longitude, station.latitude), elevation = sampleTerrainHeight(base.terrain, x, z);
    if (elevation === null) continue;
    point.set(x, elevation + .5, z).project(camera);
    if (point.z < -1 || point.z > 1) continue;
    const screenX = (point.x + 1) * width / 2, screenY = (1 - point.y) * height / 2;
    if (screenX < WIDTH / 2 || screenX > width - WIDTH / 2 || screenY < HEIGHT + POLE || screenY > height) continue;
    flags.push({ station, x: screenX, y: screenY });
  }
  return flags;
}

export class StationFlags {
  private root = document.createElement('div');
  private buttons = new Map<string, HTMLButtonElement>();
  private stations: SceneStation[] = [];
  private base: CityBase;
  private onSelect: (station: SceneStation) => void;
  private onHover: (label: string) => void;
  constructor(container: HTMLElement, base: CityBase, onSelect: (station: SceneStation) => void, onHover: (label: string) => void) {
    this.base = base; this.onSelect = onSelect; this.onHover = onHover;
    this.root.className = 'station-flags'; container.append(this.root);
  }
  setStations(stations: SceneStation[]) { this.stations = stations; }
  update(camera: THREE.Camera, width: number, height: number, selected: SceneStation | null = null) {
    const flags = projectStationFlags(this.stations, this.base, camera, width, height);
    const visible = new Set(flags.map(flag => key(flag.station)));
    for (const [id, button] of this.buttons) if (!visible.has(id)) { button.remove(); this.buttons.delete(id); }
    for (const { station, x, y } of flags) {
      const id = key(station);
      let button = this.buttons.get(id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
        button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[station.kind]}</svg><small>${station.kind === 'weather' ? 'Weather' : station.kind === 'rail' ? 'Rail' : 'Air'}</small>`;
        button.onclick = () => { const current = this.stations.find(item => key(item) === id); if (current) this.onSelect(current); };
        button.onpointerenter = () => { const current = this.stations.find(item => key(item) === id); if (current) this.onHover(stationLabel(current)); };
        button.onpointerleave = () => this.onHover('');
        this.root.append(button); this.buttons.set(id, button);
      }
      button.className = `station-flag ${station.kind}${selected && key(selected) === id ? ' selected' : ''}`;
      button.style.transform = `translate3d(${x}px,${y - POLE}px,0) translate(-50%,-100%)`;
      button.title = stationLabel(station); button.setAttribute('aria-label', button.title);
    }
  }
  dispose() { this.root.remove(); this.buttons.clear(); this.stations = []; }
}
