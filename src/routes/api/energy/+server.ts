import { energyCache, EnergyRequestError, validateEnergyRequest } from '../../../lib/server/energy.ts';

export async function GET({ url }: { url: URL }): Promise<Response> {
  try {
    return Response.json(await energyCache.series(validateEnergyRequest(url)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof EnergyRequestError) return Response.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
    throw error;
  }
}
