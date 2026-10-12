import { trafficCounterLocation } from './traffic-measurements.ts';
import * as THREE from 'three';
import { inBounds, RELEASE_BOUNDS } from './area.ts';
import { sampleTerrainHeight, type CityBase } from './city-assets.ts';
import { wgs84ToScene } from './geo.ts';
import type { Layers, SceneStation } from './scene.ts';

const RAIL_SIGN = { width: 44, height: 48, pole: 26 };
const ENVIRONMENT_SIGN = { width: 56, height: 60, pole: 60 };
const TRAFFIC_SIGN = { width: 44, height: 48, pole: 14 };
const signSize = (station: SceneStation) => station.kind === 'traffic-counter' ? TRAFFIC_SIGN : station.kind === 'rail' ? RAIL_SIGN : ENVIRONMENT_SIGN;
const trafficMode = (station: SceneStation) => station.trafficSummary?.mode ?? 'vehicles';
const trafficLabels = { vehicles: 'Vehicle', cycling: 'Bicycle', walking: 'Pedestrian' };

export const stationVisible = (station: SceneStation, layers: Layers) => station.kind === 'camera' || station.kind === 'port-camera' || layers[station.kind === 'traffic-counter' ? 'trafficMeasurements' : station.kind === 'rail' ? 'railStations' : station.kind === 'weather' ? 'weather' : 'airQuality'];
const key = (station: SceneStation) => `${station.kind}:${station.id}`;
const stationLabel = (station: SceneStation) => station.kind === 'traffic-counter' ? `${trafficLabels[trafficMode(station)]} counter · ${station.name} · ${station.detail ?? 'No recent reading'}` : station.kind === 'port-camera' ? `Port cameras · ${station.name}` : station.kind === 'camera' ? `Camera · ${station.name}` : `${station.kind === 'weather' ? 'Weather' : station.kind === 'rail' ? 'Railway' : 'Air quality'} station · ${station.name}`;
const icons = {
  vehicles: '<path d="M3 18a10 10 0 1 1 18 0M5 13h2M7 6l2 2M12 3v3M17 6l-2 2M17 13h2M12 16l4-5"/><circle cx="12" cy="16" r="2"/>',
  cycling: '<circle cx="5" cy="17" r="4"/><circle cx="19" cy="17" r="4"/><path d="m5 17 5-9 5 9H5l7-6M8 8h4M19 17l-4-13h-3"/>',
  walking: '<circle cx="14" cy="4" r="2"/><path d="m7 21 4-7M16 21l-2-7-3-3 2-4 4 4h4M6 12l3-4 4-1"/>',
  'port-camera': '<path d="M3 5h12l6 4-5 6H4L1 10Z"/><path d="m14 5 2-2h6M9 14v5H3v3M6 19h3"/>',
  camera: '<path d="M8 5l1.5-2h5L16 5h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/>',
  rail: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 10h14M8 18l-2 3M16 18l2 3M8 14h1M15 14h1"/>',
  weather: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M1 8h2M3 3l1.5 1.5M13 3l-1.5 1.5M3 13l1.5-1.5M8 19h10a4 4 0 0 0 .5-8 5 5 0 0 0-9.5 1A3.5 3.5 0 0 0 8 19Z"/>',
  'air-quality': '<path d="M2 8h13a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M2 16h6a3 3 0 1 1-3 3"/>'
};

/** Screen-sized signs put the foot of each pole at the actual station location. */
export function projectStationFlags(stations: readonly SceneStation[], base: CityBase, camera: THREE.Camera, width: number, height: number) {
  const point = new THREE.Vector3(), flags: { station: SceneStation; x: number; y: number }[] = [];
  for (const station of stations) {
    const { width: signWidth, height: signHeight, pole } = signSize(station);
    if (!station.id || !inBounds(station.longitude, station.latitude, RELEASE_BOUNDS)) continue;
    const [x, , z] = wgs84ToScene(station.longitude, station.latitude), elevation = sampleTerrainHeight(base.terrain, x, z);
    if (elevation === null) continue;
    point.set(x, elevation + .5, z).project(camera);
    if (point.z < -1 || point.z > 1) continue;
    const screenX = (point.x + 1) * width / 2, screenY = (1 - point.y) * height / 2;
    if (screenX < signWidth / 2 || screenX > width - signWidth / 2 || screenY < signHeight + pole || screenY > height) continue;
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
    const locations = new Map<string, SceneStation>();
    for (const station of this.stations) {
      if (station.kind !== 'traffic-counter') continue;
      const location = trafficCounterLocation(station), previous = locations.get(location);
      const chosen = selected?.kind === 'traffic-counter' && selected.id === station.id;
      const previousChosen = previous?.id === selected?.id;
      if (!previous || chosen || !previousChosen && (station.trafficSummary?.maximum.hourlyEquivalent ?? 0) > (previous.trafficSummary?.maximum.hourlyEquivalent ?? 0)) locations.set(location, station);
    }
    const stations = [...this.stations.filter(station => station.kind !== 'traffic-counter'), ...locations.values()];
    const flags = projectStationFlags(stations, this.base, camera, width, height);
    const visible = new Set(flags.map(flag => key(flag.station)));
    for (const [id, button] of this.buttons) if (!visible.has(id)) { button.remove(); this.buttons.delete(id); }
    for (const { station, x, y } of flags) {
      const id = key(station);
      let button = this.buttons.get(id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.tabIndex = station.kind === 'camera' || station.kind === 'port-camera' || station.kind === 'traffic-counter' ? 0 : -1;
        if (station.kind === 'camera' || station.kind === 'port-camera') button.setAttribute('aria-haspopup', 'dialog');
        button.onclick = () => { const current = this.stations.find(item => key(item) === id); if (current) this.onSelect(current); };
        button.onpointerenter = () => { const current = this.stations.find(item => key(item) === id); if (current) this.onHover(stationLabel(current)); };
        button.onpointerleave = () => this.onHover('');
        this.root.append(button); this.buttons.set(id, button);
      }
      const mode = station.kind === 'traffic-counter' ? trafficMode(station) : station.kind;
      if (button.dataset.mode !== mode) {
        button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[mode]}</svg><small>${station.kind === 'traffic-counter' ? trafficLabels[trafficMode(station)] : station.kind === 'port-camera' ? 'Port' : station.kind === 'camera' ? 'Camera' : station.kind === 'weather' ? 'Weather' : station.kind === 'rail' ? 'Rail' : 'Air'}</small>`;
        button.dataset.mode = mode;
      }
      button.className = `station-flag ${station.kind}${selected && (key(selected) === id || (station.kind === 'traffic-counter' && selected.kind === 'traffic-counter' && trafficCounterLocation(station) === trafficCounterLocation(selected))) ? ' selected' : ''}`;
      const { pole } = signSize(station);
      button.style.transform = `translate3d(${x}px,${y - pole}px,0) translate(-50%,-100%)`;
      button.title = stationLabel(station); button.setAttribute('aria-label', button.title);
    }
  }
  dispose() { this.root.remove(); this.buttons.clear(); this.stations = []; }
}
