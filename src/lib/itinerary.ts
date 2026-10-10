import type { Vehicle, TransitMode } from './types.ts';
import type { RouteContext } from './route-context.ts';
import { railId, type RailEvent, type RailJourney, type RailResult, type RailStation } from './rail.ts';
import { trafficIsStale } from './traffic.ts';

export type ItineraryState = 'visited' | 'elapsed' | 'current' | 'next' | 'upcoming' | 'cancelled' | 'unknown';
export interface ItineraryStop {
  key: string; id: string; name: string; sequence: number;
  longitude: number | null; latitude: number | null;
  expectedAt: string | null; actualAt: string | null; platform: string | null;
  state: ItineraryState; minutes: number | null; estimated: boolean;
}
export interface VehicleItinerary {
  vehicleId: string; mode: TransitMode; stops: ItineraryStop[];
  stale: boolean; progressKnown: boolean; reason: string | null;
}

export function buildItinerary(vehicle: Vehicle, route: RouteContext | null, journey: RailResult<RailJourney> | null,
  stations: RailStation[], now: number, removed = false): VehicleItinerary {
  const result: VehicleItinerary = { vehicleId: vehicle.id, mode: vehicle.mode, stops: [],
    stale: removed || trafficIsStale(vehicle, now), progressKnown: false, reason: null };
  if (vehicle.mode === 'train') {
    const data = journey?.data;
    if (!journey || !data || railId(data.summary.departureDate, data.summary.trainNumber) !== vehicle.id) {
      result.reason = journey?.error ?? 'Train itinerary unavailable.'; return result;
    }
    const checked = Date.parse(journey.retrievedAt ?? data.summary.timetableAt ?? '');
    result.stale ||= journey.state !== 'ready' || !!data.summary.timetableStale || !Number.isFinite(checked) || now - checked >= 60_000;
    const groups: { arrival?: RailEvent; departure?: RailEvent; first: number; last: number }[] = [];
    data.events.forEach((event, index) => {
      if (!event.stopping) return;
      const previous = groups.at(-1);
      if (event.type === 'DEPARTURE' && previous?.arrival?.stationCode === event.stationCode && !previous.departure) {
        previous.departure = event; previous.last = index;
      } else groups.push({ [event.type === 'ARRIVAL' ? 'arrival' : 'departure']: event, first: index, last: index });
    });
    const lastActual = data.events.findLastIndex(event => event.actualAt !== null);
    const progressAt = result.stale && Number.isFinite(checked) ? checked : now;
    const stationByCode = new Map(stations.map(station => [station.code, station]));
    result.stops = groups.map((group, index) => {
      const event = group.arrival ?? group.departure!;
      const station = stationByCode.get(event.stationCode);
      let state: ItineraryState = 'upcoming';
      if (data.summary.cancelled || group.arrival?.cancelled || group.departure?.cancelled) state = 'cancelled';
      else if (group.departure?.actualAt || (!group.departure && group.arrival?.actualAt) || group.last < lastActual) state = 'visited';
      else if (group.arrival?.actualAt) state = 'current';
      else if (lastActual < 0) {
        const end = group.departure ?? event;
        if (Date.parse(end.estimatedAt ?? end.scheduledAt) < progressAt) state = 'elapsed';
      }
      const time = state === 'current' ? group.departure ?? event : event;
      return { key: `${vehicle.id}/${group.first}`, id: event.stationCode, name: event.stationName, sequence: index + 1,
        longitude: station?.longitude ?? null, latitude: station?.latitude ?? null,
        expectedAt: time.estimatedAt ?? time.scheduledAt, actualAt: group.departure?.actualAt ?? group.arrival?.actualAt ?? null,
        platform: group.departure?.platform ?? group.arrival?.platform ?? null, state, minutes: null, estimated: time.estimatedAt !== null };
    });
    const next = result.stops.find(stop => stop.state === 'upcoming'); if (next) next.state = 'next';
    result.progressKnown = lastActual >= 0;
    if (result.stops.some(stop => stop.state === 'elapsed')) result.reason = 'Progress follows the timetable · actual station reports unavailable.';
  } else if (vehicle.mode === 'bus' || vehicle.mode === 'tram') {
    if (route?.status !== 'exact' || route.vehicleId !== vehicle.id) {
      result.reason = route?.vehicleId === vehicle.id ? route.reason : 'Journey itinerary unavailable.'; return result;
    }
    const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence);
    const matches = stops.flatMap((stop, index) => stop.id === vehicle.nextStopId ? [index] : []);
    const next = vehicle.nextStopId === 'EOL' ? stops.length : matches.length === 1 ? matches[0] : -1;
    result.progressKnown = next >= 0;
    if (!result.progressKnown) result.reason = 'Progress unavailable · the reported next stop could not be matched uniquely.';
    const delay = vehicle.delaySeconds !== null && Number.isFinite(vehicle.delaySeconds) ? vehicle.delaySeconds : null;
    // shortcut: carry the current delay through future stops; use per-stop forecasts when available.
    result.stops = stops.map((stop, index) => {
      const scheduled = stop.arrivalAt ?? stop.departureAt;
      return { key: `${vehicle.id}/${stop.sequence}`, id: stop.id, name: stop.name, sequence: stop.sequence,
        longitude: stop.longitude, latitude: stop.latitude,
        expectedAt: scheduled ? new Date(Date.parse(scheduled) + (delay ?? 0) * 1000).toISOString() : null,
        actualAt: null, platform: null, state: next < 0 ? 'unknown' : index < next ? 'visited' : index === next ? 'next' : 'upcoming',
        minutes: null, estimated: delay !== null };
    });
  }
  for (const stop of result.stops) {
    if (!result.stale && stop.expectedAt && ['next', 'upcoming', 'unknown'].includes(stop.state)) {
      const remaining = Date.parse(stop.expectedAt) - now;
      if (Number.isFinite(remaining)) stop.minutes = Math.max(0, Math.ceil(remaining / 60_000));
    }
  }
  return result;
}

export function itineraryStopLabel(stop: ItineraryStop): string {
  if (stop.state === 'visited') return 'Visited';
  if (stop.state === 'elapsed') return `${stop.estimated ? 'Estimated' : 'Scheduled'} earlier`;
  if (stop.state === 'current') return 'At station';
  if (stop.state === 'cancelled') return 'Cancelled';
  const time = stop.minutes === null ? 'Time unavailable' : `${stop.minutes} min · ${stop.estimated ? 'Estimated' : 'Scheduled'}`;
  return stop.state === 'next' ? `Next · ${time}` : time;
}
export function itineraryTime(value: string | null): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
}
