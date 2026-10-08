import { journeyIdentity, routeContextStore } from '../../../lib/server/route-context.ts';

export async function GET({ url }: { url: URL }): Promise<Response> {
  if (!url.search) return Response.json(await routeContextStore.catalog(), { headers: { 'Cache-Control': 'no-cache' } });
  let identity;
  try { identity = journeyIdentity(url.searchParams); }
  catch { return Response.json({ error: 'Invalid journey identifiers.' }, { status: 400 }); }
  return Response.json(await routeContextStore.journey(identity), { headers: { 'Cache-Control': 'no-cache' } });
}
