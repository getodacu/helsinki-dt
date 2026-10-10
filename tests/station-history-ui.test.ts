import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Observation } from '../src/lib/types.ts';

const reading = (overrides: Partial<Observation> = {}): Observation => ({ stationId: '100971', stationName: 'Helsinki Kaisaniemi',
  longitude: 24.94459, latitude: 60.17523, parameter: 't2m', value: 8.8, unit: 'degC', observedAt: '2026-10-08T12:40:00.000Z',
  receivedAt: '2026-10-08T12:50:10.677Z', quality: 'unknown', aggregation: 'avg PT1M', sourceId: 'fmi-weather', ...overrides });

test('sensor sections render latest valid values, their metadata and bounded plots without removed controls', async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('./.station-ui-', import.meta.url)));
  try {
    const source = await readFile(new URL('../src/lib/components/StationHistory.svelte', import.meta.url), 'utf8');
    const compiled = compile(source, { generate: 'server', filename: 'StationHistory.svelte' });
    const path = join(directory, 'component.js'); await writeFile(path, compiled.js.code);
    const { default: Component } = await import(pathToFileURL(path).href);
    const html = (history: Observation[], parameter = 'Temperature') => render(Component, { props: { history, parameter, hours: 6 } }).body;
    const old = reading();
    const latest = reading({ value: 9.2, observedAt: '2026-10-08T12:50:00.000Z', receivedAt: '2026-10-08T12:51:00.000Z', quality: 'verified' });
    const current = html([old, latest]);
    assert.match(current, /9.2 °C/); assert.doesNotMatch(current, /Last valid/);
    assert.match(current, /15:51:00/); assert.doesNotMatch(current, /Quality|verified/); assert.match(current, /avg PT1M/);
    assert.match(current, /<polyline/); assert.match(current, /≤6 HOURS/);
    assert.doesNotMatch(current, /type="range"|Inspect an observed time|Historical observation|Clear history cursor|Transit remains live|Null readings and missing intervals remain gaps/);
    const missing = reading({ observedAt: '2026-10-08T13:00:00.000Z', value: null, quality: 'missing', receivedAt: '2026-10-08T13:01:00.000Z' });
    const fallback = html([old, latest, missing]);
    assert.match(fallback, /9.2 °C/); assert.match(fallback, /Last valid/);
    assert.match(fallback, /15:51:00/); assert.doesNotMatch(fallback, /16:01:00/);
    assert.match(html([old, reading({ value: Infinity })]), /8.8 °C/);
    assert.match(html([reading({ value: 0 })]), />0 °C</);
    for (const history of [[], [missing]]) {
      const empty = html(history);
      assert.match(empty, /Unknown/); assert.match(empty, /No valid values in this history window/);
      assert.doesNotMatch(empty, /Last valid|<polyline|<circle/);
    }
    const single = html([old]);
    assert.match(single, /<circle/); assert.doesNotMatch(single, /<polyline/);
    const air = html([reading({ parameter: 'NO2_PT1H_avg', value: 14.5, unit: 'ug\/m3', aggregation: 'avg PT1H', sourceId: 'fmi-air-quality' })], 'Nitrogen dioxide');
    assert.match(air, /Nitrogen dioxide/); assert.match(air, /14.5 ug\/m3/); assert.match(air, /avg PT1H/);
    assert.doesNotMatch(air, /Quality/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
