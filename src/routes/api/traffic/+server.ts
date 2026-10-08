import { trafficFeed } from '../../../lib/server/traffic.ts';

export function GET(): Response {
  const release = trafficFeed.acquire();
  try { return Response.json(trafficFeed.snapshot(), { headers: { 'Cache-Control': 'no-store' } }); }
  finally { release(); }
}
