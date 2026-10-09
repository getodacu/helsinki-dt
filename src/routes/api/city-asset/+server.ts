import { municipalAssetUrl } from '../../../lib/city-source.ts';
import { cityMapCache } from '../../../lib/server/city-map-cache.ts';

export async function GET({ url, request }: { url: URL; request: Request }) {
  let source: string;
  try {
    if ([...url.searchParams].length !== 1 || !url.searchParams.has('url')) throw new Error('Use one municipal asset URL');
    source = municipalAssetUrl(url.searchParams.get('url')!);
  } catch { return new Response('Invalid map asset', { status: 400 }); }
  try {
    const asset = await cityMapCache.read(source, false, request.headers.get('x-helsinki-refresh') === '1');
    return new Response(Uint8Array.from(asset.body), { headers: { 'Content-Type': asset.type,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=2592000', 'X-Map-Retrieved-At': String(asset.retrievedAt) } });
  } catch { return new Response('Map asset temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } }); }
}
