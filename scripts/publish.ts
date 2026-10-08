import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SampleManifest } from '../src/lib/types.ts';

type ManifestInput = Omit<SampleManifest, 'version' | 'mode' | 'assets'>;

/** The root manifest is the only publication point; failed writes never change it. */
export async function publishSample(directory: string, input: ManifestInput, values: Record<string, unknown>) {
  await mkdir(join(directory, 'generations'), { recursive: true });
  const generation = `${input.generatedAt.replace(/[^0-9]/g, '')}-${randomUUID()}`;
  const staging = join(directory, `.staging-${generation}`);
  const destination = join(directory, 'generations', generation);
  const manifestTemporary = join(directory, `.manifest-${generation}.tmp`);
  await mkdir(staging);
  let committed = false;
  try {
    const assets: SampleManifest['assets'] = [];
    for (const [name, value] of Object.entries(values)) {
      if (!/^[a-z]+(?:-[a-z]+)*\.json$/.test(name)) throw new Error('Invalid sample asset name');
      const body = JSON.stringify(value, null, 2) + '\n';
      if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new Error('Sample asset exceeds 32 MiB');
      const file = await open(join(staging, name), 'wx');
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      assets.push({ path: `generations/${generation}/${name}`, bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'), count: Array.isArray(value) ? value.length : 1 });
    }
    const manifest: SampleManifest = { version: 1, mode: 'prepared-source-sample', ...input, assets };
    const pointer = await open(manifestTemporary, 'wx');
    try { await pointer.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await pointer.sync(); }
    finally { await pointer.close(); }
    await rename(staging, destination);
    await rename(manifestTemporary, join(directory, 'manifest.json'));
    committed = true;
    // Cleanup is best effort after commit; it must not turn a valid publication into a failed refresh.
    try {
    const active = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as SampleManifest;
    const activeName = active.assets[0]?.path.split('/')[1];
    const generations = (await readdir(join(directory, 'generations'))).sort().reverse();
    const keep = new Set([generation, activeName, ...generations.slice(0, 3)]);
    for (const name of generations) if (!keep.has(name)) {
      await rm(join(directory, 'generations', name), {recursive: true, force: true});
    }
    } catch (error) {
      console.warn('Sample published; old generation cleanup failed:', error instanceof Error ? error.message : String(error));
    }
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(manifestTemporary, { force: true });
    if (!committed) await rm(destination, { recursive: true, force: true });
  }
}
