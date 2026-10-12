import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { TrafficCount } from '../src/lib/traffic-measurements.ts';

const count = (minutes: number, changes: Partial<TrafficCount> = {}): TrafficCount => ({ counterId: 'HEL LAM:6373', mode: 'vehicles',
  observedAt: new Date(Date.parse('2026-07-05T10:00:00Z') + minutes * 60_000).toISOString(), retrievedAt: '2026-10-11T10:00:00Z',
  durationSeconds: 900, value: 19, hourlyEquivalent: 76, complete: true, ...changes });

test('traffic history exposes keyboard inspection, original intervals, Helsinki dates, zero bars, missing readings and gaps', async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('./.traffic-ui-', import.meta.url)));
  try {
    const source = await readFile(new URL('../src/lib/components/TrafficCountHistory.svelte', import.meta.url), 'utf8');
    const path = join(directory, 'component.js');
    await writeFile(path, compile(source, { generate: 'server', filename: 'TrafficCountHistory.svelte' }).js.code);
    const { default: Component } = await import(pathToFileURL(path).href);
    const html = (history: TrafficCount[], window?: { start: string; end: string }) => render(Component, { props: { history, window } }).body;
    const zero = html([count(0, { value: 0, hourlyEquivalent: 0 })]);
    assert.match(zero, /0 \/ 15 min \(0 \/ h\)/); assert.match(zero, /13:00:00/); assert.match(zero, /5 Jul 2026/);
    assert.match(zero, /Europe\/Helsinki/); assert.match(zero, /role="slider" tabindex="0"/);
    assert.match(zero, /aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"/);
    const gap = html([count(0), count(15), count(30, { value: null, hourlyEquivalent: null, complete: false }), count(45)]);
    assert.equal((gap.match(/<rect/g) ?? []).length, 3); assert.doesNotMatch(gap, /<polyline|<circle/);
    assert.match(zero, /class="zero-reading/); assert.doesNotMatch(zero, /<rect/);
    assert.doesNotMatch(html([count(0, { complete: false })]), /<rect|zero-reading/);
    assert.match(gap, /aria-valuemax="3" aria-valuenow="3"/);
    const rolling = html([count(0)], { start: '2026-07-05T08:00:00Z', end: '2026-07-06T08:00:00Z' });
    assert.match(rolling, />5 Jul, 11:00</); assert.doesNotMatch(rolling, />5 Jul, 13:00</);
    assert.match(html([count(0, { value: null, hourlyEquivalent: null, complete: false })]), /Missing/);
    const empty = html([]);
    assert.match(empty, /No complete counts for this mode/); assert.doesNotMatch(empty, /role="slider"|<polyline|<circle/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
