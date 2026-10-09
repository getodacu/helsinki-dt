/** Source timestamps are UTC; source and building identifiers remain strings. */
export interface DatasetSource {
  id: string;
  provider: string;
  url: string;
  license: string | null;
  attribution: string;
  retrievedAt: string;
  vintage: string | null;
  units: string[];
  coverage: string;
  method: string;
  checksum: string | null;
  coordinateReference: string | null;
  axisOrder: string | null;
  verticalReference: string | null;
}

export interface Building {
  id: string;
  gmlId: string;
  vtjPrt: string | null;
  ratu: string | null;
  uuid: string | null;
  chunkRef: string;
  longitude: number;
  latitude: number;
  attributes: Record<string, string | null>;
  sourceId: string;
}

/** Non-indexed triangles; each range resolves a triangle hit to a stable building. */
export interface BuildingChunk {
  id: string;
  positions: number[];
  ranges: { buildingId: string; firstTriangle: number; triangleCount: number }[];
  coordinateReference: string;
  verticalReference: string;
  origin: { longitude: number; latitude: number; elevation: number };
}

export type TransitMode = 'tram' | 'bus' | 'ferry' | 'train';
export interface Vehicle {
  id: string;
  mode: TransitMode;
  ownerOperatorId: string | null;
  vehicleId: string;
  operatingOperatorId: string | null;
  routeId: string;
  directionId: string | null;
  serviceDate: string | null;
  startTime: string | null;
  journeyReference: string | null;
  reportedAt: string;
  receivedAt: string;
  longitude: number | null;
  latitude: number | null;
  speedMetresPerSecond: number | null;
  headingDegrees: number | null;
  rawDeviationSeconds: number | null;
  delaySeconds: number | null;
  quality: string[];
  sourceId: string;
  rail?: import('./rail.ts').RailSummary;
}

export interface Observation {
  stationId: string;
  stationName: string;
  longitude: number;
  latitude: number;
  parameter: string;
  value: number | null;
  unit: string;
  observedAt: string;
  receivedAt: string;
  quality: string | null;
  aggregation: string | null;
  sourceId: string;
}

export interface EnergyRecord {
  id: string;
  scope: 'property' | 'building' | 'meter';
  scopeId: string;
  matchedBuildingIds: string[];
  unmatchedSourceIds: string[];
  metric: string;
  period: { start: string; end: string };
  value: number | null;
  unit: string;
  method: 'measured' | 'modeled';
  scenario: string | null;
  sourceId: string;
}

export interface SolarRecord {
  id: string;
  scope: 'building' | 'surface';
  scopeId: string;
  matchedBuildingIds: string[];
  metric: string;
  value: number | null;
  unit: string;
  calculationPeriod: string;
  vintage: string | null;
  assumptions: string[];
  sourceId: string;
}

export interface GateResult {
  status: 'pass' | 'fail' | 'blocked';
  evidence: string[];
  nextAction: string | null;
}

export interface ProbeEvidence {
  id: string;
  url: string;
  queriedAt: string;
  durationMs: number;
  status: number | string;
  decodedCount: number;
  bytes: number;
  freshness: string | null;
  authentication: string;
  notes: string[];
}

export interface SampleManifest {
  version: 1;
  generatedAt: string;
  mode: 'prepared-source-sample';
  area: { release: number[]; district: number[]; origin: number[] };
  sources: DatasetSource[];
  assets: { path: string; sha256: string; bytes: number; count: number }[];
  gates: Record<string, GateResult>;
}
