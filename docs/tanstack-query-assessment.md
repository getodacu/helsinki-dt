# TanStack Query assessment

Researched 2026-10-09. Recommendation: use TanStack Svelte Query for the proposed entity search, selected-building details, and bounded theme APIs. SQLite and bounded responses deliver the payload reduction; Query manages the resulting browser request state and small cache. For search alone, native fetch and AbortController would suffice.

## Compatibility and current API

Public npm metadata read with `npm view @tanstack/svelte-query dist-tags version peerDependencies dependencies engines --json` reports **6.3.1**, Svelte peer **^5.25.0**, and dependency **@tanstack/query-core 5.104.1**. No Node engine or SvelteKit peer restriction was reported. The repository’s Svelte 5.57.1 satisfies that peer range; Node 24 / Kit 3 integration passed Svelte/TypeScript checks and production compilation in the implementation worktree. [Package metadata](https://registry.npmjs.org/@tanstack/svelte-query/6.3.1)

Use adapter v6, despite the documentation sidebar saying “v5”: the adapter migrated to Svelte runes while core remains v5. Queries use `createQuery(() => ({ ... }))`; reactive inputs belong inside that callback, and results use `query.data`, without a store `$` prefix. Every changing request parameter belongs in its query key. [Migration guide](https://tanstack.com/query/latest/docs/framework/svelte/migrate-from-v5-to-v6), [query keys](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys)

## What it buys

- Shared cache and in-flight deduplication for identical query keys; opening the same building can reuse recently fetched details. Deduplication applies to the same key, not successive search strings or different viewports. [Maintainer explanation](https://github.com/TanStack/query/discussions/608)
- Loading, error, retry, and cache-lifetime handling across search, inspectors, and themes. Inactive results can survive briefly after the corresponding UI closes. [Defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
- Cancellation when the supplied query-function `signal` is passed to `fetch`. Unused queries are not necessarily cancelled if the signal is ignored. This cancels the browser request; it does not establish cancellation of already-running SQLite work. Search still needs a small debounce. [Cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)

## Proposed policy

The documented defaults are immediate staleness, five-minute inactive garbage collection, three browser retries, and refetching stale queries on mount, focus, and reconnect. Those need deliberate adjustment for this map. [Defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults), [query options](https://tanstack.com/query/latest/docs/framework/react/reference/interfaces/QueryOptions)

| Query family | Proposed starting policy |
|---|---|
| Search | 200 ms debounce; bounded result count; 30–60 second stale time; 60 second inactive GC; no focus refetch |
| Building detail | Cache by generation, entity kind, and ID; five-minute inactive GC |
| Theme values | Cache by generation, theme, and canonical chunk IDs; fetch only loaded chunks; 30–60 second inactive GC |
| Catalog status | Short stale time and explicit refresh/reconnect check to discover publication changes |

These timings are tuning proposals, not measured results. Canonical chunk IDs avoid creating a cache entry for every camera position; canonicalize sorted chunk sets when batching. Limit active chunks and response sizes too: `gcTime` is an inactivity timer, not a hard memory cap.

Use infinite stale time only for immutable generations that the server actually pins or validates. Merely putting a generation in the browser key cannot prevent mixed publications. On generation change, move consumers to new keys and retire old cached entries. Keep source freshness/availability fields visible independently of Query’s transport freshness. Retry transient failures at most once initially; do not retry normal validation or missing-entity responses.

## SvelteKit alternative and scope

SvelteKit `load` fits initial route data. Native remote `query` additionally deduplicates arguments and shares results while active, then releases unused values. It remains documented as experimental with explicit opt-ins. It could handle simple search/details, but Query’s configurable retained cache and request lifecycle suit repeated map exploration. [Loading data](https://svelte.dev/docs/kit/load), [remote functions](https://svelte.dev/docs/kit/remote-functions)

Start with one QueryClient/provider for the map UI and browser-enabled queries. If SSR prefetching is later needed, create isolated clients per server request and pass only bounded initial data; never share a server singleton cache between users. [SvelteKit setup](https://tanstack.com/query/latest/docs/framework/svelte/ssr), [SSR isolation](https://tanstack.com/query/latest/docs/framework/react/guides/ssr)

Keep geometry streaming, GPU objects, live traffic SSE, and full catalog blobs outside this cache. No new query abstraction layer, persistence plugin, or TanStack DB is needed.

The initial assessment used official documentation and registry metadata. The implementation now installs the pinned adapter and integrates search, details and theme queries. Browser checks verify pagination, inspector updates and detail-cache reuse without full energy/Ryhti catalog requests. Heap usage and production concurrency have not been benchmarked.


## Implementation source check

The worktree pins Svelte Query 6.3.1 / Query Core 5.104.1. `opensrc path @tanstack/query-core --cwd <worktree>` failed with “error decoding response body”, so the installed pinned sources were inspected as the fallback. `node_modules/@tanstack/query-core/src/removable.ts:23` schedules timers for finite GC durations, and `:33` shows that an explicit value overrides the server's default Infinity. `node_modules/@tanstack/svelte-query/src/QueryClientProvider.svelte:16` unmounts the client without clearing its query cache. The implementation therefore uses browser-only finite GC durations and clears its per-layout client on destruction. SvelteKit 3 uses `$app/env` for the browser flag; the installed type declarations and official Svelte MCP documentation confirm this API.

## Measured implementation scope

The local prepared dataset contains 22,686 unique buildings and 12 themes. Its SQLite database is 189,063,168 bytes on the server. The catalog summary response is 28,589 bytes; a tested 30-building search page is approximately 23–25 KB and a tested building detail is 11,271 bytes. These bounded requests replace whole metadata/energy/Ryhti downloads for search and inspection. Geometry and visible-chunk metadata still stream separately. These are local payload observations, not production capacity measurements.

Rebuild with `npm run entities:prepare` after source preparation. The browser caches immutable details/theme values by the validated generation, refreshes catalog status every 30 seconds while visible, and refreshes it immediately after an API generation conflict.

The adapter source lookup also failed with the same resolver error. Pinned `node_modules/@tanstack/svelte-query/src/createQueries.svelte.ts:292` constructs a new observer when options change. Scene callbacks can return new arrays for unchanged chunk groups, so the page derives a primitive serialized group key before creating options. A browser regression measurement fell from 418 initial theme requests to 11 distinct requests with zero failures after this correction; changing the category while those values were cached issued zero theme requests.
