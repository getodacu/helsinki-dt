import { createTrafficResponse } from '../../../../lib/server/traffic-stream.ts';

export function GET({ request }: { request: Request }): Response {
  return createTrafficResponse(request);
}
