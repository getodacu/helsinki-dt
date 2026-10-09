import type { Vehicle } from './types.ts';
import { marineFreshness, type MarineStatus } from './marine.ts';

export const TRAFFIC_STALE_MS = 30_000;
export const TRAFFIC_REMOVE_MS = 120_000;
export const TRAFFIC_IDLE_MS = 30_000;
export const TRAFFIC_HEARTBEAT_MS = 15_000;
export const TRAFFIC_MAX_VEHICLES = 1_000;
// The queue must fit one bounded snapshot of all providers.
export const TRAFFIC_MAX_QUEUE_BYTES = 8 * 1024 * 1024;

export interface TrafficStatus {
  state: 'idle' | 'connecting' | 'live' | 'reconnecting';
  connectedAt: string | null;
  lastPositionAt: string | null;
  retryAt: string | null;
  error?: string | null;
}
export interface TrafficSnapshot {
  type: 'snapshot';
  generatedAt: string;
  vehicles: Vehicle[];
  status: TrafficStatus;
  sources?: { hsl: TrafficStatus; rail?: TrafficStatus; marine?: MarineStatus };
}
export interface TrafficUpdate {
  type: 'update';
  generatedAt: string;
  vehicles: Vehicle[];
  removed: string[];
  status: TrafficStatus;
  sources?: { hsl: TrafficStatus; rail?: TrafficStatus; marine?: MarineStatus };
}
export type TrafficEvent = TrafficSnapshot | TrafficUpdate;

export function trafficAge(vehicle: Pick<Vehicle, 'reportedAt'>, now = Date.now()): number {
  return Math.max(0, now - Date.parse(vehicle.reportedAt));
}
type FreshnessVehicle = Pick<Vehicle, 'reportedAt'> & Partial<Pick<Vehicle, 'mode' | 'speedMetresPerSecond' | 'marine'>>;
const removalPolicy = (vehicle: FreshnessVehicle) => vehicle.mode === 'ship'
  ? marineFreshness({ speedMetresPerSecond: vehicle.speedMetresPerSecond ?? null, marine: vehicle.marine })
  : { staleMs: TRAFFIC_STALE_MS, removeMs: TRAFFIC_REMOVE_MS };
export function trafficIsStale(vehicle: FreshnessVehicle, now = Date.now()): boolean {
  return (vehicle.mode === 'ship' && vehicle.marine?.positionSecond === 63)
    || trafficAge(vehicle, now) >= removalPolicy(vehicle).staleMs;
}
export function trafficShouldRemove(vehicle: FreshnessVehicle, now = Date.now()): boolean {
  return trafficAge(vehicle, now) >= removalPolicy(vehicle).removeMs;
}
