import { areaCacheProgress, startAreaCache } from '../../../lib/server/city-map-warm.ts';
import { cityMapCache } from '../../../lib/server/city-map-cache.ts';

export function GET() {
  if (areaCacheProgress.phase === 'partial') startAreaCache();
  return Response.json({ ...areaCacheProgress, cacheIssue: cityMapCache.storageIssue }, { headers: { 'Cache-Control': 'no-store' } });
}
export function POST() { startAreaCache(); return GET(); }
