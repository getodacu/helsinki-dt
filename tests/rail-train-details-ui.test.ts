import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Vehicle } from '../src/lib/types.ts';
import type { RailEvent, RailJourney, RailResult, RailSummary } from '../src/lib/rail.ts';

const now = Date.parse('2026-10-10T19:03:49.999Z');
const rail: RailSummary = { trainNumber: '8735', departureDate: '2026-10-10', label: 'P', category: 'commuter',
  trainType: 'HL', operator: 'vr', origin: 'Helsinki asema', destination: 'Helsinki asema', cancelled: false,
  nextEvent: null, timetableAt: '2026-10-10T19:02:00Z' };
const vehicle: Vehicle = { id: 'digitraffic:2026-10-10:8735', mode: 'train', vehicleId: '8735',
  ownerOperatorId: null, operatingOperatorId: null, routeId: 'P', directionId: null, serviceDate: rail.departureDate,
  startTime: null, journeyReference: null, reportedAt: '2026-10-10T19:01:06Z', receivedAt: '2026-10-10T19:02:06Z',
  longitude: 24.94, latitude: 60.17, speedMetresPerSecond: 22 / 3.6, headingDegrees: null,
  rawDeviationSeconds: null, delaySeconds: null, quality: [], sourceId: 'digitraffic-rail', rail };
const event: RailEvent = { stationCode: 'HKI', stationName: 'Helsinki asema', type: 'ARRIVAL',
  scheduledAt: '2026-10-10T19:10:00Z', estimatedAt: '2026-10-10T19:12:00Z', actualAt: null,
  platform: '2', cancelled: false, commercial: true, stopping: true };
const journey: RailResult<RailJourney> = { state: 'ready', retrievedAt: rail.timetableAt, error: null,
  data: { summary: rail, events: [event] } };

test('train details show receipt age and essential fields without removed metadata or freshness notices', async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('./.rail-train-ui-', import.meta.url)));
  try {
    const source = (await readFile(new URL('../src/lib/components/RailTrainDetails.svelte', import.meta.url), 'utf8'))
      .replaceAll("from '../", "from '#lib/");
    const compiled = compile(source, { generate: 'server', filename: 'RailTrainDetails.svelte' });
    const path = join(directory, 'component.js'); await writeFile(path, compiled.js.code);
    const { default: Component } = await import(pathToFileURL(path).href);
    const html = (changes: Partial<{ vehicle: Vehicle; journey: RailResult<RailJourney> | null; now: number; loading: boolean; error: string }> = {}) =>
      render(Component, { props: { vehicle, journey, now, ...changes } }).body;
    const normal = html();
    assert.match(normal, /<dt>Train<\/dt><dd>8735<\/dd>/);
    assert.match(normal, /22 km\/h/); assert.match(normal, /FINTRAFFIC \/ COMMUTER/);
    assert.match(normal, /→ Helsinki asema/);
    assert.match(normal, /<dt>Position received<\/dt><dd>103 s ago<\/dd>/);
    assert.equal((normal.match(/Position received/g) ?? []).length, 1);
    assert.doesNotMatch(normal, /163 s ago|2026-10-10|Train \/ date|Operator \/ type|<dt>Journey|Position reported|Timetable checked/);
    assert.doesNotMatch(normal, /Stale position|position expired|Timetable is stale|Next stop and delay|Journey timetable|<details|display buffer|rail height/);
    assert.match(html({ vehicle: { ...vehicle, receivedAt: '2026-10-10T19:03:50Z' } }), /<dd>0 s ago<\/dd>/);
    assert.match(html({ now: now + 1_000 }), /<dd>104 s ago<\/dd>/);
    assert.match(html({ journey: null }), /<dt>Train<\/dt><dd>8735<\/dd>/);

    const withEvent = { ...journey, data: { summary: { ...rail, nextEvent: event }, events: [event] } };
    const stale = html({ journey: withEvent });
    assert.match(stale, /Next arrival · Helsinki asema/);
    assert.match(stale, /<dt>Platform<\/dt><dd>2<\/dd>/);
    assert.match(stale, /Unknown · timetable stale/); assert.doesNotMatch(stale, /Timetable is stale/);
    const fresh = html({ journey: { ...withEvent, data: { ...withEvent.data, summary: { ...withEvent.data.summary, timetableAt: new Date(now).toISOString() } } } });
    assert.match(fresh, /120 s late/); assert.doesNotMatch(fresh, /Unknown · timetable stale/);
    assert.match(html({ journey: { ...journey, data: { summary: { ...rail, cancelled: true }, events: [] } } }), /Cancelled service/);
    assert.match(html({ loading: true }), /Loading train timetable/);
    assert.match(html({ error: 'Network failed' }), /Timetable refresh unavailable · Network failed/);
    assert.match(html({ journey: { ...journey, error: 'Refresh failed' } }), /Timetable refresh unavailable · Refresh failed/);
    assert.match(html({ journey: { ...journey, data: null, error: 'No timetable' } }), /Timetable unavailable · No timetable/);
    assert.match(html({ journey: null, vehicle: { ...vehicle, rail: { ...rail, departureDate: null } } }), /Undated position/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
