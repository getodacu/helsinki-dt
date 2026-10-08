import { observationCache, validateObservationRequest } from '../../../lib/server/observations.ts';

export async function GET({ url }: { url: URL }): Promise<Response> {
  const error = validateObservationRequest(url);
  if (error) return Response.json({ error }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  return Response.json(await observationCache.snapshot(), { headers: { 'Cache-Control': 'no-store' } });
}
