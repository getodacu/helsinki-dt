import { runSources } from './pipeline.ts';
import { publishPreparation } from './preparation.ts';

if (process.argv.length > 2) throw new Error('data:prepare has no upstream URL or source options; use data:probe for focused checks');
const generatedAt = new Date().toISOString();
const result = await runSources();
const manifest = await publishPreparation('static/data', '.cache/task-a/latest-preparation.json', result, generatedAt);
if (!manifest) {
  console.error('Preparation failed; previous manifest retained. See .cache/task-a/latest-preparation.json');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({manifest: 'static/data/manifest.json', buildings: manifest.assets.find(asset => asset.path.endsWith('/buildings.json'))!.count,
    assets: manifest.assets.length, gates: manifest.gates}, null, 2));
  if (Object.values(manifest.gates).some(gate => gate.status !== 'pass')) process.exitCode = 2;
}
