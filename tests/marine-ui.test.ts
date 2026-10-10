import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { decodeMarineMqttPosition } from '../src/lib/data/marine.ts';
import type { MarineStatus } from '../src/lib/marine.ts';
import type { Vehicle } from '../src/lib/types.ts';

test('marine inspector shows position age without metadata rows and retains source errors', async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('./.marine-ui-', import.meta.url)));
  try {
    const source = await readFile(new URL('../src/lib/components/MarineVesselDetails.svelte', import.meta.url), 'utf8');
    const compiled = compile(source, { generate: 'server', filename: 'MarineVesselDetails.svelte' });
    const path = join(directory, 'component.js'); await writeFile(path, compiled.js.code);
    const { default: Component } = await import(pathToFileURL(path).href);
    const now = Date.parse('2026-10-10T00:00:00Z');
    const vehicle = decodeMarineMqttPosition('vessels-v2/230123456/location', { time: now / 1000, lon: 24.95, lat: 60.17, sog: 0 }, new Date(now).toISOString(), now);
    const status: MarineStatus = { state: 'live', connectedAt: null, lastPositionAt: vehicle.reportedAt, retryAt: null };
    const html = (source: MarineStatus, changes: Partial<{ vehicle: Vehicle; now: number }> = {}) => render(Component, { props: { vehicle, source, now, ...changes } }).body;
    const normal = html(status);
    assert.match(normal, /<dt>Position reported<\/dt><dd>0 s ago<\/dd>/);
    for (const field of ['Type', 'Navigation', 'MMSI', 'IMO', 'Call sign', 'Speed', 'Course over ground', 'True heading']) {
      assert.ok(normal.includes(`<dt>${field}</dt>`), `${field} remains visible`);
    }
    assert.doesNotMatch(normal, /<dt>Marker orientation|<dt>Position received|<dt>Metadata updated|<dt>Metadata received|<dt>Marine source|<dt>Position accuracy|<dt>Integrity monitoring|<dt>Position<\/dt>|<dt>Position quality|<dt>Metadata quality/);
    assert.doesNotMatch(normal, /10 Oct 2026|fresh report|stale report|expired \/ out of coverage/);
    assert.match(html(status, { vehicle: { ...vehicle, reportedAt: new Date(now - 95_999).toISOString() } }), /<dd>95 s ago<\/dd>/);
    assert.match(html(status, { now: now + 1_000 }), /<dd>1 s ago<\/dd>/);
    assert.match(html(status, { vehicle: { ...vehicle, reportedAt: new Date(now + 1_000).toISOString() } }), /<dd>0 s ago<\/dd>/);
    const metadataFailure = html({ ...status, positionError: null, metadataError: 'Metadata failure', error: 'Metadata failure' });
    assert.match(metadataFailure, /Metadata unavailable: Metadata failure/);
    assert.doesNotMatch(metadataFailure, /Position source:/);
    assert.doesNotMatch(metadataFailure, /fresh report/);
    const positionFailure = html({ ...status, positionError: 'Position failure', error: 'Combined error' });
    assert.match(positionFailure, /Position source: Position failure/); assert.doesNotMatch(positionFailure, /Combined error/);
    assert.match(html({ ...status, error: 'Legacy failure' }), /Position source: Legacy failure/);
    assert.doesNotMatch(html(status), /Position source:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
