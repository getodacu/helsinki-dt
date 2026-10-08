import type { Building, Vehicle } from './types.ts';

export const ON_TIME_BAND_SECONDS = 60;
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
export function buildingAttribute(building: Building, names: string[]): string | null {
  return Object.entries(building.attributes).find(([key, value]) => names.some(name => searchText(name) === searchText(key)) && value?.trim())?.[1] ?? null;
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
export const buildingName = (building: Building) => buildingAttribute(building, ['name', 'nimi', 'rakennuksen_nimi']) ?? buildingAddress(building) ?? building.gmlId;
export const matchesBuilding = (building: Building, query: string) => searchText([buildingName(building), buildingAddress(building), building.id,
  building.gmlId, building.vtjPrt, building.ratu, building.uuid].filter(Boolean).join(' ')).includes(searchText(query));
export const matchesVehicle = (vehicle: Vehicle, query: string, routeLabel?: string) => searchText(`${vehicle.mode} ${vehicle.routeId} ${routeLabel ?? ''} ${vehicle.id} ${vehicle.ownerOperatorId}/${vehicle.vehicleId}`).includes(searchText(query));
