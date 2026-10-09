import type { Vehicle } from './types.ts';

export const TRAFFIC_STALE_MS = 30_000;
export const TRAFFIC_REMOVE_MS = 120_000;
export const TRAFFIC_IDLE_MS = 30_000;
export const TRAFFIC_HEARTBEAT_MS = 15_000;
export const TRAFFIC_MAX_VEHICLES = 1_000;
// The queue must fit one bounded snapshot of both providers.
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
  sources?: { hsl: TrafficStatus; rail: TrafficStatus };
}
export interface TrafficUpdate {
  type: 'update';
  generatedAt: string;
  vehicles: Vehicle[];
  removed: string[];
  status: TrafficStatus;
  sources?: { hsl: TrafficStatus; rail: TrafficStatus };
}
export type TrafficEvent = TrafficSnapshot | TrafficUpdate;

export function trafficAge(vehicle: Pick<Vehicle, 'reportedAt'>, now = Date.now()): number {
  return Math.max(0, now - Date.parse(vehicle.reportedAt));
}
export function trafficIsStale(vehicle: Pick<Vehicle, 'reportedAt'>, now = Date.now()): boolean {
  return trafficAge(vehicle, now) >= TRAFFIC_STALE_MS;
}
