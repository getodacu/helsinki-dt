import { warmCityArea } from '../src/lib/server/city-map-warm.ts';
import { cityMapCache } from '../src/lib/server/city-map-cache.ts';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--refresh')) throw new Error('Usage: npm run city:cache -- [--refresh]');
let last = 0;
const state = await warmCityArea(cityMapCache, state => {
  if (Date.now() - last > 1000 || ['complete', 'partial', 'stopped'].includes(state.phase)) {
    console.log(`${state.phase}: ${state.completed}/${state.total} map parts cached, ${state.failed} awaiting retry`); last = Date.now();
  }
}, args.includes('--refresh'));
if (cityMapCache.storageIssue) console.error(cityMapCache.storageIssue);
if (state.phase !== 'complete') { console.error('Run the command again to resume missing parts. Valid saved files will be reused.'); process.exitCode = 1; }
