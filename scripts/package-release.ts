import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCityManifest } from '../src/lib/city-assets.ts';
import { EnergyCatalogStore } from '../src/lib/server/energy-catalog.ts';
import { RouteContextStore } from '../src/lib/server/route-context.ts';
import { loadPreparedSample } from '../src/routes/sample.ts';

interface Asset { path: string; bytes: number; sha256: string }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Reject a stale build and paths that could copy files outside the prepared data. */
export async function verifyAsset(root: string, asset: Asset): Promise<Asset> {
  assert.match(asset.path, /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/);
  const data = await realpath(join(root, 'static/data'));
  const path = await realpath(resolve(data, asset.path));
  assert.ok(path.startsWith(data + sep), 'Asset escapes static/data');
  const bytes = await readFile(path);
  assert.equal(bytes.length, asset.bytes, 'Asset byte count mismatch: ' + asset.path);
  assert.equal(hash(bytes), asset.sha256, 'Asset checksum mismatch: ' + asset.path);
  assert.equal(hash(await readFile(join(root, 'build/client/data', asset.path))), asset.sha256,
    'Build differs from prepared data; rebuild first: ' + asset.path);
  return asset;
}

async function inventory(root: string, directory = ''): Promise<Asset[]> {
  const files: Asset[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else if (entry.isFile()) { const bytes = await readFile(join(root, path)); files.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
    else throw new Error('Unexpected symlink in release inputs: ' + path);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function dependencyNotices(root: string) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const sections = ['# Third-party dependency notices',
    'Generated from the locked installed production dependencies. Data-provider notices and source dates are retained separately in the prepared manifests and product source drawer. Runtime dependencies installed by npm retain their original notice files.'];
  for (const [path, entry] of Object.entries(lock.packages) as [string, { dev?: boolean; optional?: boolean; version: string; license?: string }][]) {
    if (!path || entry.dev) continue;
    let pkg;
    try { pkg = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && entry.optional) continue; throw error; }
    assert.equal(pkg.version, entry.version, 'Installed dependency differs from lock: ' + path);
    const names = await readdir(join(root, path));
    let notices = names.filter(name => /^(licen[cs]e|copying|notice|copyright)(?:\.|$)/i.test(name));
    if (!notices.length) notices = names.filter(name => /^readme(?:\.|$)/i.test(name));
    sections.push(`## ${pkg.name} ${pkg.version}\n\nLicense declaration: ${JSON.stringify(pkg.license ?? pkg.licenses ?? entry.license ?? null)}\n\nAuthor: ${JSON.stringify(pkg.author ?? null)}\n\nRepository: ${JSON.stringify(pkg.repository ?? null)}`);
    for (const name of notices.sort()) {
      if ((await stat(join(root, path, name))).isFile()) sections.push(`### ${name}\n\n` + await readFile(join(root, path, name), 'utf8'));
    }
  }
  return sections.join('\n\n') + '\n';
}

export async function packageRelease(root = resolve('.'), output = resolve('.cache/task-e/releases')) {
  const fetchAsset = (async (input: RequestInfo | URL) => {
    const path = String(input);
    assert.match(path, /^\/data\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/);
    return new Response(await readFile(join(root, 'static', path)));
  }) as typeof fetch;
  const foundation = await loadPreparedSample(fetchAsset);
  assert.ok(foundation.manifest && !foundation.sampleError, foundation.sampleError ?? 'Foundation is not prepared');
  const city = await loadCityManifest(fetchAsset);
  const energy = await new EnergyCatalogStore(join(root, 'static/data/energy-manifest.json')).load();
  assert.ok(energy.catalog, energy.message ?? 'Energy is not prepared or mismatches city');
  const route = await new RouteContextStore(join(root, 'static/data/route-index.json')).catalog();
  assert.equal(route.status, 'ready', route.reason ?? 'Routes are not prepared');
  const readJson = async (path: string) => JSON.parse(await readFile(join(root, 'static/data', path), 'utf8'));
  const energyManifest = await readJson('energy-manifest.json');
  const checksumPath = city.baseUrl.replace('/data/', '').replace('base.json', 'checksums.json');
  const checksums: Asset[] = await readJson(checksumPath);
  const expectedCity = [city.baseUrl, ...city.chunks.flatMap(chunk => [chunk.url, chunk.buildingsUrl])];
  assert.deepEqual(checksums.map(asset => '/data/' + asset.path.replace('/data/', '')).sort(), expectedCity.sort(), 'City checksums must cover every active asset');
  const assets = [...foundation.manifest.assets, ...checksums.map(asset => ({ ...asset, path: asset.path.replace('/data/', '') })), energyManifest.asset];
  for (const path of ['manifest.json', 'city/manifest.json', checksumPath, 'energy-manifest.json', 'route-index.json']) {
    const bytes = await readFile(join(root, 'static/data', path)); assets.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  try {
    const bytes = await readFile(join(root, 'static/data/energy-refresh-status.json'));
    assets.push({ path: 'energy-refresh-status.json', bytes: bytes.length, sha256: hash(bytes) });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const asset of assets) await verifyAsset(root, asset);
  await stat(join(root, 'build/index.js'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  const staging = join(output, '.staging-' + process.pid);
  await mkdir(staging, { recursive: true });
  try {
    for (const path of ['build', 'docs', 'package.json', 'package-lock.json', 'README.md', '.env.example', '.nvmrc']) await cp(join(root, path), join(staging, path), { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(staging, 'THIRD_PARTY_NOTICES.md'), await dependencyNotices(root));
    const files = await inventory(staging);
    const id = pkg.name + '-' + pkg.version + '-' + hash(JSON.stringify(files)).slice(0, 12);
    await mkdir(join(staging, 'static'));
    await symlink('../build/client/data', join(staging, 'static/data'), 'dir');
    const release = { version: 1, id, packagedAt: new Date().toISOString(), node: pkg.engines.node,
      foundationGeneratedAt: foundation.manifest.generatedAt, cityGeneratedAt: city.generatedAt,
      energyGeneratedAt: energy.catalog.generatedAt, routeGeneratedAt: route.generatedAt,
      energyStatus: energy.status, dataAssets: assets, files, fileBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
    await writeFile(join(staging, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    for (const asset of assets) await verifyAsset(staging, asset);
    const destination = join(output, id);
    await rename(staging, destination);
    return { path: destination, ...release };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error('Usage: npm run release:package -- [output-directory]');
  const release = await packageRelease(resolve('.'), process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(JSON.stringify({ path: release.path, id: release.id, fileBytes: release.fileBytes, activeDataAssets: release.dataAssets.length }, null, 2));
}
