import type { Vehicle } from '../types.ts';
import { compareMarinePositions, KNOTS_TO_METRES_PER_SECOND, MARINE_FUTURE_TOLERANCE_MS, type MarineMetadata, type MarineSummary } from '../marine.ts';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid marine object');
  return value as Record<string, unknown>;
};
export function marineMmsi(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100_000_000 && value < 1_000_000_000) return String(value);
  if (typeof value === 'string' && /^\d{9}$/.test(value) && /[1-9]/.test(value)) return value;
  throw new Error('Invalid marine MMSI');
}
const epoch = (value: unknown, scale: number, now: number): string => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(now)
    || !Number.isSafeInteger(value * scale) || value * scale > now + MARINE_FUTURE_TOLERANCE_MS) throw new Error('Invalid marine record time');
  return new Date(value * scale).toISOString();
};
const receipt = (value: string): string => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid marine receipt time');
  return new Date(value).toISOString();
};
const number = (value: unknown, min: number, max: number, integer = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error('Invalid marine number');
  return value;
};
const optionalNumber = (value: unknown, min: number, max: number, integer = false) => value == null ? null : number(value, min, max, integer);
const boolean = (value: unknown): boolean | null => {
  if (value == null) return null;
  if (typeof value !== 'boolean') throw new Error('Invalid marine boolean');
  return value;
};
function position(mmsi: string, longitude: unknown, latitude: unknown, row: Record<string, unknown>, reportedAt: string, receivedAt: string, source: MarineSummary['positionSource']): Vehicle {
  const quality: string[] = [], speed = optionalNumber(row.sog, 0, 102.3), course = optionalNumber(row.cog, 0, 360);
  const heading = row.heading === 511 ? null : optionalNumber(row.heading, 0, 359, true);
  const nav = optionalNumber(row.navStat, 0, 15, true), positionAccuracy = boolean(row.posAcc), raim = boolean(row.raim);
  const positionSecond = source === 'rest' ? optionalNumber(row.timestamp, 0, 63, true) : null;
  if (speed === 102.3) quality.push('speed-unavailable');
  if (speed === 102.2) quality.push('speed-capped');
  if (positionAccuracy === false) quality.push('position-low-accuracy');
  if (positionSecond === 60) quality.push('position-second-unavailable');
  if (positionSecond === 61) quality.push('position-manual');
  if (positionSecond === 62) quality.push('position-estimated');
  if (positionSecond === 63) quality.push('position-inoperative');
  return { id: `ais:${mmsi}`, mode: 'ship', ownerOperatorId: null, vehicleId: mmsi, operatingOperatorId: null,
    routeId: null, directionId: null, serviceDate: null, startTime: null, journeyReference: null,
    reportedAt, receivedAt: receipt(receivedAt), longitude: number(longitude, -180, 180), latitude: number(latitude, -90, 90),
    speedMetresPerSecond: speed === null || speed >= 102.2 ? null : speed * KNOTS_TO_METRES_PER_SECOND,
    headingDegrees: heading, rawDeviationSeconds: null, delaySeconds: null, quality, sourceId: 'digitraffic-marine',
    marine: { mmsi, positionSource: source, imo: null, name: null, callSign: null, shipType: null, navigationStatus: nav === 15 ? null : nav,
      courseOverGroundDegrees: course === 360 ? null : course, positionAccuracy, raim, positionSecond, metadataReportedAt: null, metadataReceivedAt: null } };
}
export function decodeMarineRestPosition(value: unknown, receivedAt: string, now = Date.now()): Vehicle {
  const feature = object(value), geometry = object(feature.geometry), row = object(feature.properties), coordinates = geometry.coordinates;
  if (feature.type !== 'Feature' || geometry.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2) throw new Error('Invalid marine point');
  const mmsi = marineMmsi(row.mmsi);
  if (marineMmsi(feature.mmsi ?? feature.id) !== mmsi || (feature.id != null && marineMmsi(feature.id) !== mmsi)) throw new Error('Conflicting marine MMSI');
  return position(mmsi, coordinates[0], coordinates[1], row, epoch(row.timestampExternal, 1, now), receivedAt, 'rest');
}
export function decodeMarineMqttPosition(topic: string, payload: unknown, receivedAt: string, now = Date.now()): Vehicle {
  const match = /^vessels-v2\/(\d{9})\/location$/.exec(topic);
  if (!match) throw new Error('Invalid marine location topic');
  const mmsi = marineMmsi(match[1]), row = object(payload);
  if (row.mmsi != null && marineMmsi(row.mmsi) !== mmsi) throw new Error('Conflicting marine MMSI');
  return position(mmsi, row.lon, row.lat, row, epoch(row.time, 1000, now), receivedAt, 'mqtt');
}
const text = (value: unknown, max: number, field: string, quality: string[]): string | null => {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max) { quality.push(`metadata-${field}-invalid`); return null; }
  return value.replace(/^[@\s]+|[@\s]+$/g, '') || null;
};
const imo = (value: unknown, quality: string[]): string | null => {
  if (value == null || value === 0 || value === '0') return null;
  const digits = typeof value === 'number' && Number.isInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9]\d{6}$/.test(digits) || [...digits.slice(0, 6)].reduce((sum, digit, i) => sum + Number(digit) * (7 - i), 0) % 10 !== Number(digits[6])) {
    quality.push('metadata-imo-invalid'); return null;
  }
  return digits;
};
export function decodeMarineMetadata(value: unknown, mmsiValue: unknown, receivedAt: string, now = Date.now()): MarineMetadata {
  const row = object(value), mmsi = marineMmsi(mmsiValue), quality: string[] = [];
  if (row.mmsi != null && marineMmsi(row.mmsi) !== mmsi) throw new Error('Conflicting marine metadata MMSI');
  const type = row.shipType ?? row.type;
  let shipType: number | null = null;
  if (type != null && type !== 0) {
    if (typeof type === 'number' && Number.isInteger(type) && type > 0 && type <= 99) shipType = type;
    else quality.push('metadata-type-invalid');
  }
  if (row.shipType != null && row.type != null && row.shipType !== row.type) { shipType = null; quality.push('metadata-type-conflict'); }
  return { mmsi, imo: imo(row.imo, quality), name: text(row.name, 80, 'name', quality), callSign: text(row.callSign, 20, 'call-sign', quality), shipType,
    reportedAt: epoch(row.timestamp, 1, now), receivedAt: receipt(receivedAt), quality };
}
export function decodeMarineStatus(value: unknown, now = Date.now()): string {
  return epoch(object(value).updated, 1000, now);
}
export function withMarineMetadata(vehicle: Vehicle, metadata: MarineMetadata): Vehicle {
  if (!vehicle.marine || vehicle.marine.mmsi !== metadata.mmsi) return vehicle;
  const oldTime = vehicle.marine.metadataReportedAt;
  if (oldTime !== null && Date.parse(metadata.reportedAt) <= Date.parse(oldTime)) return vehicle;
  return { ...vehicle, quality: [...vehicle.quality.filter(flag => !flag.startsWith('metadata-')), ...metadata.quality],
    marine: { ...vehicle.marine, imo: metadata.imo, name: metadata.name, callSign: metadata.callSign, shipType: metadata.shipType,
      metadataReportedAt: metadata.reportedAt, metadataReceivedAt: metadata.receivedAt } };
}
export function mergeMarinePosition(previous: Vehicle, next: Vehicle): Vehicle {
  if (compareMarinePositions(previous, next) !== 'newer') return previous;
  const sameSecondConflict = Math.floor(Date.parse(previous.reportedAt) / 1000) === Math.floor(Date.parse(next.reportedAt) / 1000)
    && (previous.longitude !== next.longitude || previous.latitude !== next.latitude);
  const metadataTime = previous.marine!.metadataReportedAt;
  const merged = metadataTime === null ? next : withMarineMetadata(next, { mmsi: previous.marine!.mmsi,
    imo: previous.marine!.imo, name: previous.marine!.name, callSign: previous.marine!.callSign, shipType: previous.marine!.shipType,
    reportedAt: metadataTime, receivedAt: previous.marine!.metadataReceivedAt!, quality: previous.quality.filter(flag => flag.startsWith('metadata-')) });
  return sameSecondConflict ? { ...merged, quality: [...merged.quality, 'position-same-second-conflict'] } : merged;
}
