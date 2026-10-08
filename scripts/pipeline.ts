import { prepareGeometry } from './geometry.ts';
import { probeEnergy } from './energy.ts';
import { probeTransit } from './transit.ts';
import { probeObservations } from './observations.ts';
import type { Building, BuildingChunk, DatasetSource, EnergyRecord, GateResult, Observation, ProbeEvidence, SolarRecord, Vehicle } from '../src/lib/types.ts';

export interface DataBundle {
  buildings: Building[]; chunks: BuildingChunk[]; vehicles: Vehicle[]; observations: Observation[];
  energy: EnergyRecord[]; solar: SolarRecord[]; sources: DatasetSource[]; evidence: ProbeEvidence[];
  gates: Record<string, GateResult>; errors: string[];
}
export type SourceSelection = 'all' | 'geometry' | 'energy' | 'transit' | 'observations';
export function parseSelection(arguments_: string[]): SourceSelection {
  if (!arguments_.length) return 'all';
  if (arguments_.length !== 2 || arguments_[0] !== '--source'
    || !['all', 'geometry', 'energy', 'transit', 'observations'].includes(arguments_[1])) {
    throw new Error('Use --source all|geometry|energy|transit|observations');
  }
  return arguments_[1] as SourceSelection;
}

/** Independent source failures are evidence, never invented records. */
export async function runSources(selection: SourceSelection = 'all'): Promise<DataBundle> {
  const result: DataBundle = { buildings: [], chunks: [], vehicles: [], observations: [], energy: [], solar: [],
    sources: [], evidence: [], gates: {}, errors: [] };
  async function collect<T extends Partial<DataBundle>>(name: string, gates: string[], operation: () => Promise<T>) {
    try { return await operation(); }
    catch (error) {
      const message = `${name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
      result.errors.push(message);
      for (const gate of gates) result.gates[gate] = {status: 'blocked', evidence: [message], nextAction: 'Re-run the bounded source probe and inspect its diagnostic.'};
      return null;
    }
  }
  function merge(value: Partial<DataBundle> | null) {
    if (!value) return;
    for (const key of ['buildings', 'chunks', 'vehicles', 'observations', 'energy', 'solar', 'sources', 'evidence'] as const) {
      const rows = value[key];
      if (rows) (result[key] as unknown[]).push(...rows);
    }
    Object.assign(result.gates, value.gates);
  }
  const transit = selection === 'all' || selection === 'transit'
    ? collect('transit', ['tram', 'bus', 'ferry', 'gtfs_journey'], probeTransit) : Promise.resolve(null);
  const observations = selection === 'all' || selection === 'observations'
    ? collect('observations', ['weather', 'air_quality'], probeObservations) : Promise.resolve(null);
  if (selection === 'all' || selection === 'geometry' || selection === 'energy') {
    const geometry = await collect('geometry', ['building_geometry', 'coordinate_controls'], prepareGeometry);
    merge(geometry);
    if (selection === 'all' || selection === 'energy') {
      if (geometry) merge(await collect('energy', ['measured_energy', 'modeled_energy', 'solar'], () => probeEnergy(geometry.buildings)));
      else for (const key of ['measured_energy', 'modeled_energy', 'solar']) result.gates[key] = {
        status: 'blocked', evidence: ['No valid building sample available for associations.'], nextAction: 'Resolve building preparation, then rerun energy probes.'};
    }
  }
  merge(await transit);
  merge(await observations);
  result.sources = [...new Map(result.sources.map(source => [source.id, source])).values()];
  return result;
}
