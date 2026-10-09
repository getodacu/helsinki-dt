import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCityManifest, validBuilding } from '../src/lib/city-assets.ts';
import { EnergyCatalogStore } from '../src/lib/server/energy-catalog.ts';
import { RyhtiCatalogStore, readRyhtiFile } from '../src/lib/server/ryhti-catalog.ts';
import { loadPreparedSample } from '../src/routes/sample.ts';
import type { Building } from '../src/lib/types.ts';
import { buildEntityDatabase, entityHash } from './entity-database.ts';

/** Build privately; only a complete validated database may become the active generation. */
export async function prepareEntities(root = resolve('static/data'), destination = resolve('server/data/entities')) {
  const inputs = ['city/manifest.json', 'energy-manifest.json', 'ryhti-manifest.json', 'manifest.json', 'energy-refresh-status.json', 'ryhti-refresh-status.json'];
  const signatures = async () => Promise.all(inputs.map(async path => {
    try { return entityHash(await readRyhtiFile(root, path, 2_000_000)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== inputs[0]) return null; throw error; }
  }));
  const before = await signatures();
  const fetchAsset = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (!/^\/data\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/.test(path)) throw new Error('Unsafe entity input');
    try { return new Response(new Uint8Array(await readRyhtiFile(root, path.slice(6), 2_000_000))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
  }) as typeof fetch;
  const city = await loadCityManifest(fetchAsset);
  const buildings: Building[] = [];
  let bytes = 0;
  for (const chunk of city.chunks) {
    const data = await readRyhtiFile(root, chunk.buildingsUrl.slice(6), 2_000_000);
    bytes += data.length;
    if (bytes > 40_000_000) throw new Error('Entity metadata exceeds byte limit');
    const rows: Building[] = JSON.parse(data.toString());
    if (!Array.isArray(rows) || rows.length !== chunk.buildingCount || rows.some(row => !validBuilding(row, chunk.id, city))
      || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Invalid building chunk metadata');
    buildings.push(...rows);
    if (buildings.length > 50_000) throw new Error('Entity count exceeds limit');
  }
  const energy = await new EnergyCatalogStore(join(root, 'energy-manifest.json')).load();
  const ryhti = await new RyhtiCatalogStore(root).load();
  if (before[1] && !energy.catalog) throw new Error(energy.message ?? 'Invalid energy input');
  if (before[2] && !ryhti.catalog) throw new Error(ryhti.message ?? 'Invalid Ryhti input');
  const foundation = await loadPreparedSample(fetchAsset);
  if (before[3] && !foundation.manifest) throw new Error(foundation.sampleError ?? 'Invalid foundation input');
  const generation = randomUUID();
  await mkdir(destination, { recursive: true });
  const path = join(destination, generation + '.sqlite'), temporary = join(destination, generation + '.tmp');
  let published = false;
  try {
    const catalog = buildEntityDatabase(path, { generation, city, cityManifestSha256: before[0]!, buildings, energy, ryhti, foundation: foundation.manifest });
    const file = await open(path, 'r');
    let checksum: string;
    try { await file.sync(); checksum = entityHash(await file.readFile()); } finally { await file.close(); }
    if (JSON.stringify(before) !== JSON.stringify(await signatures())) throw new Error('Source manifests changed during entity preparation; retry');
    const pointer = { version: 1, generation, bytes: (await stat(path)).size, sha256: checksum };
    const manifest = await open(temporary, 'wx');
    try { await manifest.writeFile(JSON.stringify(pointer)); await manifest.sync(); } finally { await manifest.close(); }
    await rename(temporary, join(destination, 'manifest.json'));
    published = true;
    return { generation, buildings: catalog.buildingCount, themes: catalog.themes.length, bytes: pointer.bytes };
  } finally {
    await rm(temporary, { force: true });
    if (!published) await rm(path, { force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) throw new Error('Usage: npm run entities:prepare');
  console.log(JSON.stringify(await prepareEntities(), null, 2));
}
