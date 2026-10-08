import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RequestOptions { maxBytes?: number; timeoutMs?: number }
interface ResponseMetadata {
  status: number; url: string; durationMs: number; retrievedAt: string; headers: Headers;
}

async function startRequest(url: string, options: RequestOptions) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Upstream requests require HTTPS without URL credentials');
  }
  const started = performance.now();
  const retrievedAt = new Date().toISOString();
  const response = await fetch(parsed, { signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Upstream HTTP ${response.status}: ${parsed.origin}${parsed.pathname}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > (options.maxBytes ?? 16 * 1024 * 1024)) {
    await response.body.cancel();
    throw new Error('Upstream response exceeds byte limit');
  }
  return { response, started, retrievedAt };
}

async function consume(response: Response, maxBytes: number, write: (chunk: Buffer) => Promise<void>) {
  const reader = response.body!.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Upstream response exceeds byte limit');
      await write(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return bytes;
}

function metadata(response: Response, started: number, retrievedAt: string): ResponseMetadata {
  return { status: response.status, url: response.url, durationMs: Math.round(performance.now() - started),
    retrievedAt, headers: response.headers };
}

export async function requestBytes(url: string, options: RequestOptions = {}) {
  const { response, started, retrievedAt } = await startRequest(url, options);
  const chunks: Buffer[] = [];
  await consume(response, options.maxBytes ?? 16 * 1024 * 1024, async chunk => { chunks.push(chunk); });
  return { ...metadata(response, started, retrievedAt), body: Buffer.concat(chunks) };
}

export async function requestText(url: string, options: RequestOptions = {}) {
  const result = await requestBytes(url, options);
  return { ...result, body: result.body.toString('utf8') };
}

/** Publish a complete download only after its byte bound and write have succeeded. */
export async function downloadFile(url: string, path: string, options: RequestOptions = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  options = { maxBytes: 128 * 1024 * 1024, ...options };
  const { response, started, retrievedAt } = await startRequest(url, options);
  const hash = createHash('sha256');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, 'wx');
    const bytes = await consume(response, options.maxBytes ?? 128 * 1024 * 1024, async chunk => {
      hash.update(chunk);
      await file!.writeFile(chunk);
    });
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    return { ...metadata(response, started, retrievedAt), path, bytes, sha256: hash.digest('hex') };
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
