import { entityResponse } from '#lib/server/entities.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => entityResponse(request, 'themes');
