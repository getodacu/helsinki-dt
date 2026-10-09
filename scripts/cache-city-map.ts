import { warmCityArea } from '../src/lib/server/city-map-warm.ts';
import { cityMapCache } from '../src/lib/server/city-map-cache.ts';

const args = process.argv.slice(2);
if (args.some(arg => !['--refresh', '--all-levels'].includes(arg))) throw new Error('Usage: npm run city:cache -- [--refresh] [--all-levels]');
console.log('Caching every model detail level within the current prepared map bounds.');
let last = 0;
const state = await warmCityArea(cityMapCache, state => {
  if (Date.now() - last > 1000 || ['complete', 'partial', 'stopped'].includes(state.phase)) {
    console.log(`${state.phase}: ${state.completed}/${state.total} map parts cached, ${state.failed} awaiting retry`); last = Date.now();
  }
}, args.includes('--refresh'), true);
if (cityMapCache.storageIssue) console.error(cityMapCache.storageIssue);
if (state.phase !== 'complete') { console.error('Run the command again without --refresh to resume missing parts. Valid saved files will be reused.'); process.exitCode = 1; }
