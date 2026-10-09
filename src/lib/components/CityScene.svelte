<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { createCityScene, type CitySceneController, type Layers, type SceneStation, type SceneStats, type SceneLoadState, type Selection } from '#lib/scene.ts';
  import type { CityAssetCache } from '#lib/city-cache.ts';
  import type { CityBase, CityManifest } from '#lib/city-assets.ts';
  import type { TrafficSnapshot } from '#lib/traffic.ts';
  import type { Building } from '#lib/types.ts';
  import type { RouteContext } from '#lib/route-context.ts';
  let { manifest, base, cache, onloadstate, traffic, layers, stations = [], route = null, routeFilter = null, buildingColours = new Map(), buildingTheme = false, onappearance, onselection, onbuildings, onstats, onhover, onerror, oninteraction, onready, oncontroller }:
    { manifest: CityManifest; base: CityBase; cache: CityAssetCache; onloadstate: (state: SceneLoadState) => void; traffic: TrafficSnapshot; layers: Layers;
      stations?: SceneStation[]; route?: RouteContext | null; routeFilter?: string | null; buildingColours?: ReadonlyMap<string, string>; buildingTheme?: boolean; onappearance: (message: string) => void;
      onselection: (selection: Selection | null, message?: string) => void; onbuildings: (buildings: Building[]) => void;
      onstats: (stats: SceneStats) => void; onhover: (label: string) => void; onerror: (message: string) => void;
      oninteraction: () => void; onready: () => void; oncontroller: (controller: CitySceneController | null) => void } = $props();
  let container: HTMLDivElement;
  let controller = $state.raw<CitySceneController | null>(null);
  onMount(() => {
    try {
      controller = createCityScene(container, manifest, base, { onSelection: onselection, onBuildings: onbuildings,
        onStats: onstats, onHover: onhover, onError: onerror, onCameraInteraction: oninteraction, onReady: onready, onAppearanceStatus: onappearance, onLoadState: onloadstate }, cache);
      oncontroller(controller);
    } catch (error) { onerror(error instanceof Error ? error.message : 'The 3D scene could not start.'); }
    return () => { controller?.dispose(); oncontroller(null); };
  });
  $effect(() => { const instance = controller, snapshot = traffic; untrack(() => instance?.setTraffic(snapshot)); });
  $effect(() => { const instance = controller, visible = { ...layers }; untrack(() => instance?.setLayers(visible)); });
  $effect(() => { const instance = controller, values = stations; untrack(() => instance?.setStations(values)); });
  $effect(() => { const instance = controller, context = route; untrack(() => instance?.setRoute(context)); });
  $effect(() => { const instance = controller, filter = routeFilter; untrack(() => instance?.setRouteFilter(filter)); });
  $effect(() => { const instance = controller, colours = buildingColours, themed = buildingTheme; untrack(() => instance?.setBuildingColours(colours, themed)); });
</script>

<div class="scene-canvas" bind:this={container}></div>
