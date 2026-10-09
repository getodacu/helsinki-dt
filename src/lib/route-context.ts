import type { TransitMode, Vehicle } from './types.ts';

export interface RouteSource {
  url: string; archiveSha256: string; feedVersion: string | null; validFrom: string; validTo: string; retrievedAt: string | null;
}
export interface RouteStop {
  id: string; name: string; longitude: number; latitude: number; sequence: number;
  arrivalAt: string | null; departureAt: string | null;
}
export interface RouteContext {
  status: 'exact' | 'missing' | 'ambiguous' | 'unavailable';
  vehicleId: string; routeId: string; routeLabel: string | null; destination: string | null;
  tripId: string | null; departureAt: string | null; candidates: string[];
  shape: [number, number][][]; stops: RouteStop[]; reason: string | null;
  sourceId: 'hsl-gtfs' | 'digitraffic-gtfs'; generatedAt: string | null; source: RouteSource | null;
}
export interface RouteCatalog {
  status: 'ready' | 'unavailable'; generatedAt: string | null; reason: string | null; source: RouteSource | null;
  routes: { routeId: string; label: string; name: string; mode: TransitMode }[];
}
export type JourneyIdentity = Pick<Vehicle, 'id' | 'ownerOperatorId' | 'vehicleId' | 'routeId' | 'directionId' | 'serviceDate' | 'startTime'>;
export function routeRequestUrl(vehicle: JourneyIdentity): string {
  const query = new URLSearchParams();
  for (const key of ['ownerOperatorId', 'vehicleId', 'routeId', 'directionId', 'serviceDate', 'startTime'] as const) {
    if (vehicle[key] != null) query.set(key, vehicle[key]);
  }
  return `/api/route?${query}`;
}
export async function loadRouteCatalog(fetcher: typeof fetch = fetch): Promise<RouteCatalog> {
  const response = await fetcher('/api/route', { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Route labels could not load.');
  return response.json();
}
