import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inBounds, RELEASE_BOUNDS, DISTRICT_BOUNDS } from '../src/lib/area.ts';
import type { Building, DatasetSource } from '../src/lib/types.ts';
import type { EnergyCatalog, EnergyManifest } from '../src/lib/energy-types.ts';
import { validateEnergyCatalog, ENERGY_CATALOG_MAX_BYTES } from '../src/lib/server/energy-catalog.ts';
import { decodeNuukaProperty } from '../src/lib/data/energy.ts';
import { MODEL_SOURCE, MODEL_YEARS, SOLAR_SOURCE, SOLAR_VINTAGE, SOLAR_ASSUMPTIONS, uniqueBuildings, prepareModeled,
  prepareProperty, prepareSolar, joinReport, requireSourceVersion, type ModeledRow } from '../src/lib/data/energy-static.ts';
import { inspectWorkbook } from './energy-workbooks.ts';
import { cachedDownload } from './geometry.ts';
import { prepareSolarSource, SOLAR_TILESET_URL } from './energy-solar.ts';
import { NUUKA_PROPERTY_URL } from './energy.ts';

const MODEL_URL = 'https://www.hel.fi/hel2/tietokeskus/data/helsinki/kaupunginkanslia/3D-malli/Helsinki_Buildings_Heating_Energy_Demand_Climate_Change_20201021.xlsx';
const ATLAS_URL = 'https://www.hel.fi/hel2/tietokeskus/data/helsinki/kaupunginkanslia/3D-malli/data_atlas.xlsx';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function writeAtomic(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx');
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

/** Immutable catalog first; only the atomically replaced pointer can activate it. */
export async function publishEnergy(catalog: EnergyCatalog, root = 'static/data', beforePublish?: () => Promise<void>, attemptedAt = catalog.generatedAt) {
  validateEnergyCatalog(catalog);
  const bytes = JSON.stringify(catalog);
  if (Buffer.byteLength(bytes) > ENERGY_CATALOG_MAX_BYTES) throw new Error('Prepared energy catalog exceeds byte limit');
  const generation = randomUUID(), directory = join(root, 'energy', generation);
  await mkdir(directory, { recursive: true });
  let published = false;
  try {
    const file = await open(join(directory, 'energy.json'), 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const manifest: EnergyManifest = { version: 1, generatedAt: catalog.generatedAt,
      asset: { path: `energy/${generation}/energy.json`, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) },
      refresh: { status: 'current', attemptedAt, message: null } };
    await beforePublish?.();
    await writeAtomic(join(root, 'energy-manifest.json'), manifest);
    published = true;
    return manifest;
  } finally { if (!published) await rm(directory, { recursive: true, force: true }); }
}

/** Failed preparation may update diagnostics, but never replaces the last valid catalog. */
export async function recordEnergyFailure(root: string, error: unknown, attemptedAt = new Date().toISOString()) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await mkdir(root, { recursive: true });
  await writeAtomic(join(root, 'energy-refresh-status.json'), { status: 'failed', attemptedAt, message });
  try {
    const path = join(root, 'energy-manifest.json');
    if ((await stat(path)).size > 200_000) return;
    const manifest: EnergyManifest = JSON.parse(await readFile(path, 'utf8'));
    if (manifest.version !== 1 || !Number.isFinite(Date.parse(manifest.generatedAt))
      || !/^energy\/[a-zA-Z0-9_-]+\/energy\.json$/.test(manifest.asset?.path)
      || !Number.isInteger(manifest.asset.bytes) || manifest.asset.bytes < 1 || manifest.asset.bytes > ENERGY_CATALOG_MAX_BYTES
      || !/^[a-f0-9]{64}$/.test(manifest.asset.sha256) || (await stat(join(root, manifest.asset.path))).size !== manifest.asset.bytes) return;
    const bytes = await readFile(join(root, manifest.asset.path));
    if (manifest.version !== 1 || hash(bytes) !== manifest.asset.sha256 || bytes.length !== manifest.asset.bytes) return;
    validateEnergyCatalog(JSON.parse(bytes.toString()));
    await writeAtomic(join(root, 'energy-manifest.json'), { ...manifest, refresh: { status: 'failed', attemptedAt, message } });
  } catch { /* No prior valid catalog: the separate status file retains the failed first attempt. */ }
}

async function cityBuildings(): Promise<{ buildings: Building[]; source: DatasetSource; generatedAt: string }> {
  const manifest = JSON.parse(await readFile('static/data/city/manifest.json', 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.chunks) || manifest.chunks.length > 1000) throw new Error('Invalid city manifest');
  const lists: Building[] = [];
  for (const chunk of manifest.chunks) {
    if (!/^\/data\/city\/generations\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json$/.test(chunk.buildingsUrl)) throw new Error('Unsafe city metadata path');
    const path = 'static' + chunk.buildingsUrl;
    if ((await stat(path)).size > 12_000_000) throw new Error('City building list exceeds bound');
    const values = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(values) || values.some((b: Building) => !b || typeof b.id !== 'string' || typeof b.gmlId !== 'string'
      || !(b.vtjPrt === null || typeof b.vtjPrt === 'string') || !inBounds(b.longitude, b.latitude, RELEASE_BOUNDS))) throw new Error('Invalid city metadata identities');
    lists.push(...values);
  }
  const buildings = uniqueBuildings(lists), source = manifest.sources.find((source: DatasetSource) => source.id === 'helsinki-semantic-tiles');
  if (buildings.length !== 22686 || !source) throw new Error('Release building denominator or semantic source changed; review compatibility before preparing energy');
  return { buildings, source, generatedAt: manifest.generatedAt };
}

export async function prepareEnergy(refresh = false) {
  const attemptedAt = new Date().toISOString(), cache = '.cache/task-d';
  await mkdir(cache, { recursive: true });
  try {
    const city = await cityBuildings(), buildings = city.buildings;
    const rawCache = refresh ? cache + '/refresh-' + randomUUID() : '.cache/task-a';
    await mkdir(rawCache, { recursive: true });
    const modelPath = rawCache + '/modeled.xlsx', atlasPath = rawCache + '/atlas.xlsx', propertyPath = rawCache + '/nuuka-property.json';
    const modelMetadata = await cachedDownload(MODEL_URL, modelPath, 40_000_000);
    const atlasMetadata = await cachedDownload(ATLAS_URL, atlasPath, 12_000_000);
    requireSourceVersion(modelMetadata.sha256, '944e2029355ccae0c590226731dfba266b46ea5d4c35c96e083aaa5f949710b3', 'Modeled workbook');
    requireSourceVersion(atlasMetadata.sha256, '189554eca2a960a271c2c4c86176c3c7828e2cf4a28f4a1b5c041197b9533a7b', 'Atlas identity workbook');
    const propertyMetadata = await cachedDownload(NUUKA_PROPERTY_URL, propertyPath, 200_000);
    const geometryKey = hash(JSON.stringify(buildings.map(b => [b.id, b.gmlId, b.vtjPrt])));
    const inspectionPath = `${cache}/modeled-${modelMetadata.sha256}-${geometryKey}.json`;
    let inspection;
    try { inspection = JSON.parse(await readFile(inspectionPath, 'utf8')); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      inspection = await inspectWorkbook(modelPath, buildings, { maxRetainedRows: 30_000,
        retain: values => typeof values.SQ_2020_Longitude === 'number' && typeof values.SQ_2020_Latitude === 'number'
          && inBounds(values.SQ_2020_Longitude, values.SQ_2020_Latitude, RELEASE_BOUNDS) });
      await writeFile(inspectionPath, JSON.stringify(inspection));
    }
    const dataSheets = inspection.sheets.filter((sheet: { name: string }) => sheet.name !== 'metadata');
    const modelRows: ModeledRow[] = dataSheets.flatMap((sheet: { name: string; rows: { row: number; values: ModeledRow['values'] }[] }) => sheet.rows.map(row => {
      if (!(row.values.gmlid === null || typeof row.values.gmlid === 'string') || !(row.values.vtj_prt === null || typeof row.values.vtj_prt === 'string')) throw new Error('Modeled identifiers must stay strings');
      return { sourceId: `modeled:${sheet.name}:${row.row}`, gmlId: row.values.gmlid, vtjPrt: row.values.vtj_prt, values: row.values };
    }));
    const modeled = prepareModeled(modelRows, buildings);
    const atlas = await inspectWorkbook(atlasPath, buildings, { maxRetainedRows: 30_000 });
    const crosswalk = new Map<string, string[]>();
    for (const sheet of atlas.sheets) for (const row of sheet.rows) {
      const uuid = row.values.UUID, vtj = row.values.VTJ_PRT;
      if (typeof uuid === 'string' && typeof vtj === 'string') crosswalk.set('BID_' + uuid, [...(crosswalk.get('BID_' + uuid) ?? []), vtj]);
    }
    const solarSource = await prepareSolarSource(refresh ? rawCache + '/solar' : cache + '/solar');
    const solarRows = solarSource.rows.map(row => {
      const nationals = [...new Set(crosswalk.get(row.gmlId!) ?? [])];
      if (nationals.length > 1) throw new Error('Conflicting original Atlas identity versions: ' + row.gmlId);
      return { ...row, vtjPrt: nationals[0] ?? null };
    });
    const solar = prepareSolar(solarRows, buildings);
    const measured = prepareProperty(decodeNuukaProperty(JSON.parse(await readFile(propertyPath, 'utf8')), '091-001-0030-0001'), buildings);
    const source = (id: string, url: string, metadata: { retrievedAt: string; sha256: string }, vintage: string | null, units: string[], coverage: string, method: string): DatasetSource => ({
      id, provider: 'City of Helsinki', url, license: 'CC BY 4.0', attribution: 'City of Helsinki, CC BY 4.0', retrievedAt: metadata.retrievedAt,
      vintage, units, coverage, method, checksum: metadata.sha256, coordinateReference: null, axisOrder: null, verticalReference: null });
    const modelSource = source(MODEL_SOURCE, MODEL_URL, modelMetadata, '2020-10-21 export; scenarios 2020–2050', ['kWh'],
      'Full release identity set; citywide workbook source rows counted',
      'SimStadt modeled annual space heating and domestic hot water demand. 2020 SQ baseline; 2025–2050 CC changes climate while keeping the building stock. DIN V 18599 monthly energy balance; CityGML geometry, construction year/function typologies and available Atlas attributes; FMI climate reference years interpolated in 5-year steps; cooling excluded. kWh established by original City visualization (raw monthly fields /1000 → MWh) and model author paper doi:10.3390/ijgi9100602. Annual values are original workbook totals; missing calculations remain null.');
    const sources = [modelSource, source(SOLAR_SOURCE, SOLAR_TILESET_URL,
      { retrievedAt: solarSource.retrievedAt, sha256: solarSource.checksum }, SOLAR_VINTAGE, ['kWh'],
      `Only ${solarSource.tileCount} original solar tiles intersecting district ${DISTRICT_BOUNDS.join(',')}; coverage outside these tiles is unqueried`, SOLAR_ASSUMPTIONS.join(' ')),
      source('helsinki-nuuka', NUUKA_PROPERTY_URL, propertyMetadata, null, ['kWh'], 'Leijonakortteli municipal property; three original declared building members',
        'Measured property-level daily electricity retrieved on demand by the server; shared member buildings are a measurement boundary, never an allocation.'),
      source('helsinki-atlas-identity', ATLAS_URL, atlasMetadata, '2017', [], 'Original Atlas UUID and VTJ-PRT crosswalk for release IDs',
        'Original UUID → BID_UUID with declared national building identity; contradictory versions exclude solar associations.'), city.source];
    const reports = [joinReport(MODEL_SOURCE, modelSource.vintage, dataSheets.reduce((n: number, sheet: { rowCount: number }) => n + sheet.rowCount - 1, 0),
      modeled.associations, modeled.energy.filter(row => row.value !== null).flatMap(row => row.matchedBuildingIds), buildings.length,
      [`Geometry manifest generated ${city.generatedAt}; semantic source checksum ${city.source.checksum}; identity-set SHA-256 ${geometryKey}.`,
        'Within scope means at least one release identifier or source model coordinates inside release bounds. Source coordinates select records only; they do not prove association.',
        `One source building row yields ${MODEL_YEARS.length} annual scenario records, not ${MODEL_YEARS.length} independent source buildings. Duplicate identities across rows are withheld. Original conflicting rows remain in the checksum-keyed inspection cache.`]),
      joinReport(SOLAR_SOURCE, SOLAR_VINTAGE, solarRows.length, solar.associations,
        solar.solar.filter(row => row.value !== null).flatMap(row => row.matchedBuildingIds), buildings.length,
        [`Complete original building-parent count in ${solarSource.tileCount} selected district-intersecting tiles (${solarSource.totalBytes} bytes). Tile-edge records outside release stay unmatched; no citywide coverage is inferred.`,
          'Associations use original batch-table building parent GMLIDs (class 26) and original Atlas national identifier where available. Surface ids and parentPosition remain in raw tiles; no centroid/address matching.',
          'Suitable panel area, kW installed capacity, photovoltaic yield and current production are absent. Annual source radiation is incoming energy, not electricity.']),
      joinReport('helsinki-nuuka', null, measured.associations.length, measured.associations, measured.property.matchedBuildingIds, buildings.length,
        ['Denominator is three original declared property members; exact member joins do not establish building-only meters. Empty building codes remain unresolved location identities.'])];
    const catalog: EnergyCatalog = { version: 1, generatedAt: new Date().toISOString(), cityGeneratedAt: city.generatedAt, sources, energy: modeled.energy, solar: solar.solar,
      properties: [measured.property], reports };
    if (!catalog.energy.some(row => row.value !== null) || !catalog.solar.some(row => row.value !== null) || !measured.property.matchedBuildingIds.length) throw new Error('Actual modeled, solar and measured membership gates must all pass before publication');
    const manifest = await publishEnergy(catalog, 'static/data', undefined, attemptedAt);
    await writeAtomic('static/data/energy-refresh-status.json', { status: 'current', attemptedAt, message: null });
    await writeFile(cache + '/energy-summary.json', JSON.stringify({ manifest, reports: reports.map(({ associations, ...report }) => report),
      energyRecords: catalog.energy.length, solarRecords: catalog.solar.length, properties: catalog.properties, releaseBuildingCount: buildings.length }, null, 2));
    return { manifest, reports: reports.map(({ associations, ...report }) => report), energyRecords: catalog.energy.length, solarRecords: catalog.solar.length };
  } catch (error) { await recordEnergyFailure('static/data', error, attemptedAt); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(argument => argument !== '--refresh')) throw new Error('Only --refresh is supported');
  prepareEnergy(process.argv.includes('--refresh')).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error('Energy preparation failed; last valid catalog retained:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
