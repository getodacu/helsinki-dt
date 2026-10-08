import { SCENE_ORIGIN } from '../src/lib/area.ts';
import { wgs84ToScene } from '../src/lib/geo.ts';
import type { Building, BuildingChunk } from '../src/lib/types.ts';
export const CITY_CACHE = '.cache/task-b';

/** Keep identity through render batches; round at 1 cm to keep transfer sizes bounded. */
export function partitionCityBuildings(buildings: Building[], original: BuildingChunk, maxTriangles = 30_000) {
  if (!Number.isInteger(maxTriangles) || maxTriangles < 1) throw new Error('Invalid triangle budget');
  const byId = new Map(buildings.map(building => [building.id, building]));
  const tiles = new Map<string, { chunk: BuildingChunk; buildings: Building[] }[]>();
  for (const range of original.ranges) {
    const building = byId.get(range.buildingId);
    if (!building) throw new Error('Triangle range has no source building');
    const [x, , z] = wgs84ToScene(building.longitude, building.latitude);
    const tileId = `tile_${Math.floor(x / 500)}_${Math.floor(z / 500)}`;
    const batches = tiles.get(tileId) ?? []; tiles.set(tileId, batches);
    let copied = 0;
    while (copied < range.triangleCount) {
      let batch = batches.at(-1);
      if (!batch || batch.chunk.positions.length / 9 >= maxTriangles) {
        const id = tileId + '_' + batches.length;
        batch = { chunk: { ...original, id, positions: [], ranges: [], origin: { ...SCENE_ORIGIN } }, buildings: [] };
        batches.push(batch);
      }
      const triangleCount = Math.min(range.triangleCount - copied, maxTriangles - batch.chunk.positions.length / 9);
      batch.chunk.ranges.push({ buildingId: building.id, firstTriangle: batch.chunk.positions.length / 9, triangleCount });
      const start = (range.firstTriangle + copied) * 9, end = start + triangleCount * 9;
      for (let index = start; index < end; index++) batch.chunk.positions.push(Math.round(original.positions[index] * 100) / 100);
      if (!batch.buildings.some(item => item.id === building.id)) batch.buildings.push({ ...building, chunkRef: batch.chunk.id });
      copied += triangleCount;
    }
  }
  return [...tiles.values()].flat();
}
