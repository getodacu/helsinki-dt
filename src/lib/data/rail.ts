import type { Vehicle } from '../types.ts';
import { railDate, railNumber, railId, railDelay, type RailStation, type RailSummary, type RailJourney, type RailEvent, type RailDeparture } from '../rail.ts';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid rail object');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 200): string | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid rail text');
  return value;
};
const time = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('Invalid rail timestamp');
  return new Date(value).toISOString();
};
const number = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Invalid rail number');
  return value;
};
export function emptyRail(trainNumber: string, departureDate: string | null): RailSummary {
  return { trainNumber, departureDate, label: `Train ${trainNumber}`, category: 'other', trainType: null,
    operator: null, origin: null, destination: null, cancelled: false, nextEvent: null, timetableAt: null };
}
export function decodeRailPosition(value: unknown, receivedAt: string): Vehicle {
  const row = object(value), location = object(row.location), coordinates = location.coordinates;
  if (location.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2) throw new Error('Invalid train point');
  const trainNumber = railNumber(row.trainNumber), date = row.departureDate == null || row.departureDate === '' ? null : row.departureDate;
  if (date !== null && !railDate(date)) throw new Error('Invalid departure date');
  const reportedAt = time(row.timestamp); if (!reportedAt || !time(receivedAt)) throw new Error('Missing position time');
  return { id: railId(date, trainNumber), mode: 'train', ownerOperatorId: null, vehicleId: trainNumber,
    operatingOperatorId: null, routeId: `rail:${trainNumber}`, directionId: null, serviceDate: date,
    startTime: null, journeyReference: date ? `${trainNumber}_${date.replaceAll('-', '')}` : null,
    reportedAt, receivedAt, longitude: number(coordinates[0], -180, 180), latitude: number(coordinates[1], -90, 90),
    speedMetresPerSecond: row.speed == null ? null : number(row.speed, 0, 360) / 3.6, headingDegrees: null,
    rawDeviationSeconds: null, delaySeconds: null, quality: [...(date ? [] : ['journey-date-missing']), ...(row.isGpsLocation === false ? ['position-not-gps'] : [])],
    sourceId: 'digitraffic', rail: emptyRail(trainNumber, date) };
}
export function decodeRailStations(value: unknown): RailStation[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('Invalid rail station catalog');
  const codes = new Set<string>();
  return value.map(value => {
    const row = object(value), code = text(row.stationShortCode, 12), name = text(row.stationName);
    if (!code || !/^[A-ZÄÖÅ0-9_-]+$/.test(code) || !name || typeof row.passengerTraffic !== 'boolean' || codes.has(code)) throw new Error('Invalid rail station');
    codes.add(code);
    return { code, name, passenger: row.passengerTraffic, longitude: number(row.longitude, -180, 180), latitude: number(row.latitude, -90, 90) };
  });
}
export function decodeRailJourney(value: unknown, stations: RailStation[], retrievedAt: string, now = Date.now()): RailJourney {
  const row = object(value), trainNumber = railNumber(row.trainNumber);
  if (!railDate(row.departureDate) || !Array.isArray(row.timeTableRows) || row.timeTableRows.length > 2000) throw new Error('Invalid train timetable');
  const names = new Map(stations.map(station => [station.code, station.name]));
  const events: RailEvent[] = row.timeTableRows.map(value => {
    const event = object(value), stationCode = text(event.stationShortCode, 12), scheduledAt = time(event.scheduledTime);
    if (!stationCode || !scheduledAt || !['ARRIVAL', 'DEPARTURE'].includes(String(event.type))) throw new Error('Invalid timetable event');
    return { stationCode, stationName: names.get(stationCode) ?? stationCode, type: event.type as RailEvent['type'], scheduledAt,
      estimatedAt: time(event.liveEstimateTime), actualAt: time(event.actualTime), platform: text(event.commercialTrack, 30),
      cancelled: event.cancelled === true, commercial: event.commercialStop === true, stopping: event.trainStopping === true };
  });
  const category = text(row.trainCategory), trainType = text(row.trainType, 30), line = text(row.commuterLineID, 30);
  const stopping = events.filter(event => event.stopping);
  const lastActual = events.findLastIndex(event => event.actualAt !== null);
  const nextEvent = events.find((event, index) => index > lastActual && event.stopping && !event.actualAt && !event.cancelled
    && (lastActual >= 0 || Date.parse(event.estimatedAt ?? event.scheduledAt) >= now)) ?? null;
  const summary: RailSummary = { ...emptyRail(trainNumber, row.departureDate), label: line || [trainType ?? 'Train', trainNumber].join(' '),
    category: category === 'Commuter' ? 'commuter' : category === 'Long-distance' ? 'long-distance' : /cargo|freight/i.test(category ?? '') ? 'freight' : 'other',
    trainType, operator: text(row.operatorShortCode, 60), origin: stopping[0]?.stationName ?? events[0]?.stationName ?? null,
    destination: stopping.at(-1)?.stationName ?? events.at(-1)?.stationName ?? null,
    cancelled: row.cancelled === true, nextEvent, timetableAt: retrievedAt };
  return { summary, events };
}
export function withRailJourney(vehicle: Vehicle, journey: RailJourney): Vehicle {
  if (!vehicle.rail || vehicle.id !== railId(journey.summary.departureDate, journey.summary.trainNumber)) return vehicle;
  return { ...vehicle, rail: journey.summary, operatingOperatorId: journey.summary.operator, delaySeconds: railDelay(journey.summary.nextEvent) };
}
export function railDepartures(journeys: RailJourney[], stationCode: string, now = Date.now()): RailDeparture[] {
  const departures = journeys.filter(journey => ['commuter', 'long-distance'].includes(journey.summary.category)).flatMap(journey => journey.events
    .filter(event => event.stationCode === stationCode && event.type === 'DEPARTURE' && event.stopping && event.commercial && !event.actualAt
      && Date.parse(event.estimatedAt ?? event.scheduledAt) >= now - (event.cancelled || journey.summary.cancelled ? 300_000 : 0))
    .map(event => ({ id: railId(journey.summary.departureDate, journey.summary.trainNumber), summary: journey.summary, event })));
  return [...new Map(departures.map(departure => [`${departure.id}:${departure.event.scheduledAt}`, departure])).values()]
    .sort((a, b) => Date.parse(a.event.estimatedAt ?? a.event.scheduledAt) - Date.parse(b.event.estimatedAt ?? b.event.scheduledAt)).slice(0, 12);
}
