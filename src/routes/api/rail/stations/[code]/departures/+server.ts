import { railData } from '../../../../../../lib/server/rail.ts';
import { inBounds, RELEASE_BOUNDS } from '../../../../../../lib/area.ts';
export async function GET({ params, request }: { request: Request; params: { code: string } }) {
  const stations = await railData.stations(request.signal);
  if (!stations.data) return Response.json({ ...stations, data: null }, { headers: { 'Cache-Control': 'no-store' } });
  if (!stations.data.some(station => station.code === params.code && station.passenger && inBounds(station.longitude, station.latitude, RELEASE_BOUNDS))) return Response.json({ error: 'Unknown station in city coverage' }, { status: 400 });
  return Response.json(await railData.departures(params.code, request.signal), { headers: { 'Cache-Control': 'no-store' } });
}
