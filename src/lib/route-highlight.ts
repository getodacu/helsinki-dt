import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { sampleTerrainHeight, type CityBase } from './city-assets.ts';
import { wgs84ToScene } from './geo.ts';
import { MODE_COLOURS, type VehiclePlacement } from './live-fleet.ts';
import type { RouteContext, RouteStop } from './route-context.ts';
import type { TransitMode } from './types.ts';
import { itineraryStopLabel, type VehicleItinerary } from './itinerary.ts';

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

export function createRouteLines(route: RouteContext, base: CityBase, mode: TransitMode) {
  const source = routeGeometry(route, base, mode === 'ferry');
  const group = new THREE.Group();
  if (!source.getAttribute('position').count) { source.dispose(); return group; }
  const geometry = new LineSegmentsGeometry().setPositions(source.getAttribute('position').array as Float32Array);
  source.dispose();
  // Three 0.186.1: CSS pixels (LineMaterial.js:545), viewport updated on render (LineSegments2.js:419), in examples/jsm/lines/.
  for (const [colour, width, order] of [['#071923', 8, 5], [MODE_COLOURS[mode], 4, 6]] as const) {
    const line = new LineSegments2(geometry, new LineMaterial({ color: colour, linewidth: width, depthTest: false, depthWrite: false }));
    line.renderOrder = order; group.add(line);
  }
  return group;
}

export function routeStopPositions(route: RouteContext, base: CityBase, ferry = false) {
  return (route.status === 'exact' ? route.stops : []).flatMap(stop => {
    const [x, , z] = wgs84ToScene(stop.longitude, stop.latitude);
    if (x < base.bounds[0] || x > base.bounds[2] || z < base.bounds[1] || z > base.bounds[3]) return [];
    const y = ferry ? base.waterLevel : sampleTerrainHeight(base.terrain, x, z);
    return y === null ? [] : [{ stop, x, y: y + 1.5, z }];
  });
}

export function vehicleDirection(placement: VehiclePlacement | null, camera: THREE.PerspectiveCamera,
  height: number, now: number, reducedMotion: boolean) {
  if (!placement || placement.stale || placement.heading === null || height <= 0) return null;
  const { x, y, z, heading, frontExtent, vehicle } = placement;
  const distance = camera.position.distanceTo(new THREE.Vector3(x, y, z));
  const scale = Math.max(.6, distance * 2 * Math.tan(camera.fov * Math.PI / 360) / height * 18 / 8);
  const pulse = !reducedMotion && (vehicle.speedMetresPerSecond ?? 0) > .2 ? now % 1000 / 1000 * 4 : 0;
  const offset = frontExtent + (6 + pulse) * scale, radians = heading * Math.PI / 180;
  return { x: x + Math.sin(radians) * offset, y: y + 1.5, z: z - Math.cos(radians) * offset, heading, scale };
}

function disposeLines(group: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  for (const child of group.children) {
    const line = child as LineSegments2;
    geometries.add(line.geometry); line.material.dispose();
  }
  geometries.forEach(geometry => geometry.dispose()); group.clear();
}

/** Only the selected journey owns route lines, stop tooltips and a direction cue. */
export class RouteHighlight {
  root = new THREE.Group();
  private paths = new THREE.Group();
  private direction = new THREE.Group();
  private directionMaterial = new THREE.MeshBasicMaterial({ color: '#e1ffee', side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  private outlineMaterial = new THREE.MeshBasicMaterial({ color: '#071923', side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  private directionGeometry: THREE.ShapeGeometry;
  private markers = document.createElement('div');
  private stops: { stop: Pick<RouteStop, 'id' | 'name' | 'sequence'>; x: number; y: number; z: number; button: HTMLButtonElement }[] = [];
  private itinerary: VehicleItinerary | null = null;
  private markerSignature = '';
  private point = new THREE.Vector3();
  private base: CityBase;
  constructor(container: HTMLElement, base: CityBase) {
    this.base = base; this.markers.className = 'route-stop-markers'; container.append(this.markers);
    const shape = new THREE.Shape().moveTo(-4, -3).lineTo(0, 1).lineTo(4, -3).lineTo(4, 1).lineTo(0, 5).lineTo(-4, 1).closePath();
    this.directionGeometry = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    const outline = new THREE.Mesh(this.directionGeometry, this.outlineMaterial), arrow = new THREE.Mesh(this.directionGeometry, this.directionMaterial);
    outline.scale.setScalar(1.35); outline.renderOrder = 7; arrow.renderOrder = 8;
    this.direction.add(outline, arrow); this.direction.visible = false;
    this.root.add(this.paths, this.direction); this.setVisible(false);
  }
  setRoute(route: RouteContext | null, mode: TransitMode) {
    disposeLines(this.paths);
    if (route?.status === 'exact') {
      const lines = createRouteLines(route, this.base, mode); this.paths.add(...[...lines.children]);
    }
    if (this.itinerary && this.itinerary.vehicleId === route?.vehicleId) return;
    this.itinerary = null; this.markerSignature = ''; this.markers.replaceChildren(); this.stops = [];
    if (route?.status !== 'exact') return;
    this.markers.style.setProperty('--route-colour', MODE_COLOURS[mode]);
    this.stops = routeStopPositions(route, this.base, mode === 'ferry').map(position => {
      const button = document.createElement('button'); button.type = 'button';
      button.setAttribute('aria-label', `Stop ${position.stop.sequence}: ${position.stop.name}`);
      button.className = 'route-stop-marker'; button.title = position.stop.name;
      const dot = document.createElement('span'), name = document.createElement('span');
      dot.className = 'route-stop-dot'; name.className = 'route-stop-name'; name.textContent = position.stop.name;
      button.append(dot, name); this.markers.append(button);
      return { ...position, button };
    });
  }
  setItinerary(itinerary: VehicleItinerary | null) {
    this.itinerary = itinerary;
    const positions = (itinerary?.stops ?? []).flatMap(stop => {
      if (stop.longitude === null || stop.latitude === null) return [];
      const [x, , z] = wgs84ToScene(stop.longitude, stop.latitude);
      if (x < this.base.bounds[0] || x > this.base.bounds[2] || z < this.base.bounds[1] || z > this.base.bounds[3]) return [];
      const height = sampleTerrainHeight(this.base.terrain, x, z);
      return height === null ? [] : [{ stop, x, y: height + 1.5, z }];
    });
    const signature = JSON.stringify(positions.map(({ stop, x, y, z }) => [stop.key, x, y, z]));
    if (signature !== this.markerSignature) {
      this.markerSignature = signature; this.markers.replaceChildren();
      this.stops = positions.map(position => {
        const button = document.createElement('button'); button.type = 'button';
        const dot = document.createElement('span'), name = document.createElement('span');
        dot.className = 'route-stop-dot'; name.className = 'route-stop-name';
        button.append(dot, name); this.markers.append(button);
        return { ...position, button };
      });
    }
    if (itinerary) this.markers.style.setProperty('--route-colour', MODE_COLOURS[itinerary.mode]);
    positions.forEach(({ stop }, index) => {
      const button = this.stops[index].button;
      const text = `${stop.name} · ${itineraryStopLabel(stop)}`;
      button.className = `route-stop-marker ${stop.state}`; button.title = text;
      button.setAttribute('aria-label', `Stop ${stop.sequence}: ${text}`);
      button.setAttribute('aria-current', stop.state === 'next' || stop.state === 'current' ? 'step' : 'false');
      button.children[1].textContent = text;
    });
  }
  setVisible(visible: boolean) { this.paths.visible = visible; this.markers.hidden = !visible; }
  update(placement: VehiclePlacement | null, camera: THREE.PerspectiveCamera, width: number, height: number,
    now: number, reducedMotion: boolean) {
    camera.updateMatrixWorld();
    if (this.paths.visible) for (const { x, y, z, button } of this.stops) {
      this.point.set(x, y, z).project(camera);
      const screenX = (this.point.x + 1) * width / 2, screenY = (1 - this.point.y) * height / 2;
      button.hidden = this.point.z < -1 || this.point.z > 1 || screenX < 12 || screenX > width - 12 || screenY < 12 || screenY > height - 12;
      if (!button.hidden) button.style.transform = `translate3d(${screenX}px,${screenY}px,0) translate(-50%,-50%)`;
    }
    const cue = vehicleDirection(placement, camera, height, now, reducedMotion);
    this.direction.visible = !!cue;
    if (cue) {
      this.direction.position.set(cue.x, cue.y, cue.z); this.direction.rotation.y = -cue.heading * Math.PI / 180;
      this.direction.scale.setScalar(cue.scale);
    }
  }
  dispose() {
    disposeLines(this.paths); this.directionGeometry.dispose(); this.directionMaterial.dispose(); this.outlineMaterial.dispose();
    this.root.clear(); this.markers.remove(); this.stops = [];
  }
}
