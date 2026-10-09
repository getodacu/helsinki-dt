<script lang="ts">
  import { onMount, tick } from 'svelte';
  import CityScene from '#lib/components/CityScene.svelte';
  import NearbyConditions from '#lib/components/NearbyConditions.svelte';
  import BuildingEnergy from '#lib/components/BuildingEnergy.svelte';
  import { energyThemeOptions, buildingEnergyTheme, energyForCity, ENERGY_COLOURS, NO_ENERGY_COLOUR } from '#lib/energy-display.ts';
  import type { EnergyCatalogState } from '#lib/energy-types.ts';
  import StationHistory from '#lib/components/StationHistory.svelte';
  import { loadPreparedSample } from './sample.ts';
  import { loadCityManifest, loadCityBase, loadBuildingSearchIndex, type CityManifest, type CityBase } from '#lib/city-assets.ts';
  import { CityAssetCache } from '#lib/city-cache.ts';
  import { INITIAL_LAYERS, type SceneLoadState, type Layers, type Selection, type SceneStation, type SceneStats, type CitySceneController, type CameraPreset } from '#lib/scene.ts';
  import { MODE_COLOURS, VEHICLE_DISPLAY_SCALE } from '#lib/live-fleet.ts';
  import { trafficAge, trafficIsStale, TRAFFIC_REMOVE_MS, type TrafficSnapshot, type TrafficEvent } from '#lib/traffic.ts';
  import { groupObservationStations, observationHistory, OBSERVATION_PARAMETERS, type ObservationSnapshot } from '#lib/observations.ts';
  import { loadRouteCatalog, routeRequestUrl, type RouteCatalog, type RouteContext } from '#lib/route-context.ts';
  import { buildingName, buildingAddress, buildingAttribute, matchesBuilding, matchesVehicle, searchText, delayLabel, signedSeconds, formatDate, label } from '#lib/inspection.ts';
  import type { Building, TransitMode } from '#lib/types.ts';
  let energyResponse = $state.raw<EnergyCatalogState>({ status: 'unavailable', catalog: null, message: null, attemptedAt: null });
  let energyLoading = $state(true);
  let themeKey = $state('');
  let sample = $state.raw<Awaited<ReturnType<typeof loadPreparedSample>>>({ manifest: null, buildings: [], sampleError: null });
  let city = $state.raw<{ manifest: CityManifest; base: CityBase; cache: CityAssetCache } | null>(null);
  let energy = $derived(energyForCity(energyResponse, city?.manifest ?? null));
  let themeOptions = $derived(energyThemeOptions(energy.catalog));
  let activeTheme = $derived(themeOptions.find(option => option.key === themeKey) ?? null);
  let theme = $derived(buildingEnergyTheme(energy.catalog, activeTheme));
  let scene = $state.raw<CitySceneController | null>(null);
  let layers = $state<Layers>({ ...INITIAL_LAYERS, weather: true, airQuality: true });
  let buildings = $state.raw<Building[]>([]);
  let searchBuildings = $state.raw<Building[]>([]);
  let indexState = $state('loading');
  let indexMessage = $state('Loading the prepared building metadata index.');
  let selected = $state.raw<Selection | null>(null);
  let selectionMessage = $state('');
  let hovered = $state('');
  let sceneError = $state('');
  let appearanceStatus = $state('');
  let trafficError = $state('');
  let ready = $state(false);
  let mapLoad = $state.raw<SceneLoadState>({ phase: 'discovering', completed: 0, total: 0, failed: 0, cacheIssue: '', background: { phase: 'idle', completed: 0, total: 0, failed: 0 } });
  let sourceOpen = $state(false);
  let preset = $state<CameraPreset>('city');
  let following = $state(false);
  let query = $state('');
  let routeFilter = $state('');
  let now = $state(Date.now());
  let observationSnapshot = $state.raw<ObservationSnapshot | null>(null);
  let observationLoading = $state(true);
  let observationError = $state('');
  let enabledParameters = $state<string[]>(OBSERVATION_PARAMETERS.map(parameter => parameter.id));
  let stationParameter = $state('t2m');
  let route = $state.raw<RouteContext | null>(null);
  let routeLoading = $state(false);
  let routeError = $state('');
  let routeCatalog = $state.raw<RouteCatalog | null>(null);
  let routeCatalogLoading = $state(true);
  let mobilePanel = $state<'controls' | 'inspect' | null>(null);
  let stats = $state.raw<SceneStats | null>(null);
  let traffic = $state.raw<TrafficSnapshot>({ type: 'snapshot', generatedAt: new Date().toISOString(), vehicles: [],
    status: { state: 'idle', connectedAt: null, lastPositionAt: null, retryAt: null } });
  let browserConnected = $state(false);
  let loading = $state(true);
  let mapCovered = $derived(loading || !['ready', 'available'].includes(mapLoad.phase));
  const modes: TransitMode[] = ['tram', 'bus', 'ferry'];
  const modeNames: Record<TransitMode, string> = { tram: 'Trams', bus: 'Buses', ferry: 'HSL Ferries' };
  const age = (vehicle: { reportedAt: string }) => `${Math.max(0, Math.floor(trafficAge(vehicle, now) / 1000))} s ago`;
  let releaseBuildingCount = $derived(indexState === 'current' ? searchBuildings.length : null);
  let routes = $derived(routeCatalog?.routes ?? []);
  const routeName = (id: string) => routes.find(item => item.routeId === id)?.label ?? id;
  let availableVehicles = $derived(traffic.vehicles.filter(vehicle => trafficAge(vehicle, now) < TRAFFIC_REMOVE_MS));
  let visibleVehicles = $derived(availableVehicles.filter(vehicle => layers[vehicle.mode] && (!routeFilter || vehicle.routeId === routeFilter))
    .sort((a, b) => a.mode.localeCompare(b.mode) || a.routeId.localeCompare(b.routeId) || a.id.localeCompare(b.id)));
  let matchingVehicles = $derived(visibleVehicles.filter(vehicle => !query || matchesVehicle(vehicle, query, routeName(vehicle.routeId))));
  let indexedBuildings = $derived([...new Map([...searchBuildings, ...buildings].map(building => [building.id, building])).values()]);
  let filteredBuildings = $derived(query ? indexedBuildings.filter(building => matchesBuilding(building, query)) : sceneError && !scene ? indexedBuildings : buildings);
  let matchingRoutes = $derived(routes.filter(item => (!routeFilter || item.routeId === routeFilter) && layers[item.mode]
    && (!query || searchText(`${item.routeId} ${item.label} ${item.name}`).includes(searchText(query)))));
  let observationStations = $derived(observationSnapshot ? groupObservationStations(observationSnapshot) : []);
  let stations = $derived<SceneStation[]>(observationStations.map(station => ({ id: station.id, name: station.name,
    longitude: station.longitude, latitude: station.latitude, kind: station.sourceId === 'fmi-air-quality' ? 'air-quality' : 'weather', sourceIds: [station.sourceId] })));
  let matchingStations = $derived(stations.filter(station => layers[station.kind === 'weather' ? 'weather' : 'airQuality']
    && (!query || searchText(`${station.id} ${station.name}`).includes(searchText(query)))));
  let staleCount = $derived(visibleVehicles.filter(vehicle => trafficIsStale(vehicle, now)).length);
  let currentFeed = $derived(browserConnected && traffic.status.state === 'live');
  let selectedSource = $derived.by(() => { const selection = selected; return selection?.kind === 'building' ? city?.manifest.sources.find(source => source.id === selection.building.sourceId) : null; });
  let selectedStation = $derived.by(() => { const selection = selected; return selection?.kind === 'station' ? observationStations.find(station => station.id === selection.station.id) : null; });
  let selectedStationParameters = $derived(OBSERVATION_PARAMETERS.filter(parameter => selectedStation?.parameters.includes(parameter.id)));
  let displayedStationParameter = $derived(selectedStationParameters.some(parameter => parameter.id === stationParameter) ? stationParameter : selectedStationParameters[0]?.id ?? stationParameter);
  let stationHistory = $derived(selected?.kind === 'station' && observationSnapshot ? observationHistory(observationSnapshot.observations, selected.station.id, displayedStationParameter) : []);
  let stationLatest = $derived(stationHistory.at(-1));
  let contextPosition = $derived(selected?.kind === 'vehicle' ? { longitude: selected.vehicle.longitude, latitude: selected.vehicle.latitude }
    : selected?.kind === 'building' ? selected.building : selected?.kind === 'station' ? selected.station : { longitude: 24.952, latitude: 60.1695 });
  let contextScope = $derived(selected?.kind === 'vehicle' ? 'Near the last reported vehicle position' : selected?.kind === 'building' ? 'Near this building' : selected?.kind === 'station' ? 'Near this station' : 'Near the city-centre view origin');
  let journeyUrl = $derived(selected?.kind === 'vehicle' ? routeRequestUrl(selected.vehicle) : null);
  let selectedStationSources = $derived.by(() => { const selection = selected; return selection?.kind === 'station' ? observationSnapshot?.sources.filter(source => selection.station.sourceIds.includes(source.id)) ?? [] : []; });
  const setSelection = (selection: Selection | null, message = '') => {
    const identity = (value: Selection | null) => !value ? null : value.kind === 'vehicle' ? `v:${value.vehicle.id}` : value.kind === 'building' ? `b:${value.building.id}` : `s:${value.station.id}`;
    const changed = identity(selected) !== identity(selection);
    if (changed || (selection?.kind === 'vehicle' && selection.removed)) following = false;
    if (changed) {
      if (selection) mobilePanel = 'inspect';
      void tick().then(() => {
        document.getElementById('identity-inspector')?.scrollTo({ top: 0 });
        document.getElementById('inspection-heading')?.focus({ preventScroll: true });
      });
    }
    selected = selection; selectionMessage = message;
  };
  const selectObject = (selection: Selection) => { if (scene) scene.select(selection); else setSelection(selection, '3D rendering unavailable. Showing available source metadata.'); };
  const clearSelection = () => { if (scene) scene.clearSelection(); else setSelection(null); };
  const setMobilePanel = (panel: typeof mobilePanel) => {
    const previous = mobilePanel;
    mobilePanel = panel;
    void tick().then(() => {
      const id = panel === 'controls' ? 'scene-controls' : panel === 'inspect' ? 'identity-inspector' : null;
      if (id) document.querySelector<HTMLButtonElement>(`#${id} .mobile-sheet-heading button`)?.focus();
      else document.querySelector<HTMLButtonElement>(`[aria-controls="${previous === 'controls' ? 'scene-controls' : 'identity-inspector'}"]`)?.focus();
    });
  };
  function showSources(dialog: HTMLDialogElement) {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return { destroy() { dialog.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); } };
  }
  const choosePreset = (value: CameraPreset) => { preset = value; following = false; scene?.preset(value); };
  const selectStation = (id: string) => { const station = stations.find(station => station.id === id); if (station) selectObject({ kind: 'station', station }); };
  const chooseRoute = (id: string) => {
    routeFilter = id;
    const vehicle = availableVehicles.find(vehicle => vehicle.routeId === id && layers[vehicle.mode]);
    if (vehicle) selectObject({ kind: 'vehicle', vehicle });
    else selectionMessage = 'No current vehicle report for this route. No journey shape can be inferred.';
  };
  const openSources = () => sourceOpen = true;
  $effect(() => {
    const url = journeyUrl;
    route = null; routeError = ''; routeLoading = !!url;
    if (!url) return;
    const request = new AbortController();
    void fetch(url, { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) })
      .then(async response => { if (!response.ok) throw new Error(`Route context unavailable (${response.status})`); return await response.json() as RouteContext; })
      .then(value => { if (!request.signal.aborted) route = value; })
      .catch(error => { if (!request.signal.aborted) routeError = error instanceof Error ? error.message : 'Route context unavailable'; })
      .finally(() => { if (!request.signal.aborted) routeLoading = false; });
    return () => request.abort();
  });
  $effect(() => {
    if (!ready && !sceneError) return;
    const request = new AbortController();
    void fetch('/api/energy/catalog', { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) })
      .then(async response => {
        if (!response.ok) throw new Error(`Prepared energy catalog unavailable (${response.status}).`);
        const state = await response.json() as EnergyCatalogState;
        if (!['ready', 'stale', 'unavailable'].includes(state.status) || (state.catalog && (state.catalog.version !== 1
          || !Array.isArray(state.catalog.energy) || !Array.isArray(state.catalog.solar) || !Array.isArray(state.catalog.properties)
          || !Array.isArray(state.catalog.sources) || !Array.isArray(state.catalog.reports)))) throw new Error('Prepared energy catalog could not be read.');
        return state;
      }).then(state => { if (!request.signal.aborted) energyResponse = state; })
      .catch(error => { if (!request.signal.aborted) energyResponse = { status: 'unavailable', catalog: null, message: error instanceof Error ? error.message : 'Energy catalog unavailable.', attemptedAt: null }; })
      .finally(() => { if (!request.signal.aborted) energyLoading = false; });
    return () => request.abort();
  });
  onMount(() => {
    const lifetime = new AbortController();
    let stream: EventSource | null = null, request: AbortController | null = null, disposed = false;
    const fleet = new Map<string, TrafficSnapshot['vehicles'][number]>();
    function receive(event: TrafficEvent) {
      if (!event || !['snapshot', 'update'].includes(event.type) || !Array.isArray(event.vehicles)
        || !event.status || !Number.isFinite(Date.parse(event.generatedAt))) throw new Error('Invalid traffic update');
      if (event.type === 'snapshot') fleet.clear();
      else for (const id of event.removed) fleet.delete(id);
      for (const vehicle of event.vehicles) fleet.set(vehicle.id, vehicle);
      traffic = { type: 'snapshot', generatedAt: event.generatedAt, vehicles: [...fleet.values()], status: event.status };
      if (!scene && selected?.kind === 'vehicle') {
        const vehicle = fleet.get(selected.vehicle.id);
        setSelection({ kind: 'vehicle', vehicle: vehicle ?? selected.vehicle, removed: !vehicle });
      }
      browserConnected = true; trafficError = '';
    }
    async function connect() {
      if (disposed || document.hidden) return;
      request?.abort(); const attempt = new AbortController(); request = attempt;
      try {
        const response = await fetch('/api/traffic', { cache: 'no-store', signal: AbortSignal.any([attempt.signal, lifetime.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error(`Traffic source returned ${response.status}`);
        const event = await response.json();
        if (disposed || document.hidden || attempt.signal.aborted || request !== attempt) return;
        receive(event);
      } catch (error) {
        if (disposed || document.hidden || attempt.signal.aborted || request !== attempt) return;
        trafficError = error instanceof Error ? error.message : 'Traffic snapshot unavailable';
      }
      if (disposed || document.hidden || attempt.signal.aborted || request !== attempt) return;
      stream?.close(); const connection = new EventSource('/api/traffic/stream'); stream = connection;
      const update = (event: MessageEvent) => { if (disposed || document.hidden || stream !== connection) return; try { receive(JSON.parse(event.data)); } catch { trafficError = 'Traffic update could not be read'; browserConnected = false; } };
      connection.addEventListener('snapshot', update); connection.addEventListener('update', update);
      connection.onerror = () => { if (disposed || stream !== connection) return; browserConnected = false; trafficError = 'Connection interrupted · reconnecting'; };
    }
    const visibility = () => {
      if (document.hidden) { stream?.close(); stream = null; request?.abort(); browserConnected = false; }
      else { now = Date.now(); void connect(); }
    };

    let observationRequest: AbortController | null = null;
    async function refreshObservations() {
      if (disposed || document.hidden || observationRequest) return;
      const attempt = new AbortController(); observationRequest = attempt;
      try {
        const response = await fetch('/api/observations', { cache: 'no-store', signal: AbortSignal.any([attempt.signal, lifetime.signal, AbortSignal.timeout(45_000)]) });
        if (!response.ok) throw new Error(`Observation source unavailable (${response.status})`);
        const value = await response.json() as ObservationSnapshot;
        if (!Array.isArray(value.observations) || !Array.isArray(value.sources) || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('Observation snapshot could not be read');
        if (!disposed) { observationSnapshot = value; observationError = ''; }
      } catch (error) { if (!disposed) observationError = error instanceof Error ? error.message : 'Observations unavailable'; }
      finally { observationRequest = null; if (!disposed) observationLoading = false; }
    }
    const resumeObservations = () => { if (!document.hidden) void refreshObservations(); };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('visibilitychange', resumeObservations);
    const clock = setInterval(() => { if (!document.hidden) now = Date.now(); }, 1000);
    const observationsCheck = setInterval(() => void refreshObservations(), 5 * 60_000);
    void connect(); void refreshObservations();
    void loadRouteCatalog(fetch).then(value => { if (!disposed) routeCatalog = value; }).catch(error => { if (!disposed) routeCatalog = { status: 'unavailable', generatedAt: null, source: null, routes: [], reason: error instanceof Error ? error.message : 'Route labels unavailable' }; }).finally(() => { if (!disposed) routeCatalogLoading = false; });
    void loadPreparedSample(fetch).then(data => { if (!disposed) sample = data; });
    const cache = new CityAssetCache();
    void loadCityManifest(fetch, lifetime.signal).then(async manifest => {
      const base = await loadCityBase(manifest, fetch, lifetime.signal, cache);
      if (disposed) return; city = { manifest, base, cache };
      void loadBuildingSearchIndex(manifest, fetch, lifetime.signal, cache).then(index => {
        if (disposed) return; searchBuildings = index.buildings;
        indexState = index.unavailableChunks.length ? 'partial' : index.buildings.length ? 'current' : 'empty';
        indexMessage = index.unavailableChunks.length ? `${index.unavailableChunks.length} metadata batches unavailable; searchable coverage is partial.` : `${index.buildings.length.toLocaleString()} prepared building identities searchable.`;
      }).catch(error => { if (!disposed) { indexState = 'unavailable'; indexMessage = error instanceof Error ? error.message : 'Building index unavailable'; } });
    }).catch(error => { if (!disposed) { sceneError = error instanceof Error ? error.message : 'City assets unavailable'; indexState = 'unavailable'; indexMessage = 'City index unavailable.'; } })
      .finally(() => { if (!disposed) loading = false; });
    return () => { disposed = true; cache.dispose(); lifetime.abort(); request?.abort(); observationRequest?.abort(); stream?.close(); clearInterval(clock); clearInterval(observationsCheck); document.removeEventListener('visibilitychange', visibility); document.removeEventListener('visibilitychange', resumeObservations); };
  });
</script>

<svelte:head><title>Helsinki Lens · Living city</title><meta name="description" content="Inspect central Helsinki buildings, live HSL vehicle reports and dated environmental station observations." /></svelte:head>
<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !sourceOpen) { clearSelection(); if (mobilePanel) setMobilePanel(null); } }} />
<a class="skip-link" href="#object-browser" onclick={() => mobilePanel = 'inspect'}>Skip to searchable objects</a>
<div class="app-shell">
  <header class="masthead">
    <a class="brand" href="/">HELSINKI <span>LENS</span><small>Living city</small></a>
    <div class="header-status"><span class:connected={currentFeed} class="status-dot"></span><span>{currentFeed ? 'HSL connected' : traffic.status.state === 'idle' ? 'Waiting for HSL' : 'HSL reconnecting'}</span><span class="header-location">60.1695° N · 24.9520° E</span></div>
    <button class="source-button" onclick={() => sourceOpen = !sourceOpen} aria-expanded={sourceOpen} aria-controls="sources">Sources & status ↗</button>
  </header>
  <main class="city-workspace" data-scene-ready={!mapCovered} aria-busy={mapCovered}>
    {#if city}
      <CityScene manifest={city.manifest} base={city.base} cache={city.cache} onloadstate={value => mapLoad = value} {traffic} {layers} {stations} {route} routeFilter={routeFilter || null} buildingColours={theme.colours} buildingTheme={!!activeTheme} onappearance={value => appearanceStatus = value} onselection={setSelection}
        onbuildings={(value) => buildings = value} onstats={(value) => stats = value} onhover={(value) => hovered = value}
        onerror={(value) => sceneError = value} oninteraction={() => following = false} onready={() => ready = true}
        oncontroller={(value) => scene = value} />
    {/if}
    {#if mapCovered}
      <div class="map-loading-cover">
        <div class="scene-status" role="status" aria-live="polite">
          <span class="eyebrow">Helsinki geographic model</span>
          <strong>{sceneError && !scene ? 'City scene unavailable' : 'Loading the complete view'}</strong>
          <p>{sceneError && !scene ? sceneError : loading ? 'Loading terrain…' : mapLoad.phase === 'discovering' ? 'Finding buildings and imagery…' : mapLoad.phase === 'rendering' ? 'Preparing the map…' : `${mapLoad.completed.toLocaleString()} of ${mapLoad.total.toLocaleString()} map parts loaded.`}</p>
          {#if !sceneError || scene}
            {#if loading || mapLoad.phase === 'discovering'}
              <progress aria-label="Loading current map view"></progress>
            {:else}
              <progress aria-label="Loading current map view" value={mapLoad.completed} max={Math.max(1, mapLoad.total)}></progress>
            {/if}
          {/if}
          {#if sceneError && !scene}<p>Use Inspect &amp; search for available data and source records.</p>{/if}
        </div>
      </div>
    {/if}
    {#if mapLoad.cacheIssue}<div class="map-cache-status" role="status">{mapLoad.cacheIssue}</div>
    {:else if ready && ['discovering', 'loading', 'complete'].includes(mapLoad.background.phase)}
      <div class="map-cache-status" role="status" aria-live="polite">
        {mapLoad.background.phase === 'discovering' ? 'Preparing the shared map cache…'
          : mapLoad.background.phase === 'complete' ? 'Prepared area cached on the server.'
          : `Caching area on the server: ${mapLoad.background.completed.toLocaleString()} / ${mapLoad.background.total.toLocaleString()}`}
      </div>
    {/if}
    <div class="scene-title"><span class="eyebrow">FINLAND / LIVE GEOGRAPHIC VIEW</span><h1>{preset === 'city' ? 'City Centre' : preset === 'harbour' ? 'South Harbour' : preset === 'energy' ? 'Energy · Senate district' : 'Suomenlinna'}</h1><p>Buildings in metres. Movement from received HSL reports.</p></div>
    {#if city?.manifest.gaps.length}<button class="coverage-notice" onclick={openSources}>Building coverage incomplete <span>View evidence ↗</span></button>{/if}
    <aside class="left-stack" class:mobile-active={mobilePanel === 'controls'} id="scene-controls" aria-label="Scene controls and conditions">
      <div class="mobile-sheet-heading"><strong>Layers & conditions</strong><button class="icon-button" aria-label="Close controls sheet" onclick={() => setMobilePanel(null)}>×</button></div>
      <section class="panel layers-panel"><div class="panel-heading"><h2>Layers</h2><span>GEOGRAPHIC CONTEXT</span></div>
        <div class="layer-list">
          <label class="layer-control"><input type="checkbox" bind:checked={layers.imagery} /><span class="layer-symbol" aria-hidden="true">▧</span><span>Aerial imagery & textures</span></label>
          {#if layers.imagery}<p class="panel-note">Helsinki orthophoto 2025 · textured LoD2 buildings.<br /><a href="https://kartta.hel.fi/3d/" target="_blank" rel="noreferrer">© City of Helsinki · CC BY 4.0 ↗</a></p>{#if appearanceStatus}<p class="panel-note" role="status">{appearanceStatus}</p>{/if}{/if}
          {#each [['buildings', 'Semantic buildings'], ['terrain', 'Terrain & islands'], ['roads', 'Roads & rail']] as [key, name] (key)}
            <label class="layer-control"><input type="checkbox" bind:checked={layers[key as keyof Layers]} /><span class="layer-symbol" aria-hidden="true">{key === 'buildings' ? '▥' : key === 'terrain' ? '△' : '≋'}</span><span>{name}</span></label>
          {/each}
          <div class="layer-divider"></div>
          {#each modes as mode (mode)}<label class="layer-control"><input type="checkbox" aria-label={modeNames[mode]} bind:checked={layers[mode]} /><span class="mode-swatch" style:background={MODE_COLOURS[mode]}></span><span class="mode-label">{modeNames[mode]}</span><small>{availableVehicles.filter(vehicle => vehicle.mode === mode).length}</small></label>{/each}
          <label class="filter-label">Route filter<select bind:value={routeFilter}><option value="">All received routes</option>{#each [...new Set(availableVehicles.map(vehicle => vehicle.routeId))].sort() as id (id)}<option value={id}>{routeName(id)} · {id}</option>{/each}</select></label>
          {#if routeFilter}<button class="text-button" onclick={() => routeFilter = ''}>Clear route filter</button>{/if}
          <div class="layer-divider"></div>
          <label class="layer-control"><input type="checkbox" bind:checked={layers.weather} /><span class="station-swatch weather" aria-hidden="true">○</span><span>Weather stations</span></label>
          <label class="layer-control"><input type="checkbox" bind:checked={layers.airQuality} /><span class="station-swatch air-quality" aria-hidden="true">◇</span><span>Air-quality stations</span></label>
          <div class="layer-divider"></div>
          <div class="building-theme" data-building-theme={activeTheme?.kind ?? 'neutral'}>
            <label class="filter-label">Building colors<select value={activeTheme?.key ?? ''} onchange={event => themeKey = event.currentTarget.value}><option value="">{layers.imagery ? 'Textured buildings' : 'Neutral buildings'}</option>{#each ['modeled-demand', 'solar'] as kind (kind)}<optgroup label={kind === 'modeled-demand' ? 'Modeled demand' : 'Modeled solar potential'}>{#each themeOptions.filter(option => option.kind === kind) as option (option.key)}<option value={option.key}>{label(option.metric)} · {option.unit} · {option.period}{option.scenario ? ` · ${option.scenario}` : ''}</option>{/each}</optgroup>{/each}</select></label>
            {#if activeTheme}
              <p class="panel-note">{label(activeTheme.metric)} · {activeTheme.unit}<br />{activeTheme.kind === 'solar' ? 'Modeled solar potential' : 'Modeled building demand'} · {activeTheme.period}{activeTheme.scenario ? ` · ${activeTheme.scenario}` : ''}<br />Source: {activeTheme.sourceId}</p>
              {#if theme.minimum !== null && theme.maximum !== null}<div class="theme-gradient" style:background={`linear-gradient(to right, ${ENERGY_COLOURS[0]} 0% 33.333%, ${ENERGY_COLOURS[1]} 33.333% 66.666%, ${ENERGY_COLOURS[2]} 66.666% 100%)`} aria-hidden="true"></div><div class="theme-limits"><span>{theme.minimum.toLocaleString('en-GB', { maximumFractionDigits: 2 })}</span><span>{theme.maximum.toLocaleString('en-GB', { maximumFractionDigits: 2 })} {activeTheme.unit}</span></div><p class="panel-note">{theme.minimum === theme.maximum ? 'One value; middle color.' : 'Three equal ranges from the displayed minimum to maximum.'}</p>{/if}
              <p class="panel-note" data-theme-covered={theme.count} data-theme-denominator={releaseBuildingCount ?? ''}>{theme.count.toLocaleString()} colored / {releaseBuildingCount?.toLocaleString() ?? 'unknown'} prepared release buildings. Shared property totals and ambiguous associations excluded.</p>
              <p class="panel-note"><span class="no-data-swatch" style:background={NO_ENERGY_COLOUR}></span> Neutral = no comparable record. {theme.count ? '' : 'No comparable values in this dataset selection.'}</p>
            {:else}<p class="panel-note">{layers.imagery ? 'City building textures. Energy colors replace textures while a metric is selected.' : 'Neutral palette.'} Select one supported modeled demand or solar metric to see its period, units, limits and coverage.</p>{/if}
            {#if energyLoading}<p class="notice" role="status">{ready ? 'Loading prepared energy and solar records…' : 'Energy records load after the scene is ready.'}</p>{:else if energy.status !== 'ready'}<p class="notice">{energy.status === 'stale' ? 'Dated catalog retained' : 'Energy catalog unavailable'} · {energy.message}</p>{/if}
          </div>
          <fieldset class="parameter-controls"><legend>Nearby parameters</legend>{#each OBSERVATION_PARAMETERS as parameter (parameter.id)}<label><input type="checkbox" value={parameter.id} bind:group={enabledParameters} />{parameter.label}</label>{/each}</fieldset>
        </div><p class="panel-note">Station markers show actual locations. Vehicle symbols ×{VEHICLE_DISPLAY_SCALE} are illustrative.</p>
      </section>
      <section class="panel conditions"><div class="panel-heading"><h2>Nearby conditions</h2><span>STATION CONTEXT</span></div>
        <div class="condition-source-states">{#each observationSnapshot?.sources ?? [] as source (source.id)}<button onclick={openSources}><span>{source.id === 'fmi-weather' ? 'Weather' : 'Air quality'}</span><span class="badge {source.state}">{source.state}</span></button>{/each}</div>
        <NearbyConditions snapshot={observationSnapshot} longitude={contextPosition.longitude} latitude={contextPosition.latitude} parameters={enabledParameters} {now} loading={observationLoading} error={observationError} scope={contextScope} onsources={openSources} onstation={selectStation} />
      </section>
      <section class="panel feed-panel" aria-label="Traffic status"><div class="panel-heading"><h2>Reported traffic</h2><span class:connected={currentFeed} class="status-dot"></span></div>
        <div class="feed-summary"><strong>{visibleVehicles.length}</strong><span>vehicles in visible modes / route<br />{staleCount ? `${staleCount} stale · held at last position` : 'Latest received positions'}</span></div>
        <p class="panel-note">{trafficError || (traffic.status.lastPositionAt ? `Last report ${formatDate(traffic.status.lastPositionAt)}` : 'Waiting for real position reports.')}</p>
        {#if stats?.unplacedVehicles}<p class="panel-note">{stats.unplacedVehicles} ground vehicles omitted where terrain height is unknown.</p>{/if}
      </section>
    </aside>
    <aside class="right-stack" class:mobile-active={mobilePanel === 'inspect'} id="identity-inspector" aria-label="Identity inspector and searchable objects">
      <div class="mobile-sheet-heading"><strong>Inspect & search</strong><button class="icon-button" aria-label="Close inspector sheet" onclick={() => setMobilePanel(null)}>×</button></div>
      <section class="panel inspector"><div class="panel-heading"><h2 id="inspection-heading" tabindex="-1">{selected?.kind === 'building' ? 'Building identity' : selected?.kind === 'vehicle' ? 'Vehicle identity' : selected?.kind === 'station' ? 'Station observations' : 'Explore the city'}</h2>{#if selected}<button class="icon-button" aria-label="Clear selection" onclick={() => clearSelection()}>×</button>{:else}<span>SELECT</span>{/if}</div>
        <div class="panel-content">
          {#if selected?.kind === 'building'}
            <span class="eyebrow">SEMANTIC BUILDING</span><h3>{buildingName(selected.building)}</h3>
            {#if selected.unloaded}<p class="notice">Identity retained. Geometry is outside the currently loaded view.</p>{/if}
            <dl class="properties"><div><dt>Address</dt><dd>{buildingAddress(selected.building) ?? 'Unknown'}</dd></div><div><dt>Built</dt><dd>{buildingAttribute(selected.building, ['yearOfConstruction', 'rakennusvuosi']) ?? 'Unknown'}</dd></div><div><dt>Floors</dt><dd>{buildingAttribute(selected.building, ['storeysAboveGround', 'kerrosluku']) ?? 'Unknown'}</dd></div><div><dt>Use</dt><dd>{buildingAttribute(selected.building, ['usage', 'function', 'kayttotarkoitus']) ?? 'Unknown'}</dd></div><div><dt>Stable ID</dt><dd>{selected.building.id}</dd></div><div><dt>GML ID</dt><dd>{selected.building.gmlId}</dd></div><div><dt>VTJ-PRT</dt><dd>{selected.building.vtjPrt ?? 'Unknown'}</dd></div><div><dt>RATU</dt><dd>{selected.building.ratu ?? 'Unknown'}</dd></div><div><dt>UUID</dt><dd>{selected.building.uuid ?? 'Unknown'}</dd></div><div><dt>Geometry vintage</dt><dd>{selectedSource?.vintage ?? 'Unknown — not supplied'}</dd></div><div><dt>Retrieved</dt><dd>{formatDate(selectedSource?.retrievedAt)}</dd></div><div><dt>Source</dt><dd>{selected.building.sourceId}</dd></div></dl>
            {#if selectedSource}<a class="source-link" href={selectedSource.url} target="_blank" rel="noreferrer">Building source reference ↗</a>{/if}
            <details><summary>Available source attributes</summary><dl class="properties">{#each Object.entries(selected.building.attributes) as [key, value] (key)}<div><dt>{label(key)}</dt><dd>{value ?? 'Unknown'}</dd></div>{/each}</dl></details>
            {#key selected.building.id}<BuildingEnergy building={selected.building} catalogState={energy} loadingCatalog={energyLoading} buildings={indexedBuildings} onmember={id => { const member = indexedBuildings.find(building => building.id === id); if (member) selectObject({ kind: 'building', building: member }); }} onsources={openSources} />{/key}
          {:else if selected?.kind === 'vehicle'}
            <span class="eyebrow">HSL / {selected.vehicle.mode.toUpperCase()}</span><h3>Route {route?.status === 'exact' ? route.routeLabel ?? routeName(selected.vehicle.routeId) : routeName(selected.vehicle.routeId)}</h3>
            {#if selected.removed || trafficAge(selected.vehicle, now) >= TRAFFIC_REMOVE_MS}<p class="notice">This vehicle has left the current feed or its position expired. Its last reported identity remains here.</p>{:else if trafficIsStale(selected.vehicle, now)}<p class="notice">Stale position. Held at its last received coordinates.</p>{/if}
            <dl class="properties"><div><dt>Mode</dt><dd>{label(selected.vehicle.mode)}</dd></div><div><dt>Route ID</dt><dd>{selected.vehicle.routeId}</dd></div><div><dt>Direction</dt><dd>{selected.vehicle.directionId === null ? 'Unknown' : `HFP ${selected.vehicle.directionId}`}</dd></div><div><dt>Destination</dt><dd>{route?.status === 'exact' ? route.destination ?? 'Unknown — not supplied' : 'Unknown — journey not verified'}</dd></div><div><dt>Owner / vehicle</dt><dd>{selected.vehicle.ownerOperatorId} / {selected.vehicle.vehicleId}</dd></div><div><dt>Schedule</dt><dd class:late={(selected.vehicle.delaySeconds ?? 0) > 60} class:early={(selected.vehicle.delaySeconds ?? 0) < -60}>{delayLabel(selected.vehicle.delaySeconds)}</dd></div><div><dt>Speed</dt><dd>{selected.vehicle.speedMetresPerSecond === null ? 'Unknown' : `${(selected.vehicle.speedMetresPerSecond * 3.6).toFixed(1)} km/h`}</dd></div><div><dt>Reported</dt><dd>{formatDate(selected.vehicle.reportedAt)}<small>{age(selected.vehicle)}</small></dd></div><div><dt>Received</dt><dd>{formatDate(selected.vehicle.receivedAt)}</dd></div><div><dt>Feed / position</dt><dd>{currentFeed ? 'Browser connected' : 'Browser paused / disconnected'} · {selected.removed ? 'expired' : trafficIsStale(selected.vehicle, now) ? 'stale' : 'current'}</dd></div></dl>
            <p class="panel-note">±60 seconds is an application display convention for “on time”. Exact signed deviation remains below.</p>
            <details class="vehicle-details"><summary>Exact report & journey details</summary><dl class="properties"><div><dt>Raw HFP deviation</dt><dd>{signedSeconds(selected.vehicle.rawDeviationSeconds)}<small>Negative means late in HFP.</small></dd></div><div><dt>Normalized delay</dt><dd>{signedSeconds(selected.vehicle.delaySeconds)}<small>{selected.vehicle.delaySeconds === null ? 'Unknown' : selected.vehicle.delaySeconds > 0 ? 'Positive = late' : selected.vehicle.delaySeconds < 0 ? 'Negative = early' : 'Exact zero'}</small></dd></div><div><dt>Journey</dt><dd>{selected.vehicle.journeyReference ?? 'Unknown'}</dd></div><div><dt>Service date</dt><dd>{selected.vehicle.serviceDate ?? 'Unknown'}</dd></div><div><dt>Start time</dt><dd>{selected.vehicle.startTime ?? 'Unknown'}</dd></div><div><dt>Operating operator</dt><dd>{selected.vehicle.operatingOperatorId ?? 'Unknown'}</dd></div><div><dt>Quality flags</dt><dd>{selected.vehicle.quality.join(', ') || 'No flags supplied'}</dd></div><div><dt>Position</dt><dd>{selected.vehicle.latitude?.toFixed(5) ?? 'Unknown'}, {selected.vehicle.longitude?.toFixed(5) ?? 'Unknown'}</dd></div></dl></details>
            <button class="follow-button" disabled={!scene || selected.removed || trafficIsStale(selected.vehicle, now)} onclick={() => { following = !following; scene?.followVehicle(following && selected?.kind === 'vehicle' ? selected.vehicle.id : null); }}>{following ? 'Stop following' : 'Follow vehicle'} <span>↗</span></button>
            <p class="panel-note">{!scene ? 'Follow requires the 3D scene. ' : ''}Moving the camera cancels follow. Positions stop when reports stop.</p>
            <div class="route-context" data-route-status={routeLoading ? 'loading' : route?.status ?? 'unavailable'}><h4>Scheduled route context</h4><p class="panel-note">{routeLoading ? 'Checking the exact reported journey…' : routeError || route?.reason || (route?.status === 'exact' ? 'Verified journey shape and stops. The raw vehicle position is not snapped to this path.' : 'Journey mapping unavailable. No guessed path is drawn.')}</p>
              {#if route}<p class="route-match">Match: {route.status}</p>{/if}
              {#if route?.status === 'exact'}<dl class="properties"><div><dt>Trip</dt><dd>{route.tripId}</dd></div><div><dt>Departure</dt><dd>{formatDate(route.departureAt)}</dd></div><div><dt>Index prepared</dt><dd>{formatDate(route.generatedAt)}</dd></div><div><dt>GTFS retrieved</dt><dd>{formatDate(route.source?.retrievedAt)}</dd></div></dl><details><summary>{route.stops.length} scheduled stops in this area</summary><ol class="route-stop-list">{#each route.stops as stop (stop.sequence)}<li><strong>{stop.name}</strong><span>{formatDate(stop.arrivalAt ?? stop.departureAt)}</span></li>{/each}</ol></details>{/if}
            </div>
          {:else if selected?.kind === 'station'}
            <span class="eyebrow">{selected.station.kind === 'weather' ? 'WEATHER' : 'AIR QUALITY'} / STATION</span><h3>{selected.station.name}</h3>
            <label class="filter-label">Station parameter<select value={displayedStationParameter} onchange={event => stationParameter = event.currentTarget.value}>{#each selectedStationParameters as parameter (parameter.id)}<option value={parameter.id}>{parameter.label}</option>{/each}</select></label>
            <dl class="properties"><div><dt>Station ID</dt><dd>{selected.station.id}</dd></div><div><dt>Latest value</dt><dd>{stationLatest?.value ?? 'Unknown'} {stationLatest?.value !== null ? stationLatest?.unit ?? '' : ''}</dd></div><div><dt>Observed</dt><dd>{formatDate(stationLatest?.observedAt)}</dd></div><div><dt>Received</dt><dd>{formatDate(stationLatest?.receivedAt)}</dd></div><div><dt>Quality</dt><dd>{stationLatest?.quality ?? 'Unknown — not supplied'}</dd></div><div><dt>Aggregation</dt><dd>{stationLatest?.aggregation ?? 'Unknown — not supplied'}</dd></div><div><dt>Scope</dt><dd>Station observation</dd></div><div><dt>Coordinates</dt><dd>{selected.station.latitude.toFixed(5)}, {selected.station.longitude.toFixed(5)}</dd></div></dl>
            {#each selectedStationSources as source (source.id)}<p class="notice">{label(source.state)} · {source.message}</p><a class="source-link" href={source.url} target="_blank" rel="noreferrer">{source.provider} source reference ↗</a>{/each}
            {#key `${selected.station.id}/${displayedStationParameter}`}<StationHistory history={stationHistory} parameter={selectedStationParameters.find(parameter => parameter.id === displayedStationParameter)?.label ?? displayedStationParameter} hours={observationSnapshot?.historyHours ?? 6} />{/key}
          {:else}<div class="inspect-symbol" aria-hidden="true">⌖</div><h3>A city, with identity.</h3><p class="panel-note">Select a building, vehicle or station to inspect its identifiers and source times. Search offers the same selections by keyboard.</p><p class="panel-note">Drag to orbit · scroll to zoom</p>{/if}
          {#if selectionMessage}<p class="notice" role="status">{selectionMessage}</p>{/if}
        </div>
      </section>
      <section class="panel object-browser" id="object-browser" tabindex="-1"><div class="panel-heading"><h2>Search the city</h2><span>KEYBOARD</span></div>
        <div class="search-content"><label class="search-label">Vehicle, route, building, address or station<input type="search" bind:value={query} placeholder="Route 4, street or original ID" /></label><p class="panel-note" data-index-state={indexState}>{indexMessage}</p>{#if query}<button class="text-button" onclick={() => query = ''}>Clear search</button>{/if}</div>
        <details open><summary>Vehicles <span>{matchingVehicles.length}</span></summary><div class="object-list">{#each matchingVehicles.slice(0, 60) as vehicle (vehicle.id)}<button class:selected={selected?.kind === 'vehicle' && selected.vehicle.id === vehicle.id} onclick={() => selectObject({ kind: 'vehicle', vehicle })}><span class="mode-swatch" style:background={MODE_COLOURS[vehicle.mode]}></span><span><strong>{label(vehicle.mode)} · {routeName(vehicle.routeId)}</strong><small>{vehicle.ownerOperatorId}/{vehicle.vehicleId} · {trafficIsStale(vehicle, now) ? 'stale' : age(vehicle)}</small></span></button>{:else}<p class="panel-note">No matching current vehicles in visible modes / route.</p>{/each}{#if matchingVehicles.length > 60}<p class="panel-note">First 60 results. Refine your search.</p>{/if}</div></details>
        <details open={!!query}><summary>Routes <span>{matchingRoutes.length}</span></summary><div class="object-list">{#each matchingRoutes.slice(0, 60) as item (item.routeId)}<button onclick={() => chooseRoute(item.routeId)}><span class="mode-swatch" style:background={MODE_COLOURS[item.mode]}></span><span><strong>Route {item.label} · {label(item.mode)}</strong><small>{item.name} · {item.routeId}</small></span></button>{:else}<p class="panel-note">{routeCatalogLoading ? 'Loading prepared route labels…' : routeCatalog?.reason ?? 'No matching prepared route labels.'}</p>{/each}{#if matchingRoutes.length > 60}<p class="panel-note">First 60 routes. Refine your search.</p>{/if}</div></details>
        <details open={!!query}><summary>{query ? 'Matching buildings' : sceneError && !scene ? 'Available buildings' : 'Loaded buildings'} <span>{filteredBuildings.length}</span></summary><div class="object-list building-list">{#each filteredBuildings.slice(0, 60) as building (building.id)}<button class:selected={selected?.kind === 'building' && selected.building.id === building.id} onclick={() => selectObject({ kind: 'building', building })}><span><strong>{buildingName(building)}</strong><small>{building.vtjPrt ?? building.ratu ?? building.id}</small></span></button>{:else}<p class="panel-note">{query ? 'No matching prepared building or address.' : 'Buildings appear as the district loads.'}</p>{/each}{#if filteredBuildings.length > 60}<p class="panel-note">First 60 buildings. Refine your search.</p>{/if}</div></details>
        <details open><summary>Stations <span>{matchingStations.length}</span></summary><div class="object-list">{#each matchingStations as station (station.id)}<button class:selected={selected?.kind === 'station' && selected.station.id === station.id} onclick={() => selectObject({ kind: 'station', station })}><span class="station-swatch {station.kind}" aria-hidden="true">{station.kind === 'weather' ? '○' : '◇'}</span><span><strong>{station.name}</strong><small>{label(station.kind)} · {station.id}</small></span></button>{:else}<p class="panel-note">{observationLoading ? 'Loading stations…' : 'No matching stations in the available coverage / layers.'}</p>{/each}</div></details>
      </section>
    </aside>
    <nav class="camera-presets" aria-label="Camera presets"><span>VIEW</span>{#each [['city', 'City Centre'], ['harbour', 'Harbour'], ['suomenlinna', 'Suomenlinna'], ['energy', 'Energy']] as [id, name] (id)}<button class:active={preset === id} aria-pressed={preset === id} disabled={!scene} onclick={() => choosePreset(id as CameraPreset)}>{name}</button>{/each}</nav>
    <div class="scene-footer"><span>{hovered || 'Drag to orbit · scroll to zoom'}</span>{#if stats}<span class="performance" aria-label="Scene performance" data-fps={stats.fps} data-draw-calls={stats.drawCalls} data-geometries={stats.geometries} data-triangles={stats.triangles} data-loaded-chunks={stats.loadedChunks} data-placed-vehicles={stats.vehicles} data-unplaced-vehicles={stats.unplacedVehicles} data-receipt-latency-ms={stats.lastReceiptLatencyMs ?? ''}>{stats.fps} FPS · {stats.drawCalls} draws · {stats.loadedChunks} chunks</span>{/if}</div>
    {#if sceneError && ready}<p class="scene-error" role="status">{sceneError}</p>{/if}
    <nav class="mobile-panel-nav" aria-label="Mobile scene panels"><button aria-controls="scene-controls" aria-expanded={mobilePanel === 'controls'} onclick={() => setMobilePanel(mobilePanel === 'controls' ? null : 'controls')}>Layers & conditions</button><button aria-controls="identity-inspector" aria-expanded={mobilePanel === 'inspect'} onclick={() => setMobilePanel(mobilePanel === 'inspect' ? null : 'inspect')}>Inspect & search{selected ? ' •' : ''}</button><button onclick={() => setMobilePanel(null)} aria-pressed={mobilePanel === null}>Scene</button></nav>
  </main>
</div>
{#if sourceOpen}
  <dialog class="source-drawer" id="sources" aria-labelledby="sources-heading" use:showSources onclose={() => sourceOpen = false}><div class="drawer-heading"><div><span class="eyebrow">EVIDENCE & PROVENANCE</span><h2 id="sources-heading">Sources & status</h2></div><button class="icon-button" aria-label="Close sources" onclick={event => event.currentTarget.closest('dialog')?.close()}>×</button></div>
    <div class="drawer-content"><p class="panel-note">HSL positions are live reports. FMI weather and HSY air-quality values are dated station observations. Static building and terrain vintages are independent.</p><p class="panel-note">Juxtaposed weather and vehicle delay do not establish causation. A historical observation cursor does not replay traffic.</p>
      <h3>Environmental freshness & outages</h3>
      {#if observationLoading && !observationSnapshot}<p class="notice">Loading observations…</p>{/if}{#if observationError}<p class="notice">Unavailable refresh · {observationError}</p>{/if}
      {#each observationSnapshot?.sources ?? [] as source (source.id)}<details class="source-record" open><summary>{source.provider} · <span class="badge {source.state}">{source.state}</span></summary><p class="panel-note">{source.message}</p>{#if source.lastError}<p class="notice">Outage: {source.lastError}</p>{/if}<p class="panel-note">{source.attribution}</p><a href={source.url} target="_blank" rel="noreferrer">Source query reference ↗</a><dl class="properties"><div><dt>Observed</dt><dd>{formatDate(source.observedAt)}</dd></div><div><dt>Retrieved</dt><dd>{formatDate(source.retrievedAt)}</dd></div><div><dt>Metadata retrieved</dt><dd>{formatDate(source.metadataRetrievedAt)}</dd></div><div><dt>Last check</dt><dd>{formatDate(source.lastAttemptAt)}</dd></div><div><dt>Next eligible check</dt><dd>{formatDate(source.nextRefreshAt)}</dd></div><div><dt>Refresh check</dt><dd>{source.refreshMs / 60_000} min</dd></div><div><dt>Vintage / window</dt><dd>{source.vintage ?? 'Unknown'}</dd></div><div><dt>License</dt><dd>{source.license}</dd></div><div><dt>Coverage</dt><dd>{source.coverage}</dd></div><div><dt>Resolution</dt><dd>{source.resolution}</dd></div><div><dt>Units</dt><dd>{source.units.join(', ') || 'Unknown'}</dd></div><div><dt>Parameters</dt><dd>{source.parameters.join(', ')}</dd></div></dl><p class="panel-note">{source.method}</p>{#if source.requests?.length}<details><summary>Actual bounded source requests</summary>{#each source.requests as request, index (index)}<a href={request.url} target="_blank" rel="noreferrer">Request {index + 1} ↗</a><p class="panel-note">Retrieved {formatDate(request.retrievedAt)} · received {formatDate(request.receivedAt)}</p>{/each}</details>{/if}</details>{/each}
      <p class="panel-note">Weather refresh checks start at five minutes; air-quality checks at fifteen minutes. Provider publication cadence and per-parameter freshness differ. Refreshing never changes an observation time.</p>
      <h3>Traffic</h3><p class="panel-note">Browser stream: {currentFeed ? 'connected' : 'paused / disconnected'} · last upstream state: {traffic.status.state}. Last provider report {formatDate(traffic.status.lastPositionAt)}. {trafficError}</p><p class="panel-note">Motion buffer: 1.2 seconds of received reports. Stale after 30 seconds; removed after 120 seconds. Vehicle symbols ×{VEHICLE_DISPLAY_SCALE}; exact vehicle appearance is unknown.</p>
      <h3>Scheduled route data</h3><p class="panel-note">{routeCatalogLoading ? 'Loading route metadata…' : routeCatalog?.status === 'ready' ? `${routes.length} prepared routes available.` : routeCatalog?.reason ?? 'Route metadata unavailable.'}</p>{#if routeCatalog?.source}<a class="source-link" href={routeCatalog.source.url} target="_blank" rel="noreferrer">HSL GTFS source ↗</a><dl class="properties"><div><dt>Provider</dt><dd>Helsinki Region Transport (HSL)</dd></div><div><dt>Index prepared</dt><dd>{formatDate(routeCatalog.generatedAt)}</dd></div><div><dt>GTFS retrieved</dt><dd>{formatDate(routeCatalog.source.retrievedAt)}</dd></div><div><dt>Feed version</dt><dd>{routeCatalog.source.feedVersion ?? 'Unknown'}</dd></div><div><dt>Validity</dt><dd>{routeCatalog.source.validFrom}–{routeCatalog.source.validTo}</dd></div><div><dt>Archive SHA256</dt><dd>{routeCatalog.source.archiveSha256}</dd></div></dl><p class="panel-note">Only an exact active journey match supplies shape and stops. Missing or ambiguous matches show an explicit reason.</p>{/if}
      {#if sample.sampleError}<p class="notice">{sample.sampleError}</p>{/if}
      {#if city}<h3>City coverage</h3><p class="panel-note">{city.manifest.chunks.length} chunks · prepared {formatDate(city.manifest.generatedAt)}. {indexMessage} Buildings retain source dimensions. Sea surface is the N2000 0 m display datum, separate from live sea height.</p><p class="panel-note">Local origin: {city.manifest.origin.longitude}° E, {city.manifest.origin.latitude}° N. ETRS-GK25 / N2000 metres; scene axes east, elevation, −north.</p>{#each city.manifest.gaps as gap (gap)}<p class="notice">{gap}</p>{/each}{/if}
      <h3>Prepared source records</h3>{#each [...new Map([...(sample.manifest?.sources ?? []), ...(city?.manifest.sources ?? []), ...(energy.catalog?.sources ?? [])].filter(source => !source.id.startsWith('fmi-')).map(source => [source.id, source])).values()] as source (source.id)}<details class="source-record"><summary>{source.provider} · {label(source.id)}</summary><p class="panel-note">{source.attribution}</p>{#if /^https?:\/\//.test(source.url)}<a href={source.url} target="_blank" rel="noreferrer">Source reference ↗</a>{:else}<p class="panel-note">{source.url}</p>{/if}<dl class="properties"><div><dt>Retrieved</dt><dd>{formatDate(source.retrievedAt)}</dd></div><div><dt>Vintage</dt><dd>{source.vintage ?? 'Unknown'}</dd></div><div><dt>License</dt><dd>{source.license ?? 'Unverified'}</dd></div><div><dt>Checksum</dt><dd>{source.checksum ?? 'Unknown — not supplied'}</dd></div><div><dt>Coordinates</dt><dd>{source.coordinateReference ?? 'Not applicable / unknown'}<small>{source.axisOrder ?? 'Axis order unknown'} · {source.verticalReference ?? 'Vertical reference unknown'}</small></dd></div><div><dt>Coverage</dt><dd>{source.coverage}</dd></div><div><dt>Units</dt><dd>{source.units.join(', ') || 'Unknown'}</dd></div></dl><p class="panel-note">{source.method}</p></details>{/each}
      <h3>Energy catalog & join coverage</h3><p class="panel-note">{energyLoading ? 'Loading prepared catalog' : energy.status} · catalog prepared {formatDate(energy.catalog?.generatedAt)} · last refresh attempt {formatDate(energy.attemptedAt)}. {energy.message}</p><p class="panel-note">Energy months are historical property measurements. Demand and solar are source models, independent from live transit. Solar radiation is incident energy, not generated electricity; kW, kWh and kWh/m² are separate metrics.</p>
      {#each energy.catalog?.reports ?? [] as report (report.sourceId)}<details class="source-record"><summary>{report.sourceId} · {report.buildingsCovered.toLocaleString()} buildings covered</summary><p class="panel-note">{report.denominator} · vintage {report.sourceVintage ?? 'Unknown'}</p><dl class="properties"><div><dt>Source records</dt><dd>{report.totalSourceRecords.toLocaleString()}</dd></div><div><dt>Within scope</dt><dd>{report.recordsWithinScope.toLocaleString()}</dd></div><div><dt>Exact / reviewed</dt><dd>{report.exactMatches} / {report.reviewedMatches}</dd></div><div><dt>Unmatched</dt><dd>{report.unmatchedRecords}</dd></div><div><dt>Ambiguous / conflict</dt><dd>{report.ambiguousRecords} / {report.conflictingRecords}</dd></div></dl>{#each report.notes as note, index (index)}<p class="panel-note">{note}</p>{/each}</details>{/each}
      <h3>Foundation source probes · historical</h3><p class="panel-note">These probe gates were recorded {formatDate(sample.manifest?.generatedAt)}. Current modeled demand and solar coverage are the validated energy catalog and join reports above.</p>{#each Object.entries(sample.manifest?.gates ?? {}) as [name, gate] (name)}<details class="gate-row"><summary><span>{label(name)}</span><span class="badge {gate.status}">historical {gate.status}</span></summary>{#each gate.evidence as evidence, index (index)}<p class="panel-note">{evidence}</p>{/each}{#if gate.nextAction}<p class="notice">Next: {gate.nextAction}</p>{/if}</details>{/each}
      {#if stats}<p class="panel-note">Renderer: {stats.geometries} geometries · {stats.triangles.toLocaleString()} triangles · {stats.vehicles} placed vehicles.</p>{/if}
    </div>
  </dialog>
{/if}

<style>
  .theme-gradient { height: 8px; border-radius: 2px; margin: 10px 0 5px; }
  .theme-limits { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; margin-bottom: 8px; }
  .no-data-swatch { width: 10px; height: 10px; display: inline-block; margin-right: 5px; vertical-align: middle; border-radius: 2px; }
</style>
