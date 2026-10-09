import { railData } from '../../../../lib/server/rail.ts';
import { inBounds, RELEASE_BOUNDS } from '../../../../lib/area.ts';
export async function GET({ request }: { request: Request }) {
  const result = await railData.stations(request.signal);
  return Response.json({ ...result, data: result.data?.filter(station => station.passenger && inBounds(station.longitude, station.latitude, RELEASE_BOUNDS)) ?? null }, { headers: { 'Cache-Control': 'no-cache' } });
}
