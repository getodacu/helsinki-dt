import { railData } from '../../../../../../lib/server/rail.ts';
import { railRoutes } from '../../../../../../lib/server/rail-routes.ts';
import { railDate, railNumber } from '../../../../../../lib/rail.ts';
export async function GET({ params, request }: { request: Request; params: { date: string; number: string } }) {
  try { if (!railDate(params.date)) throw new Error(); railNumber(params.number); }
  catch { return Response.json({ error: 'Invalid train identity' }, { status: 400 }); }
  const [journey, route] = await Promise.all([railData.train(params.date, params.number, request.signal), railRoutes.journey(params.date, params.number)]);
  return Response.json({ ...journey, route }, { headers: { 'Cache-Control': 'no-store' } });
}
