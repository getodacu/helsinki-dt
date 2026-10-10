import { webcamById } from '../../../../lib/webcams.ts';
import { webcamCache } from '../../../../lib/server/webcams.ts';

export async function GET({ params }: { params: { stationId: string } }): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (!webcamById(params.stationId)) return Response.json({ error: 'Unknown camera.' }, { status: 404, headers });
  return Response.json(await webcamCache.get(params.stationId), { headers });
}
