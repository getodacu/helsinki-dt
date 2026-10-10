import type { MarineStatus } from './marine.ts';
import type { Building, Vehicle } from './types.ts';

export const ON_TIME_BAND_SECONDS = 60;
export function hslSchedule(seconds: number | null): { state: 'on-time' | 'delayed' | 'early' | 'unknown'; label: string } {
  if (seconds === null || !Number.isFinite(seconds)) return { state: 'unknown', label: 'Unknown delay' };
  if (seconds > ON_TIME_BAND_SECONDS) return { state: 'delayed', label: 'Delayed' };
  if (seconds < -ON_TIME_BAND_SECONDS) return { state: 'early', label: 'Early' };
  return { state: 'on-time', label: 'On time' };
}
export function delayLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'Unknown delay';
  if (Math.abs(seconds) <= ON_TIME_BAND_SECONDS) return 'Within ±60 s';
  return `${Math.abs(seconds)} s ${seconds > 0 ? 'late' : 'early'}`;
}
export function signedSeconds(seconds: number | null): string {
  return seconds === null || !Number.isFinite(seconds) ? 'Unknown' : `${seconds > 0 ? '+' : ''}${seconds} s`;
}
export function formatDate(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
    : 'Unknown';
}
export const label = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
export const searchText = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fi').trim();
export const knownValue = (value: string | null | undefined): value is string => !!value?.trim() && !/^((unknown|unavailable|not known|not available)(\s*[—–:]\s*.*)?|n\/a)$/i.test(value.trim());
export function buildingAttribute(building: Building, names: string[]): string | null {
  return Object.entries(building.attributes).find(([key, value]) => names.some(name => searchText(name) === searchText(key)) && knownValue(value))?.[1] ?? null;
}
export function buildingAddress(building: Building): string | null {
  const address = buildingAttribute(building, ['address', 'osoite']);
  if (!address) return null;
  if (!address.trim().startsWith('{')) return address;
  try {
    const fields = JSON.parse(address);
    if (!fields || typeof fields !== 'object') return address;
    return [fields.Street, fields.HouseNumber, fields.PostalCode, fields.City].filter(value => typeof value === 'string' && value.trim()).join(' ') || null;
  } catch { return address; }
}
export const buildingName = (building: Building) => buildingAttribute(building, ['name', 'nimi', 'rakennuksen_nimi']) ?? buildingAddress(building) ?? 'Building';
export const matchesBuilding = (building: Building, query: string) => searchText([buildingName(building), buildingAddress(building), building.id,
  building.gmlId, building.vtjPrt, building.ratu, building.uuid].filter(Boolean).join(' ')).includes(searchText(query));
export const matchesVehicle = (vehicle: Vehicle, query: string, routeLabel?: string) => searchText(`${vehicle.mode} ${vehicle.routeId ?? ''} ${routeLabel ?? ''} ${vehicle.id} ${vehicle.ownerOperatorId ?? ''}/${vehicle.vehicleId} ${vehicle.rail?.label ?? ''} ${vehicle.rail?.destination ?? ''} ${vehicle.rail?.origin ?? ''} ${vehicle.rail?.nextEvent?.stationName ?? ''} ${vehicle.marine?.name ?? ''} ${vehicle.marine?.mmsi ?? ''} ${vehicle.marine?.callSign ?? ''}`).includes(searchText(query));

export const vehicleSourceLabel = (vehicle: Pick<Vehicle, 'mode'>) => vehicle.mode === 'ship' ? 'Fintraffic AIS' : vehicle.mode === 'train' ? 'Fintraffic rail' : 'HSL';
export function marineSourceLabel(source?: MarineStatus): string {
  if (!source) return 'Starting';
  if (source.stale) return 'Stale source';
  if (source.periodic) return 'Periodic updates';
  if (source.degraded) return 'Degraded updates';
  return source.state === 'live' ? 'Live updates' : source.state === 'reconnecting' ? 'Reconnecting' : source.state === 'connecting' ? 'Connecting' : 'Waiting for reports';
}
