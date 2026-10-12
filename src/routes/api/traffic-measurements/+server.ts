import { trafficMeasurements } from '../../../lib/server/traffic-measurements.ts';

export async function GET({ url }: { url: URL }): Promise<Response> {
  if (url.search) return Response.json({ error: 'Traffic measurements use a fixed Helsinki area and recent window.' }, { status: 400 });
  return Response.json(await trafficMeasurements.snapshot(), { headers: { 'Cache-Control': 'no-store' } });
}
