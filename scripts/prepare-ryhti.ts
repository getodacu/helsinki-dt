import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestBytes } from '../src/lib/server/io.ts';
import { readRyhtiFile, ryhtiHash } from '../src/lib/server/ryhti-catalog.ts';
import { loadCityManifest, loadBuildingSearchIndex } from '../src/lib/city-assets.ts';
import { uniqueBuildings } from '../src/lib/data/energy-static.ts';
import { decodeRyhtiRecord, prepareRyhtiCatalog, ryhtiObject, ryhtiIdentifier, uniqueRyhtiRecords, validateRyhtiCatalog, RYHTI_MAX_BYTES } from '../src/lib/data/ryhti.ts';
import { RYHTI_COLLECTIONS, type RyhtiRecord, type RyhtiCatalog, type RyhtiManifest } from '../src/lib/ryhti-types.ts';
import type { Building, DatasetSource } from '../src/lib/types.ts';

async function writeAtomic(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function publishRyhti(catalog: RyhtiCatalog, root = 'static/data', beforePublish?: () => Promise<void>): Promise<RyhtiManifest> {
  validateRyhtiCatalog(catalog);
  const bytes = JSON.stringify(catalog);
  if (Buffer.byteLength(bytes) > RYHTI_MAX_BYTES) throw new Error('Ryhti catalog exceeds byte limit');
  const generation = randomUUID(), directory = join(root, 'ryhti', generation);
  await mkdir(directory, { recursive: true });
  let published = false;
  try {
    await writeAtomic(join(directory, 'catalog.json'), catalog);
    const manifest: RyhtiManifest = { version: 1, generatedAt: catalog.generatedAt,
      asset: { path: `ryhti/${generation}/catalog.json`, sha256: ryhtiHash(bytes), bytes: Buffer.byteLength(bytes) } };
    await beforePublish?.();
    await writeAtomic(join(root, 'ryhti-manifest.json'), manifest);
    published = true;
    return manifest;
  } finally { if (!published) await rm(directory, { recursive: true, force: true }); }
}
export async function recordRyhtiFailure(root: string, error: unknown, attemptedAt = new Date().toISOString()) {
  await mkdir(root, { recursive: true });
  await writeAtomic(join(root, 'ryhti-refresh-status.json'), { status: 'failed', attemptedAt,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
}
type ReadPage = (url: string) => Promise<unknown>;
export async function fetchRyhtiBatch(endpoint: string, identifiers: string[], readPage: ReadPage): Promise<RyhtiRecord[]> {
  if (!identifiers.length || identifiers.length > 50 || identifiers.some(id => !ryhtiIdentifier(id))) throw new Error('Invalid Ryhti identifier batch');
  const allowed = new Set(identifiers), first = new URL(endpoint);
  first.search = new URLSearchParams({ f: 'application/json', limit: '1000', 'filter-lang': 'cql-text',
    filter: `permanent_building_identifier IN (${identifiers.map(id => `'${id}'`).join(',')})` }).toString();
  let next: string | null = first.href, expected: number | null = null;
  const seen = new Set<string>(), rows: RyhtiRecord[] = [];
  while (next) {
    if (seen.has(next) || seen.size >= 100) throw new Error('Ryhti pagination did not complete');
    const url: URL = new URL(next);
    if (url.origin !== first.origin || url.pathname !== first.pathname || url.username || url.password
      || [...first.searchParams].some(([key, value]) => url.searchParams.get(key) !== value)
      || [...url.searchParams.keys()].some(key => !first.searchParams.has(key) && key !== 'startIndex')) throw new Error('Unsafe Ryhti pagination link');
    seen.add(next);
    const page = ryhtiObject(await readPage(next));
    if (page.type !== 'FeatureCollection' || !Array.isArray(page.features) || page.features.length > 1000
      || !Number.isSafeInteger(page.numberMatched) || (page.numberMatched as number) < 0 || (page.numberMatched as number) > 100000
      || page.numberReturned !== page.features.length || (page.links !== undefined && !Array.isArray(page.links))) throw new Error('Malformed Ryhti page');
    if (expected !== null && expected !== page.numberMatched) throw new Error('Ryhti changed during pagination; retry the snapshot');
    expected = page.numberMatched as number;
    for (const raw of page.features) {
      const row = decodeRyhtiRecord(raw);
      if (!allowed.has(row.properties.permanent_building_identifier)) throw new Error('Ryhti ignored the identifier filter');
      rows.push(row);
    }
    const links = ((page.links ?? []) as unknown[]).map(ryhtiObject).filter(link => link.rel === 'next');
    if (links.length > 1 || (links.length && typeof links[0].href !== 'string')) throw new Error('Invalid Ryhti next link');
    next = links.length ? new URL(links[0].href as string, url).href : null;
    if (rows.length > expected || (next && !page.features.length)) throw new Error('Invalid Ryhti pagination count');
  }
  const unique = uniqueRyhtiRecords(rows);
  if (unique.length !== expected) throw new Error('Incomplete Ryhti pagination');
  return unique;
}

export async function prepareRyhti(refresh = false, root = resolve('static/data'), cache = resolve('.cache/ryhti')) {
  const attemptedAt = new Date().toISOString();
  try {
    const cityBytes = await readRyhtiFile(root, 'city/manifest.json', 2_000_000), cityHash = ryhtiHash(cityBytes);
    const allRows: Building[] = [];
    const fetchCity = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (!/^\/data\/city\/(?:manifest\.json|generations\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json)$/.test(path)) throw new Error('Unsafe city metadata path');
      const bytes = path === '/data/city/manifest.json' ? cityBytes : await readRyhtiFile(root, path.slice(6), 2_000_000);
      if (path !== '/data/city/manifest.json') allRows.push(...JSON.parse(bytes.toString()));
      return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    const city = await loadCityManifest(fetchCity), index = await loadBuildingSearchIndex(city, fetchCity);
    if (index.unavailableChunks.length) throw new Error('Complete city metadata is required for Ryhti preparation');
    const buildings = uniqueBuildings(allRows), identifiers = [...new Set(buildings.flatMap(b => b.vtjPrt ? [b.vtjPrt] : []))].sort();
    if (!identifiers.length || identifiers.some(id => !ryhtiIdentifier(id))) throw new Error('Invalid city VTJ-PRT identifiers');
    const cacheKey = ryhtiHash(JSON.stringify(identifiers)), cacheDirectory = join(cache, cacheKey);
    await mkdir(cacheDirectory, { recursive: true });
    const records: Record<string, RyhtiRecord[]> = {}, sources: DatasetSource[] = [];
    for (const [kind, endpoint] of Object.entries(RYHTI_COLLECTIONS)) {
      const cachePath = join(cacheDirectory, kind + '.json');
      let snapshot: { retrievedAt: string; records: RyhtiRecord[]; sha256: string } | null = null;
      if (!refresh) {
        try {
          const bytes = await readRyhtiFile(cacheDirectory, kind + '.json', RYHTI_MAX_BYTES);
          const value = JSON.parse(bytes.toString());
          if (!Number.isFinite(Date.parse(value.retrievedAt)) || !Array.isArray(value.records)
            || value.sha256 !== ryhtiHash(JSON.stringify(value.records))) throw new Error('Invalid Ryhti source cache; use --refresh');
          snapshot = { ...value, records: value.records.map(decodeRyhtiRecord) };
          if (snapshot!.records.some(row => !identifiers.includes(row.properties.permanent_building_identifier))) throw new Error('Ryhti cache identifier mismatch');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!snapshot) {
        const rows: RyhtiRecord[] = [];
        for (let offset = 0; offset < identifiers.length; offset += 50) {
          rows.push(...await fetchRyhtiBatch(endpoint, identifiers.slice(offset, offset + 50), async url => {
            const result = await requestBytes(url, { timeoutMs: 30000, maxBytes: 8_000_000, redirect: 'error' });
            return JSON.parse(result.body.toString());
          }));
          if (rows.length > 100000) throw new Error('Ryhti source record bound exceeded');
          if (offset % 500 === 0) console.log(`${kind}: ${Math.min(offset + 50, identifiers.length)}/${identifiers.length} identifiers`);
        }
        const unique = uniqueRyhtiRecords(rows);
        snapshot = { retrievedAt: new Date().toISOString(), records: unique, sha256: ryhtiHash(JSON.stringify(unique)) };
        if (Buffer.byteLength(JSON.stringify(snapshot)) > RYHTI_MAX_BYTES) throw new Error('Ryhti source cache exceeds byte limit');
        await writeAtomic(cachePath, snapshot);
      }
      records[kind] = snapshot.records;
      sources.push({ id: 'ryhti-' + kind, provider: 'Finnish Environment Institute (Syke) / Ryhti', url: endpoint,
        license: 'CC BY 4.0', attribution: 'Source: Finnish Environment Institute (Syke), Ryhti building data, CC BY 4.0.',
        retrievedAt: snapshot.retrievedAt, vintage: null, units: [], coverage: `${identifiers.length} exact VTJ-PRT identifiers from ${buildings.length} prepared buildings`,
        method: 'Batched exact identifier queries; all pages validated. Permit records include historical work. No spatial or address joins.',
        checksum: snapshot.sha256, coordinateReference: null, axisOrder: null, verticalReference: null });
    }
    const catalog = prepareRyhtiCatalog(buildings, records.completed, records.permits, { generatedAt: city.generatedAt, sha256: cityHash }, sources);
    const manifest = await publishRyhti(catalog, root, async () => {
      if (ryhtiHash(await readRyhtiFile(root, 'city/manifest.json', 2_000_000)) !== cityHash) throw new Error('City changed during Ryhti preparation');
    });
    await rm(join(root, 'ryhti-refresh-status.json'), { force: true });
    return { manifest, coverage: catalog.coverage };
  } catch (error) { await recordRyhtiFailure(root, error, attemptedAt); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some(argument => argument !== '--refresh')) throw new Error('Only --refresh is supported');
  prepareRyhti(process.argv.includes('--refresh')).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error('Ryhti preparation failed; previous snapshot retained:', error); process.exitCode = 1; });
}
