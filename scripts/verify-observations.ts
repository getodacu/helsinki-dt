import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ObservationCache, OBSERVATION_MAX_RECORDS } from '../src/lib/server/observations.ts';
import { groupObservationStations } from '../src/lib/observations.ts';

const snapshot = await new ObservationCache().snapshot();
assert.ok(snapshot.observations.length <= 2 * OBSERVATION_MAX_RECORDS);
assert.ok(snapshot.sources.every(source => source.retrievedAt === null || Number.isFinite(Date.parse(source.retrievedAt))));
const result = { mode: 'live anonymous source check; no offline fallback', checkedAt: snapshot.generatedAt,
  stations: groupObservationStations(snapshot), sources: snapshot.sources,
  parameters: [...new Set(snapshot.observations.map(value => value.parameter))].map(parameter => {
    const readings = snapshot.observations.filter(value => value.parameter === parameter);
    const valid = readings.filter(value => value.value !== null).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    return { parameter, records: readings.length, missing: readings.length - valid.length, first: valid[0] ?? null, latest: valid.at(-1) ?? null };
  }) };
await mkdir('.cache/task-c', { recursive: true });
await writeFile('.cache/task-c/observations-live.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (snapshot.sources.some(source => source.state === 'unavailable' || source.state === 'empty')) process.exitCode = 2;
