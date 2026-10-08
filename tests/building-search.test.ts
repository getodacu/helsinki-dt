import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBuildingSearchIndex, type CityManifest } from '../src/lib/city-assets.ts';
import { SCENE_ORIGIN } from '../src/lib/area.ts';
import type { Building, DatasetSource } from '../src/lib/types.ts';
const building: Building = { id: 'BID_001', gmlId: 'BID_001', vtjPrt: '001', ratu: null, uuid: null,
  chunkRef: 'a', longitude: 24.95, latitude: 60.17, attributes: {}, sourceId: 'fixture' };
const manifest = { version: 1, generatedAt: '2026-10-08T00:00:00Z', origin: SCENE_ORIGIN, bounds: [24.9,60.1,25,60.2],
  initialChunkIds: ['a'], baseUrl: '/data/city/generations/f/base.json', gaps: [], sources: [{ id: 'fixture' } as DatasetSource],
  chunks: ['a','b','c'].map(id => ({ id, url: `/data/city/generations/f/${id}.json`, buildingsUrl: `/data/city/generations/f/${id}_buildings.json`,
    bounds: [0,0,1,1], buildingCount: 1, triangleCount: 1, bytes: 100 })) } as CityManifest;
test('search reads metadata only, deduplicates split identities and reports partial coverage', async () => {
  const requested: string[] = [];
  const fetcher = (async (url: RequestInfo | URL) => {
    requested.push(String(url));
    if (String(url).endsWith('c_buildings.json')) return new Response('outage', { status: 503 });
    const chunkRef = String(url).endsWith('a_buildings.json') ? 'a' : 'b';
    return new Response(JSON.stringify([{ ...building, chunkRef }]));
  }) as typeof fetch;
  const result = await loadBuildingSearchIndex(manifest, fetcher);
  assert.equal(result.buildings.length, 1); assert.equal(result.buildings[0].vtjPrt, '001');
  assert.deepEqual(result.unavailableChunks, ['c']); assert.ok(requested.every(url => url.endsWith('_buildings.json')));
});
test('invalid identity chunks stay unavailable and caller cancellation is respected', async () => {
  const fetcher = (async () => new Response(JSON.stringify([{ ...building, longitude: Infinity }]))) as typeof fetch;
  const result = await loadBuildingSearchIndex(manifest, fetcher);
  assert.equal(result.buildings.length, 0); assert.deepEqual(result.unavailableChunks, ['a','b','c']);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadBuildingSearchIndex(manifest, fetcher, controller.signal), /abort/i);
  await assert.rejects(loadBuildingSearchIndex({ ...manifest, chunks: [{ ...manifest.chunks[0], buildingCount: 50_001 }] }, fetcher), /record limit/);
});
