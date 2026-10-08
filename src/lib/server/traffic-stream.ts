import { TRAFFIC_HEARTBEAT_MS, TRAFFIC_MAX_QUEUE_BYTES } from '../traffic.ts';
import { trafficFeed, type TrafficFeed } from './traffic.ts';

/** Clients recover with a full snapshot; a slow client reconnects instead of growing a replay queue. */
export function createTrafficResponse(request: Request, feed: TrafficFeed = trafficFeed): Response {
  const encoder = new TextEncoder();
  let finish = (_close = true) => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const abort = () => finish();
      finish = (close = true) => {
        if (ended) return;
        ended = true;
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener('abort', abort);
        unsubscribe?.();
        if (close) controller.close();
      };
      const send = (text: string) => {
        if (ended) return;
        const bytes = encoder.encode(text);
        if (bytes.length > (controller.desiredSize ?? 0)) { finish(); return; }
        controller.enqueue(bytes);
      };
      if (request.signal.aborted) { finish(); return; }
      request.signal.addEventListener('abort', abort, { once: true });
      unsubscribe = feed.subscribe(event => send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      if (ended) { unsubscribe(); return; }
      heartbeat = setInterval(() => send(': heartbeat\n\n'), TRAFFIC_HEARTBEAT_MS);
      heartbeat.unref?.();
    },
    cancel() { finish(false); }
  }, { highWaterMark: TRAFFIC_MAX_QUEUE_BYTES, size: bytes => bytes.byteLength });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' } });
}
