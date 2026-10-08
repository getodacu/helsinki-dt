import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { publishSample } from '../scripts/publish.ts';

const input = { generatedAt: '2026-10-08T10:00:00Z', area: {release: [], district: [], origin: []}, sources: [], gates: {} };
test('publish twice and preserve the previous generation after a rejected write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helsinki-publication-'));
  try {
    const first = await publishSample(directory, input, {'buildings.json': [{id: 'BID_001'}]});
    const firstBody = await readFile(join(directory, first.assets[0].path));
    assert.equal(createHash('sha256').update(firstBody).digest('hex'), first.assets[0].sha256);
    const second = await publishSample(directory, input, {'buildings.json': [{id: 'BID_002'}]});
    assert.notEqual(first.assets[0].path, second.assets[0].path);
    const pointer = await readFile(join(directory, 'manifest.json'), 'utf8');
    await assert.rejects(publishSample(directory, input, {'../broken.json': []}), /Invalid sample asset name/);
    assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), pointer);
    assert.deepEqual(JSON.parse(await readFile(join(directory, first.assets[0].path), 'utf8')), [{id: 'BID_001'}]);
    assert.equal((await readdir(directory)).some(name => name.startsWith('.staging-')), false);
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    await assert.rejects(publishSample(directory, input, {'buildings.json': cyclic}));
    assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), pointer);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
