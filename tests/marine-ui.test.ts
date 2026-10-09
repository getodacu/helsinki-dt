import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { decodeMarineMqttPosition } from '../src/lib/data/marine.ts';
import type { MarineStatus } from '../src/lib/marine.ts';

test('marine inspector keeps metadata failures separate from explicit position status and supports legacy errors', async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('./.marine-ui-', import.meta.url)));
  try {
    const source = await readFile(new URL('../src/lib/components/MarineVesselDetails.svelte', import.meta.url), 'utf8');
    const compiled = compile(source, { generate: 'server', filename: 'MarineVesselDetails.svelte' });
    const path = join(directory, 'component.js'); await writeFile(path, compiled.js.code);
    const { default: Component } = await import(pathToFileURL(path).href);
    const now = Date.parse('2026-10-10T00:00:00Z');
    const vehicle = decodeMarineMqttPosition('vessels-v2/230123456/location', { time: now / 1000, lon: 24.95, lat: 60.17, sog: 0 }, new Date(now).toISOString(), now);
    const status: MarineStatus = { state: 'live', connectedAt: null, lastPositionAt: vehicle.reportedAt, retryAt: null };
    const html = (source: MarineStatus) => render(Component, { props: { vehicle, source, connected: true, now } }).body;
    const metadataFailure = html({ ...status, positionError: null, metadataError: 'Metadata failure', error: 'Metadata failure' });
    assert.match(metadataFailure, /Metadata unavailable: Metadata failure/);
    assert.doesNotMatch(metadataFailure, /Position source:/);
    assert.match(metadataFailure, /fresh report/);
    const positionFailure = html({ ...status, positionError: 'Position failure', error: 'Combined error' });
    assert.match(positionFailure, /Position source: Position failure/); assert.doesNotMatch(positionFailure, /Combined error/);
    assert.match(html({ ...status, error: 'Legacy failure' }), /Position source: Legacy failure/);
    assert.doesNotMatch(html(status), /Position source:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
