/** Bounds are WGS84 [west, south, east, north]. Heights remain N2000 metres. */
export const RELEASE_BOUNDS = [24.86, 60.135, 25.06, 60.225] as const;
export const DISTRICT_BOUNDS = [24.944, 60.164, 24.958, 60.174] as const;
export const SCENE_ORIGIN = { longitude: 24.952, latitude: 60.1695, elevation: 0 };
export function inBounds(longitude: number, latitude: number, bounds: readonly number[]): boolean {
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= bounds[0] && longitude <= bounds[2]
    && latitude >= bounds[1] && latitude <= bounds[3];
}
