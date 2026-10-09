import type { Vehicle } from './types.ts';
import type { TrafficStatus } from './traffic.ts';

export const MARINE_STALE_MS = 120_000;
export const MARINE_REMOVE_MS = 600_000;
export const MARINE_STATIONARY_STALE_MS = 600_000;
export const MARINE_STATIONARY_REMOVE_MS = 1_800_000;
export const MARINE_BUFFER_MS = 10_000;
export const MARINE_GAP_MS = 30_000;
export const MARINE_MAX_DISTANCE_METRES = 1_000;
export const MARINE_MAX_SPEED_METRES_PER_SECOND = 40;
export const MARINE_MAX_POINTS = 64;
export const MARINE_FUTURE_TOLERANCE_MS = 5_000;
export const KNOTS_TO_METRES_PER_SECOND = 1852 / 3600;
export const MARINE_STATIONARY_SPEED = .5 * KNOTS_TO_METRES_PER_SECOND;

export interface MarineMetadata {
  mmsi: string;
  imo: string | null;
  name: string | null;
  callSign: string | null;
  shipType: number | null;
  reportedAt: string;
  receivedAt: string;
  quality: string[];
}
export interface MarineSummary {
  mmsi: string;
  positionSource: 'rest' | 'mqtt';
  imo: string | null;
  name: string | null;
  callSign: string | null;
  shipType: number | null;
  navigationStatus: number | null;
  courseOverGroundDegrees: number | null;
  positionAccuracy: boolean | null;
  raim: boolean | null;
  positionSecond: number | null;
  metadataReportedAt: string | null;
  metadataReceivedAt: string | null;
}
export interface MarineStatus extends TrafficStatus {
  lastSnapshotAt?: string | null;
  lastMessageAt?: string | null;
  feedUpdatedAt?: string | null;
  positionError?: string | null;
  metadataError?: string | null;
  periodic?: boolean;
  stale?: boolean;
  degraded?: boolean;
  capacityReached?: boolean;
  localCount?: number;
}

export function marineFreshness(vehicle: Pick<Vehicle, 'speedMetresPerSecond' | 'marine'>): { staleMs: number; removeMs: number } {
  const stationary = [1, 5].includes(vehicle.marine?.navigationStatus ?? -1)
    && vehicle.speedMetresPerSecond !== null && Number.isFinite(vehicle.speedMetresPerSecond)
    && vehicle.speedMetresPerSecond >= 0 && vehicle.speedMetresPerSecond <= MARINE_STATIONARY_SPEED;
  return stationary ? { staleMs: MARINE_STATIONARY_STALE_MS, removeMs: MARINE_STATIONARY_REMOVE_MS }
    : { staleMs: MARINE_STALE_MS, removeMs: MARINE_REMOVE_MS };
}
export function marineIsRemoved(vehicle: Pick<Vehicle, 'reportedAt' | 'speedMetresPerSecond' | 'marine'>, now = Date.now()): boolean {
  return now - Date.parse(vehicle.reportedAt) >= marineFreshness(vehicle).removeMs;
}
export function marineHeading(vehicle: Pick<Vehicle, 'headingDegrees' | 'speedMetresPerSecond' | 'marine'>): number | null {
  if (vehicle.marine?.positionSecond === 63) return null;
  return vehicle.headingDegrees ?? (vehicle.speedMetresPerSecond !== null && vehicle.speedMetresPerSecond > MARINE_STATIONARY_SPEED
    ? vehicle.marine?.courseOverGroundDegrees ?? null : null);
}

const samePosition = (a: Vehicle, b: Vehicle) => a.longitude === b.longitude && a.latitude === b.latitude
  && a.speedMetresPerSecond === b.speedMetresPerSecond && a.headingDegrees === b.headingDegrees
  && a.marine?.navigationStatus === b.marine?.navigationStatus && a.marine?.courseOverGroundDegrees === b.marine?.courseOverGroundDegrees
  && a.marine?.positionAccuracy === b.marine?.positionAccuracy && a.marine?.raim === b.marine?.raim
  && (a.marine?.positionSecond === b.marine?.positionSecond || a.marine?.positionSecond === null || b.marine?.positionSecond === null)
  && a.quality.filter(flag => !flag.startsWith('metadata-') && flag !== 'position-same-second-conflict').join('|')
    === b.quality.filter(flag => !flag.startsWith('metadata-') && flag !== 'position-same-second-conflict').join('|');

/** MQTT truncates milliseconds: only REST can supersede a report in that same second. */
export function compareMarinePositions(previous: Vehicle, next: Vehicle): 'newer' | 'older' | 'duplicate' | 'conflict' {
  if (previous.id !== next.id || !previous.marine || !next.marine) throw new Error('Mismatched marine position identity');
  const before = Date.parse(previous.reportedAt), after = Date.parse(next.reportedAt);
  if (Math.floor(before / 1000) === Math.floor(after / 1000) && previous.marine.positionSource !== next.marine.positionSource) {
    return next.marine.positionSource === 'rest' ? 'newer' : 'older';
  }
  if (after !== before) return after > before ? 'newer' : 'older';
  return samePosition(previous, next) ? 'duplicate' : 'conflict';
}
export function marineDistanceMetres(previous: Pick<Vehicle, 'longitude' | 'latitude'>, next: Pick<Vehicle, 'longitude' | 'latitude'>): number {
  if (previous.longitude === null || previous.latitude === null || next.longitude === null || next.latitude === null) return Infinity;
  const radians = Math.PI / 180, latitude = (next.latitude - previous.latitude) * radians, longitude = (next.longitude - previous.longitude) * radians;
  const square = Math.sin(latitude / 2) ** 2 + Math.cos(previous.latitude * radians) * Math.cos(next.latitude * radians) * Math.sin(longitude / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, square)));
}
export function marineMotionPlausible(previous: Vehicle, next: Vehicle): boolean {
  const before = Date.parse(previous.reportedAt), after = Date.parse(next.reportedAt), gap = after - before;
  // Same-second precision corrections are snapped, not timed as a new movement.
  if (Math.floor(before / 1000) === Math.floor(after / 1000) && previous.marine?.positionSource !== next.marine?.positionSource) return true;
  return gap > MARINE_GAP_MS || (gap > 0 && marineDistanceMetres(previous, next) / (gap / 1000) <= MARINE_MAX_SPEED_METRES_PER_SECOND);
}
export function marineTypeLabel(type: number | null): string {
  if (type === null) return 'Unknown type';
  if (type >= 20 && type <= 29) return 'Wing in ground';
  if (type >= 40 && type <= 49) return 'High-speed craft';
  if (type >= 60 && type <= 69) return 'Passenger ship';
  if (type >= 70 && type <= 79) return 'Cargo ship';
  if (type >= 80 && type <= 89) return 'Tanker';
  return ({ 30: 'Fishing vessel', 31: 'Tug', 32: 'Tug', 33: 'Dredging / underwater operations', 34: 'Diving vessel',
    35: 'Military vessel', 36: 'Sailing vessel', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue',
    52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution vessel', 55: 'Law enforcement', 58: 'Medical transport' } as Record<number, string>)[type] ?? 'Other ship';
}
export function marineNavigationLabel(status: number | null): string {
  return status === null ? 'Unknown navigation status' : ['Under way using engine', 'At anchor', 'Not under command', 'Restricted manoeuvrability',
    'Constrained by draught', 'Moored', 'Aground', 'Fishing', 'Under way sailing', 'Reserved', 'Reserved', 'Towing astern',
    'Pushing / towing alongside', 'Reserved', 'AIS search and rescue'][status] ?? 'Unknown navigation status';
}
