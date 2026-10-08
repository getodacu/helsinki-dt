import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAsset } from '../scripts/package-release.ts';

test('release rejects stale build assets, corruption and paths outside prepared data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helsinki-package-'));
  const body = '{"source":"dated"}', asset = { path: 'sample.json', bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  try {
    await mkdir(join(root, 'static/data'), { recursive: true });
    await mkdir(join(root, 'build/client/data'), { recursive: true });
    await writeFile(join(root, 'static/data/sample.json'), body);
    await writeFile(join(root, 'build/client/data/sample.json'), body);
    assert.deepEqual(await verifyAsset(root, asset), asset);
    await writeFile(join(root, 'build/client/data/sample.json'), '{"source":"old"}');
    await assert.rejects(verifyAsset(root, asset), /rebuild first/);
    await assert.rejects(verifyAsset(root, { ...asset, sha256: '0'.repeat(64) }), /checksum mismatch/);
    await assert.rejects(verifyAsset(root, { ...asset, path: '../sample.json' }));
    await writeFile(join(root, 'outside.json'), body);
    await symlink('../../outside.json', join(root, 'static/data/escape.json'));
    await assert.rejects(verifyAsset(root, { ...asset, path: 'escape.json' }), /escapes static/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
