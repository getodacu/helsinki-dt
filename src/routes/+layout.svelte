<script lang="ts">
  import '../app.css';
  import { onDestroy, type Snippet } from 'svelte';
  import { browser } from '$app/env';
  import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/svelte-query';
  import { EntityApiError } from '#lib/entity-query.ts';
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: error => {
      if (error instanceof EntityApiError && error.status === 409) void queryClient.invalidateQueries({ queryKey: ['entity-catalog'] });
    } }),
    defaultOptions: { queries: { enabled: browser, staleTime: 30_000, gcTime: browser ? 300_000 : Infinity, refetchOnWindowFocus: false,
      retry: (count, error) => count < 1 && (!(error instanceof EntityApiError) || error.status >= 500) } }
  });
  onDestroy(() => queryClient.clear());
  let { children }: { children: Snippet } = $props();
</script>

<QueryClientProvider client={queryClient}>{@render children()}</QueryClientProvider>
