import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { downloadFile } from '../src/lib/server/io.ts';
import { prepareBuildingChunk, verifyCoordinateControls } from '../src/lib/data/geometry.ts';
import type { CityJson } from '../src/lib/data/geometry.ts';
import type { DatasetSource, GateResult, ProbeEvidence } from '../src/lib/types.ts';
import { selectDistrictArchive, sha256File } from './geometry-archive.ts';

export const BUILDINGS_URL = 'https://3d.hel.ninja/data/citygml/Helsinki3D_CityGML_Kalasatama_20190326.zip';
const CONVERTER_URL = 'https://github.com/citygml4j/citygml-tools/releases/download/v2.5.0/citygml-tools-2.5.0.zip';
const SOURCE_SHA = 'ef6a787068b82642e5a0be5e20268e137075bb41fdbf0ec88619ad79926e2299';
const CONVERTER_SHA = 'bb2949fbc6c3ec44ec85c25a0bcdfe9accde9cbdb9e26ec773889779694710b1';
const execute = promisify(execFile);
export const CACHE = '.cache/task-a';

/** Immutable source files are cached with their original retrieval time and content checksum. */
export async function cachedDownload(url: string, path: string, maxBytes: number, expectedSha?: string) {
  let metadata: { retrievedAt: string; durationMs: number; status: number | string; bytes: number; sha256: string };
  try {
    const info = await stat(path);
    if (info.size > maxBytes) throw new Error('Cached source exceeds byte limit');
    const sha256 = await sha256File(path);
    let original: { retrievedAt: string } | undefined;
    try { original = JSON.parse(await readFile(path + '.metadata.json', 'utf8')); } catch {}
    metadata = { retrievedAt: original?.retrievedAt ?? info.mtime.toISOString(), durationMs: 0,
      status: 'cached checksum verified', bytes: info.size, sha256 };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    metadata = await downloadFile(url, path, { maxBytes, timeoutMs: 90_000 });
  }
  if (expectedSha && metadata.sha256 !== expectedSha) throw new Error('Pinned source checksum mismatch');
  await writeFile(path + '.metadata.json', JSON.stringify({ ...metadata, url }, null, 2));
  return metadata;
}

export async function prepareGeometry() {
  await mkdir(CACHE, { recursive: true });
  await mkdir('.cache/citygml-tools', { recursive: true });
  const archive = await cachedDownload(BUILDINGS_URL, CACHE + '/buildings.zip', 30_000_000, SOURCE_SHA);
  const converterArchive = await cachedDownload(CONVERTER_URL, '.cache/citygml-tools/tools.zip', 40_000_000, CONVERTER_SHA);
  const converter = '.cache/citygml-tools/citygml-tools-2.5.0/citygml-tools';
  try { await stat(converter); }
  catch {
    await execute('unzip', ['-q', '.cache/citygml-tools/tools.zip', '-d', '.cache/citygml-tools'], {
      timeout: 30_000, maxBuffer: 1024 * 1024 });
  }
  const started = performance.now();
  const selected = await selectDistrictArchive(CACHE + '/buildings.zip', CACHE + '/senate-square.gml');
  await execute(converter, ['to-cityjson', '--epsg=3879', '--compute-extent', '--cityjson-version=2.0',
    '--vertex-precision=3', '--output=' + CACHE, CACHE + '/senate-square.gml'], {
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, JAVA_OPTS: '-Xmx512m' } });
  const convertedFile = CACHE + '/senate-square.json';
  if ((await stat(convertedFile)).size > 20 * 1024 * 1024) throw new Error('Converted district exceeds byte limit');
  const document: CityJson = JSON.parse(await readFile(convertedFile, 'utf8'));
  const prepared = prepareBuildingChunk(document, selected.records);
  const duplicateRecords = selected.records.length - new Set(selected.records.map(record => record.gmlId)).size;
  const evidence: ProbeEvidence[] = [{
    id: 'buildings-citygml', url: BUILDINGS_URL, queriedAt: archive.retrievedAt,
    durationMs: archive.durationMs, status: archive.status, decodedCount: selected.sourceRecords,
    bytes: archive.bytes, freshness: '2019-03-26 archive; individual creation dates retained',
    authentication: 'anonymous', notes: [
      'CityModel contains ' + selected.rawBytes + ' inflated bytes; streamed with 280 MB bound.',
      selected.records.length + ' source records intersect the district by envelope centre.',
      duplicateRecords + ' repeated GMLID records reconciled across LoDs.',
      selected.appearanceCount + ' appearance records removed because texture files are absent.',
      prepared.buildings.length + ' unique renderable buildings; ' + prepared.chunk.positions.length / 9 + ' triangles.',
      'Rejected: ' + JSON.stringify(prepared.rejected),
      'Conversion/normalization elapsed ' + Math.round(performance.now() - started) + ' ms.',
      'Archive EPSG URI contains drf typo; corrected only in scoped converter input; original declaration preserved.'
    ]
  }, {
    id: 'citygml-converter', url: CONVERTER_URL, queriedAt: converterArchive.retrievedAt,
    durationMs: converterArchive.durationMs, status: converterArchive.status, decodedCount: prepared.buildings.length,
    bytes: converterArchive.bytes, freshness: 'pinned 2.5.0', authentication: 'anonymous',
    notes: ['SHA-256 ' + CONVERTER_SHA, 'Java 17+ required; conversion evaluated with Java 26.',
      'citygml-tools to-cityjson --epsg=3879 --compute-extent --cityjson-version=2.0 --vertex-precision=3 --output=.cache/task-a .cache/task-a/senate-square.gml']
  }];
  const sources: DatasetSource[] = [{
    id: 'helsinki-citygml-20190326', provider: 'City of Helsinki, Helsinki 3D', url: BUILDINGS_URL,
    license: 'CC BY 4.0', attribution: 'Helsinki 3D city information model, City of Helsinki (2019), CC BY 4.0',
    retrievedAt: archive.retrievedAt, vintage: '2019-03-26', units: ['m'],
    coverage: 'Senate Square district within Helsinki archive; envelope-centre selection',
    method: 'Semantic CityGML converted by citygml-tools 2.5.0; highest usable LoD; triangulated and batched',
    checksum: archive.sha256, coordinateReference: 'EPSG:3879 ETRS-GK25',
    axisOrder: 'archive tuples: easting,northing,elevation; scene: east,elevation,-north',
    verticalReference: 'N2000 metres; original heights preserved'
  }];
  const gates: Record<string, GateResult> = {
    building_geometry: { status: prepared.buildings.length >= 20 ? 'pass' : 'fail',
      evidence: [prepared.buildings.length + ' unique actual buildings retain GMLID, UUID, VTJ-PRT/RATU where available.',
        'Browser non-indexed chunk contains stable contiguous triangle-to-building ranges.',
        prepared.rejected.length + ' unusable objects excluded with explicit reasons.'], nextAction: null },
    coordinate_controls: { status: 'blocked', evidence: ['Metric projection and N2000 elevation preservation are regression tested.',
      'Three independent identifiable control locations still require saved coordinate evidence.'],
      nextAction: 'Save and verify three independent control locations.' }
  };
  try {
    const controls = JSON.parse(await readFile('tests/fixtures/coordinate-controls.json', 'utf8'));
    const results = verifyCoordinateControls(prepared.buildings, prepared.chunk, Array.isArray(controls) ? controls : controls.controls);
    gates.coordinate_controls = { status: 'pass', evidence: results.map(result => result.name + ': ' +
      result.distanceMetres.toFixed(2) + ' m from mesh extent; N2000 extrema differ by ' +
      result.verticalDifference.toFixed(4) + ' m; ' + result.sourceUrl), nextAction: null };
    await writeFile(CACHE + '/coordinate-control-results.json', JSON.stringify(results, null, 2));
  } catch (error) {
    gates.coordinate_controls.evidence.push(error instanceof Error ? error.message : String(error));
  }
  await writeFile(CACHE + '/geometry-result.json', JSON.stringify(prepared));
  await writeFile(CACHE + '/geometry-evidence.json', JSON.stringify({ sources, evidence, gates }, null, 2));
  return { buildings: prepared.buildings, chunks: [prepared.chunk], sources, evidence, gates };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await prepareGeometry();
  console.log(JSON.stringify({ buildings: result.buildings.length, triangles: result.chunks[0].positions.length / 9,
    gates: result.gates }, null, 2));
}
