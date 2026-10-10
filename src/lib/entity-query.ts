import type { EntityCatalog, EntityDetail, EntitySearch, EntityThemeValues, EntityPhoto } from './entity-types.ts';
import { validBuildingPhoto } from './building-photo.ts';

export class EntityApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
type EntityPayload = EntityCatalog | EntityDetail | EntitySearch | EntityThemeValues | EntityPhoto;
export async function fetchEntity<T extends EntityPayload>(path: string, signal: AbortSignal, generation?: string): Promise<T> {
  const response = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new EntityApiError(response.status, typeof body?.error === 'string' ? body.error : `Entity request failed (${response.status}).`);
  }
  if (!response.body) throw new Error('Empty entity response.');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error('Entity response exceeds its size limit.');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value.generation !== 'string' || (generation && value.generation !== generation)) throw new Error('Entity response generation mismatch.');
  if (path.startsWith('/api/catalog/')) {
    if (value.version !== 1 || !Number.isSafeInteger(value.buildingCount) || !Array.isArray(value.themes)
      || !value.energy || !value.ryhti || !Number.isFinite(Date.parse(value.cityGeneratedAt))) throw new Error('Invalid entity catalog.');
  } else if (/^\/api\/entities\/building\/[^/]+\/photo(?:\?|$)/.test(path)) {
    if (typeof value.buildingId !== 'string' || !(value.photo === null || validBuildingPhoto(value.photo))) throw new Error('Invalid building photo response.');
  } else if (path.startsWith('/api/entities/building/')) {
    if (!value.building || typeof value.building.id !== 'string' || !Array.isArray(value.members) || !value.energy || !value.ryhti) throw new Error('Invalid building response.');
  } else if (path.startsWith('/api/themes/')) {
    if (!Array.isArray(value.values) || value.values.some((row: unknown) => !Array.isArray(row) || row.length !== 3
      || typeof row[0] !== 'string' || !/^#[a-f0-9]{6}$/i.test(row[1]) || !(row[2] === null || typeof row[2] === 'string'))) throw new Error('Invalid theme response.');
  } else if (!Array.isArray(value.buildings) || !(value.nextCursor === null || typeof value.nextCursor === 'string')) throw new Error('Invalid search response.');
  return value;
}
