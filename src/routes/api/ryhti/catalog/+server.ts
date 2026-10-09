import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { ryhtiCatalogStore } from '../../../../lib/server/ryhti-catalog.ts';
const loadRyhtiCatalog = () => ryhtiCatalogStore.load();
import type { RyhtiCatalogState } from '../../../../lib/ryhti-types.ts';

const compress = promisify(gzip);
let compressed: { state: RyhtiCatalogState; body: Promise<Buffer> } | null = null;

export async function GET({ url, request }: { url: URL; request: Request }): Promise<Response> {
  if ([...url.searchParams.keys()].length) return Response.json({ error: 'The prepared Ryhti catalog accepts no parameters.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  const state = await loadRyhtiCatalog();
  const headers = { 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding', 'Content-Type': 'application/json' };
  const encodings = (request.headers.get('Accept-Encoding') ?? '').toLowerCase().split(',').map(value => value.split(';').map(part => part.trim()));
  const wildcard = encodings.find(([name]) => name === '*');
  const quality = (coding: string[] | undefined) => {
    const parameter = coding?.slice(1).find(value => value.startsWith('q='));
    const weight = parameter === undefined ? 1 : Number(parameter.slice(2));
    return weight > 0 && weight <= 1 ? weight : 0;
  };
  const accepted = encodings.find(([name]) => name === 'gzip') ?? wildcard;
  if (!accepted || !quality(accepted)) {
    const identity = encodings.find(([name]) => name === 'identity');
    if (identity ? !quality(identity) : wildcard && !quality(wildcard)) return new Response(null, { status: 406, headers });
    return Response.json(state, { headers });
  }
  // Cache one validated state; concurrent browsers share its compression work.
  if (compressed?.state !== state) compressed = { state, body: compress(JSON.stringify(state)) };
  return new Response(new Uint8Array(await compressed.body), { headers: { ...headers, 'Content-Encoding': 'gzip' } });
}
