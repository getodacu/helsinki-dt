import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { readRyhtiFile } from './ryhti-catalog.ts';
import { searchText } from '../inspection.ts';
import { buildingImageCache, buildingPhotoCache } from './building-photo.ts';
import type { Building } from '../types.ts';
import type { EnergyCatalog, EnergyAssociation } from '../energy-types.ts';
import type { RyhtiBuilding } from '../ryhti-types.ts';
import type { EntityCatalog, EntityDetail, EntitySearch, EntityThemeValues } from '../entity-types.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class EntityError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new EntityError(status, message); }
export function entityParameters(url: URL, allowed: string[]) {
  if (url.search.length > 8192 || [...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) fail(400, 'Invalid or duplicate query parameter.');
  return url.searchParams;
}
interface StoredDetail {
  energy: EnergyCatalog['energy']; solar: EnergyCatalog['solar']; properties: EnergyCatalog['properties'];
  associations: EnergyAssociation[][]; ryhti: RyhtiBuilding | null;
}

export class EntityDatabase {
  db: DatabaseSync;
  catalog: EntityCatalog;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    try {
      this.db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192;');
      const row = this.db.prepare("SELECT value FROM metadata WHERE key='catalog'").get();
      this.catalog = JSON.parse(String(row?.value));
      if (this.catalog.version !== 1 || !Array.isArray(this.catalog.themes) || !Number.isSafeInteger(this.catalog.buildingCount)) throw new Error('Invalid database metadata');
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  search(params: URLSearchParams, catalog = this.catalog): EntitySearch {
    if (params.has('kind') && params.get('kind') !== 'building') fail(400, 'Supported entity kind: building.');
    const raw = params.get('q') ?? '';
    if (raw.length > 200 || /[\u0000-\u001f]/.test(raw)) fail(400, 'Search must be at most 200 characters.');
    const q = searchText(raw), size = params.get('limit') ?? '30';
    if (!/^[1-9]\d?$/.test(size) || Number(size) > 60) fail(400, 'Limit must be between 1 and 60.');
    const theme = params.get('theme') ?? '', category = params.get('category') ?? '';
    if (theme || category) {
      const option = catalog.themes.find(item => item.key === theme);
      if (!option || !option.categories.some(item => item.key === category)) fail(400, 'Unknown theme category.');
    }
    const fingerprint = hash(JSON.stringify([catalog.generation, q, theme, category]));
    let cursor: { fingerprint: string; priority: number; id: string } | null = null;
    if (params.has('cursor')) {
      const value = params.get('cursor')!;
      try {
        if (!value || value.length > 2048 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error();
        cursor = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (!cursor || cursor.fingerprint !== fingerprint || ![0, 1].includes(cursor.priority) || typeof cursor.id !== 'string' || cursor.id.length > 4096) throw new Error();
      } catch { fail(400, 'Invalid cursor for this search.'); }
    }
    const exact = !!q && !!this.db.prepare('SELECT 1 FROM identifiers WHERE value=? LIMIT 1').get(q);
    const where: string[] = [], values: (string | number)[] = exact ? [q] : [];
    if (q) {
      if ([...q].length >= 3) {
        where.push('b.rowid IN (SELECT rowid FROM building_search WHERE building_search MATCH ?)');
        values.push('"' + q.replaceAll('"', '""') + '"');
      }
      where.push('instr(b.search_text,?) > 0'); values.push(q);
    }
    if (category) {
      where.push('EXISTS (SELECT 1 FROM theme_values t WHERE t.building_id=b.id AND t.theme=? AND t.category=?)'); values.push(theme, category);
    }
    const priority = exact ? 'CASE WHEN EXISTS(SELECT 1 FROM identifiers i WHERE i.value=? AND i.building_id=b.id) THEN 0 ELSE 1 END' : '1';
    const base = `SELECT b.id,b.data,${priority} AS priority
      FROM buildings b ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const page = cursor ? exact ? 'WHERE (priority,id) > (?,?)' : 'WHERE id > ?' : '';
    if (cursor) values.push(...(exact ? [cursor.priority, cursor.id] : [cursor.id]));
    values.push(Number(size) + 1);
    const rows = this.db.prepare(`SELECT * FROM (${base}) ${page} ORDER BY ${exact ? 'priority,id' : 'id'} LIMIT ?`).all(...values);
    const more = rows.length > Number(size); if (more) rows.pop();
    const last = rows.at(-1);
    return { generation: catalog.generation, buildings: rows.map(row => JSON.parse(String(row.data))),
      nextCursor: more && last ? Buffer.from(JSON.stringify({ fingerprint, priority: last.priority, id: last.id })).toString('base64url') : null };
  }
  detail(id: string, catalog = this.catalog): EntityDetail {
    if (!id || id.length > 4096 || /[\u0000-\u001f]/.test(id)) fail(400, 'Invalid building identifier.');
    const row = this.db.prepare('SELECT data,detail FROM buildings WHERE id=?').get(id);
    if (!row) fail(404, 'Building not found in this generation.');
    const detail: StoredDetail = JSON.parse(String(row!.detail));
    const ids = [...new Set(detail.properties.flatMap(property => property.matchedBuildingIds))];
    const getMember = this.db.prepare('SELECT data FROM buildings WHERE id=?');
    const members: Building[] = ids.flatMap(id => { const member = getMember.get(id); return member ? [JSON.parse(String(member.data))] : []; });
    return { generation: catalog.generation, building: JSON.parse(String(row!.data)), members,
      energy: { ...catalog.energy, catalog: catalog.energy.catalog ? { ...catalog.energy.catalog, energy: detail.energy,
        solar: detail.solar, properties: detail.properties, reports: catalog.energy.catalog.reports.map((report, index) => ({ ...report, associations: detail.associations[index] ?? [] })) } : null },
      ryhti: { ...catalog.ryhti, catalog: catalog.ryhti.catalog ? { ...catalog.ryhti.catalog, buildings: detail.ryhti ? [detail.ryhti] : [] } : null } };
  }
  theme(key: string, params: URLSearchParams, catalog = this.catalog): EntityThemeValues {
    if (!catalog.themes.some(theme => theme.key === key)) fail(404, 'Theme not found in this generation.');
    const chunks = (params.get('chunks') ?? '').split(',');
    if (!chunks.length || chunks.length > 16 || chunks.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) || new Set(chunks).size !== chunks.length) fail(400, 'Supply between 1 and 16 distinct chunk IDs.');
    const slots = chunks.map(() => '?').join(',');
    if (this.db.prepare(`SELECT count(*) AS count FROM chunks WHERE id IN (${slots})`).get(...chunks)?.count !== chunks.length) fail(400, 'Unknown city chunk.');
    const rows = this.db.prepare(`SELECT DISTINCT t.building_id,t.colour,t.category FROM theme_values t
      JOIN building_chunks c ON c.building_id=t.building_id WHERE t.theme=? AND c.chunk_id IN (${slots}) ORDER BY t.building_id LIMIT 10001`).all(key, ...chunks);
    if (rows.length > 10000) fail(413, 'Theme response is too large; request fewer chunks.');
    return { generation: catalog.generation, key, values: rows.map(row => [String(row.building_id), String(row.colour), row.category === null ? null : String(row.category)]) };
  }
}

/** One read-only connection per process; each request pins a validated generation. */
export class EntityStore {
  private current: EntityDatabase | null = null;
  private pending: Promise<void> | null = null;
  private checkedAt = -Infinity;
  private catalog: EntityCatalog | null = null;
  private failure = 'Entity data is unavailable. Run entities:prepare.';
  private directory: string;
  private data: string;
  private now: () => number;
  constructor(directory = resolve('server/data/entities'), data = resolve('static/data'), now = Date.now) {
    this.directory = directory; this.data = data; this.now = now;
  }
  close() { this.current?.close(); this.current = null; this.catalog = null; this.checkedAt = -Infinity; }
  async load(generation?: string): Promise<{ database: EntityDatabase; catalog: EntityCatalog }> {
    if (!this.pending && this.now() - this.checkedAt >= 1000) {
      this.checkedAt = this.now(); this.pending = this.refresh().finally(() => { this.pending = null; });
    }
    await this.pending;
    if (!this.current || !this.catalog) fail(503, this.failure);
    if (generation !== undefined && generation !== this.catalog!.generation) fail(409, 'The dataset changed. Refresh the catalog and retry.');
    return { database: this.current!, catalog: this.catalog! };
  }
  private async refresh() {
    let publicationError = false;
    try {
      const pointer = JSON.parse((await readRyhtiFile(this.directory, 'manifest.json', 4096)).toString());
      if (pointer.version !== 1 || !/^[a-f0-9-]{36}$/.test(pointer.generation) || !/^[a-f0-9]{64}$/.test(pointer.sha256)
        || !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 1 || pointer.bytes > 1024 ** 3) throw new Error('Invalid entity manifest');
      if (this.current?.catalog.generation !== pointer.generation) {
        const path = pointer.generation + '.sqlite';
        const root = await realpath(this.directory), file = await realpath(resolve(root, path));
        if (!file.startsWith(root + sep) || (await stat(file)).size !== pointer.bytes) throw new Error('Invalid entity path or size');
        const checksum = createHash('sha256'); let size = 0;
        for await (const bytes of createReadStream(file)) {
          size += bytes.length; if (size > pointer.bytes) throw new Error('Entity database grew during validation');
          checksum.update(bytes);
        }
        if (size !== pointer.bytes || checksum.digest('hex') !== pointer.sha256) throw new Error('Invalid entity checksum');
        const next = new EntityDatabase(file);
        if (next.catalog.generation !== pointer.generation) { next.close(); throw new Error('Invalid entity generation'); }
        this.current?.close(); this.current = next;
      }
    } catch { publicationError = true; }
    this.catalog = this.current ? { ...this.current.catalog, status: publicationError ? 'stale' : 'ready',
      message: publicationError ? 'Entity refresh is unavailable; retaining the last validated database.' : null } : null;
    if (!this.catalog) return;
    try {
      if (hash(await readRyhtiFile(this.data, 'city/manifest.json', 2_000_000)) !== this.catalog.cityManifestSha256) throw new Error();
    } catch { this.catalog = null; this.failure = 'Entity data does not match the city. Run entities:prepare after source preparation.'; return; }
    for (const name of ['energy', 'ryhti'] as const) {
      const state = { ...this.catalog[name] };
      try {
        const manifest = JSON.parse((await readRyhtiFile(this.data, name + '-manifest.json', 16384)).toString());
        if (manifest.generatedAt !== state.catalog?.generatedAt) {
          state.status = state.catalog ? 'stale' : 'unavailable'; state.message = 'New source data awaits entities:prepare; showing the indexed snapshot.';
        }
        if (name === 'energy' && manifest.refresh?.status === 'failed') {
          state.status = state.catalog ? 'stale' : 'unavailable'; state.message = String(manifest.refresh.message ?? 'Source refresh failed.').slice(0, 1000);
          state.attemptedAt = manifest.refresh.attemptedAt;
        }
      } catch { if (state.catalog) { state.status = 'stale'; state.message = 'Source manifest unavailable; showing the indexed snapshot.'; } }
      try {
        const failure = JSON.parse((await readRyhtiFile(this.data, name + '-refresh-status.json', 16384)).toString());
        if (failure.status === 'failed' && Number.isFinite(Date.parse(failure.attemptedAt)) && typeof failure.message === 'string'
          && Date.parse(failure.attemptedAt) >= Date.parse(state.catalog?.generatedAt ?? '1970-01-01')) {
          state.status = state.catalog ? 'stale' : 'unavailable'; state.message = failure.message.slice(0, 1000); state.attemptedAt = failure.attemptedAt;
        }
      } catch { /* Optional preparation diagnostics do not invalidate a validated snapshot. */ }
      Object.assign(this.catalog, { [name]: state });
    }
  }
}
export const entityStore = new EntityStore();

export async function entityResponse(request: Request, kind: 'status' | 'search' | 'detail' | 'photo' | 'photo-image' | 'themes' | 'theme', id = '', store = entityStore): Promise<Response> {
  try {
    const allowed = kind === 'status' ? [] : kind === 'search' ? ['generation', 'q', 'kind', 'limit', 'cursor', 'theme', 'category']
      : kind === 'theme' ? ['generation', 'chunks'] : ['generation'];
    const params = entityParameters(new URL(request.url), allowed);
    const generation = kind === 'status' ? undefined : params.get('generation');
    if (generation === null || generation !== undefined && !/^[a-f0-9-]{36}$/.test(generation)) fail(400, 'A valid dataset generation is required.');
    const { database, catalog } = await store.load(generation);
    if (kind === 'photo-image') {
      const photo = await buildingPhotoCache.get(database.detail(id, catalog).building);
      if (!photo) fail(404, 'No building photo is available.');
      const image = await buildingImageCache.read(photo);
      const headers = { 'Content-Type': image.type, 'Cache-Control': 'public, max-age=86400',
        ETag: image.etag, 'X-Content-Type-Options': 'nosniff' };
      return request.headers.get('If-None-Match') === image.etag ? new Response(null, { status: 304, headers })
        : new Response(Uint8Array.from(image.body), { headers });
    }
    const result = kind === 'status' ? catalog : kind === 'themes' ? { generation: catalog.generation, themes: catalog.themes }
      : kind === 'search' ? database.search(params, catalog) : kind === 'detail' ? database.detail(id, catalog)
        : kind === 'photo' ? { generation: catalog.generation, buildingId: id, photo: await buildingPhotoCache.get(database.detail(id, catalog).building) }
          : database.theme(id, params, catalog);
    const body = JSON.stringify(result);
    if (Buffer.byteLength(body) > 2_000_000) fail(413, 'Response exceeds its size limit. Refine the request.');
    const etag = '"' + hash(body) + '"';
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag };
    return request.headers.get('If-None-Match') === etag ? new Response(null, { status: 304, headers }) : new Response(body, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof EntityError ? error.message : 'Entity query could not be completed.' },
      { status: error instanceof EntityError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
