import type { Vehicle } from './types.ts';

export const RAIL_CATEGORIES = ['commuter', 'long-distance', 'freight', 'other'] as const;
export type RailCategory = typeof RAIL_CATEGORIES[number];
export interface RailStation { code: string; name: string; longitude: number; latitude: number; passenger: boolean }
export interface RailEvent {
  stationCode: string; stationName: string; type: 'ARRIVAL' | 'DEPARTURE';
  scheduledAt: string; estimatedAt: string | null; actualAt: string | null;
  platform: string | null; cancelled: boolean; commercial: boolean; stopping: boolean;
}
export interface RailSummary {
  trainNumber: string; departureDate: string | null; label: string; category: RailCategory;
  trainType: string | null; operator: string | null; origin: string | null; destination: string | null;
  cancelled: boolean; nextEvent: RailEvent | null; timetableAt: string | null; timetableStale?: boolean;
}
export interface RailJourney { summary: RailSummary; events: RailEvent[] }
export interface RailDeparture { id: string; summary: RailSummary; event: RailEvent }
export interface RailResult<T> { state: 'ready' | 'stale' | 'unavailable'; data: T | null; retrievedAt: string | null; error: string | null }
export const railId = (date: string | null, number: string) => `digitraffic:${date ?? 'undated'}:${number}`;
export function railDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export function railNumber(value: unknown): string {
  const number = String(value);
  if (!/^[1-9]\d{0,4}$/.test(number)) throw new Error('Invalid train number');
  return number;
}
export function railDelay(event: RailEvent | null): number | null {
  const time = event?.actualAt ?? event?.estimatedAt;
  return time && event ? Math.round((Date.parse(time) - Date.parse(event.scheduledAt)) / 1000) : null;
}
export const vehicleLabel = (vehicle: Pick<Vehicle, 'rail' | 'routeId'> & Partial<Pick<Vehicle, 'marine' | 'vehicleId'>>, routeLabel?: string) =>
  vehicle.marine ? vehicle.marine.name ?? `MMSI ${vehicle.marine.mmsi}` : vehicle.rail?.label ?? routeLabel ?? vehicle.routeId ?? vehicle.vehicleId ?? 'Unknown vehicle';
export const railJourneyUrl = (rail: RailSummary) => rail.departureDate ? `/api/rail/trains/${rail.departureDate}/${rail.trainNumber}` : null;
