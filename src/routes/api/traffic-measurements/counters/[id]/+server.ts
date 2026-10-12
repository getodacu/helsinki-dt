import { trafficCounterKey } from '../../../../../lib/data/traffic-measurements.ts';
import { trafficMeasurements, TrafficCounterNotFound } from '../../../../../lib/server/traffic-measurements.ts';

export async function GET({ params, url }: { params: { id: string }; url: URL }): Promise<Response> {
  try { trafficCounterKey(params.id); if (url.search) throw new Error('Counter history uses a fixed latest-day window.'); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Invalid counter request' }, { status: 400 }); }
  try { return Response.json(await trafficMeasurements.counter(params.id), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Counter unavailable' }, {
    status: error instanceof TrafficCounterNotFound ? 404 : 503, headers: { 'Cache-Control': 'no-store' } }); }
}
