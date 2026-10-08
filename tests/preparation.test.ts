import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataBundle } from '../scripts/pipeline.ts';
import type { DatasetSource, GateResult, ProbeEvidence } from '../src/lib/types.ts';
import { publishPreparation } from '../scripts/preparation.ts';

const pass: GateResult = {status: 'pass', evidence: ['Recorded fixture verified.'], nextAction: null};
const blocked: GateResult = {status: 'blocked', evidence: ['Required association or unit is not verified.'], nextAction: 'Verify metadata.'};
const generatedAt = '2026-10-08T10:00:00Z';
function source(id: string): DatasetSource {
  return {id, provider: 'offline fixture', url: 'https://example.test/' + id, license: 'CC BY 4.0', attribution: 'Offline fixture',
    retrievedAt: generatedAt, vintage: 'fixture', units: [], coverage: 'fixture', method: 'fixture', checksum: null,
    coordinateReference: null, axisOrder: null, verticalReference: null};
}
function evidence(id: string, status: number | string = 200): ProbeEvidence {
  return {id, url: 'https://example.test/' + id, queriedAt: generatedAt, durationMs: 1, status,
    decodedCount: 1, bytes: 10, freshness: null, authentication: 'anonymous', notes: status === 200 ? [] : ['Upstream request failed.']};
}
function bundle(): DataBundle {
  return {
    buildings: Array.from({length: 20}, (_, index) => ({id: `BID_${index}`, gmlId: `BID_${index}`, vtjPrt: null, ratu: null, uuid: null,
      chunkRef: 'district', longitude: 24.952, latitude: 60.1695, attributes: {}, sourceId: 'geometry'})),
    chunks: [{id: 'district', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], ranges: [{buildingId: 'BID_0', firstTriangle: 0, triangleCount: 1}],
      coordinateReference: 'local metres', verticalReference: 'N2000', origin: {longitude: 24.952, latitude: 60.1695, elevation: 0}}],
    vehicles: [{id: '0040/00100', mode: 'tram', ownerOperatorId: '0040', vehicleId: '00100', operatingOperatorId: '40', routeId: '1009',
      directionId: '1', serviceDate: '2026-10-08', startTime: '13:27', journeyReference: 'fixture', reportedAt: generatedAt, receivedAt: generatedAt,
      longitude: 24.952, latitude: 60.1695, speedMetresPerSecond: null, headingDegrees: null, rawDeviationSeconds: null, delaySeconds: null,
      quality: [], sourceId: 'hsl-hfp'}],
    observations: [{stationId: '100971', stationName: 'fixture', longitude: 24.952, latitude: 60.1695, parameter: 't2m', value: 5,
      unit: 'degC', observedAt: generatedAt, receivedAt: generatedAt, quality: null, aggregation: null, sourceId: 'fmi-weather'}],
    energy: [{id: 'property/day', scope: 'property', scopeId: 'property', matchedBuildingIds: ['BID_0'], unmatchedSourceIds: [], metric: 'electricity',
      period: {start: '2026-10-06', end: '2026-10-07'}, value: 100, unit: 'kWh', method: 'measured', scenario: null, sourceId: 'helsinki-nuuka'}],
    solar: [], sources: ['geometry', 'hsl-hfp', 'fmi-weather', 'helsinki-nuuka'].map(source),
    evidence: [evidence('geometry'), evidence('hfp-tram', 'bounded MQTT session completed'), evidence('fmi-weather'), evidence('nuuka-property-energy')],
    gates: {building_geometry: structuredClone(pass), tram: structuredClone(pass), weather: structuredClone(pass), measured_energy: structuredClone(pass),
      modeled_energy: structuredClone(blocked), solar: structuredClone(blocked)}, errors: [],
  };
}

async function withSample(operation: (directory: string, diagnostic: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'helsinki-preparation-'));
  try { await operation(directory, join(directory, 'diagnostics/latest-preparation.json')); }
  finally { await rm(directory, {recursive: true, force: true}); }
}

test('initial partial sample and a successful refresh publish with known modeled/solar blocks', async () => {
  await withSample(async (directory, diagnostic) => {
    const partial = bundle();
    partial.vehicles = []; partial.observations = []; partial.energy = [];
    partial.gates.tram = structuredClone(blocked); partial.gates.weather = structuredClone(blocked); partial.gates.measured_energy = structuredClone(blocked);
    partial.errors.push('observations: upstream unavailable');
    partial.evidence.push(evidence('nuuka-property-energy', 'failed'));
    const first = await publishPreparation(directory, diagnostic, partial, generatedAt);
    assert.ok(first);
    assert.equal(first.assets.find(asset => asset.path.endsWith('/observations.json'))!.count, 0);
    const second = await publishPreparation(directory, diagnostic, bundle(), '2026-10-08T11:00:00Z');
    assert.ok(second);
    assert.notEqual(first.assets[0].path, second.assets[0].path);
    assert.equal(second.gates.modeled_energy.status, 'blocked');
    assert.equal(second.gates.solar.status, 'blocked');
    assert.equal(second.assets.find(asset => asset.path.endsWith('/energy.json'))!.count, 1);
    const report = JSON.parse(await readFile(diagnostic, 'utf8'));
    assert.equal(report.gates.publication.status, 'pass');
  });
});

for (const [gate, records, sourceId] of [
  ['weather', 'observations', 'fmi-weather'], ['tram', 'vehicles', 'hfp-tram'], ['measured_energy', 'energy', 'nuuka-property-energy'],
] as const) {
  test(`${gate} source failure retains manifest bytes and all prior records`, async () => {
    await withSample(async (directory, diagnostic) => {
      const first = await publishPreparation(directory, diagnostic, bundle(), generatedAt);
      assert.ok(first);
      const pointer = await readFile(join(directory, 'manifest.json'));
      const previousBodies = await Promise.all(first.assets.map(asset => readFile(join(directory, asset.path))));
      const failed = bundle(); failed[records] = [];
      failed.gates[gate] = {status: 'blocked', evidence: ['Source request failed.'], nextAction: 'Retry.'};
      failed.evidence.push(evidence(sourceId, 'failed'));
      assert.equal(await publishPreparation(directory, diagnostic, failed, '2026-10-08T12:00:00Z'), null);
      assert.deepEqual(await readFile(join(directory, 'manifest.json')), pointer);
      for (let index = 0; index < first.assets.length; index++) {
        assert.deepEqual(await readFile(join(directory, first.assets[index].path)), previousBodies[index]);
      }
      assert.equal((await readdir(join(directory, 'generations'))).length, 1);
      const report = JSON.parse(await readFile(diagnostic, 'utf8'));
      assert.equal(report.gates.publication.status, 'blocked');
      assert.match(report.gates.publication.evidence.join('\n'), new RegExp(gate));
    });
  });
}

test('source errors, failure evidence despite passing gates, gate regressions and record erasure each reject refresh', async () => {
  await withSample(async (directory, diagnostic) => {
    const first = await publishPreparation(directory, diagnostic, bundle(), generatedAt);
    assert.ok(first);
    const pointer = await readFile(join(directory, 'manifest.json'));
    for (const status of ['failed', 'error', 503]) {
      const failed = bundle(); failed.evidence.push(evidence('partial-session', status));
      assert.equal(await publishPreparation(directory, diagnostic, failed, '2026-10-08T12:00:00Z'), null);
      assert.deepEqual(await readFile(join(directory, 'manifest.json')), pointer);
    }
    const errored = bundle(); errored.errors.push('transit: connection timed out');
    assert.equal(await publishPreparation(directory, diagnostic, errored, generatedAt), null);
    const regression = bundle(); regression.gates.weather = structuredClone(blocked);
    assert.equal(await publishPreparation(directory, diagnostic, regression, generatedAt), null);
    const erased = bundle(); erased.energy = [];
    assert.equal(await publishPreparation(directory, diagnostic, erased, generatedAt), null);
    assert.deepEqual(await readFile(join(directory, 'manifest.json')), pointer);
  });
});

test('missing values remain records and do not count as erasure when source gates still pass', async () => {
  await withSample(async (directory, diagnostic) => {
    assert.ok(await publishPreparation(directory, diagnostic, bundle(), generatedAt));
    const refreshed = bundle(); refreshed.observations[0].value = null;
    // The weather gate can pass with other non-null parameters in the bounded source sample.
    refreshed.observations.push({...refreshed.observations[0], parameter: 'ws_10min', value: 1, unit: 'm/s'});
    const manifest = await publishPreparation(directory, diagnostic, refreshed, '2026-10-08T11:00:00Z');
    assert.ok(manifest);
    const observations = manifest.assets.find(asset => asset.path.endsWith('/observations.json'))!;
    const records = JSON.parse(await readFile(join(directory, observations.path), 'utf8'));
    assert.equal(records[0].value, null);
    assert.equal(records[1].value, 1);
  });
});
