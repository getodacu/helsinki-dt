import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile, requestBytes, requestText } from '../src/lib/server/io.ts';

test('bounded downloads reject oversized bodies and retain a valid cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helsinki-download-'));
  const original = globalThis.fetch;
  const target = join(directory, 'source.zip');
  try {
    await writeFile(target, 'previous');
    globalThis.fetch = async () => new Response('too-large', {status: 200});
    await assert.rejects(downloadFile('https://source.example/sample', target, {maxBytes: 4}), /byte limit/);
    assert.equal(await readFile(target, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['source.zip']);
    globalThis.fetch = async () => new Response('new', {status: 200});
    const result = await downloadFile('https://source.example/sample', target, {maxBytes: 4});
    assert.equal(result.bytes, 3);
    assert.equal(await readFile(target, 'utf8'), 'new');
    globalThis.fetch = async () => new Response('failure', {status: 503});
    await assert.rejects(requestBytes('https://source.example/sample'), /HTTP 503/);
    await assert.rejects(requestBytes('http://source.example/sample'), /HTTPS/);
    await assert.rejects(requestBytes('https://user:password@source.example/sample'), /credentials/);
  } finally { globalThis.fetch = original; await rm(directory, {recursive: true, force: true}); }
});


test('upstream deadline aborts a stalled body after successful response headers', async () => {
  const original = globalThis.fetch;
  const keepAlive = setInterval(() => {}, 100);
  let aborted = false;
  try {
    globalThis.fetch = async (_input, options) => {
      const signal = options!.signal!;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('<unfinished'));
        signal.addEventListener('abort', () => { aborted = true; controller.error(signal.reason); }, { once: true });
      } }));
    };
    await assert.rejects(requestText('https://source.example/observations', { maxBytes: 1024, timeoutMs: 10 }), { name: 'TimeoutError' });
    assert.equal(aborted, true);
  } finally { clearInterval(keepAlive); globalThis.fetch = original; }
});
