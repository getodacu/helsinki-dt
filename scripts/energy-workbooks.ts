import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import ExcelJS from 'exceljs';
import type { Building } from '../src/lib/types.ts';

/** Preflight the same immutable file that ExcelJS reads; count actual inflated bytes before parsing. */
export async function verifyWorkbookInflation(path: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
      if (error || !archive) reject(error ?? new Error('Invalid XLSX ZIP')); else resolve(archive);
    });
  });
  let entries = 0, bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => { zip.close(); reject(error); };
    zip.once('error', fail);
    zip.once('end', resolve);
    zip.on('entry', (entry: yauzl.Entry) => {
      if (++entries > 100 || entry.uncompressedSize + bytes > 250_000_000
        || entry.fileName === 'xl/sharedStrings.xml' && entry.uncompressedSize > 16_000_000) {
        fail(new Error('Workbook inflation or shared-string limit exceeded')); return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { fail(error ?? new Error('Invalid XLSX entry')); return; }
        stream.once('error', fail);
        stream.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 250_000_000) { stream.destroy(); fail(new Error('Workbook inflation byte limit exceeded')); }
        });
        stream.once('end', () => zip.readEntry());
      });
    });
    zip.readEntry();
  });
  return { entries, bytes };
}

export interface WorkbookRow { row: number; values: Record<string, string | number | null> }
export interface WorkbookInspection {
  sheets: { name: string; rowCount: number; headers: string[]; rows: WorkbookRow[] }[];
  inflatedBytes: number;
}

function cellValue(value: ExcelJS.CellValue): string | number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length ? value : null;
  if (typeof value === 'object' && 'sharedString' in value) throw new Error('Unresolved workbook shared string');
  if (typeof value === 'object' && 'richText' in value) return value.richText.map(item => item.text).join('');
  if (typeof value === 'object' && 'result' in value) return cellValue(value.result ?? null);
  if (typeof value === 'object' && 'text' in value) return value.text;
  return null;
}

export async function inspectWorkbook(path: string, buildings: Building[], options: { maxRetainedRows?: number; retain?: (values: WorkbookRow['values']) => boolean } = {}): Promise<WorkbookInspection> {
  const maxRetainedRows = options.maxRetainedRows ?? 500;
  if (!Number.isInteger(maxRetainedRows) || maxRetainedRows < 1 || maxRetainedRows > 100_000) throw new Error('Invalid workbook retained-row bound');
  const bounded = await verifyWorkbookInflation(path);
  const wanted = new Set(buildings.flatMap(building => [building.gmlId, building.vtjPrt, building.uuid]).filter(Boolean));
  const input = createReadStream(path);
  const pipe = input.pipe.bind(input);
  // unzipper signals end before paused ZIP entries drain; keep the bounded entry stream flowing.
  input.pipe = (destination, options) => {
    if (destination instanceof Readable) destination.on('pause', () => destination.resume());
    return pipe(destination, options);
  };
  // ponytail: supports verified provider ZIP ordering; revisit if a provider moves workbook metadata after worksheet parsing.
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, {
    worksheets: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', entries: 'ignore'
  });
  const sheets: WorkbookInspection['sheets'] = [];
  try {
    for await (const sheet of reader) {
      if (sheets.length >= 5) throw new Error('Workbook sheet limit exceeded');
      if (!('name' in sheet) || typeof sheet.name !== 'string') throw new Error('Workbook sheet name missing');
      const rows: WorkbookRow[] = [];
      let headers: string[] = [], rowCount = 0;
      for await (const row of sheet) {
        if (++rowCount > 100_000) throw new Error('Workbook row limit exceeded');
        if (rowCount === 1) {
          headers = Array.from({ length: row.cellCount }, (_, index) => String(cellValue(row.getCell(index + 1).value) ?? ''));
          if (headers.length > 200 || !headers.includes('vtj_prt') && !headers.includes('VTJ_PRT')) {
            throw new Error('Unexpected workbook header schema');
          }
          continue;
        }
        const values = Object.fromEntries(headers.map((header, index) => [header, cellValue(row.getCell(index + 1).value)]));
        const matching = Object.values(values).some(value => typeof value === 'string' && wanted.has(value));
        if (sheet.name === 'metadata' || matching || options.retain?.(values)) {
          if (rows.length >= maxRetainedRows) throw new Error('Workbook retained-row limit exceeded');
          rows.push({ row: row.number, values });
        }
      }
      sheets.push({ name: sheet.name, rowCount, headers, rows });
    }
  } finally { input.destroy(); }
  return { sheets, inflatedBytes: bounded.bytes };
}
