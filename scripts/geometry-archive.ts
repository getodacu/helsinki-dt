import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createReadStream } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DISTRICT_BOUNDS, inBounds } from '../src/lib/area.ts';
import { gk25ToWgs84 } from '../src/lib/geo.ts';
import type { SourceBuilding } from '../src/lib/data/geometry.ts';

export async function sha256File(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** This dated archive has exactly one CityGML member; bound advertised and actual inflation. */
export async function openBuildingStream(path: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
      if (error || !archive) reject(error ?? new Error('Invalid ZIP')); else resolve(archive);
    });
  });
  return new Promise<import('node:stream').Readable>((resolve, reject) => {
    let entries = 0;
    zip.on('error', reject);
    zip.on('end', () => reject(new Error('CityGML member missing')));
    zip.on('entry', (entry: yauzl.Entry) => {
      if (++entries > 100) { zip.close(); reject(new Error('ZIP entry limit exceeded')); return; }
      if (entry.fileName !== 'Helsinki3D_CityGML_Kalasatama_20190326.gml') { zip.readEntry(); return; }
      if (entry.uncompressedSize > 280_000_000 || entry.compressedSize > 30_000_000) {
        zip.close(); reject(new Error('CityGML ZIP inflation limit exceeded')); return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { zip.close(); reject(error ?? new Error('No GML stream')); return; }
        stream.once('close', () => zip.close());
        stream.once('end', () => zip.close());
        resolve(stream);
      });
    });
    zip.readEntry();
  });
}

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false });
function attributesOf(building: Record<string, unknown>) {
  const attributes: Record<string, string | null> = {};
  for (const [tag, contents] of Object.entries(building)) {
    if (!/^gen:(string|int|double|date|uri)Attribute$/.test(tag)) continue;
    for (const item of (Array.isArray(contents) ? contents : [contents]) as Record<string, unknown>[]) {
      const name = item['@_name'];
      if (typeof name !== 'string') continue;
      const value = item['gen:value'];
      attributes[name] = typeof value === 'string' ? value.length ? value : null : value == null ? null : String(value);
    }
  }
  for (const key of ['creationDate', 'bldg:yearOfConstruction', 'bldg:function', 'bldg:usage', 'bldg:measuredHeight']) {
    const value = building[key];
    if (typeof value === 'string') attributes[key] = value;
  }
  return attributes;
}

export async function selectDistrictArchive(path: string, outputPath: string) {
  const input = await openBuildingStream(path);
  const output = await openFile(outputPath, 'w');
  const records: SourceBuilding[] = [];
  const decoder = new StringDecoder('utf8');
  let buffer = '', headerWritten = false, rawBytes = 0, sourceRecords = 0, appearanceCount = 0;
  try {
    for await (const chunk of input) {
      rawBytes += Buffer.byteLength(chunk);
      if (rawBytes > 280_000_000) throw new Error('CityGML inflation byte limit exceeded');
      buffer += decoder.write(chunk);
      if (/<!DOCTYPE|<!ENTITY/i.test(buffer)) throw new Error('XML entities are not supported');
      for (;;) {
        const begin = buffer.indexOf('<cityObjectMember>');
        const end = buffer.indexOf('</cityObjectMember>');
        if (begin < 0 || end < begin) break;
        if (!headerWritten) {
          const header = buffer.slice(0, begin).replaceAll('urn:ogc:drf:crs:EPSG::3879', 'urn:ogc:def:crs:EPSG::3879');
          if (!header.includes('<CityModel')) throw new Error('Expected CityGML CityModel header');
          await output.writeFile(header);
          headerWritten = true;
        }
        const fragment = buffer.slice(begin, end + '</cityObjectMember>'.length);
        buffer = buffer.slice(end + '</cityObjectMember>'.length);
        const index = sourceRecords++;
        const lower = fragment.match(/<gml:lowerCorner>([^<]+)<\/gml:lowerCorner>/)?.[1]?.trim().split(/\s+/).map(Number);
        const upper = fragment.match(/<gml:upperCorner>([^<]+)<\/gml:upperCorner>/)?.[1]?.trim().split(/\s+/).map(Number);
        if (!lower || !upper || lower.length !== 3 || upper.length !== 3 || ![...lower, ...upper].every(Number.isFinite)) continue;
        const [longitude, latitude] = gk25ToWgs84((lower[0] + upper[0]) / 2, (lower[1] + upper[1]) / 2);
        if (!inBounds(longitude, latitude, DISTRICT_BOUNDS)) continue;
        if (records.length >= 500) throw new Error('District retained-record limit exceeded');
        if (XMLValidator.validate(fragment) !== true) throw new Error('Malformed selected CityGML record');
        const parsed = parser.parse(fragment)?.cityObjectMember?.['bldg:Building'];
        if (!parsed || typeof parsed['@_gml:id'] !== 'string') continue;
        const gmlId: string = parsed['@_gml:id'];
        const key = `${gmlId}__source_record_${index}`;
        const attributes = attributesOf(parsed);
        attributes.sourceEnvelopeMinimumElevation = String(lower[2]);
        attributes.sourceEnvelopeMaximumElevation = String(upper[2]);
        attributes.sourceCrsDeclaration = 'urn:ogc:drf:crs:EPSG::3879';
        records.push({ key, gmlId, longitude, latitude, attributes });
        const stripped = fragment.replace(/<app:appearance\b[^>]*>[\s\S]*?<\/app:appearance>/g, () => {
          appearanceCount++; return '';
        }).replaceAll('urn:ogc:drf:crs:EPSG::3879', 'urn:ogc:def:crs:EPSG::3879')
          .replace(/(<bldg:Building\b[^>]*gml:id=")[^"]+(")/, `$1${key}$2`);
        await output.writeFile(stripped + '\n');
      }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) throw new Error('CityGML record-buffer limit exceeded');
    }
    buffer += decoder.end();
    if (!headerWritten || buffer.includes('<cityObjectMember>')) throw new Error('Incomplete CityGML archive');
    await output.writeFile('</CityModel>\n');
    await output.sync();
  } finally { input.destroy(); await output.close(); }
  return { records, rawBytes, sourceRecords, appearanceCount };
}
