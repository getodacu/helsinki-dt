import { ShapeUtils, Vector2 } from 'three';
import { SCENE_ORIGIN } from '../area.ts';
import { gk25ToScene, wgs84ToScene } from '../geo.ts';
import type { Building, BuildingChunk } from '../types.ts';

export interface SourceBuilding {
  key: string;
  gmlId: string;
  longitude: number;
  latitude: number;
  attributes: Record<string, string | null>;
}

export interface ReconciledBuilding extends SourceBuilding {
  recordKeys: string[];
}
const identityFields = ['Rakennustunnus_(VTJ-PRT)', 'Rakennustunnus_(RATU)', 'UUID'];

function compatible(a: SourceBuilding, b: SourceBuilding) {
  return identityFields.every(field => !a.attributes[field] || !b.attributes[field]
    || a.attributes[field] === b.attributes[field]);
}

/** Merge repeated LoD records, retaining every conflicting attribute and identifier. */
export function reconcileBuildings(records: SourceBuilding[]): ReconciledBuilding[] {
  const groups = new Map<string, ReconciledBuilding[]>();
  for (const record of [...records].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!record.gmlId || !record.key || !Number.isFinite(record.longitude) || !Number.isFinite(record.latitude)) {
      throw new Error('Invalid source building identity or location');
    }
    const sameId = groups.get(record.gmlId) ?? [];
    const match = sameId.find(group => compatible(group, record));
    if (match) {
      match.recordKeys.push(record.key);
      for (const [name, value] of Object.entries(record.attributes)) {
        if (match.attributes[name] == null) match.attributes[name] = value;
        else if (value != null && match.attributes[name] !== value) {
          const conflictKey = `${name}__conflictingValues`;
          const previous: string[] = match.attributes[conflictKey]
            ? JSON.parse(match.attributes[conflictKey]) : [match.attributes[name]!];
          match.attributes[conflictKey] = JSON.stringify([...new Set([...previous, value])].sort());
        }
      }
    } else {
      sameId.push({ ...record, attributes: { ...record.attributes }, recordKeys: [record.key] });
      groups.set(record.gmlId, sameId);
    }
  }
  return [...groups.values()].flatMap(groups => groups.map(group => {
    const key = groups.length === 1 ? group.gmlId
      : `${group.gmlId}::conflict:${encodeURIComponent(identityFields.map(field => group.attributes[field] ?? '').join('|'))}`;
    return { ...group, key, attributes: { ...group.attributes,
      sourceRecordCount: String(group.recordKeys.length),
      ...(groups.length > 1 ? { identityConflict: 'true' } : {}) } };
  })).sort((a, b) => a.key.localeCompare(b.key));
}

interface CityGeometry { type: string; lod?: string | number; boundaries: unknown }
interface CityObject { type: string; children?: string[]; geometry?: CityGeometry[] }
export interface CityJson {
  type: string;
  version: string;
  CityObjects: Record<string, CityObject>;
  vertices: number[][];
  transform?: { scale: number[]; translate: number[] };
}

function polygonRings(geometry: CityGeometry): number[][][] {
  const boundaries = geometry.boundaries as number[][][];
  if (geometry.type === 'MultiSurface' || geometry.type === 'CompositeSurface') return boundaries;
  if (geometry.type === 'Solid') return (geometry.boundaries as number[][][][]).flat();
  if (geometry.type === 'MultiSolid' || geometry.type === 'CompositeSolid') {
    return (geometry.boundaries as number[][][][][]).flat(2);
  }
  throw new Error(`Unsupported CityJSON geometry ${geometry.type}`);
}

export function triangulateSurface(rings: number[][], vertices: number[][]): number[] {
  if (!Array.isArray(rings) || !rings.length) throw new Error('Surface has no rings');
  const normalized = rings.map(ring => {
    if (!Array.isArray(ring) || ring.length < 3) throw new Error('Surface ring has fewer than three vertices');
    const first = vertices[ring[0]], last = vertices[ring.at(-1)!];
    const clean = first && last && first.every((value, axis) => value === last[axis]) ? ring.slice(0, -1) : [...ring];
    if (clean.some(index => !Number.isInteger(index) || !vertices[index]
      || vertices[index].length !== 3 || !vertices[index].every(Number.isFinite))) {
      throw new Error('Surface references an invalid vertex');
    }
    return clean;
  });
  const outer = normalized[0].map(index => vertices[index]);
  const normal = [0, 0, 0];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  if (Math.abs(normal[drop]) < 1e-9) throw new Error('Degenerate surface');
  const axes = [0, 1, 2].filter(axis => axis !== drop);
  const projected = normalized.map(ring => ring.map(index => new Vector2(vertices[index][axes[0]], vertices[index][axes[1]])));
  const triangles = ShapeUtils.triangulateShape(projected[0], projected.slice(1));
  if (!triangles.length) throw new Error('Surface could not be triangulated');
  const flatIndices = normalized.flat();
  return triangles.flatMap(triangle => {
    const [a, b, c] = triangle.map(index => vertices[flatIndices[index]]);
    const cross = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    const ordered = cross.reduce((sum, value, axis) => sum + value * normal[axis], 0) < 0
      ? [triangle[0], triangle[2], triangle[1]] : triangle;
    return ordered.flatMap(index => gk25ToScene(...vertices[flatIndices[index]] as [number, number, number]));
  });
}

export function prepareBuildingChunk(document: CityJson, records: SourceBuilding[]) {
  if (document.type !== 'CityJSON' || !document.CityObjects || !Array.isArray(document.vertices)) {
    throw new Error('Invalid CityJSON document');
  }
  const vertices = document.vertices.map(vertex => vertex.map((value, axis) => document.transform
    ? value * document.transform.scale[axis] + document.transform.translate[axis] : value));
  const chunk: BuildingChunk = { id: 'senate-square', positions: [], ranges: [],
    coordinateReference: 'local metres [east, elevation, -north] from EPSG:3879',
    verticalReference: 'N2000 metres', origin: { ...SCENE_ORIGIN } };
  const buildings: Building[] = [];
  const rejected: { buildingId: string; reason: string }[] = [];
  for (const record of reconcileBuildings(records)) {
    const geometry: CityGeometry[] = [];
    const visited = new Set<string>();
    const collect = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const object = document.CityObjects[key];
      if (!object) return;
      geometry.push(...(object.geometry ?? []));
      for (const child of object.children ?? []) collect(child);
    };
    record.recordKeys.forEach(collect);
    const lods = [...new Set(geometry.map(item => Number(item.lod ?? 0)))].filter(Number.isFinite).sort((a, b) => b - a);
    let positions: number[] | undefined;
    let selectedLod: number | undefined;
    let lastError = 'No converted geometry';
    for (const lod of lods) {
      try {
        const candidate = geometry.filter(item => Number(item.lod ?? 0) === lod)
          .flatMap(item => polygonRings(item).flatMap(rings => triangulateSurface(rings, vertices)));
        if (!candidate.length || candidate.length % 9) throw new Error('Empty or incomplete triangles');
        positions = candidate;
        selectedLod = lod;
        break;
      } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    }
    if (!positions) { rejected.push({ buildingId: record.key, reason: lastError }); continue; }
    chunk.ranges.push({ buildingId: record.key, firstTriangle: chunk.positions.length / 9, triangleCount: positions.length / 9 });
    chunk.positions.push(...positions);
    buildings.push({ id: record.key, gmlId: record.gmlId, vtjPrt: record.attributes['Rakennustunnus_(VTJ-PRT)'] ?? null,
      ratu: record.attributes['Rakennustunnus_(RATU)'] ?? null, uuid: record.attributes.UUID ?? null,
      longitude: record.longitude, latitude: record.latitude, chunkRef: chunk.id, sourceId: 'helsinki-citygml-20190326',
      attributes: { ...record.attributes, selectedLod: String(selectedLod), availableLods: lods.join(',') } });
  }
  return { buildings, chunk, rejected };
}

/** Three.js faceIndex is the triangle ordinal for the non-indexed chunk. */
export function buildingIdForTriangle(chunk: BuildingChunk, faceIndex: number | null | undefined): string | null {
  if (faceIndex == null || !Number.isInteger(faceIndex) || faceIndex < 0) return null;
  return chunk.ranges.find(range => faceIndex >= range.firstTriangle
    && faceIndex < range.firstTriangle + range.triangleCount)?.buildingId ?? null;
}

export interface CoordinateControl {
  name: string;
  gmlId: string;
  longitude: number;
  latitude: number;
  sourceUrl: string;
  retrievedAt: string;
}

/** Service locations can be entrances; compare to the actual building extent, not its centroid. */
export function verifyCoordinateControls(buildings: Building[], chunk: BuildingChunk, controls: CoordinateControl[]) {
  if (controls.length < 3 || new Set(controls.map(control => control.gmlId)).size < 3) {
    throw new Error('Three distinct identifiable control buildings are required');
  }
  return controls.map(control => {
    if (!control.sourceUrl.startsWith('https://') || !Number.isFinite(Date.parse(control.retrievedAt))) {
      throw new Error('Independent coordinate control provenance missing');
    }
    const building = buildings.find(building => building.gmlId === control.gmlId);
    const range = building && chunk.ranges.find(range => range.buildingId === building.id);
    if (!building || !range) throw new Error('Control building missing from geometry');
    const positions = chunk.positions.slice(range.firstTriangle * 9, (range.firstTriangle + range.triangleCount) * 9);
    const minima = [Infinity, Infinity, Infinity], maxima = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index++) {
      const axis = index % 3;
      minima[axis] = Math.min(minima[axis], positions[index]); maxima[axis] = Math.max(maxima[axis], positions[index]);
    }
    const [east, , north] = wgs84ToScene(control.longitude, control.latitude);
    const dx = Math.max(minima[0] - east, 0, east - maxima[0]);
    const dz = Math.max(minima[2] - north, 0, north - maxima[2]);
    const distanceMetres = Math.hypot(dx, dz);
    const sourceMinimum = Number(building.attributes.sourceEnvelopeMinimumElevation);
    const sourceMaximum = Number(building.attributes.sourceEnvelopeMaximumElevation);
    const verticalDifference = Math.max(Math.abs(sourceMinimum - minima[1]), Math.abs(sourceMaximum - maxima[1]));
    if (!Number.isFinite(verticalDifference) || verticalDifference > 0.02) throw new Error('Control N2000 elevation treatment failed');
    if (distanceMetres > 30) throw new Error('Control horizontal alignment failed: ' + control.name);
    return { ...control, buildingId: building.id, distanceMetres, sourceMinimum, sourceMaximum,
      renderedMinimum: minima[1], renderedMaximum: maxima[1], verticalDifference };
  });
}
