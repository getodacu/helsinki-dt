import { mkdir, writeFile } from 'node:fs/promises';
import { runSources, parseSelection } from './pipeline.ts';

const selected = parseSelection(process.argv.slice(2));
const result = await runSources(selected);
await mkdir('.cache/task-a', {recursive: true});
await writeFile(`.cache/task-a/probe-${selected}.json`, JSON.stringify({queriedAt: new Date().toISOString(), ...result}, null, 2) + '\n');
console.log(JSON.stringify({source: selected, gates: result.gates, errors: result.errors}, null, 2));
if (Object.values(result.gates).some(gate => gate.status !== 'pass')) process.exitCode = 2;
