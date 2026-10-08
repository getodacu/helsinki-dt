import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requestText } from '../src/lib/server/io.ts';
import type { Building, DatasetSource, EnergyRecord, GateResult, ProbeEvidence, SolarRecord } from '../src/lib/types.ts';
import { decodeNuukaProperty, matchBuildingIdentity, normalizeNuukaEnergy } from '../src/lib/data/energy.ts';
import { cachedDownload, CACHE } from './geometry.ts';
import { inspectWorkbook } from './energy-workbooks.ts';
import type { WorkbookInspection } from './energy-workbooks.ts';

export const NUUKA_PROPERTY_URL = 'https://helsinki-openapi.nuuka.cloud/api/v1.0/Property/Search?SearchString=1761&SearchFromRecord=LocationName';
export const NUUKA_ENERGY_URL = 'https://helsinki-openapi.nuuka.cloud/api/v1.0/EnergyData/Daily/ListByProperty?Record=PropertyCode&SearchString=091-001-0030-0001&ReportingGroup=Electricity&StartTime=2026-10-06&EndTime=2026-10-07';
export const NUUKA_SWAGGER_URL = 'https://helsinki-openapi.nuuka.cloud/swagger/Nuuka%20Open%20API/swagger.json';
const ATLAS_BASE = 'https://www.hel.fi/hel2/tietokeskus/data/helsinki/kaupunginkanslia/3D-malli/';
export const SOLAR_SCHEMA_URL = 'https://kartta.hsy.fi/geoserver/wfs?service=WFS&version=2.0.0&request=DescribeFeatureType&typeNames=ilmasto_ja_energia:rakennukset_aurinkosahkopotentiaali';
export const SOLAR_SAMPLE_URL = 'https://kartta.hsy.fi/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=ilmasto_ja_energia:rakennukset_aurinkosahkopotentiaali&outputFormat=application%2Fjson&count=5&srsName=EPSG:4326&bbox=24.944,60.164,24.958,60.174,EPSG:4326';

function source(id: string, provider: string, url: string, retrievedAt: string, extras: Partial<DatasetSource>): DatasetSource {
  return { id, provider, url, retrievedAt, license: 'CC BY 4.0', attribution: provider + ', CC BY 4.0',
    vintage: null, units: [], coverage: 'Senate Square bounded sample', method: 'Source sample',
    checksum: null, coordinateReference: null, axisOrder: null, verticalReference: null, ...extras };
}
function failedEvidence(id: string, url: string, queriedAt: string, started: number, error: unknown): ProbeEvidence {
  return { id, url, queriedAt, durationMs: Math.round(performance.now() - started),
    status: 'failed', decodedCount: 0, bytes: 0, freshness: null, authentication: 'anonymous',
    notes: [error instanceof Error ? error.message : String(error)] };
}
function joins(inspection: WorkbookInspection, buildings: Building[]) {
  const counts = { exact: 0, missing: 0, ambiguous: 0, conflict: 0 };
  for (const sheet of inspection.sheets.filter(sheet => sheet.name !== 'metadata')) {
    for (const row of sheet.rows) {
      const gmlId = row.values.gmlid ?? row.values.gml_id;
      const vtjPrt = row.values.vtj_prt ?? row.values.VTJ_PRT;
      const uuid = row.values.UUID;
      const effectiveGml = typeof gmlId === 'string' ? gmlId : typeof uuid === 'string' ? 'BID_' + uuid : null;
      const match = matchBuildingIdentity(buildings, effectiveGml, typeof vtjPrt === 'string' ? vtjPrt : null);
      counts[match.status]++;
    }
  }
  return counts;
}

export async function probeEnergy(buildings: Building[]) {
  await mkdir(CACHE, { recursive: true });
  const sources: DatasetSource[] = [];
  const evidence: ProbeEvidence[] = [];
  const energy: EnergyRecord[] = [];
  const solar: SolarRecord[] = [];
  const gates: Record<string, GateResult> = {
    measured_energy: { status: 'blocked', evidence: [], nextAction: 'Retrieve and validate the Nuuka measured property sample.' },
    modeled_energy: { status: 'blocked', evidence: [], nextAction: 'Obtain authoritative units for the modeled heating demand workbook.' },
    solar: { status: 'blocked', evidence: [], nextAction: 'Establish an evidenced solar-feature-to-GMLID association, units and model vintage.' }
  };
  let started = performance.now(), queriedAt = new Date().toISOString();
  try {
    const swagger = await requestText(NUUKA_SWAGGER_URL, { maxBytes: 128_000, timeoutMs: 30_000 });
    const schema = JSON.parse(swagger.body);
    const operation = schema.paths?.['/api/v{version}/EnergyData/Daily/ListByProperty']?.get;
    if (!operation?.parameters?.some((item: { description?: string }) => item.description?.includes('BuildingCode returns data from the property'))) {
      throw new Error('Nuuka property-level consumption semantics could not be verified');
    }
    const metadata = await requestText(NUUKA_PROPERTY_URL, { maxBytes: 128_000, timeoutMs: 30_000 });
    const property = decodeNuukaProperty(JSON.parse(metadata.body), '091-001-0030-0001');
    const consumption = await requestText(NUUKA_ENERGY_URL, { maxBytes: 128_000, timeoutMs: 30_000 });
    const normalized = normalizeNuukaEnergy(JSON.parse(consumption.body), property, buildings);
    energy.push(...normalized.records);
    const exact = normalized.matches.filter(match => match.status === 'exact').length;
    const counts = Object.fromEntries(['exact', 'missing', 'ambiguous', 'conflict']
      .map(status => [status, normalized.matches.filter(match => match.status === status).length]));
    evidence.push({ id: 'nuuka-property-energy', url: NUUKA_ENERGY_URL, queriedAt: consumption.retrievedAt,
      durationMs: swagger.durationMs + metadata.durationMs + consumption.durationMs, status: consumption.status,
      decodedCount: normalized.records.length, bytes: Buffer.byteLength(swagger.body + metadata.body + consumption.body),
      freshness: 'Daily electricity, 6–7 October 2026; returned local date labels have no timezone offset.',
      authentication: 'anonymous', notes: [
        'Metadata ' + NUUKA_PROPERTY_URL, 'Scope schema ' + NUUKA_SWAGGER_URL,
        'Property 091-001-0030-0001 has ' + property.buildings.length + ' declared building members; joins ' + JSON.stringify(counts),
        'One property/day record keeps the whole consumption total; no allocation across members.',
        'City Hall VTJ-PRT 103027184J matched by exact national identifier.',
        'Member ambiguity candidates ' + JSON.stringify(normalized.matches.filter(match => match.status === 'ambiguous'))] });
    sources.push(source('helsinki-nuuka', 'City of Helsinki municipal service property energy / Nuuka', NUUKA_ENERGY_URL,
      consumption.retrievedAt, { units: ['kWh'], vintage: '2026-10-06/2026-10-07', coverage: 'Leijonakortteli property',
        method: 'Measured property-level daily electricity; exact building membership association; no allocation',
        checksum: createHash('sha256').update(consumption.body).digest('hex'), coordinateReference: 'WGS84 metadata',
        axisOrder: 'named longitude,latitude fields' }));
    gates.measured_energy = { status: normalized.hasMeasuredAssociation ? 'pass' : 'blocked',
      evidence: [normalized.records.length + ' measured property/day records with kWh units.',
        exact + '/' + property.buildings.length + ' property members uniquely associate with sample geometry (' + (exact / property.buildings.length * 100).toFixed(1) + '%).',
        'Join counts ' + JSON.stringify(counts), 'Total consumption retained once per property/day.'],
      nextAction: normalized.hasMeasuredAssociation ? null : 'Obtain a finite measured value with an exact property-member association.' };
    await writeFile(CACHE + '/nuuka-probe.json', JSON.stringify({ metadata: JSON.parse(metadata.body),
      consumption: JSON.parse(consumption.body), matches: normalized.matches, retrievedAt: consumption.retrievedAt }, null, 2));
  } catch (error) {
    evidence.push(failedEvidence('nuuka-property-energy', NUUKA_ENERGY_URL, queriedAt, started, error));
    gates.measured_energy.evidence = [evidence.at(-1)!.notes[0]];
  }

  const workbooks = [
    { name: 'atlas', file: 'data_atlas.xlsx', limit: 20_000_000, vintage: 'Atlas archive; individual certificate and 2015–2016 fields' },
    { name: 'heka', file: 'HEKA_Bldgs_Measured_Consumptions_2015_2016_2017_2018.xlsx', limit: 20_000_000, vintage: '2015–2018' },
    { name: 'modeled', file: 'Helsinki_Buildings_Heating_Energy_Demand_Climate_Change_20201021.xlsx', limit: 40_000_000, vintage: '2020-10-21; scenarios 2020–2050' }
  ];
  const workbookResults: Record<string, { inspection: WorkbookInspection; counts: ReturnType<typeof joins> }> = {};
  for (const workbook of workbooks) {
    started = performance.now(); queriedAt = new Date().toISOString();
    const url = ATLAS_BASE + workbook.file;
    try {
      const downloaded = await cachedDownload(url, CACHE + '/' + workbook.name + '.xlsx', workbook.limit);
      const inspectionKey = createHash('sha256').update(downloaded.sha256 + buildings.map(b => b.id).sort().join('|')).digest('hex');
      const summaryFile = CACHE + '/' + workbook.name + '-' + inspectionKey + '.summary.json';
      let inspection: WorkbookInspection;
      try { inspection = JSON.parse(await readFile(summaryFile, 'utf8')); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        inspection = await inspectWorkbook(CACHE + '/' + workbook.name + '.xlsx', buildings);
        await writeFile(summaryFile, JSON.stringify(inspection));
      }
      const counts = joins(inspection, buildings);
      workbookResults[workbook.name] = { inspection, counts };
      const rows = inspection.sheets.filter(s => s.name !== 'metadata').reduce((sum, s) => sum + s.rowCount - 1, 0);
      const matched = counts.exact;
      evidence.push({ id: 'atlas-' + workbook.name, url, queriedAt: downloaded.retrievedAt,
        durationMs: Math.round(performance.now() - started), status: downloaded.status, decodedCount: rows,
        bytes: downloaded.bytes, freshness: workbook.vintage, authentication: 'anonymous',
        notes: [inspection.inflatedBytes + ' inflated XLSX bytes; streaming rows retain only district identifiers.',
          'Matching retained row joins ' + JSON.stringify(counts),
          matched + '/' + buildings.length + ' sample buildings have exact retained rows (' + (matched / Math.max(1, buildings.length) * 100).toFixed(1) + '%).',
          workbook.name === 'modeled' ? 'Metadata descriptions declare heating and domestic-hot-water demand, without an energy unit. Values are excluded from normalized energy until verified.'
            : 'Header identifiers and declared units inspected; source rows preserved in ignored cache.'] });
      sources.push(source('helsinki-atlas-' + workbook.name, 'City of Helsinki Energy and Climate Atlas', url, downloaded.retrievedAt,
        { vintage: workbook.vintage, checksum: downloaded.sha256,
          method: 'Streamed XLSX metadata and exact district identifier matches',
          units: workbook.name === 'heka' ? ['MWh', 'kWh', 'm³'] : [],
          coordinateReference: workbook.name === 'modeled' ? 'WGS84 named fields' : null,
          axisOrder: workbook.name === 'modeled' ? 'longitude,latitude' : null }));
      if (workbook.name === 'modeled') gates.modeled_energy.evidence = [
        'Exact/missing/ambiguous/conflict retained model joins: ' + JSON.stringify(counts),
        'City Hall row has matching GMLID and VTJ-PRT; SQ_2020_Total_Yearly_Heat_DHW_demand = 59114, unit unverified.',
        'Both metadata descriptions and data header omit energy units; no modeled values published.'];
    } catch (error) {
      evidence.push(failedEvidence('atlas-' + workbook.name, url, queriedAt, started, error));
      if (workbook.name === 'modeled') gates.modeled_energy.evidence = [evidence.at(-1)!.notes[0]];
    }
  }
  await writeFile(CACHE + '/workbook-probes.json', JSON.stringify(workbookResults, null, 2));

  started = performance.now(); queriedAt = new Date().toISOString();
  try {
    const schema = await requestText(SOLAR_SCHEMA_URL, { maxBytes: 128_000, timeoutMs: 30_000 });
    if (!schema.body.includes('name="panel_ala"') || !schema.body.includes('name="elec_kwh_v"')) throw new Error('Unexpected HSY solar schema');
    const response = await requestText(SOLAR_SAMPLE_URL, { maxBytes: 1_000_000, timeoutMs: 30_000 });
    const payload = JSON.parse(response.body);
    if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features) || payload.features.length > 5
      || payload.features.some((feature: { properties?: Record<string, unknown> }) => !feature.properties
        || !['panel_ala', 'elec_kwh_v'].every(key => feature.properties![key] === null
          || typeof feature.properties![key] === 'number' && Number.isFinite(feature.properties![key])))) {
      throw new Error('Malformed solar features');
    }
    evidence.push({ id: 'hsy-solar', url: SOLAR_SAMPLE_URL, queriedAt: response.retrievedAt,
      durationMs: schema.durationMs + response.durationMs, status: response.status, decodedCount: payload.features.length,
      bytes: Buffer.byteLength(schema.body + response.body), freshness: typeof payload.timeStamp === 'string' ? payload.timeStamp : null,
      authentication: 'anonymous', notes: ['Schema ' + SOLAR_SCHEMA_URL,
        'Schema fields: ogc_fid,geom,panel_ala,elec_kwh_v. No GMLID, VTJ-PRT or RATU field.',
        'Requested five records; numberMatched ' + String(payload.numberMatched) + ' in the district bbox.',
        'ogc_fid is preserved as source identity; returned fid strings are generated service identifiers.',
        'No unverified spatial/manual association is attached to buildings. No model vintage declared by response.'] });
    sources.push(source('hsy-solar', 'Helsinki Region Environmental Services Authority (HSY)', SOLAR_SAMPLE_URL,
      response.retrievedAt, { method: 'Building-level solar-potential WFS schema and bounded features',
        coordinateReference: 'EPSG:4326', axisOrder: 'GeoJSON longitude,latitude',
        checksum: createHash('sha256').update(response.body).digest('hex') }));
    gates.solar.evidence = ['Five actual building-level solar features decoded; ' + String(payload.numberMatched) + ' district matches.',
      'No common building identifier or evidenced manual association; 0 solar records attached.',
      'Annual-unit field name is available, while model vintage/assumptions require authoritative metadata.'];
    await writeFile(CACHE + '/solar-probe.json', JSON.stringify({ schema: schema.body, payload, retrievedAt: response.retrievedAt }, null, 2));
  } catch (error) {
    evidence.push(failedEvidence('hsy-solar', SOLAR_SAMPLE_URL, queriedAt, started, error));
    gates.solar.evidence = [evidence.at(-1)!.notes[0]];
  }
  await writeFile(CACHE + '/energy-result.json', JSON.stringify({ energy, solar, sources, evidence, gates }, null, 2));
  return { energy, solar, sources, evidence, gates };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const geometry = JSON.parse(await readFile(CACHE + '/geometry-result.json', 'utf8'));
  const result = await probeEnergy(geometry.buildings);
  console.log(JSON.stringify({ energy: result.energy.length, solar: result.solar.length, gates: result.gates }, null, 2));
}
