import type { Vehicle, TransitMode } from '../types.ts';

/** HFP topic IDs preserve their zero padding; payload oper may be a subcontractor. */
export function decodeHfp(topic: string, payload: unknown, receivedAt: string): Vehicle {
  const fields = topic.split('/');
  if (fields.slice(0, 6).join('/') !== '/hfp/v2/journey/ongoing/vp'
      || !['tram', 'bus', 'ferry'].includes(fields[6]) || fields.length < 14
      || !/^\d+$/.test(fields[7]) || !/^\d+$/.test(fields[8]) || !fields[9]) {
    throw new Error('Invalid HFP vehicle-position topic');
  }
  if (!payload || typeof payload !== 'object' || !('VP' in payload)
      || !payload.VP || typeof payload.VP !== 'object') throw new Error('Missing HFP VP');
  const vp = payload.VP as Record<string, unknown>;
  const numeric = (key: string): number | null => {
    const value = vp[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid HFP ${key}`);
    return value;
  };
  const reportedTime = typeof vp.tst === 'string' && /Z$/.test(vp.tst) ? Date.parse(vp.tst) : NaN;
  if (!Number.isFinite(reportedTime)) throw new Error('Invalid HFP timestamp');
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('Invalid reception time');
  const longitude = numeric('long');
  const latitude = numeric('lat');
  if ((longitude !== null && Math.abs(longitude) > 180) || (latitude !== null && Math.abs(latitude) > 90)) {
    throw new Error('Invalid HFP position');
  }
  const optionalString = (key: string): string | null => {
    const value = vp[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error(`Invalid HFP ${key}`);
    return value;
  };
  const serviceDate = optionalString('oday');
  if (serviceDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error('Invalid HFP service date');
  const startTime = optionalString('start') ?? fields[12];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new Error('Invalid HFP departure time');
  const oper = vp.oper;
  if (oper !== null && oper !== undefined && typeof oper !== 'number' && typeof oper !== 'string') throw new Error('Invalid operating operator');
  const journey = vp.jrn;
  if (journey != null && typeof journey !== 'string' && (typeof journey !== 'number' || !Number.isSafeInteger(journey))) throw new Error('Invalid HFP journey reference');
  const nextStopId = fields[13] || null;
  if (nextStopId !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(nextStopId)) throw new Error('Invalid HFP next stop');
  const deviation = numeric('dl');
  return {
    id: `${fields[7]}/${fields[8]}`, mode: fields[6] as TransitMode,
    ownerOperatorId: fields[7], vehicleId: fields[8], operatingOperatorId: oper == null ? null : String(oper),
    routeId: fields[9], directionId: ['1', '2'].includes(fields[10]) ? fields[10] : null,
    serviceDate, startTime, journeyReference: journey == null ? null : String(journey), nextStopId,
    reportedAt: new Date(reportedTime).toISOString(), receivedAt,
    longitude, latitude, speedMetresPerSecond: numeric('spd'), headingDegrees: numeric('hdg'),
    rawDeviationSeconds: deviation, delaySeconds: deviation === null ? null : -deviation,
    quality: longitude === null || latitude === null ? ['position-missing'] : [], sourceId: 'hsl-hfp'
  };
}

/** Geohash topics repeat the same timestamp; count only independent reports. */
export function uniqueHfpReports(vehicles: Vehicle[]): Vehicle[] {
  return [...new Map(vehicles.map((vehicle) => [`${vehicle.id}/${vehicle.reportedAt}`, vehicle])).values()];
}

export function cadenceSeconds(vehicles: Vehicle[]): number[] {
  const times = new Map<string, number[]>();
  for (const vehicle of uniqueHfpReports(vehicles)) {
    const list = times.get(vehicle.id) ?? [];
    list.push(Date.parse(vehicle.reportedAt)); times.set(vehicle.id, list);
  }
  return [...times.values()].flatMap((list) => list.sort((a, b) => a - b).slice(1).map((value, index) => (value - list[index]) / 1000));
}

/** One current position per stable vehicle, even if delivery arrives out of order. */
export function latestHfpVehicles(reports: Vehicle[]): Vehicle[] {
  return [...new Map([...reports].sort((a, b) => Date.parse(a.reportedAt) - Date.parse(b.reportedAt)).map((report) => [report.id, report])).values()];
}
