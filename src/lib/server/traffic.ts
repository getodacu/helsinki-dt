import { RailFeed, type RailSource, type RailFeedUpdate } from './rail-feed.ts';
import { MarineFeed, type MarineSource, type MarineFeedUpdate } from './marine-feed.ts';
import type { MarineStatus } from '../marine.ts';
import mqtt, { type MqttClient } from 'mqtt';
import { RELEASE_BOUNDS, inBounds } from '../area.ts';
import { decodeHfp } from '../data/hfp.ts';
import { TRAFFIC_IDLE_MS, TRAFFIC_MAX_VEHICLES, TRAFFIC_REMOVE_MS, trafficShouldRemove,
  type TrafficEvent, type TrafficSnapshot, type TrafficStatus } from '../traffic.ts';
import type { Vehicle } from '../types.ts';

export type TrafficConnection = Pick<MqttClient, 'on' | 'subscribe' | 'end'>;
// HFP's digit-pair geohash: the release crosses longitude 25; both cells include the ferry corridor.
export const TRAFFIC_TOPICS = ['tram', 'bus', 'ferry'].flatMap(mode => ['60;24/19', '60;25/10']
  .map(cell => `/hfp/v2/journey/ongoing/vp/${mode}/+/+/+/+/+/+/+/+/${cell}/#`));
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_MESSAGES_PER_SECOND = 5_000;
const MAX_BYTES_PER_SECOND = 4 * 1024 * 1024;

function connectHsl(): TrafficConnection {
  return mqtt.connect('mqtts://mqtt.hsl.fi:8883', { connectTimeout: 12_000, reconnectPeriod: 0,
    resubscribe: false, rejectUnauthorized: true, protocolVersion: 4, clean: true, queueQoSZero: false });
}

/** One connection and bounded latest state per process; consumers provide its lifetime. */
export class TrafficFeed {
  private client: TrafficConnection | null = null;
  private railVehicles = new Map<string, Vehicle>();
  private marineVehicles = new Map<string, Vehicle>();
  private marineStatus: MarineStatus | null = null;
  private lifetime = 0;
  private railStatus: TrafficStatus = { state: 'idle', connectedAt: null, lastPositionAt: null, retryAt: null };
  private consumers = 0;
  private releases = new Set<() => void>();
  private listeners = new Set<{ listener: (event: TrafficEvent) => void; unsubscribe: () => void }>();
  private vehicles = new Map<string, Vehicle>();
  private reportedTimes = new Map<string, number>();
  private pending = new Map<string, Vehicle>();
  private removed = new Set<string>();
  private status: TrafficStatus = { state: 'idle', connectedAt: null, lastPositionAt: null, retryAt: null };
  private dirty = false;
  private fullSnapshot = false;
  private tick: ReturnType<typeof setInterval> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1_000;
  private intervalMessages = 0;
  private intervalBytes = 0;
  private counts = { accepted: 0, rejected: 0, duplicates: 0, capacityDrops: 0,
    receivedMessages: 0, receivedBytes: 0, maxPendingVehicles: 0, maxPendingRemovals: 0 };

  private connector: () => TrafficConnection;
  private rail: RailSource | null;
  private marine: MarineSource | null;
  constructor(connector: () => TrafficConnection = connectHsl, rail: RailSource | null = null, marine: MarineSource | null = null) {
    this.connector = connector; this.rail = rail; this.marine = marine;
  }

  acquire(): () => void {
    this.consumers++;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (!this.tick) {
      this.tick = setInterval(() => this.flush(), 1_000);
      this.tick.unref?.();
      const lifetime = ++this.lifetime;
      this.rail?.start(update => { if (this.lifetime === lifetime) this.receiveRail(update); });
      this.marine?.start(update => { if (this.lifetime === lifetime) this.receiveMarine(update); });
    }
    if (!this.client && !this.retry) this.connect();
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      this.releases.delete(release);
      if (--this.consumers === 0) {
        this.idle = setTimeout(() => this.stop(), TRAFFIC_IDLE_MS);
        this.idle.unref?.();
      }
    };
    this.releases.add(release);
    return release;
  }

  subscribe(listener: (event: TrafficEvent) => void): () => void {
    const release = this.acquire();
    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.listeners.delete(subscription);
      release();
    };
    const subscription = { listener, unsubscribe };
    this.listeners.add(subscription);
    try { listener(this.snapshot()); } catch { unsubscribe(); }
    return unsubscribe;
  }

  snapshot(): TrafficSnapshot {
    this.expire();
    return { type: 'snapshot', generatedAt: new Date().toISOString(),
      vehicles: [...this.vehicles.values(), ...this.railVehicles.values(), ...this.marineVehicles.values()], status: { ...this.status }, sources: this.sources() };
  }

  private sources() {
    return this.rail || this.marine ? { hsl: { ...this.status },
      ...(this.rail ? { rail: { ...this.railStatus } } : {}),
      ...(this.marineStatus ? { marine: { ...this.marineStatus } } : {}) } : undefined;
  }
  private receiveRail(update: RailFeedUpdate) {
    this.railStatus = update.status;
    const next = new Map(update.vehicles.filter(vehicle => !trafficShouldRemove(vehicle)).map(vehicle => [vehicle.id, vehicle]));
    for (const id of this.railVehicles.keys()) if (!next.has(id)) this.remove(id, this.railVehicles);
    for (const [id, vehicle] of next) {
      if (this.railVehicles.get(id) !== vehicle) this.pending.set(id, vehicle);
      this.removed.delete(id);
    }
    this.railVehicles = next; this.dirty = true;
  }
  private receiveMarine(update: MarineFeedUpdate) {
    this.marineStatus = update.status;
    const next = new Map(update.vehicles.filter(vehicle => !trafficShouldRemove(vehicle)).map(vehicle => [vehicle.id, vehicle]));
    for (const id of this.marineVehicles.keys()) if (!next.has(id)) this.remove(id, this.marineVehicles);
    for (const [id, vehicle] of next) {
      if (this.marineVehicles.get(id) !== vehicle) this.pending.set(id, vehicle);
      this.removed.delete(id);
    }
    this.marineVehicles = next; this.dirty = true;
  }

  diagnostics() {
    return { ...this.counts, upstreamConnections: this.client ? 1 : 0, subscribers: this.listeners.size,
      consumers: this.consumers, railVehicles: this.railVehicles.size, vehicles: this.vehicles.size, identities: this.reportedTimes.size,
      marineVehicles: this.marineVehicles.size, marine: this.marine?.diagnostics?.(),
      pendingVehicles: this.pending.size, pendingRemovals: this.removed.size,
      timers: Number(!!this.tick) + Number(!!this.idle) + Number(!!this.retry) };
  }

  close(): void {
    for (const { unsubscribe } of [...this.listeners]) unsubscribe();
    for (const release of [...this.releases]) release();
    this.stop();
  }

  private connect(): void {
    this.status = { ...this.status, state: this.retryDelay === 1_000 ? 'connecting' : 'reconnecting',
      connectedAt: null, retryAt: null };
    this.dirty = true;
    let client: TrafficConnection;
    try { client = this.connector(); } catch { this.failed(); return; }
    this.client = client;
    client.on('error', () => { if (this.client === client) this.failed(); });
    client.on('close', () => { if (this.client === client) this.failed(); });
    client.on('connect', () => {
      if (this.client !== client) return;
      client.subscribe(TRAFFIC_TOPICS, { qos: 0 }, (error, granted) => {
        if (this.client !== client) return;
        if (error || granted?.some(topic => topic.qos === 128)) { this.failed(); return; }
        this.retryDelay = 1_000;
        this.status = { ...this.status, state: 'live', connectedAt: new Date().toISOString(), retryAt: null };
        const snapshot = this.snapshot();
        this.pending.clear(); this.removed.clear(); this.dirty = false; this.fullSnapshot = false;
        this.broadcast(snapshot);
      });
    });
    client.on('message', (topic, bytes) => {
      if (this.client === client && this.status.state === 'live') this.receive(topic, bytes);
    });
  }

  private failed(): void {
    const client = this.client;
    this.client = null;
    client?.end(true);
    if (!this.consumers) {
      this.status = { ...this.status, state: 'reconnecting', connectedAt: null, retryAt: null };
      this.dirty = true; return;
    }
    const delay = this.retryDelay;
    this.retryDelay = Math.min(30_000, delay * 2);
    this.status = { ...this.status, state: 'reconnecting', connectedAt: null,
      retryAt: new Date(Date.now() + delay).toISOString() };
    this.dirty = true;
    this.retry = setTimeout(() => { this.retry = null; if (this.consumers) this.connect(); }, delay);
    this.retry.unref?.();
  }

  private receive(topic: string, bytes: Buffer): void {
    this.counts.receivedMessages++; this.counts.receivedBytes += bytes.length;
    this.intervalMessages++; this.intervalBytes += bytes.length;
    if (topic.length > 512 || bytes.length > MAX_PAYLOAD_BYTES
      || this.intervalMessages > MAX_MESSAGES_PER_SECOND || this.intervalBytes > MAX_BYTES_PER_SECOND) {
      this.counts.rejected++; return;
    }
    let vehicle: Vehicle;
    try { vehicle = decodeHfp(topic, JSON.parse(bytes.toString('utf8')), new Date().toISOString()); }
    catch { this.counts.rejected++; return; }
    const reportedTime = Date.parse(vehicle.reportedAt);
    if (vehicle.longitude === null || vehicle.latitude === null || reportedTime > Date.now() + 5_000
      || [vehicle.routeId, vehicle.operatingOperatorId, vehicle.journeyReference].some(value => value !== null && (!value.isWellFormed() || /[\u0000-\u001f]/.test(value)))
      || Date.now() - reportedTime >= TRAFFIC_REMOVE_MS || vehicle.id.length > 64 || Buffer.byteLength(vehicle.routeId ?? '') > 64
      || Buffer.byteLength(vehicle.operatingOperatorId ?? '') > 64 || Buffer.byteLength(vehicle.journeyReference ?? '') > 64
      || (vehicle.speedMetresPerSecond !== null && (vehicle.speedMetresPerSecond < 0 || vehicle.speedMetresPerSecond > 100))
      || (vehicle.headingDegrees !== null && (vehicle.headingDegrees < 0 || vehicle.headingDegrees > 360))
      || (vehicle.rawDeviationSeconds !== null && Math.abs(vehicle.rawDeviationSeconds) > 86_400)) {
      this.counts.rejected++; return;
    }
    const previousTime = this.reportedTimes.get(vehicle.id);
    if (previousTime !== undefined && reportedTime <= previousTime) { this.counts.duplicates++; return; }
    const inside = inBounds(vehicle.longitude, vehicle.latitude, RELEASE_BOUNDS);
    if (!inside && previousTime === undefined) return;
    if (previousTime === undefined && this.reportedTimes.size >= TRAFFIC_MAX_VEHICLES) {
      this.counts.capacityDrops++; return;
    }
    this.reportedTimes.set(vehicle.id, reportedTime);
    this.counts.accepted++;
    if (!inside) { this.remove(vehicle.id); return; }
    this.vehicles.set(vehicle.id, vehicle);
    this.pending.set(vehicle.id, vehicle);
    this.removed.delete(vehicle.id);
    if (!this.status.lastPositionAt || reportedTime > Date.parse(this.status.lastPositionAt)) {
      this.status = { ...this.status, lastPositionAt: vehicle.reportedAt };
    }
    this.counts.maxPendingVehicles = Math.max(this.counts.maxPendingVehicles, this.pending.size);
    this.dirty = true;
  }

  private remove(id: string, vehicles = this.vehicles): void {
    if (!vehicles.delete(id)) return;
    this.pending.delete(id);
    this.removed.add(id);
    // A full refresh bounds removal churn even if repeated snapshots expire many identities between ticks.
    if (this.removed.size > TRAFFIC_MAX_VEHICLES) { this.removed.clear(); this.fullSnapshot = true; }
    this.counts.maxPendingRemovals = Math.max(this.counts.maxPendingRemovals, this.removed.size);
    this.dirty = true;
  }

  private expire(): void {
    const now = Date.now();
    for (const vehicles of [this.railVehicles, this.marineVehicles]) {
      for (const [id, vehicle] of vehicles) if (trafficShouldRemove(vehicle, now)) this.remove(id, vehicles);
    }
    for (const [id, reportedTime] of this.reportedTimes) {
      if (now - reportedTime >= TRAFFIC_REMOVE_MS) { this.remove(id); this.reportedTimes.delete(id); }
    }
  }

  private flush(): void {
    this.intervalMessages = 0; this.intervalBytes = 0;
    this.expire();
    if (!this.dirty) return;
    const event: TrafficEvent = this.fullSnapshot ? this.snapshot() : {
      type: 'update', generatedAt: new Date().toISOString(), vehicles: [...this.pending.values()],
      removed: [...this.removed], status: { ...this.status }, sources: this.sources()
    };
    this.pending.clear(); this.removed.clear(); this.dirty = false; this.fullSnapshot = false;
    this.broadcast(event);
  }

  private broadcast(event: TrafficEvent): void {
    for (const { listener, unsubscribe } of [...this.listeners]) {
      try { listener(event); } catch { unsubscribe(); }
    }
  }

  private stop(): void {
    this.lifetime++;
    this.rail?.stop(); this.railVehicles.clear();
    this.marine?.stop(); this.marineVehicles.clear(); this.marineStatus = null;
    this.railStatus = { state: 'idle', connectedAt: null, lastPositionAt: null, retryAt: null };
    if (this.tick) clearInterval(this.tick);
    if (this.idle) clearTimeout(this.idle);
    if (this.retry) clearTimeout(this.retry);
    this.tick = null; this.idle = null; this.retry = null;
    const client = this.client;
    this.client = null;
    client?.end(true);
    this.vehicles.clear(); this.reportedTimes.clear(); this.pending.clear(); this.removed.clear();
    this.dirty = false; this.fullSnapshot = false; this.retryDelay = 1_000;
    this.intervalMessages = 0; this.intervalBytes = 0;
    this.status = { state: 'idle', connectedAt: null, lastPositionAt: null, retryAt: null };
  }
}

export const trafficFeed = new TrafficFeed(connectHsl, new RailFeed(), new MarineFeed());
