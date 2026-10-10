import { webcamById, WEBCAM_STALE_MS, type Webcam, type WebcamSnapshot } from '../webcams.ts';
import { requestText, type RequestOptions } from './io.ts';

type FetchData = (url: string, options: RequestOptions) => Promise<{ body: string }>;
interface Entry { measuredTime: string | null; receivedAt: string | null; lastError: string | null; dueAt: number; pending: Promise<void> | null }

export function decodeWebcamData(value: unknown, camera: Webcam, now: number): string {
  const data = value as { id?: unknown; presets?: { id?: unknown; measuredTime?: unknown }[] } | null;
  if (!data || data.id !== camera.id || !Array.isArray(data.presets) || data.presets.length > 100) throw new Error('Invalid camera station data.');
  const matches = data.presets.filter(preset => preset?.id === camera.presetId);
  if (matches.length !== 1 || typeof matches[0].measuredTime !== 'string') throw new Error('The camera is not reporting image times.');
  const time = Date.parse(matches[0].measuredTime);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(matches[0].measuredTime) || !Number.isFinite(time) || time > now + 60_000) throw new Error('Invalid camera image time.');
  return new Date(time).toISOString();
}

/** Six fixed cameras bound the cache and upstream requests. */
export class WebcamCache {
  private entries = new Map<string, Entry>();
  private fetchData: FetchData;
  private now: () => number;
  constructor(fetchData: FetchData = requestText, now: () => number = Date.now) { this.fetchData = fetchData; this.now = now; }

  async get(id: string): Promise<WebcamSnapshot> {
    const camera = webcamById(id);
    if (!camera) throw new Error('Unknown camera.');
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { measuredTime: null, receivedAt: null, lastError: null, dueAt: 0, pending: null };
      this.entries.set(id, entry);
    }
    const saved = entry;
    if (!saved.pending && this.now() >= saved.dueAt) {
      saved.pending = Promise.resolve().then(async () => {
        try {
          const response = await this.fetchData(`https://tie.digitraffic.fi/api/weathercam/v1/stations/${camera.id}/data`, {
            maxBytes: 32 * 1024, timeoutMs: 10_000, redirect: 'error',
            headers: { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'HelsinkiLens/Webcams 1.0' }
          });
          const measuredTime = decodeWebcamData(JSON.parse(response.body), camera, this.now());
          if (saved.measuredTime && Date.parse(measuredTime) < Date.parse(saved.measuredTime)) throw new Error('The camera returned an older image time.');
          saved.measuredTime = measuredTime; saved.receivedAt = new Date(this.now()).toISOString(); saved.lastError = null;
        } catch (error) {
          saved.lastError = error instanceof Error ? error.message.slice(0, 250) : 'Camera source unavailable.';
        } finally { saved.dueAt = this.now() + 60_000; saved.pending = null; }
      });
    }
    await saved.pending;
    return { stationId: camera.id, presetId: camera.presetId, measuredTime: saved.measuredTime, receivedAt: saved.receivedAt,
      state: !saved.measuredTime ? 'unavailable' : saved.lastError || this.now() - Date.parse(saved.measuredTime) > WEBCAM_STALE_MS ? 'stale' : 'current',
      lastError: saved.lastError };
  }
}
export const webcamCache = new WebcamCache();
