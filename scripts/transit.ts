import mqtt from 'mqtt';
import { mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DatasetSource, GateResult, ProbeEvidence, TransitMode, Vehicle } from '../src/lib/types.ts';
import { RELEASE_BOUNDS, inBounds } from '../src/lib/area.ts';
import { cadenceSeconds, decodeHfp, latestHfpVehicles, uniqueHfpReports } from '../src/lib/data/hfp.ts';
import { matchJourney, readGtfsSnapshot, type GtfsSnapshot, type JourneyMatch } from '../src/lib/data/gtfs.ts';
import { downloadFile } from '../src/lib/server/io.ts';

const BROKER = 'mqtts://mqtt.hsl.fi:8883';
const coarseTopic = (mode: string) => `/hfp/v2/journey/ongoing/vp/${mode}/+/+/+/+/+/+/+/+/60;24/19/#`;
const GTFS_URL = 'https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip';
export interface HfpRawSample { topic: string; payload: unknown; receivedAt: string }
export interface TransitProbeResult {
  vehicles: Vehicle[];
  sources: DatasetSource[];
  evidence: ProbeEvidence[];
  gates: Record<string, GateResult>;
  gtfsMatch: JourneyMatch;
  gtfsSnapshot: GtfsSnapshot | null;
  rawSamples: HfpRawSample[];
}

async function sampleHfp(durationMs: number): Promise<{ samples: HfpRawSample[]; vehicles: Vehicle[]; evidence: ProbeEvidence[] }> {
  if (durationMs < 1000 || durationMs > 60_000) throw new Error('HFP probe duration must be 1–60 seconds');
  const started = Date.now();
  const receivedAt = new Date().toISOString();
  const samples: HfpRawSample[] = [];
  const vehicles: Vehicle[] = [];
  const seen = new Set<string>();
  const followed = new Map<TransitMode, string>();
  const counts = { messages: 0, bytes: 0, rejected: 0, error: '' };
  await new Promise<void>((resolve) => {
    const client = mqtt.connect(BROKER, { connectTimeout: 12_000, reconnectPeriod: 0, rejectUnauthorized: true, protocolVersion: 4, clean: true });
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) counts.error = error.message;
      client.end(true); resolve();
    };
    const timer = setTimeout(() => finish(), durationMs);
    client.on('error', (error) => finish(error));
    client.on('connect', () => {
      client.subscribe(['tram', 'bus', 'ferry'].map(coarseTopic), { qos: 0 }, (error) => { if (error) finish(error); });
    });
    client.on('message', (topic, bytes) => {
      if (done) return;
      counts.messages++; counts.bytes += bytes.length;
      if (counts.messages > 10000 || counts.bytes > 4 * 1024 ** 2 || bytes.length > 32 * 1024) { finish(new Error('HFP message/byte limit reached')); return; }
      try {
        const sample = { topic, payload: JSON.parse(bytes.toString('utf8')) as unknown, receivedAt: new Date().toISOString() };
        const vehicle = decodeHfp(topic, sample.payload, sample.receivedAt);
        const inside = vehicle.longitude !== null && vehicle.latitude !== null && inBounds(vehicle.longitude, vehicle.latitude, RELEASE_BOUNDS);
        if (!inside && followed.get(vehicle.mode) !== vehicle.id) return;
        if (!followed.has(vehicle.mode) && inside) {
          followed.set(vehicle.mode, vehicle.id);
          client.unsubscribe(coarseTopic(vehicle.mode));
          client.subscribe(`/hfp/v2/journey/ongoing/vp/${vehicle.mode}/${vehicle.ownerOperatorId}/${vehicle.vehicleId}/#`, { qos: 0 }, (error) => { if (error) finish(error); });
        }
        const identity = `${vehicle.id}/${vehicle.reportedAt}`;
        if (seen.has(identity)) return; seen.add(identity);
        if (vehicles.length >= 150) return;
        vehicles.push(vehicle); samples.push(sample);
      } catch { counts.rejected++; }
    });
  });
  const evidence: ProbeEvidence[] = (['tram', 'bus', 'ferry'] as const).map((mode) => {
    const modeVehicles = uniqueHfpReports(vehicles.filter((vehicle) => vehicle.mode === mode));
    const intervals = cadenceSeconds(modeVehicles);
    const latest = modeVehicles.length ? Math.max(...modeVehicles.map((vehicle) => Date.parse(vehicle.reportedAt))) : null;
    return { id: `hfp-${mode}`, url: BROKER, queriedAt: receivedAt, durationMs: Date.now() - started,
      status: counts.error ? 'failed' : 'bounded MQTT session completed', decodedCount: modeVehicles.length, bytes: counts.bytes,
      freshness: latest === null ? null : `${Math.round((Date.now() - latest) / 1000)} seconds since latest report`, authentication: 'Anonymous MQTT over TLS; no API key',
      notes: [...(counts.error ? [counts.error] : []), `Coarse region /60;24/19/# until first in-bounds vehicle per mode, then follow selected vehicle; duration <= ${durationMs} ms`,
        `Session totals: ${counts.messages} messages, ${counts.rejected} rejected payloads; byte count shared by mode probes`,
        `Independent owner/id/tst reports: ${modeVehicles.length}; null positions: ${modeVehicles.filter((vehicle) => vehicle.longitude === null || vehicle.latitude === null).length}`,
        `Observed intervals seconds: ${intervals.length ? `${Math.min(...intervals)}–${Math.max(...intervals)}` : 'insufficient repeated reports'}`,
        `One selected ${mode} vehicle followed without geographic filter to include null positions: ${followed.get(mode) ?? 'none'}`,
        'HFP dl is timetable deviation: normalized displayed delaySeconds = -dl; raw deviation retained'] };
  });
  return { samples, vehicles, evidence };
}

export async function probeTransit(durationMs = 30_000): Promise<TransitProbeResult> {
  const hfp = await sampleHfp(durationMs);
  const result: TransitProbeResult = { vehicles: latestHfpVehicles(hfp.vehicles), sources: [], evidence: hfp.evidence, gates: {}, rawSamples: hfp.samples,
    gtfsMatch: { vehicleId: '', tripId: null, status: 'missing', candidates: [], departureAt: null, firstStopId: null }, gtfsSnapshot: null };
  const retrievedAt = new Date().toISOString();
  result.sources.push({ id: 'hsl-hfp', provider: 'Helsinki Region Transport (HSL)', url: BROKER, license: 'CC BY 4.0',
    attribution: 'HSL / Digitransit', retrievedAt, vintage: hfp.vehicles.length ? hfp.vehicles[0].reportedAt : null,
    units: ['m/s', 'degrees', 'seconds'], coverage: `Release bounds; ${result.vehicles.length} distinct vehicles, ${hfp.vehicles.length} independent reports`, method: 'bounded HFP vehicle position subscription',
    checksum: null, coordinateReference: 'WGS84 / EPSG:4326', axisOrder: 'named payload long / lat fields', verticalReference: null });
  for (const mode of ['tram', 'bus', 'ferry'] as const) {
    const count = result.vehicles.filter((vehicle) => vehicle.mode === mode).length;
    result.gates[mode] = { status: count ? 'pass' : 'blocked', evidence: [`hfp-${mode}: ${count} distinct vehicles; ${hfp.evidence.find((entry) => entry.id === `hfp-${mode}`)!.decodedCount} real decoded reports`], nextAction: count ? null : `Repeat bounded ${mode} probe during service; absence in one window is not absence of coverage` };
  }
  const selected = result.vehicles.find((vehicle) => vehicle.mode === 'tram' && vehicle.serviceDate && vehicle.startTime && vehicle.directionId)
    ?? result.vehicles.find((vehicle) => vehicle.serviceDate && vehicle.startTime && vehicle.directionId);
  if (!selected?.serviceDate) { result.gates.gtfs_journey = { status: 'blocked', evidence: ['No usable real HFP journey in bounded session'], nextAction: 'Repeat HFP probe before checking GTFS' }; return result; }
  try {
    await mkdir('.cache/task-a', { recursive: true });
    const cache = '.cache/task-a/hsl-gtfs.zip';
    const existing = await stat(cache).catch(() => null);
    const response = existing && Date.now() - existing.mtimeMs < 3600_000 && existing.size <= 128 * 1024 ** 2
      ? { bytes: existing.size, sha256: null, durationMs: 0, status: 'one-hour bounded cache', retrievedAt: new Date(existing.mtimeMs).toISOString() }
      : await downloadFile(GTFS_URL, cache, { maxBytes: 128 * 1024 ** 2, timeoutMs: 120_000 });
    if (!response.sha256) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(cache)) hash.update(chunk);
      response.sha256 = hash.digest('hex');
    }
    const snapshot = await readGtfsSnapshot(cache, selected.routeId, selected.serviceDate);
    result.gtfsSnapshot = snapshot; result.gtfsMatch = matchJourney(selected, snapshot);
    result.evidence.push({ id: 'hsl-gtfs', url: GTFS_URL, queriedAt: response.retrievedAt, durationMs: response.durationMs,
      status: response.status, decodedCount: snapshot.trips.length, bytes: response.bytes, freshness: `${Math.round((Date.now() - Date.parse(response.retrievedAt)) / 1000)} seconds since GTFS ZIP retrieval`, authentication: 'Anonymous GTFS ZIP; no API key',
      notes: [`Filtered route ${selected.routeId}, service ${selected.serviceDate}; ${snapshot.scannedRows} scanned CSV rows, ${snapshot.inflatedBytes} inflated bytes`,
        `Match ${result.gtfsMatch.status}; candidates ${result.gtfsMatch.candidates.join(', ') || 'none'}; first stop ${result.gtfsMatch.firstStopId ?? 'unknown'}, departure ${result.gtfsMatch.departureAt ?? 'unknown'}`, 'Route ID + direction 1/2→0/1 + active calendar/exception + first-stop departure clock; labels not used',
        'GTFS ZIP <=128 MiB; aggregate inflation <=1536 MiB, individual entry <=1024 MiB; retained <=5000 selected trips'] });
    result.sources.push({ id: 'hsl-gtfs', provider: 'Helsinki Region Transport (HSL)', url: GTFS_URL, license: 'CC BY 4.0', attribution: 'HSL / Digitransit',
      retrievedAt: response.retrievedAt, vintage: snapshot.feedInfo.map((row) => `${row.feed_start_date ?? ''}–${row.feed_end_date ?? ''} ${row.feed_version ?? ''}`).join('; ') || selected.serviceDate,
      units: ['service-day seconds'], coverage: `Filtered active route ${selected.routeId}`, method: 'streamed ZIP/CSV, earliest stop retained for active route trips',
      checksum: response.sha256, coordinateReference: null, axisOrder: null, verticalReference: null });
    result.gates.gtfs_journey = { status: result.gtfsMatch.status === 'exact' ? 'pass' : 'blocked',
      evidence: [`${selected.id} ${selected.serviceDate} ${selected.routeId}/${selected.directionId} ${selected.startTime}: ${result.gtfsMatch.status} ${result.gtfsMatch.tripId ?? ''}`],
      nextAction: result.gtfsMatch.status === 'exact' ? null : 'Inspect current GTFS/service calendar; retain unknown for missing or ambiguous journeys' };
  } catch (error) { result.gates.gtfs_journey = { status: 'blocked', evidence: [String(error)], nextAction: 'Retry/inspect bounded GTFS download and selected journey' }; }
  return result;
}
