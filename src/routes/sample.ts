import type { Building, SampleManifest } from '#lib/types.ts';

export async function loadPreparedSample(fetch: typeof globalThis.fetch) {
  try {
    const response = await fetch('/data/manifest.json', { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return { manifest: null, buildings: [], sampleError: null };
    if (!response.ok) throw new Error(`Sample manifest returned HTTP ${response.status}`);
    const manifest: SampleManifest = await response.json();
    if (manifest.version !== 1 || manifest.mode !== 'prepared-source-sample'
      || !Number.isFinite(Date.parse(manifest.generatedAt)) || !Array.isArray(manifest.assets)
      || !Array.isArray(manifest.sources) || manifest.sources.some((source) =>
        typeof source.id !== 'string' || !Number.isFinite(Date.parse(source.retrievedAt))
        || !Array.isArray(source.units) || source.units.some((unit) => typeof unit !== 'string')
        || typeof source.url !== 'string' || !/^(https?|mqtts?|wss?):\/\//.test(source.url))
      || !manifest.gates || typeof manifest.gates !== 'object'
      || Object.values(manifest.gates).some((gate) =>
        !['pass', 'fail', 'blocked'].includes(gate.status) || !Array.isArray(gate.evidence)
        || gate.evidence.some((evidence) => typeof evidence !== 'string'))) {
      throw new Error('Invalid prepared sample manifest');
    }
    const asset = manifest.assets.find((item) => item.path.endsWith('/buildings.json'));
    if (!asset || !/^generations\/[a-zA-Z0-9_-]+\/buildings\.json$/.test(asset.path)) {
      throw new Error('Prepared sample has no valid building asset');
    }
    const buildingResponse = await fetch(`/data/${asset.path}`, { signal: AbortSignal.timeout(30_000) });
    if (!buildingResponse.ok) throw new Error(`Building sample returned HTTP ${buildingResponse.status}`);
    const buildings: Building[] = await buildingResponse.json();
    if (!Array.isArray(buildings) || buildings.length !== asset.count || buildings.some((building) =>
      typeof building.id !== 'string' || typeof building.gmlId !== 'string'
      || !Number.isFinite(building.longitude) || !Number.isFinite(building.latitude)
      || !building.attributes || typeof building.attributes !== 'object'
      || Object.values(building.attributes).some((value) => value !== null && typeof value !== 'string'))
      || new Set(buildings.map((building) => building.id)).size !== buildings.length) {
      throw new Error('Invalid prepared building sample');
    }
    return { manifest, buildings, sampleError: null };
  } catch (error) {
    return { manifest: null, buildings: [], sampleError: error instanceof Error ? error.message : 'Sample could not be loaded' };
  }
}
