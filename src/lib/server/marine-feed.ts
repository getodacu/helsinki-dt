import { randomUUID } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import { RELEASE_BOUNDS, inBounds } from '../area.ts';
import { decodeMarineMetadata, decodeMarineMqttPosition, decodeMarineRestPosition, decodeMarineStatus, withMarineMetadata, mergeMarinePosition } from '../data/marine.ts';
import { compareMarinePositions, marineMotionPlausible, MARINE_STATIONARY_REMOVE_MS,
  type MarineMetadata, type MarineStatus } from '../marine.ts';
import { trafficShouldRemove } from '../traffic.ts';
import type { Vehicle } from '../types.ts';
import { requestText, UpstreamHttpError, type RequestOptions } from './io.ts';

export interface MarineFeedUpdate { vehicles: Vehicle[]; status: MarineStatus }
export interface MarineSource { start(listener: (update: MarineFeedUpdate) => void): void; stop(): void; diagnostics?(): object }
export type MarineConnection = Pick<MqttClient, 'on' | 'subscribe' | 'end'>;
export type FetchMarine = (url: string, options: RequestOptions) => Promise<{ body: string }>;
export interface MarineFeedOptions {
  connector?: () => MarineConnection; fetcher?: FetchMarine; now?: () => number; random?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}
export const MARINE_TOPICS = ['vessels-v2/+/location', 'vessels-v2/+/metadata', 'vessels-v2/status'];
export const MARINE_LIMITS = { vehicles: 250, metadata: 500, identities: 1_000, metadataQueue: 250,
  metadataConcurrent: 2, metadataPerMinute: 20, restBytes: 8 * 1024 * 1024,
  payloadBytes: 32 * 1024, messagesPerSecond: 1_000, bytesPerSecond: 1024 * 1024 } as const;
const API = 'https://meri.digitraffic.fi/api/ais/v1/';
const REST_INTERVAL = 60_000, QUIET_MS = 120_000, METADATA_TTL = 6 * 60 * 60_000, MISS_TTL = 15 * 60_000;
const idle = (): MarineStatus => ({ state: 'idle', connectedAt: null, lastPositionAt: null, retryAt: null,
  lastSnapshotAt: null, lastMessageAt: null, feedUpdatedAt: null, positionError: null, metadataError: null,
  periodic: false, stale: false, degraded: false, capacityReached: false, localCount: 0 });
const errorText = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : 'Marine upstream unavailable';
function connectMarine(): MarineConnection {
  return mqtt.connect('wss://meri.digitraffic.fi:443/mqtt', { clientId: `HelsinkiLens-${randomUUID()}`,
    connectTimeout: 12_000, reconnectPeriod: 0, resubscribe: false, rejectUnauthorized: true,
    protocolVersion: 4, clean: true, queueQoSZero: false });
}
function retryAfter(error: unknown, now: number): number {
  if (!(error instanceof UpstreamHttpError) || ![429, 503].includes(error.status) || !error.retryAfter) return 0;
  if (/^\d+(?:\.\d+)?$/.test(error.retryAfter.trim())) {
    const delay = Number(error.retryAfter) * 1_000; return Number.isFinite(delay) ? delay : 0;
  }
  const at = Date.parse(error.retryAfter); return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

/** Source-local latest state. TrafficFeed owns demand, coalescing and the idle grace period. */
export class MarineFeed implements MarineSource {
  private listener: ((update: MarineFeedUpdate) => void) | null = null;
  private lifetime: AbortController | null = null;
  private client: MarineConnection | null = null;
  private subscribed = false;
  private healthyAt = 0;
  private connectedAt = 0;
  private subscribeStartedAt: number | null = null;
  private retryMs = 15_000;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setTimeout> | null = null;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private restRecovery = false;
  private restFlight = false;
  private nextRestAt = 0;
  private restNotBefore = 0;
  private metadataNotBefore = 0;
  private vehicles = new Map<string, Vehicle>();
  private versions = new Map<string, Vehicle>();
  private metadata = new Map<string, { value: MarineMetadata | null; expiresAt: number }>();
  private metadataQueue = new Set<string>();
  private metadataFlight = new Set<string>();
  private metadataStarts: number[] = [];
  private status = idle();
  private dirty = false;
  private intervalMessages = 0;
  private intervalBytes = 0;
  private budgetUntil = 0;
  private counts = { accepted: 0, rejected: 0, duplicates: 0, conflicts: 0, motionDrops: 0, inoperativeDrops: 0, capacityDrops: 0,
    budgetDrops: 0, receivedMessages: 0, receivedBytes: 0, validMessages: 0, restRequests: 0,
    metadataRequests: 0, metadataFailures: 0, reconnects: 0, maxVehicles: 0, maxIdentities: 0, maxMetadata: 0,
    maxMetadataQueue: 0, maxMetadataFlight: 0 };
  private connector: () => MarineConnection;
  private fetcher: FetchMarine;
  private now: () => number;
  private random: () => number;
  private schedule: NonNullable<MarineFeedOptions['schedule']>;
  private cancel: NonNullable<MarineFeedOptions['cancel']>;
  constructor(options: MarineFeedOptions = {}) {
    this.connector = options.connector ?? connectMarine; this.fetcher = options.fetcher ?? requestText;
    this.now = options.now ?? (() => Date.now()); this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return timer; });
    this.cancel = options.cancel ?? clearTimeout;
  }
  start(listener: (update: MarineFeedUpdate) => void) {
    if (this.lifetime) return;
    const lifetime = this.lifetime = new AbortController(); this.listener = listener;
    this.status = { ...idle(), state: 'connecting' }; this.emit();
    this.connect(lifetime); void this.positions(lifetime); this.tick = this.schedule(() => this.maintain(lifetime), 1_000);
  }
  snapshot(): MarineFeedUpdate { return { vehicles: [...this.vehicles.values()], status: { ...this.status } }; }
  diagnostics() {
    return { ...this.counts, vehicles: this.vehicles.size, identities: this.versions.size, metadata: this.metadata.size,
      metadataQueue: this.metadataQueue.size, metadataFlight: this.metadataFlight.size, restFlight: Number(this.restFlight),
      upstreamConnections: Number(!!this.client), timers: Number(!!this.retry) + Number(!!this.tick) + Number(!!this.restTimer) };
  }
  private active(lifetime: AbortController) { return this.lifetime === lifetime && !lifetime.signal.aborted; }
  private emit() { this.dirty = false; this.listener?.(this.snapshot()); }
  private refreshStatus() {
    const now = this.now(), periodic = !this.subscribed && !!this.status.lastSnapshotAt;
    const stale = !this.subscribed && (!this.status.lastSnapshotAt || now - Date.parse(this.status.lastSnapshotAt) >= QUIET_MS);
    const capacityReached = this.vehicles.size >= MARINE_LIMITS.vehicles || this.versions.size >= MARINE_LIMITS.identities;
    const error = this.status.positionError || this.status.metadataError || (this.budgetUntil > now ? 'Marine input budget exceeded' : null)
      || (capacityReached ? 'Marine state capacity reached' : null);
    this.status = { ...this.status, state: this.subscribed || periodic ? 'live' : this.retry ? 'reconnecting' : 'connecting',
      periodic, stale, capacityReached, localCount: this.vehicles.size, degraded: periodic || stale || !!error, error };
  }
  private connect(lifetime: AbortController) {
    if (!this.active(lifetime) || this.client) return;
    let client: MarineConnection;
    try { client = this.connector(); } catch (error) { this.failed(lifetime, errorText(error)); return; }
    this.client = client;
    const current = () => this.active(lifetime) && this.client === client;
    client.on('error', error => { if (current()) this.failed(lifetime, errorText(error)); });
    client.on('close', () => { if (current()) this.failed(lifetime, 'Marine MQTT disconnected'); });
    client.on('connect', () => {
      if (!current()) return;
      this.subscribeStartedAt = this.now();
      client.subscribe(MARINE_TOPICS, { qos: 0 }, (error, granted) => {
        if (!current()) return;
        if (error || !granted || granted.length !== MARINE_TOPICS.length || granted.some(topic => topic.qos !== 0 || !MARINE_TOPICS.includes(topic.topic))) {
          this.failed(lifetime, error ? errorText(error) : 'Marine subscription rejected'); return;
        }
        this.subscribed = true; this.subscribeStartedAt = null; this.retryMs = 15_000; this.connectedAt = this.healthyAt = this.now();
        this.status = { ...this.status, connectedAt: new Date(this.now()).toISOString(), retryAt: null };
        if (!this.restRecovery) this.clearRestTimer();
        this.refreshStatus(); this.emit(); void this.positions(lifetime, true);
      });
    });
    client.on('message', (topic, bytes) => { if (current() && this.subscribed) this.receive(topic, bytes, lifetime); });
  }
  private failed(lifetime: AbortController, error: string) {
    if (!this.active(lifetime) || this.retry) return;
    const client = this.client; this.client = null; this.subscribed = false; this.subscribeStartedAt = null; client?.end(true);
    const delay = this.retryMs + Math.floor(Math.max(0, Math.min(1, this.random())) * 5_000);
    this.retryMs = Math.min(60_000, this.retryMs * 2); this.counts.reconnects++;
    this.status = { ...this.status, connectedAt: null, retryAt: new Date(this.now() + delay).toISOString(), positionError: error };
    this.retry = this.schedule(() => { this.retry = null; this.connect(lifetime); }, delay);
    this.refreshStatus(); this.emit(); void this.positions(lifetime);
  }
  private receive(topic: string, bytes: Buffer, lifetime: AbortController) {
    this.counts.receivedMessages++; this.counts.receivedBytes += bytes.length;
    this.intervalMessages++; this.intervalBytes += bytes.length;
    if (bytes.length > MARINE_LIMITS.payloadBytes || this.intervalMessages > MARINE_LIMITS.messagesPerSecond
      || this.intervalBytes > MARINE_LIMITS.bytesPerSecond) {
      this.counts.rejected++; this.counts.budgetDrops++; this.budgetUntil = this.now() + REST_INTERVAL; this.dirty = true; return;
    }
    const now = this.now(), receivedAt = new Date(now).toISOString();
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (topic === 'vessels-v2/status') {
        const updated = decodeMarineStatus(value, now);
        if (!this.status.feedUpdatedAt || updated > this.status.feedUpdatedAt) {
          this.status = { ...this.status, feedUpdatedAt: updated };
          if (now - Date.parse(updated) < QUIET_MS) this.healthyAt = now;
        }
      } else if (/^vessels-v2\/\d{9}\/location$/.test(topic)) {
        const vehicle = decodeMarineMqttPosition(topic, value, receivedAt, now);
        if (now - Date.parse(vehicle.reportedAt) < QUIET_MS) this.healthyAt = now;
        this.accept(vehicle, lifetime);
      } else if (/^vessels-v2\/\d{9}\/metadata$/.test(topic)) {
        const mmsi = topic.split('/')[1];
        if (!this.versions.has(`ais:${mmsi}`) && !this.metadata.has(mmsi)) return;
        this.saveMetadata(decodeMarineMetadata(value, mmsi, receivedAt, now));
      } else { this.counts.rejected++; return; }
      this.counts.validMessages++; this.status = { ...this.status, lastMessageAt: receivedAt }; this.dirty = true;
    } catch { this.counts.rejected++; }
  }
  private accept(vehicle: Vehicle, lifetime: AbortController) {
    const now = this.now(), previousVersion = this.versions.get(vehicle.id), previous = this.vehicles.get(vehicle.id);
    if (vehicle.marine?.positionSecond === 63) { this.counts.rejected++; this.counts.inoperativeDrops++; return; }
    if (now - Date.parse(vehicle.reportedAt) >= MARINE_STATIONARY_REMOVE_MS) { this.counts.rejected++; return; }
    if (previousVersion) {
      const order = compareMarinePositions(previousVersion, vehicle);
      if (order !== 'newer') { if (order === 'conflict') this.counts.conflicts++; else this.counts.duplicates++; return; }
    }
    const inside = inBounds(vehicle.longitude!, vehicle.latitude!, RELEASE_BOUNDS);
    if (!inside && !previousVersion) return;
    if (!previousVersion && this.versions.size >= MARINE_LIMITS.identities) { this.capacityDrop(); return; }
    if (inside && !previous && this.vehicles.size >= MARINE_LIMITS.vehicles) { this.capacityDrop(); return; }
    // Keep rejected new revisions too: delayed bootstrap data must not revive an exit or impossible jump.
    this.versions.delete(vehicle.id); this.versions.set(vehicle.id, vehicle);
    this.counts.maxIdentities = Math.max(this.counts.maxIdentities, this.versions.size);
    if (!inside) { if (this.vehicles.delete(vehicle.id)) { this.refreshStatus(); this.emit(); } return; }
    if (previous && !marineMotionPlausible(previous, vehicle)) { this.counts.rejected++; this.counts.motionDrops++; return; }
    if (trafficShouldRemove(vehicle, now)) { this.counts.rejected++; return; }
    const cached = this.metadata.get(vehicle.marine!.mmsi);
    const next = previous ? mergeMarinePosition(previous, vehicle) : vehicle;
    const enriched = cached?.value ? withMarineMetadata(next, cached.value) : next;
    this.vehicles.set(vehicle.id, enriched); this.counts.accepted++;
    this.counts.maxVehicles = Math.max(this.counts.maxVehicles, this.vehicles.size);
    if (!this.status.lastPositionAt || enriched.reportedAt > this.status.lastPositionAt) this.status = { ...this.status, lastPositionAt: enriched.reportedAt };
    this.enqueueMetadata(enriched.marine!.mmsi); this.pumpMetadata(lifetime); this.refreshStatus(); this.emit();
  }
  private capacityDrop() { this.counts.capacityDrops++; this.budgetUntil = this.now() + REST_INTERVAL; this.dirty = true; }
  private requestOptions(lifetime: AbortController): RequestOptions {
    return { maxBytes: MARINE_LIMITS.restBytes, timeoutMs: 12_000, redirect: 'error', signal: lifetime.signal,
      headers: { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'HelsinkiLens/1.0' } };
  }
  private clearRestTimer() { if (this.restTimer) this.cancel(this.restTimer); this.restTimer = null; this.restRecovery = false; }
  private schedulePositions(lifetime: AbortController, recovery = false) {
    if (!this.active(lifetime)) return;
    recovery ||= this.restRecovery; this.clearRestTimer(); this.restRecovery = recovery;
    // Node timers overflow above about 24 days; retain the absolute deadline and recheck it in bounded sleeps.
    this.restTimer = this.schedule(() => { this.restTimer = null; this.restRecovery = false; void this.positions(lifetime, recovery); },
      Math.min(REST_INTERVAL, Math.max(0, this.nextRestAt - this.now(), this.restNotBefore - this.now())));
  }
  private async positions(lifetime: AbortController, recovery = false) {
    if (!this.active(lifetime) || this.restFlight) return;
    if (this.now() < Math.max(this.nextRestAt, this.restNotBefore)) { this.schedulePositions(lifetime, recovery); return; }
    this.clearRestTimer(); this.restFlight = true; this.nextRestAt = this.now() + REST_INTERVAL; this.counts.restRequests++;
    const url = `${API}locations?latitude=60.18&longitude=25&radius=15&from=${this.now() - MARINE_STATIONARY_REMOVE_MS}`;
    try {
      const response = await this.fetcher(url, this.requestOptions(lifetime));
      if (!this.active(lifetime)) return;
      if (Buffer.byteLength(response.body) > MARINE_LIMITS.restBytes) throw new Error('Marine response exceeds byte limit');
      const value = JSON.parse(response.body) as { type?: unknown; features?: unknown[] };
      if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > 20_000) throw new Error('Invalid marine position snapshot');
      const now = this.now(), receivedAt = new Date(now).toISOString(); let valid = 0;
      for (const row of value.features) {
        try { const vehicle = decodeMarineRestPosition(row, receivedAt, now); valid++; this.accept(vehicle, lifetime); }
        catch { this.counts.rejected++; }
      }
      if (value.features.length && !valid) throw new Error('No valid records in marine snapshot');
      this.status = { ...this.status, lastSnapshotAt: receivedAt, positionError: null }; this.refreshStatus(); this.emit();
    } catch (error) {
      if (!this.active(lifetime)) return;
      this.restNotBefore = Math.max(this.restNotBefore, this.now() + retryAfter(error, this.now()));
      this.status = { ...this.status, positionError: errorText(error) }; this.refreshStatus(); this.emit();
    } finally {
      if (this.active(lifetime)) { this.restFlight = false; if (!this.subscribed) this.schedulePositions(lifetime); }
    }
  }
  private enqueueMetadata(mmsi: string) {
    const cached = this.metadata.get(mmsi);
    if ((cached && cached.expiresAt > this.now()) || this.metadataFlight.has(mmsi) || this.metadataQueue.has(mmsi)) return;
    if (this.metadataQueue.size >= MARINE_LIMITS.metadataQueue) { this.capacityDrop(); return; }
    this.metadataQueue.add(mmsi); this.counts.maxMetadataQueue = Math.max(this.counts.maxMetadataQueue, this.metadataQueue.size);
  }
  private pumpMetadata(lifetime: AbortController) {
    const now = this.now(); this.metadataStarts = this.metadataStarts.filter(at => now - at < REST_INTERVAL);
    while (this.active(lifetime) && now >= this.metadataNotBefore && this.metadataFlight.size < MARINE_LIMITS.metadataConcurrent
      && this.metadataStarts.length < MARINE_LIMITS.metadataPerMinute && this.metadataQueue.size) {
      const mmsi = this.metadataQueue.values().next().value!; this.metadataQueue.delete(mmsi);
      if (!this.vehicles.has(`ais:${mmsi}`) || (this.metadata.get(mmsi)?.expiresAt ?? 0) > now) continue;
      this.metadataFlight.add(mmsi); this.metadataStarts.push(now); this.counts.metadataRequests++;
      this.counts.maxMetadataFlight = Math.max(this.counts.maxMetadataFlight, this.metadataFlight.size);
      void this.lookupMetadata(mmsi, lifetime);
    }
  }
  private cacheMetadata(mmsi: string, value: MarineMetadata | null, expiresAt: number) {
    this.metadata.delete(mmsi);
    while (this.metadata.size >= MARINE_LIMITS.metadata) this.metadata.delete(this.metadata.keys().next().value!);
    this.metadata.set(mmsi, { value, expiresAt }); this.counts.maxMetadata = Math.max(this.counts.maxMetadata, this.metadata.size);
  }
  private saveMetadata(value: MarineMetadata) {
    const previous = this.metadata.get(value.mmsi)?.value;
    if (previous && value.reportedAt <= previous.reportedAt) { this.counts.duplicates++; return; }
    this.cacheMetadata(value.mmsi, value, this.now() + METADATA_TTL); this.metadataQueue.delete(value.mmsi);
    const current = this.vehicles.get(`ais:${value.mmsi}`);
    if (current) { this.vehicles.set(current.id, withMarineMetadata(current, value)); this.refreshStatus(); this.emit(); }
  }
  private async lookupMetadata(mmsi: string, lifetime: AbortController) {
    try {
      const response = await this.fetcher(`${API}vessels/${mmsi}`, this.requestOptions(lifetime));
      if (!this.active(lifetime)) return;
      if (Buffer.byteLength(response.body) > MARINE_LIMITS.restBytes) throw new Error('Marine metadata exceeds byte limit');
      const value = JSON.parse(response.body);
      if (value !== null) this.saveMetadata(decodeMarineMetadata(value, mmsi, new Date(this.now()).toISOString(), this.now()));
      else if (!this.metadata.get(mmsi)?.value) this.cacheMetadata(mmsi, null, this.now() + MISS_TTL);
      this.status = { ...this.status, metadataError: null }; this.refreshStatus(); this.emit();
    } catch (error) {
      if (!this.active(lifetime)) return;
      this.cacheMetadata(mmsi, this.metadata.get(mmsi)?.value ?? null, this.now() + MISS_TTL);
      this.metadataNotBefore = Math.max(this.metadataNotBefore, this.now() + retryAfter(error, this.now())); this.counts.metadataFailures++;
      this.status = { ...this.status, metadataError: errorText(error) }; this.refreshStatus(); this.emit();
    } finally {
      if (this.active(lifetime)) { this.metadataFlight.delete(mmsi); this.pumpMetadata(lifetime); }
    }
  }
  private maintain(lifetime: AbortController) {
    if (!this.active(lifetime)) return;
    this.tick = null; const now = this.now(); this.intervalMessages = 0; this.intervalBytes = 0;
    for (const [id, vehicle] of this.vehicles) if (trafficShouldRemove(vehicle, now)) { this.vehicles.delete(id); this.dirty = true; }
    for (const [id, vehicle] of this.versions) if (now - Date.parse(vehicle.reportedAt) >= MARINE_STATIONARY_REMOVE_MS) this.versions.delete(id);
    for (const [mmsi, cached] of this.metadata) if (cached.expiresAt <= now && !this.vehicles.has(`ais:${mmsi}`)) this.metadata.delete(mmsi);
    for (const vehicle of this.vehicles.values()) this.enqueueMetadata(vehicle.marine!.mmsi);
    this.pumpMetadata(lifetime);
    if (this.client && !this.subscribed && this.subscribeStartedAt !== null && now - this.subscribeStartedAt >= 12_000)
      this.failed(lifetime, 'Marine subscription acknowledgement timed out');
    if (this.subscribed && now - Math.max(this.healthyAt, this.connectedAt) >= QUIET_MS) this.failed(lifetime, 'Marine source heartbeat stale');
    const before = JSON.stringify(this.status); this.refreshStatus();
    if (this.dirty || before !== JSON.stringify(this.status)) this.emit();
    this.tick = this.schedule(() => this.maintain(lifetime), 1_000);
  }
  stop() {
    this.lifetime?.abort(); this.lifetime = null; this.listener = null;
    for (const timer of [this.tick, this.retry, this.restTimer]) if (timer) this.cancel(timer);
    this.tick = this.retry = this.restTimer = null; this.restRecovery = false;
    const client = this.client; this.client = null; this.subscribed = false; this.subscribeStartedAt = null; client?.end(true);
    this.vehicles.clear(); this.versions.clear(); this.metadata.clear(); this.metadataQueue.clear(); this.metadataFlight.clear();
    this.metadataStarts = []; this.restFlight = false; this.nextRestAt = this.restNotBefore = this.metadataNotBefore = 0;
    this.retryMs = 15_000; this.healthyAt = this.connectedAt = this.budgetUntil = 0;
    this.intervalMessages = this.intervalBytes = 0; this.dirty = false; this.status = idle();
  }
}
