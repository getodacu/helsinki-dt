import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPreparedSample } from '../src/routes/sample.ts';

const manifest = {
  version: 1, mode: 'prepared-source-sample', generatedAt: '2026-10-08T12:00:00Z',
  assets: [{ path: 'generations/sample-1/buildings.json', count: 1 }],
  sources: [], gates: { geometry: { status: 'pass', evidence: ['20 source buildings'], nextAction: null } }
};
const buildings = [{ id: '001', gmlId: '001', longitude: 24.95, latitude: 60.17, attributes: {} }];
function event(responses: Record<string, unknown | Response>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const value = responses[String(url)];
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
}

test('shell distinguishes absent sample from an upstream or decoding error', async () => {
  const absent = await loadPreparedSample(event({ '/data/manifest.json': new Response(null, { status: 404 }) }));
  assert.equal(absent.manifest, null);
  assert.equal(absent.sampleError, null);
  const failed = await loadPreparedSample(event({ '/data/manifest.json': new Response(null, { status: 503 }) }));
  assert.match(failed.sampleError ?? '', /HTTP 503/);
  const malformed = await loadPreparedSample(event({ '/data/manifest.json': new Response('invalid json') }));
  assert.ok(malformed.sampleError);
});

test('shell reads the declared generation and preserves string identifiers', async () => {
  const data = await loadPreparedSample(event({ '/data/manifest.json': manifest, '/data/generations/sample-1/buildings.json': buildings }));
  assert.equal(data.sampleError, null);
  assert.equal(data.buildings[0].id, '001');
  assert.equal(data.manifest?.generatedAt, manifest.generatedAt);
});

test('shell rejects traversal, mismatched counts and duplicate building IDs', async () => {
  const unsafe = await loadPreparedSample(event({ '/data/manifest.json': { ...manifest, assets: [{ path: '../buildings.json', count: 1 }] } }));
  assert.match(unsafe.sampleError ?? '', /building asset/);
  const mismatch = await loadPreparedSample(event({ '/data/manifest.json': manifest, '/data/generations/sample-1/buildings.json': [] }));
  assert.match(mismatch.sampleError ?? '', /building sample/);
  const duplicates = await loadPreparedSample(event({ '/data/manifest.json': { ...manifest, assets: [{ path: 'generations/sample-1/buildings.json', count: 2 }] },
    '/data/generations/sample-1/buildings.json': [buildings[0], buildings[0]] }));
  assert.match(duplicates.sampleError ?? '', /building sample/);
});

test('shell rejects malformed gate/source metadata before rendering', async () => {
  const badGate = await loadPreparedSample(event({ '/data/manifest.json': { ...manifest, gates: { geometry: { status: 'pass', evidence: 1 } } } }));
  assert.match(badGate.sampleError ?? '', /manifest/);
  const badSource = await loadPreparedSample(event({ '/data/manifest.json': { ...manifest, sources: [{ id: 'fmi', retrievedAt: 'invalid', units: [], url: 'https://example.com' }] } }));
  assert.match(badSource.sampleError ?? '', /manifest/);
});
