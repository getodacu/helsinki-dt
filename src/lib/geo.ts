import proj4 from "proj4";
import { SCENE_ORIGIN } from "./area.ts";

export const GK25 = "+proj=tmerc +lat_0=0 +lon_0=25 +k=1 +x_0=25500000 +y_0=0 +ellps=GRS80 +units=m +no_defs";
export const PROJECTED_ORIGIN = proj4("EPSG:4326", GK25, [SCENE_ORIGIN.longitude, SCENE_ORIGIN.latitude]);

export function gk25ToWgs84(east: number, north: number): [number, number] {
  if (![east, north].every(Number.isFinite)) throw new Error("Non-finite projected coordinate");
  return proj4(GK25, "EPSG:4326", [east, north]) as [number, number];
}

/** Source CityGML explicitly stores east, north, N2000 elevation, despite the official EPSG axis order. */
export function gk25ToScene(east: number, north: number, elevation: number): [number, number, number] {
  if (![east, north, elevation].every(Number.isFinite)) throw new Error("Non-finite geometry coordinate");
  return [east - PROJECTED_ORIGIN[0], elevation - SCENE_ORIGIN.elevation, -(north - PROJECTED_ORIGIN[1])];
}

export function wgs84ToScene(longitude: number, latitude: number, elevation = 0): [number, number, number] {
  if (![longitude, latitude].every(Number.isFinite) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    throw new Error("Invalid WGS84 longitude/latitude");
  }
  const [east, north] = proj4("EPSG:4326", GK25, [longitude, latitude]);
  return gk25ToScene(east, north, elevation);
}
