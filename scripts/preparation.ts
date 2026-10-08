import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RELEASE_BOUNDS, DISTRICT_BOUNDS, SCENE_ORIGIN } from '../src/lib/area.ts';
import type { SampleManifest } from '../src/lib/types.ts';
import type { DataBundle } from './pipeline.ts';
import { publishSample } from './publish.ts';

/** A failed refresh cannot replace an existing dated sample with reduced coverage. */
export function refreshIssues(previous: SampleManifest | null, result: DataBundle, counts: Record<string, number>): string[] {
  if (!previous) return [];
  const issues = Object.entries(previous.gates)
    .filter(([name, gate]) => gate.status === 'pass' && result.gates[name]?.status !== 'pass')
    .map(([name]) => `Previously passed ${name} gate is now ${result.gates[name]?.status ?? 'missing'}.`);
  issues.push(...result.errors.map(error => `Source refresh failed: ${error}`));
  for (const entry of result.evidence) {
    if (typeof entry.status === 'number' ? entry.status >= 400 : /failed|error|HTTP\s*[45]\d\d/i.test(entry.status)) {
      issues.push(`Source refresh failed: ${entry.id} (${entry.status}); ${entry.notes.join('; ')}`);
    }
  }
  for (const asset of previous.assets) {
    const name = asset.path.split('/').at(-1)!;
    if (asset.count > 0 && counts[name] === 0) issues.push(`Previously nonempty ${name} would be erased.`);
  }
  return issues;
}

export async function publishPreparation(directory: string, diagnosticPath: string, result: DataBundle, generatedAt: string): Promise<SampleManifest | null> {
  let manifest: SampleManifest | null = null;
  await mkdir(dirname(diagnosticPath), {recursive: true});
  const writeDiagnostic = () => writeFile(diagnosticPath, JSON.stringify({generatedAt, ...result}, null, 2) + '\n');
  try {
    let previous: SampleManifest | null = null;
    try { previous = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (previous && (previous.version !== 1 || previous.mode !== 'prepared-source-sample'
      || !Number.isFinite(Date.parse(previous.generatedAt)) || !Array.isArray(previous.assets)
      || previous.assets.some(asset => !/^generations\/[a-zA-Z0-9_-]+\/[a-z-]+\.json$/.test(asset.path)
        || !Number.isSafeInteger(asset.count) || asset.count < 0)
      || !previous.gates || Object.values(previous.gates).some(gate => !['pass', 'fail', 'blocked'].includes(gate.status)))) {
      throw new Error('Previous sample manifest is invalid; retain it for inspection.');
    }
    const sources = new Set(result.sources.map(source => source.id));
    const licensed = new Set(result.sources.filter(source => source.license !== null && /CC[- ]BY[- ]4\.0/i.test(source.license)).map(source => source.id));
    const rows = [...result.buildings, ...result.vehicles, ...result.observations, ...result.energy, ...result.solar];
    const unlicensed = rows.filter(record => !licensed.has(record.sourceId));
    result.gates.publication = unlicensed.length ? {
      status: 'blocked', evidence: [`${unlicensed.length} records have no verified reusable source license.`], nextAction: 'Verify reuse terms before distributing these records.'
    } : {status: 'pass', evidence: ['All distributed data records have source attribution and verified CC BY 4.0 terms.'], nextAction: null};
    const buildings = result.buildings.filter(record => licensed.has(record.sourceId));
    const buildingIds = new Set(buildings.map(building => building.id));
    const values = {
      'buildings.json': buildings, 'chunks.json': result.chunks,
      'vehicles.json': result.vehicles.filter(record => licensed.has(record.sourceId)),
      'observations.json': result.observations.filter(record => licensed.has(record.sourceId)),
      'energy.json': result.energy.filter(record => licensed.has(record.sourceId)),
      'solar.json': result.solar.filter(record => licensed.has(record.sourceId)),
    };
    const issues = refreshIssues(previous, result, Object.fromEntries(Object.entries(values).map(([name, rows]) => [name, rows.length])));
    if (buildingIds.size < 20 || !result.chunks.length || result.gates.building_geometry?.status !== 'pass') {
      issues.push('No complete licensed building sample.');
    }
    if (result.chunks.some(chunk => chunk.ranges.some(range => !buildingIds.has(range.buildingId)))) {
      issues.push('Geometry includes an undistributable or unknown building.');
    }
    if (rows.some(row => !sources.has(row.sourceId))) issues.push('Unknown record source.');
    if (issues.length) throw new Error(issues.join('\n'));
    await writeDiagnostic();
    manifest = await publishSample(directory, {
      generatedAt, area: {release: [...RELEASE_BOUNDS], district: [...DISTRICT_BOUNDS],
        origin: [SCENE_ORIGIN.longitude, SCENE_ORIGIN.latitude, SCENE_ORIGIN.elevation]},
      sources: result.sources, gates: result.gates,
    }, {...values, 'probe-evidence.json': result.evidence});
  } catch (error) {
    result.gates.publication = {status: 'blocked', evidence: [error instanceof Error ? error.message : String(error)],
      nextAction: 'Previous manifest retained. Inspect this diagnostic and retry the failed source refresh.'};
  }
  if (!manifest) await writeDiagnostic();
  return manifest;
}
