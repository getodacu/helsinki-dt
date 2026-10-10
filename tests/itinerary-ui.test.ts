import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { VehicleItinerary } from '../src/lib/itinerary.ts';

test('the itinerary renders departure first, visited and next status, cumulative minutes and stale fallback accessibly', async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('./.itinerary-ui-', import.meta.url)));
  try {
    const source = await readFile(new URL('../src/lib/components/VehicleItinerary.svelte', import.meta.url), 'utf8');
    const compiled = compile(source, { generate: 'server', filename: 'VehicleItinerary.svelte' });
    const path = join(directory, 'component.js'); await writeFile(path, compiled.js.code);
    const { default: Component } = await import(pathToFileURL(path).href);
    const itinerary: VehicleItinerary = { vehicleId: 'fixture', mode: 'bus', stale: false, progressKnown: true, reason: null,
      stops: ['origin', 'next', 'destination'].map((name, i) => ({ key: String(i), id: String(i), name, sequence: i + 1,
        longitude: null, latitude: null, expectedAt: '2026-10-10T10:00:00Z', actualAt: null, platform: null,
        state: i === 0 ? 'visited' : i === 1 ? 'next' : 'upcoming', minutes: i === 0 ? null : i * 3, estimated: true })) };
    const html = (value: VehicleItinerary) => render(Component, { props: { itinerary: value } }).body;
    const normal = html(itinerary);
    assert.ok(normal.indexOf('origin') < normal.indexOf('destination'));
    assert.match(normal, /Departure/); assert.match(normal, /Destination/); assert.match(normal, /Visited/);
    assert.match(normal, /Next · 3 min · Estimated/); assert.match(normal, /6 min · Estimated/);
    assert.match(normal, /aria-current="step"/); assert.match(normal, /Minutes from now · Helsinki time/);
    assert.match(normal, /13:00/); assert.doesNotMatch(normal, /<details/);
    const stale = html({ ...itinerary, stale: true, stops: itinerary.stops.map(stop => ({ ...stop, minutes: null })) });
    assert.match(stale, /arrival countdowns unavailable/); assert.match(stale, /Time unavailable/); assert.doesNotMatch(stale, /3 min/);
    assert.match(html({ ...itinerary, stops: [], reason: 'No exact journey.' }), /No exact journey/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
