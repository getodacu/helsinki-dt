<script lang="ts">
  import '#lib/city-console.css';
  import ConsoleIcon from '#lib/components/ConsoleIcon.svelte';
  import MarineVesselDetails from '#lib/components/MarineVesselDetails.svelte';
  import RailTrainDetails from '#lib/components/RailTrainDetails.svelte';
  import RailStationBoard from '#lib/components/RailStationBoard.svelte';
  import { RAIL_CATEGORIES, vehicleLabel, railJourneyUrl, type RailStation, type RailJourney, type RailResult } from '#lib/rail.ts';
  import { vehicleVisible } from '#lib/live-fleet.ts';
  import { onMount, tick } from 'svelte';
  import { browser } from '$app/env';
  import { createQuery, createQueries } from '@tanstack/svelte-query';
  import { fetchEntity } from '#lib/entity-query.ts';
  import type { EntityCatalog, EntityDetail, EntitySearch, EntityThemeValues } from '#lib/entity-types.ts';
  import CityScene from '#lib/components/CityScene.svelte';
  import NearbyConditions from '#lib/components/NearbyConditions.svelte';
  import BuildingRyhti from '#lib/components/BuildingRyhti.svelte';
  import BuildingPhoto from '#lib/components/BuildingPhoto.svelte';
  import { RYHTI_THEMES, RYHTI_DIM_COLOUR } from '#lib/ryhti-display.ts';
  import type { RyhtiCatalogState } from '#lib/ryhti-types.ts';
  import BuildingEnergy from '#lib/components/BuildingEnergy.svelte';
  import { ENERGY_COLOURS, NO_ENERGY_COLOUR, humanizeEnergyUsage } from '#lib/energy-display.ts';
  import type { EnergyCatalogState } from '#lib/energy-types.ts';
  import StationHistory from '#lib/components/StationHistory.svelte';
  import { loadCityManifest, loadCityBase, type CityManifest, type CityBase } from '#lib/city-assets.ts';
  import { CityAssetCache } from '#lib/city-cache.ts';
  import { INITIAL_LAYERS, type SceneLoadState, type Layers, type Selection, type SceneStation, type SceneStats, type CitySceneController, type CameraPreset } from '#lib/scene.ts';
  import { MODE_COLOURS } from '#lib/live-fleet.ts';
  import { trafficAge, trafficIsStale, trafficShouldRemove, type TrafficSnapshot, type TrafficEvent } from '#lib/traffic.ts';
  import { groupObservationStations, observationHistory, OBSERVATION_PARAMETERS, type ObservationSnapshot } from '#lib/observations.ts';
  import { loadRouteCatalog, routeRequestUrl, type RouteCatalog, type RouteContext } from '#lib/route-context.ts';
  import { buildingName, buildingAddress, buildingAttribute, knownValue, matchesVehicle, searchText, delayLabel, signedSeconds, formatDate, label, vehicleSourceLabel, marineSourceLabel } from '#lib/inspection.ts';
  import type { Building, TransitMode, Vehicle } from '#lib/types.ts';
  const consoleTools = [
    { id: 'explore', label: 'Explore' }, { id: 'transport', label: 'Transport' },
    { id: 'buildings', label: 'Buildings' }, { id: 'energy', label: 'Energy' },
    { id: 'environment', label: 'Environment' }
  ] as const;
  type ConsoleTool = typeof consoleTools[number]['id'] | 'help';
  const appearanceLayers = [
    { key: 'imagery', label: 'Aerial imagery' }, { key: 'buildings', label: 'Buildings' },
    { key: 'terrain', label: 'Land & islands' }, { key: 'roads', label: 'Roads & rail' }
  ] as const;
  let activeTool = $state<ConsoleTool>('explore');
  let buildingTab = $state<'overview' | 'details'>('overview');
  let themeKey = $state('');
  let city = $state.raw<{ manifest: CityManifest; base: CityBase; cache: CityAssetCache } | null>(null);
  let ryhtiCategoryKey = $state('');
  const changeTheme = (key: string) => { themeKey = key; ryhtiCategoryKey = ''; };
  let scene = $state.raw<CitySceneController | null>(null);
  let layers = $state<Layers>({ ...INITIAL_LAYERS, weather: true, airQuality: true });
  let keyboardNavigation = $state(true);
  let buildings = $state.raw<Building[]>([]);
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
  let searchOpen = $state(false);
  const closeSearch = () => { document.getElementById('city-search')?.focus(); searchOpen = false; };
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
  let railJourney = $state.raw<RailResult<RailJourney> | null>(null);
  let railStations = $state.raw<RailResult<RailStation[]> | null>(null);
  let railStationsError = $state('');
  let routeCatalog = $state.raw<RouteCatalog | null>(null);
  let routeCatalogLoading = $state(true);
  let mobilePanel = $state<'controls' | 'inspect' | null>(null);
  let stats = $state.raw<SceneStats | null>(null);
  let traffic = $state.raw<TrafficSnapshot>({ type: 'snapshot', generatedAt: new Date().toISOString(), vehicles: [],
    status: { state: 'idle', connectedAt: null, lastPositionAt: null, retryAt: null } });
  let browserConnected = $state(false);
  let loading = $state(true);
  const catalogQuery = createQuery(() => ({ queryKey: ['entity-catalog'],
    queryFn: ({ signal }) => fetchEntity<EntityCatalog>('/api/catalog/status', signal), refetchInterval: 30_000 }));
  let catalog = $derived.by(() => {
    const value = catalogQuery.data;
    if (!value || (city && value.cityGeneratedAt !== city.manifest.generatedAt)) return null;
    if (!catalogQuery.error) return value;
    const message = catalogQuery.error.message;
    return { ...value, status: 'stale' as const, message,
      energy: { ...value.energy, status: value.energy.catalog ? 'stale' as const : 'unavailable' as const, message },
      ryhti: { ...value.ryhti, status: value.ryhti.catalog ? 'stale' as const : 'unavailable' as const, message } };
  });
  let generation = $derived(catalog?.generation ?? '');
  let indexState = $derived(catalog ? catalog.status === 'stale' ? 'partial' : 'current' : catalogQuery.isPending ? 'loading' : 'unavailable');
  let indexMessage = $derived(catalog ? catalog.message ?? `${catalog.buildingCount.toLocaleString()} prepared building identities searchable on the server.`
    : catalogQuery.error?.message ?? (catalogQuery.data ? 'The city generation changed. Reload to use the current data.' : 'Loading searchable city coverage…'));
  let sample = $derived({ manifest: catalog?.foundation ?? null, sampleError: null });
  let energy = $derived<EnergyCatalogState>(catalog?.energy ?? { status: 'unavailable', catalog: null, message: indexMessage, attemptedAt: null });
  let ryhti = $derived<RyhtiCatalogState>(catalog?.ryhti ?? { status: 'unavailable', catalog: null, message: indexMessage, attemptedAt: null });
  let energyLoading = $derived(catalogQuery.isPending);
  let ryhtiLoading = $derived(catalogQuery.isPending);
  let themeOptions = $derived(catalog?.themes.flatMap(theme => theme.energy ? [theme.energy] : []) ?? []);
  let activeTheme = $derived(themeOptions.find(option => option.key === themeKey) ?? null);
  let activeRyhtiTheme = $derived(ryhti.catalog ? RYHTI_THEMES.find(option => option.key === themeKey) ?? null : null);
  let activeThemeSummary = $derived(catalog?.themes.find(theme => theme.key === themeKey));
  let debouncedQuery = $state('');
  $effect(() => {
    const value = query.trim();
    const timer = setTimeout(() => debouncedQuery = value, 200);
    return () => clearTimeout(timer);
  });
  let searchEnabled = $derived(!!generation && !!(debouncedQuery || (activeRyhtiTheme && ryhtiCategoryKey) || (sceneError && !scene)));
  let searchSignature = $derived(JSON.stringify([generation, debouncedQuery, activeRyhtiTheme?.key, ryhtiCategoryKey]));
  let pagination = $state<{ signature: string; cursors: (string | null)[] }>({ signature: '', cursors: [null] });
  let cursor = $derived(pagination.signature === searchSignature ? pagination.cursors.at(-1) ?? null : null);
  const searchQuery = createQuery(() => {
    const params = new URLSearchParams({ generation, q: debouncedQuery, kind: 'building', limit: '30' });
    if (activeRyhtiTheme && ryhtiCategoryKey) { params.set('theme', activeRyhtiTheme.key); params.set('category', ryhtiCategoryKey); }
    if (cursor) params.set('cursor', cursor);
    const version = generation;
    return { queryKey: ['entities', version, debouncedQuery, activeRyhtiTheme?.key ?? '', ryhtiCategoryKey, cursor],
      enabled: browser && searchEnabled, gcTime: browser ? 60_000 : Infinity,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchEntity<EntitySearch>(`/api/entities?${params}`, signal, version) };
  });
  let selectedBuildingId = $derived(selected?.kind === 'building' ? selected.building.id : '');
  const detailQuery = createQuery(() => {
    const version = generation, id = selectedBuildingId;
    return { queryKey: ['entity-detail', version, id], enabled: browser && !!version && !!id, staleTime: Infinity,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchEntity<EntityDetail>(`/api/entities/building/${encodeURIComponent(id)}?${new URLSearchParams({ generation: version })}`, signal, version) };
  });
  let detail = $derived(generation && detailQuery.data?.generation === generation && detailQuery.data.building.id === selectedBuildingId ? detailQuery.data : null);
  let detailEnergy = $derived<EnergyCatalogState>(detail ? { ...detail.energy, status: energy.status, message: energy.message, attemptedAt: energy.attemptedAt }
    : { status: 'unavailable', catalog: null, message: detailQuery.error?.message ?? null, attemptedAt: null });
  let detailRyhti = $derived<RyhtiCatalogState>(detail ? { ...detail.ryhti, status: ryhti.status, message: ryhti.message, attemptedAt: ryhti.attemptedAt }
    : { status: 'unavailable', catalog: null, message: detailQuery.error?.message ?? null, attemptedAt: null });
  let indexedBuildings = $derived([...new Map([...buildings, ...(detail?.members ?? [])].map(building => [building.id, building])).values()]);
  let filteredBuildings = $derived(searchEnabled ? searchQuery.data?.buildings ?? [] : buildings);
  // Stable manifest groups retain cached theme values when adjacent chunks enter or leave the view.
  let themeGroupKey = $derived.by(() => {
    if (!generation || !activeThemeSummary || !city || !layers.buildings) return '[]';
    const loaded = new Set(buildings.map(building => building.chunkRef));
    const chunks = city.manifest.chunks.map(chunk => chunk.id).sort();
    const groups: string[][] = [];
    for (let i = 0; i < chunks.length; i += 16) {
      const group = chunks.slice(i, i + 16);
      if (group.some(id => loaded.has(id))) groups.push(group);
    }
    return JSON.stringify(groups);
  });
  // Equal chunk sets must keep the same options: the adapter recreates its observer on changes.
  let themeGroups = $derived(JSON.parse(themeGroupKey) as string[][]);
  const themeQueries = createQueries(() => {
    const version = generation, key = themeKey;
    return { queries: themeGroups.map(chunks => ({ queryKey: ['entity-theme', version, key, chunks], enabled: browser,
      staleTime: Infinity, gcTime: browser ? 60_000 : Infinity,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchEntity<EntityThemeValues>(`/api/themes/${encodeURIComponent(key)}?${new URLSearchParams({ generation: version, chunks: chunks.join(',') })}`, signal, version) })),
      combine: results => ({ values: results.flatMap(result => result.data?.values ?? []),
        pending: results.some(result => result.isPending), error: results.find(result => result.error)?.error ?? null }) };
  });
  let themeColours = $derived(new Map(themeQueries.values.map(([id, colour, category]) => [id, activeRyhtiTheme && ryhtiCategoryKey && category !== ryhtiCategoryKey ? RYHTI_DIM_COLOUR : colour])));
  let ryhtiColors = $derived({ colours: themeColours, categories: activeThemeSummary?.categories ?? [] });
  let theme = $derived({ colours: themeColours, minimum: activeThemeSummary?.minimum ?? null,
    maximum: activeThemeSummary?.maximum ?? null, count: activeThemeSummary?.count ?? 0 });
  let mapCovered = $derived(loading || !ready);
  const modes: TransitMode[] = ['tram', 'bus', 'ferry', 'train', 'ship'];
  const modeNames: Record<TransitMode, string> = { tram: 'Trams', bus: 'Buses', ferry: 'HSL Ferries', train: 'Trains', ship: 'Ships' };
  const age = (vehicle: { reportedAt: string }) => `${Math.max(0, Math.floor(trafficAge(vehicle, now) / 1000))} s ago`;
  let releaseBuildingCount = $derived(catalog?.buildingCount ?? null);
  let routes = $derived(routeCatalog?.routes ?? []);
  const routeName = (id: string | null) => traffic.vehicles.find(vehicle => vehicle.routeId === id && vehicle.rail)?.rail?.label ?? routes.find(item => item.routeId === id)?.label ?? id ?? '';
  let availableVehicles = $derived(traffic.vehicles.filter(vehicle => !trafficShouldRemove(vehicle, now)));
  let visibleVehicles = $derived(availableVehicles.filter(vehicle => vehicleVisible(vehicle, layers, routeFilter || null))
    .sort((a, b) => a.mode.localeCompare(b.mode) || vehicleLabel(a, routeName(a.routeId)).localeCompare(vehicleLabel(b, routeName(b.routeId))) || a.id.localeCompare(b.id)));
  let matchingVehicles = $derived(visibleVehicles.filter(vehicle => !query || matchesVehicle(vehicle, query, routeName(vehicle.routeId))));
  let matchingRoutes = $derived(routes.filter(item => (!routeFilter || item.routeId === routeFilter) && layers[item.mode]
    && (!query || searchText(`${item.routeId} ${item.label} ${item.name}`).includes(searchText(query)))));
  let observationStations = $derived(observationSnapshot ? groupObservationStations(observationSnapshot) : []);
  let stations = $derived<SceneStation[]>([...observationStations.map(station => ({ id: station.id, name: station.name,
    longitude: station.longitude, latitude: station.latitude, kind: (station.sourceId === 'fmi-air-quality' ? 'air-quality' : 'weather') as SceneStation['kind'], sourceIds: [station.sourceId] })),
    ...(railStations?.data ?? []).map(station => ({ id: `rail:${station.code}`, name: station.name, longitude: station.longitude, latitude: station.latitude, kind: 'rail' as const, sourceIds: ['digitraffic'] }))]);
  let matchingStations = $derived(stations.filter(station => (station.kind !== 'rail' || layers.railStations)
    && (!query || searchText(`${station.id} ${station.name} ${station.id === 'rail:HKI' ? 'Helsinki Central' : ''}`).includes(searchText(query)))));
  let staleCount = $derived(visibleVehicles.filter(vehicle => trafficIsStale(vehicle, now)).length);
  let hslLive = $derived(browserConnected && traffic.status.state === 'live');
  let railLive = $derived(browserConnected && traffic.sources?.rail?.state === 'live');
  let marineSource = $derived(traffic.sources?.marine);
  let marineLive = $derived(browserConnected && marineSource?.state === 'live' && !marineSource.stale && !marineSource.periodic);
  let currentFeed = $derived(hslLive || railLive || marineLive);
  let liveFeeds = $derived([
    { name: 'HSL', live: hslLive, state: browserConnected ? label(traffic.status.state) : 'Paused / disconnected', lastAt: traffic.status.lastPositionAt, error: traffic.status.error },
    { name: 'Rail', live: railLive, state: browserConnected ? label(traffic.sources?.rail?.state ?? 'connecting') : 'Paused / disconnected', lastAt: traffic.sources?.rail?.lastPositionAt, error: traffic.sources?.rail?.error },
    { name: 'AIS', live: marineLive, state: browserConnected ? marineSourceLabel(marineSource) : 'Paused / disconnected', lastAt: marineSource?.lastPositionAt, error: [...new Set([marineSource?.error, marineSource?.positionError, marineSource?.metadataError].filter(Boolean))].join(' · ') }
  ]);
  let marineVehicles = $derived(availableVehicles.filter(vehicle => vehicle.mode === 'ship'));
  let freshMarine = $derived(marineVehicles.filter(vehicle => !trafficIsStale(vehicle, now)));
  let marineState = $derived(`${browserConnected ? '' : 'Browser paused / disconnected · '}${marineSourceLabel(marineSource)}`);
  let railVehicles = $derived(visibleVehicles.filter(vehicle => vehicle.mode === 'train'));
  let freshRail = $derived(railVehicles.filter(vehicle => !trafficIsStale(vehicle, now)));
  const currentRailDelay = (vehicle: Vehicle) => vehicle.rail?.timetableAt && now - Date.parse(vehicle.rail.timetableAt) < 60_000 && !vehicle.rail.timetableStale ? vehicle.delaySeconds : null;
  let railDelayed = $derived(freshRail.filter(vehicle => (currentRailDelay(vehicle) ?? 0) > 60).length);
  let railUnknown = $derived(freshRail.filter(vehicle => currentRailDelay(vehicle) === null).length);
  let selectedStation = $derived.by(() => { const selection = selected; return selection?.kind === 'station' ? observationStations.find(station => station.id === selection.station.id) : null; });
  let selectedStationParameters = $derived(OBSERVATION_PARAMETERS.filter(parameter => selectedStation?.parameters.includes(parameter.id)));
  let displayedStationParameter = $derived(selectedStationParameters.some(parameter => parameter.id === stationParameter) ? stationParameter : selectedStationParameters[0]?.id ?? stationParameter);
  let stationHistory = $derived(selected?.kind === 'station' && observationSnapshot ? observationHistory(observationSnapshot.observations, selected.station.id, displayedStationParameter) : []);
  let stationLatest = $derived(stationHistory.at(-1));
  let contextPosition = $derived(selected?.kind === 'vehicle' ? { longitude: selected.vehicle.longitude, latitude: selected.vehicle.latitude }
    : selected?.kind === 'building' ? selected.building : selected?.kind === 'station' ? selected.station : { longitude: 24.952, latitude: 60.1695 });
  let contextScope = $derived(selected?.kind === 'vehicle' ? 'Near the last reported vehicle position' : selected?.kind === 'building' ? 'Near this building' : selected?.kind === 'station' ? 'Near this station' : 'Near the city-centre view origin');
  let journeyUrl = $derived(selected?.kind === 'vehicle' ? selected.vehicle.mode === 'ship' ? null : selected.vehicle.rail ? railJourneyUrl(selected.vehicle.rail) : routeRequestUrl(selected.vehicle) : null);
  let selectedStationSources = $derived.by(() => { const selection = selected; return selection?.kind === 'station' ? observationSnapshot?.sources.filter(source => selection.station.sourceIds.includes(source.id)) ?? [] : []; });
  const identity = (value: Selection | null) => !value ? null : value.kind === 'vehicle' ? `v:${value.vehicle.id}` : value.kind === 'building' ? `b:${value.building.id}` : `s:${value.station.id}`;
  const focusInspector = () => void tick().then(() => {
    document.getElementById('identity-inspector')?.scrollTo({ top: 0 });
    document.getElementById('inspection-heading')?.focus({ preventScroll: true });
  });
  const setSelection = (selection: Selection | null, message = '') => {
    const changed = identity(selected) !== identity(selection);
    if (changed || (selection?.kind === 'vehicle' && selection.removed)) following = false;
    if (changed) {
      buildingTab = 'overview';
      if (selection) { mobilePanel = 'inspect'; searchOpen = false; focusInspector(); }
      else { if (mobilePanel === 'inspect') mobilePanel = null; closeSearch(); }
    }
    if (selection?.kind === 'vehicle' && selection.vehicle.mode === 'ship') { route = null; railJourney = null; routeError = ''; }
    selected = selection; selectionMessage = message;
  };
  const selectObject = (selection: Selection) => {
    if (scene && ready) scene.select(selection);
    else setSelection(selection, sceneError ? '3D rendering unavailable. Showing available source metadata.' : 'Map loading. Showing source metadata.');
    if (searchOpen && identity(selected) === identity(selection)) { searchOpen = false; mobilePanel = 'inspect'; focusInspector(); }
  };
  const clearSelection = () => { if (scene) scene.clearSelection(); else setSelection(null); };
  const setMobilePanel = (panel: typeof mobilePanel) => {
    const previous = mobilePanel;
    mobilePanel = panel;
    void tick().then(() => {
      const id = panel === 'controls' ? 'scene-controls' : panel === 'inspect' ? 'identity-inspector' : null;
      if (id) document.querySelector<HTMLButtonElement>(`#${id} .mobile-sheet-heading button`)?.focus();
      else Array.from(document.querySelectorAll<HTMLButtonElement>(`[aria-controls="${previous === 'controls' ? 'scene-controls' : 'identity-inspector'}"]`)).find(button => button.getClientRects().length)?.focus();
    });
  };
  const chooseTool = (tool: ConsoleTool) => {
    activeTool = tool;
    if (tool === 'explore') { setMobilePanel(null); return; }
    mobilePanel = 'controls';
    void tick().then(() => {
      document.getElementById('scene-controls')?.scrollTo({ top: 0 });
      document.getElementById('tool-heading')?.focus({ preventScroll: true });
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
    searchOpen = false;
    routeFilter = id;
    const vehicle = availableVehicles.find(vehicle => vehicle.routeId === id && layers[vehicle.mode]);
    if (vehicle) selectObject({ kind: 'vehicle', vehicle });
    else selectionMessage = 'No current vehicle report for this route. No journey shape can be inferred.';
  };
  const openSources = () => sourceOpen = true;
  $effect(() => {
    const url = journeyUrl;
    route = null; railJourney = null; routeError = ''; routeLoading = !!url;
    if (!url) return;
    const rail = url.startsWith('/api/rail/');
    let disposed = false, request: AbortController | null = null;
    async function refresh() {
      if (disposed || document.hidden || request) return;
      const attempt = new AbortController(); request = attempt;
      try {
        const response = await fetch(url!, { cache: 'no-store', signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(20_000)]) });
        if (!response.ok) throw new Error(`Journey context unavailable (${response.status})`);
        const value = await response.json();
        if (disposed || attempt.signal.aborted) return;
        if (rail) { railJourney = value; route = value.route; } else route = value;
        routeError = '';
      } catch (error) { if (!disposed && !attempt.signal.aborted) routeError = error instanceof Error ? error.message : 'Journey context unavailable'; }
      finally { if (request === attempt) request = null; if (!disposed) routeLoading = false; }
    }
    const visibility = () => { if (document.hidden) { request?.abort(); request = null; } else void refresh(); };
    void refresh(); const timer = rail ? setInterval(() => void refresh(), 30_000) : null;
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; request?.abort(); if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
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
      traffic = { type: 'snapshot', generatedAt: event.generatedAt, vehicles: [...fleet.values()], status: event.status, sources: event.sources };
      if (!scene && selected?.kind === 'vehicle') {
        const vehicle = fleet.get(selected.vehicle.id);
        setSelection({ kind: 'vehicle', vehicle: vehicle ?? selected.vehicle, removed: !vehicle || trafficShouldRemove(vehicle, now) });
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
    const resumeObservations = () => { if (!document.hidden) { void refreshObservations(); void refreshRailStations(); } };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('visibilitychange', resumeObservations);
    const clock = setInterval(() => { if (!document.hidden) now = Date.now(); }, 1000);
    const observationsCheck = setInterval(() => void refreshObservations(), 5 * 60_000);
    async function refreshRailStations() {
      if (disposed || document.hidden) return;
      try {
        const response = await fetch('/api/rail/stations', { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]) });
        if (!response.ok) throw new Error('Railway stations unavailable');
        const value = await response.json() as RailResult<RailStation[]>;
        if (value.data !== null && !Array.isArray(value.data)) throw new Error('Invalid rail station catalog');
        if (!disposed) { railStations = value; railStationsError = value.error ?? ''; }
      } catch (error) { if (!disposed) railStationsError = error instanceof Error ? error.message : 'Railway stations unavailable'; }
    }
    const railStationsTimer = setInterval(() => void refreshRailStations(), 5 * 60_000);
    void connect(); void refreshObservations(); void refreshRailStations();
    void loadRouteCatalog(fetch).then(value => { if (!disposed) routeCatalog = value; }).catch(error => { if (!disposed) routeCatalog = { status: 'unavailable', generatedAt: null, source: null, routes: [], reason: error instanceof Error ? error.message : 'Route labels unavailable' }; }).finally(() => { if (!disposed) routeCatalogLoading = false; });
    const cache = new CityAssetCache();
    void loadCityManifest(fetch, lifetime.signal).then(async manifest => {
      const base = await loadCityBase(manifest, fetch, lifetime.signal, cache);
      if (disposed) return; city = { manifest, base, cache };
    }).catch(error => { if (!disposed) sceneError = error instanceof Error ? error.message : 'City assets unavailable'; })
      .finally(() => { if (!disposed) loading = false; });
    return () => { disposed = true; cache.dispose(); lifetime.abort(); request?.abort(); observationRequest?.abort(); stream?.close(); clearInterval(clock); clearInterval(observationsCheck); clearInterval(railStationsTimer); document.removeEventListener('visibilitychange', visibility); document.removeEventListener('visibilitychange', resumeObservations); };
  });
</script>

<svelte:head><title>Helsinki Lens · City Console</title><meta name="description" content="Inspect central Helsinki buildings, live HSL, rail and AIS ship reports and dated environmental station observations." /></svelte:head>
<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !sourceOpen && !document.getElementById('live-feed-status')?.matches(':popover-open')) { if (searchOpen) { event.preventDefault(); closeSearch(); } else { clearSelection(); if (mobilePanel) setMobilePanel(null); } } }} onpointerdown={event => { if (searchOpen && event.target instanceof Element && !event.target.closest('.navbar-search')) searchOpen = false; }} />
<a class="skip-link" href="#city-search">Skip to city search</a>
<div class="app-shell city-console">
  <header class="masthead">
    <a class="brand" href="/" aria-label="Helsinki Lens home"><span class="brand-symbol" aria-hidden="true">▥</span><span class="brand-name">HELSINKI <em>LENS</em><small>CITY CONSOLE</small></span></a>
    <search class="navbar-search" aria-label="City search" onfocusout={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) searchOpen = false; }}>
      <input id="city-search" type="search" bind:value={query} placeholder="Find a building, route or station…" aria-label="Vehicle, route, building, address or station" aria-controls="city-search-results" onfocus={() => searchOpen = true} onclick={() => searchOpen = true} oninput={() => searchOpen = true} />
      {#if searchOpen}
        <div class="panel object-browser search-results" id="city-search-results">
          <div class="panel-heading"><h2>Search results</h2><button class="icon-button" aria-label="Close search results" onclick={closeSearch}>×</button></div>
          {#if indexState !== 'current'}<p class="panel-note search-status" role="status" data-index-state={indexState}>{indexState === 'loading' ? 'Loading buildings…' : indexMessage}</p>{/if}{#if searchEnabled && searchQuery.isFetching}<p class="panel-note search-status" role="status">Searching…</p>{/if}{#if searchEnabled && searchQuery.error}<p class="notice search-status" role="status">{searchQuery.error.message}</p>{/if}
          {#if query}<button class="text-button clear-search" onclick={() => { query = ''; document.getElementById('city-search')?.focus(); }}>Clear search</button>{/if}
        <details open><summary>Vehicle reports <span>{matchingVehicles.length}</span></summary><div class="object-list">{#each matchingVehicles.slice(0, 60) as vehicle (vehicle.id)}<button class:selected={selected?.kind === 'vehicle' && selected.vehicle.id === vehicle.id} onclick={() => selectObject({ kind: 'vehicle', vehicle })}><span class="mode-swatch" style:background={MODE_COLOURS[vehicle.mode]}></span><span><strong>{label(vehicle.mode)} · {vehicleLabel(vehicle, routeName(vehicle.routeId))}</strong><small>{vehicleSourceLabel(vehicle)} · {vehicle.marine ? `MMSI ${vehicle.marine.mmsi}` : vehicle.rail ? `${vehicle.rail.trainNumber} · ${vehicle.rail.destination ?? 'Destination unavailable'}` : `${vehicle.ownerOperatorId}/${vehicle.vehicleId}`} · {trafficIsStale(vehicle, now) ? `stale · ${age(vehicle)}` : age(vehicle)}</small></span></button>{:else}<p class="panel-note">No matching retained vehicle reports in visible modes / transit route.</p>{/each}{#if matchingVehicles.length > 60}<p class="panel-note">First 60 results. Refine your search.</p>{/if}</div></details>
        <details open={!!query}><summary>Routes <span>{matchingRoutes.length}</span></summary><div class="object-list">{#each matchingRoutes.slice(0, 60) as item (item.routeId)}<button onclick={() => chooseRoute(item.routeId)}><span class="mode-swatch" style:background={MODE_COLOURS[item.mode]}></span><span><strong>Route {item.label} · {label(item.mode)}</strong><small>{item.name} · {item.routeId}</small></span></button>{:else}<p class="panel-note">{routeCatalogLoading ? 'Loading prepared route labels…' : routeCatalog?.reason ?? 'No matching prepared route labels.'}</p>{/each}{#if matchingRoutes.length > 60}<p class="panel-note">First 60 routes. Refine your search.</p>{/if}</div></details>
        <details open={!!query || !!(activeRyhtiTheme && ryhtiCategoryKey)}><summary>{query || (activeRyhtiTheme && ryhtiCategoryKey) ? 'Matching buildings' : sceneError && !scene ? 'Available buildings' : 'Loaded buildings'} <span>{filteredBuildings.length}</span></summary><div class="object-list building-list">{#each filteredBuildings.slice(0, 60) as building (building.id)}<button class:selected={selected?.kind === 'building' && selected.building.id === building.id} onclick={() => selectObject({ kind: 'building', building })}><span><strong>{buildingName(building)}</strong>{#if buildingAddress(building) && buildingAddress(building) !== buildingName(building)}<small>{buildingAddress(building)}</small>{/if}</span></button>{:else}<p class="panel-note">{query || (activeRyhtiTheme && ryhtiCategoryKey) ? 'No matching prepared building or address.' : 'Buildings appear as the district loads.'}</p>{/each}{#if filteredBuildings.length > 60}<p class="panel-note">First 60 buildings. Refine your search.</p>{/if}{#if searchEnabled}<div class="search-pagination"><button class="text-button" disabled={!cursor || searchQuery.isFetching} onclick={() => pagination = { signature: searchSignature, cursors: pagination.cursors.slice(0, -1) }}>Previous</button><button class="text-button" disabled={!searchQuery.data?.nextCursor || searchQuery.isFetching} onclick={() => pagination = { signature: searchSignature, cursors: [...(pagination.signature === searchSignature ? pagination.cursors : [null]), searchQuery.data!.nextCursor] }}>Next buildings</button></div>{/if}</div></details>
        <details open><summary>Stations <span>{matchingStations.length}</span></summary><div class="object-list">{#each matchingStations as station (station.id)}<button class:selected={selected?.kind === 'station' && selected.station.id === station.id} onclick={() => selectObject({ kind: 'station', station })}><span class="station-swatch {station.kind}" aria-hidden="true">{station.kind === 'weather' ? '○' : station.kind === 'rail' ? '▣' : '◇'}</span><span><strong>{station.name}</strong><small>{label(station.kind)} · {station.id}</small></span></button>{:else}<p class="panel-note">{observationLoading ? 'Loading stations…' : 'No matching stations in the available coverage / layers.'}</p>{/each}</div></details>
        </div>
      {/if}
    </search>
    <button class="live-feed-button" popovertarget="live-feed-status" aria-label="Show live feed status" aria-haspopup="dialog" title={currentFeed ? 'Live feeds connected' : 'Live feeds connecting or paused'}><span class:connected={currentFeed} class="status-dot" aria-hidden="true"></span></button>
    <div class="live-feed-popover" id="live-feed-status" popover="auto" role="dialog" aria-labelledby="live-feed-heading">
      <h2 id="live-feed-heading">Live feeds</h2>
      {#each liveFeeds as feed (feed.name)}<div class="live-feed-row"><strong><span class:connected={feed.live} class="status-dot" aria-hidden="true"></span>{feed.name}</strong><span>{feed.state}</span><small>Last report: {feed.lastAt ? formatDate(feed.lastAt) : 'No report yet'}</small>{#if feed.error}<p>{feed.error}</p>{/if}</div>{/each}
      {#if trafficError}<p class="panel-note">{trafficError}</p>{/if}
    </div>
    <button class="console-help" aria-label="Help using the city" onclick={() => chooseTool('help')}>?</button>
    <button class="source-button" onclick={() => sourceOpen = !sourceOpen} aria-expanded={sourceOpen} aria-controls="sources">Data & sources ↗</button>
  </header>
  <main class="city-workspace" data-scene-ready={!mapCovered} aria-busy={mapCovered}>
    {#if city}
      <CityScene manifest={city.manifest} base={city.base} cache={city.cache} onloadstate={value => mapLoad = value} {traffic} {layers} marinePaused={!browserConnected} {keyboardNavigation} {stations} {route} {routes} routeFilter={routeFilter || null} buildingColours={activeRyhtiTheme ? ryhtiColors.colours : theme.colours} buildingTheme={!!activeTheme || !!activeRyhtiTheme} onappearance={value => appearanceStatus = value} onselection={setSelection}
        onbuildings={(value) => buildings = value} onstats={(value) => stats = value} onhover={(value) => hovered = value}
        onerror={(value) => sceneError = value} oninteraction={() => following = false} onready={() => { ready = true; if (selected) scene?.select(selected); }}
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
          {#if sceneError && !scene}<p>Use search and Sources &amp; status for available data.</p>{/if}
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
    {#if city?.manifest.gaps.length}<button class="coverage-notice" onclick={openSources}>Building coverage incomplete <span>View evidence ↗</span></button>{/if}
    <nav class="map-appearance" aria-label="Map appearance">
      {#each appearanceLayers as layer (layer.key)}<button aria-label={layer.label} title={layer.label} aria-pressed={layers[layer.key]} onclick={() => layers[layer.key] = !layers[layer.key]}><ConsoleIcon name={layer.key} /></button>{/each}
    </nav>
    {#if layers.imagery && appearanceStatus}<div class="appearance-status" role="status">{appearanceStatus}</div>{/if}
    <nav class="console-toolbox panel" aria-label="City tools">
      <div class="panel-heading"><h2>City tools</h2><span aria-hidden="true">▥</span></div>
      <div class="console-tool-grid">{#each consoleTools as tool (tool.id)}
        <button aria-pressed={activeTool === tool.id} aria-controls="scene-controls" onclick={() => chooseTool(tool.id)}><ConsoleIcon name={tool.id} /><span>{tool.label}</span></button>
      {/each}</div>
    </nav>
    <aside class="left-stack" class:mobile-active={mobilePanel === 'controls'} id="scene-controls" aria-label="Scene controls and conditions">
      <div class="mobile-sheet-heading"><strong>{activeTool === 'help' ? 'Help' : consoleTools.find(tool => tool.id === activeTool)?.label}</strong><button class="icon-button" aria-label="Close controls sheet" onclick={() => setMobilePanel(null)}>×</button></div>
      {#if activeTheme || activeRyhtiTheme}<button class="console-active-theme" onclick={() => chooseTool(activeTheme ? 'energy' : 'buildings')}>Building colors on <span>↗</span></button>{/if}
      {#if activeTool !== 'explore'}
      <section class="panel layers-panel">
        <div class="panel-heading"><h2 id="tool-heading" tabindex="-1"><ConsoleIcon name={activeTool} />{activeTool === 'transport' ? 'Transport' : activeTool === 'buildings' ? 'Buildings' : activeTool === 'energy' ? 'Energy & solar' : activeTool === 'environment' ? 'Environment' : 'Getting around'}</h2><span aria-hidden="true">▤</span></div>
        <div class="layer-list">
          {#if activeTool === 'transport'}
          {#each modes as mode (mode)}<label class="layer-control"><input type="checkbox" aria-label={modeNames[mode]} bind:checked={layers[mode]} /><span class="mode-swatch" style:background={MODE_COLOURS[mode]}></span><span class="mode-label">{modeNames[mode]}</span><small aria-label={`${availableVehicles.filter(vehicle => vehicle.mode === mode).length} reports`}>{availableVehicles.filter(vehicle => vehicle.mode === mode).length}</small></label>{/each}
          <label class="layer-control"><input type="checkbox" bind:checked={layers.railStations} /><span class="station-swatch rail" aria-hidden="true">▣</span><span>Rail stations</span></label>
          {#if layers.train}<details class="rail-filters"><summary>Train categories</summary>{#each RAIL_CATEGORIES as category (category)}<label class="layer-control"><input type="checkbox" bind:checked={layers[category]} /><span>{label(category)}</span></label>{/each}</details>{/if}
          <div class="rail-summary"><strong>Rail · {railLive ? 'connected' : traffic.sources?.rail?.state ?? 'connecting'}</strong><span>{freshRail.length} fresh · {railVehicles.length - freshRail.length} stale</span><span>{railDelayed} delayed · {railUnknown} delay unknown</span></div>
          {#if traffic.sources?.rail?.error}<p class="notice">{traffic.sources.rail.error}</p>{/if}
          {#if railStationsError}<p class="panel-note">{railStationsError}</p>{/if}
          <div class="rail-summary marine-summary"><strong>Ships · {marineState}</strong><span>{freshMarine.length} fresh reports · {marineVehicles.length - freshMarine.length} stale reports</span>{#if !marineVehicles.length}<span>No retained reports in this coverage; this does not establish that no ships are present.</span>{/if}</div>
          {#if marineSource?.error}<p class="notice">{marineSource.error}</p>{/if}
          <label class="filter-label">Transit route filter<select bind:value={routeFilter}><option value="">All received routes</option>{#each [...new Set(availableVehicles.flatMap(vehicle => vehicle.routeId === null ? [] : [vehicle.routeId]))].sort() as id (id)}<option value={id}>{routeName(id)} · {id}</option>{/each}</select></label>
          {#if routeFilter}<button class="text-button" onclick={() => routeFilter = ''}>Clear route filter</button>{/if}
          <p class="panel-note">Transit models use real-world scale. Ship markers are schematic; banners identify their sources. Counts are reports, with possible HSL / AIS overlap.</p>

          {:else if activeTool === 'buildings' || activeTool === 'energy'}
            <p class="panel-note console-intro">{activeTool === 'buildings' ? 'Select a building for its address, use and register details. Use colors to explore patterns across the city.' : 'Explore estimated demand and solar potential. Select a building for available measurements and model records.'}</p>
          {#if themeQueries.pending}<p class="notice" role="status">Loading colors for the current view…</p>{/if}
          {#if themeQueries.error}<p class="notice" role="status">{themeQueries.error.message}</p>{/if}
          <div class="building-theme" data-building-theme={activeRyhtiTheme ? 'ryhti' : activeTheme?.kind ?? 'neutral'}>
            <label class="filter-label">Color buildings by<select value={activeRyhtiTheme?.key ?? activeTheme?.key ?? ''} onchange={event => changeTheme(event.currentTarget.value)}><option value="">{layers.imagery ? 'Textured buildings' : 'Neutral buildings'}</option>{#each ['modeled-demand', 'solar'] as kind (kind)}<optgroup label={kind === 'modeled-demand' ? 'Modeled demand' : 'Modeled solar potential'}>{#each themeOptions.filter(option => option.kind === kind) as option (option.key)}<option value={option.key}>{label(option.metric)} · {option.unit} · {option.period}{option.scenario ? ` · ${option.scenario}` : ''}</option>{/each}</optgroup>{/each}<optgroup label="Ryhti register">{#each RYHTI_THEMES as option (option.key)}<option value={option.key} disabled={!ryhti.catalog}>{option.label}</option>{/each}</optgroup></select></label>
            {#if activeRyhtiTheme}
              <p class="panel-note">{activeRyhtiTheme.label} · Syke / Ryhti · prepared {formatDate(ryhti.catalog?.generatedAt)}. Select a category to highlight it and narrow building search; other buildings remain pickable.</p>
              <div class="ryhti-legend" aria-label="Ryhti categories">
                <button class="text-button" aria-pressed={!ryhtiCategoryKey} onclick={() => ryhtiCategoryKey = ''}>All categories · {ryhti.catalog?.coverage.totalBuildings}</button>
                {#each ryhtiColors.categories as category (category.key)}<button class="text-button" aria-pressed={ryhtiCategoryKey === category.key} onclick={() => ryhtiCategoryKey = ryhtiCategoryKey === category.key ? '' : category.key}><span class="no-data-swatch" style:background={category.colour}></span>{category.label} · {category.count}</button>{/each}
              </div>
              {#if activeRyhtiTheme.key === 'ryhti:permits'}<p class="panel-note">All linked records, including historical permits. Multiple statuses means records report different statuses; this is not a live construction map.</p>{/if}
            {:else if activeTheme}
              <p class="panel-note">{label(activeTheme.metric)} · {activeTheme.unit}<br />{activeTheme.kind === 'solar' ? 'Modeled solar potential' : 'Modeled building demand'} · {activeTheme.period}{activeTheme.scenario ? ` · ${activeTheme.scenario}` : ''}<br />Source: {activeTheme.sourceId}</p>
              {#if theme.minimum !== null && theme.maximum !== null}{@const minimum = humanizeEnergyUsage(theme.minimum, activeTheme.unit)}{@const maximum = humanizeEnergyUsage(theme.maximum, activeTheme.unit)}<div class="theme-gradient" style:background={`linear-gradient(to right, ${ENERGY_COLOURS[0]} 0% 33.333%, ${ENERGY_COLOURS[1]} 33.333% 66.666%, ${ENERGY_COLOURS[2]} 66.666% 100%)`} aria-hidden="true"></div><div class="theme-limits"><span>{minimum.value} {minimum.unit}</span><span>{maximum.value} {maximum.unit}</span></div><p class="panel-note">{theme.minimum === theme.maximum ? 'One value; middle color.' : 'Three equal ranges from the displayed minimum to maximum.'}</p>{/if}
              <p class="panel-note" data-theme-covered={theme.count} data-theme-denominator={releaseBuildingCount ?? ''}>{theme.count.toLocaleString()} colored / {releaseBuildingCount?.toLocaleString() ?? 'unknown'} prepared release buildings. Shared property totals and ambiguous associations excluded.</p>
              <p class="panel-note"><span class="no-data-swatch" style:background={NO_ENERGY_COLOUR}></span> Neutral = no comparable record. {theme.count ? '' : 'No comparable values in this dataset selection.'}</p>
            {/if}
            {#if energyLoading}<p class="notice" role="status">Loading available energy themes…</p>{:else if energy.status !== 'ready'}<p class="notice">{energy.status === 'stale' ? 'Dated catalog retained' : 'Energy catalog unavailable'} · {energy.message}</p>{/if}
          </div>
          <p class="panel-note" role="status">Ryhti: {ryhtiLoading ? 'loading coverage' : ryhti.status}. {ryhti.message ?? ''}</p>

          {:else if activeTool === 'environment'}
            <label class="layer-control"><input type="checkbox" bind:checked={layers.weather} /><span>Weather stations</span></label>
            <label class="layer-control"><input type="checkbox" bind:checked={layers.airQuality} /><span>Air-quality stations</span></label>
          <fieldset class="parameter-controls"><legend>Show nearby readings</legend>{#each OBSERVATION_PARAMETERS as parameter (parameter.id)}<label><input type="checkbox" value={parameter.id} bind:group={enabledParameters} />{parameter.label}</label>{/each}</fieldset>

          {:else}
            <dl class="console-instructions"><div><dt>Look around</dt><dd>Drag to orbit. Scroll or pinch to zoom.</dd></div><div><dt>Move across the city</dt><dd>Use W, A, S and D, or right-drag. On a touch screen, drag with two fingers.</dd></div><div><dt>Inspect a place</dt><dd>Select a building, vehicle or station. Escape closes your selection.</dd></div><div><dt>Find something</dt><dd>Search an address, route, vehicle or station above.</dd></div></dl>
            <label class="layer-control"><input type="checkbox" bind:checked={keyboardNavigation} /><span>WASD navigation</span></label>
            <button class="follow-button" disabled={!scene} onclick={() => choosePreset('city')}>Return to City Centre <span>↗</span></button>
            <button class="text-button" onclick={openSources}>About the data & sources ↗</button>
          {/if}
        </div>
      </section>
      {/if}
      {#if activeTool === 'environment'}
      <section class="panel conditions"><div class="panel-heading"><h2>Nearby conditions</h2><span>STATION CONTEXT</span></div>
        <div class="condition-source-states">{#each observationSnapshot?.sources ?? [] as source (source.id)}<button onclick={openSources}><span>{source.id === 'fmi-weather' ? 'Weather' : 'Air quality'}</span><span class="badge {source.state}">{source.state}</span></button>{/each}</div>
        <NearbyConditions snapshot={observationSnapshot} longitude={contextPosition.longitude} latitude={contextPosition.latitude} parameters={enabledParameters} {now} loading={observationLoading} error={observationError} scope={contextScope} onsources={openSources} onstation={selectStation} />
      </section>
      {/if}
      {#if activeTool === 'transport'}
      <section class="panel feed-panel" aria-label="Traffic status"><div class="panel-heading"><h2>Reported traffic</h2><span class:connected={currentFeed} class="status-dot"></span></div>
        <div class="feed-summary"><strong>{visibleVehicles.length}</strong><span>reports in visible modes / transit route<br />{staleCount ? `${staleCount} stale · held at last position` : 'Latest received positions'}</span></div>
        <p class="panel-note">{trafficError || (traffic.status.lastPositionAt ? `Last report ${formatDate(traffic.status.lastPositionAt)}` : 'Waiting for real position reports.')}</p>
        {#if stats?.unplacedVehicles}<p class="panel-note">{stats.unplacedVehicles} ground vehicles omitted where terrain height is unknown.</p>{/if}
      </section>
      {/if}
    </aside>
    <aside class="right-stack" class:mobile-active={!!selected && mobilePanel === 'inspect'} id="identity-inspector" aria-label="Inspector">
      <div class="mobile-sheet-heading"><strong>Inspect</strong><button class="icon-button" aria-label="Close inspector sheet" onclick={() => setMobilePanel(null)}>×</button></div>
      {#if selected}
      <section class="panel inspector"><div class="panel-heading"><h2 id="inspection-heading" tabindex="-1"><ConsoleIcon name={selected.kind === 'building' ? 'buildings' : selected.kind === 'vehicle' || selected.station.kind === 'rail' ? 'transport' : 'environment'} />{selected.kind === 'building' ? 'Building' : selected.kind === 'vehicle' ? 'Vehicle information' : selected.station.kind === 'rail' ? 'Station departures' : 'Station observations'}</h2><button class="icon-button" aria-label="Clear selection" onclick={() => clearSelection()}>×</button></div>
        {#if selected.kind === 'building'}
          {#key selected.building.id}<BuildingPhoto building={selected.building} {generation} base={city?.base} cache={city?.cache} />{/key}
        {/if}
        <div class="panel-content">
          {#if selected?.kind === 'building'}
            <h3>{buildingName(selected.building)}</h3>
            {#if selected.unloaded}<p class="notice">Outside the current map view.</p>{/if}
            <nav class="console-inspector-tabs" aria-label="Building information">
              {#each ['overview', 'details'] as tab (tab)}<button aria-pressed={buildingTab === tab} onclick={() => buildingTab = tab as typeof buildingTab}>{tab === 'overview' ? 'Overview' : 'Details'}</button>{/each}
            </nav>
            <div hidden={buildingTab !== 'overview'}>
            <dl class="properties">
              {#each [
                ['Address', buildingAddress(selected.building)],
                ['Built', buildingAttribute(selected.building, ['yearOfConstruction', 'rakennusvuosi'])],
                ['Floors', buildingAttribute(selected.building, ['storeysAboveGround', 'kerrosluku'])],
                ['Use', buildingAttribute(selected.building, ['usage', 'function', 'kayttotarkoitus'])]
              ].filter(([, value]) => knownValue(value)) as [name, value] (name)}
                <div><dt>{name}</dt><dd>{value}</dd></div>
              {/each}
            </dl>
            {#key selected.building.id}<BuildingEnergy building={selected.building} catalogState={detailEnergy} loadingCatalog={detailQuery.isFetching} buildings={indexedBuildings} onmember={id => { const member = indexedBuildings.find(building => building.id === id); if (member) selectObject({ kind: 'building', building: member }); }} />{/key}
            </div>
            <div hidden={buildingTab !== 'details'}>
              <BuildingRyhti entry={detailRyhti.catalog?.buildings[0]} state={detailRyhti} loading={detailQuery.isFetching} />
              <details class="console-source-details"><summary>Source identifiers</summary><dl class="properties">
                {#each [['Building ID', selected.building.id], ['CityGML ID', selected.building.gmlId], ['VTJ-PRT', selected.building.vtjPrt], ['RATU', selected.building.ratu], ['Source', selected.building.sourceId]].filter(([, value]) => knownValue(value)) as [name, value] (name)}<div><dt>{name}</dt><dd>{value}</dd></div>{/each}
              </dl></details>
              <button class="text-button" onclick={openSources}>Data coverage & sources ↗</button>
            </div>
          {:else if selected?.kind === 'vehicle'}
            {#if selected.vehicle.mode === 'ship'}
              <MarineVesselDetails vehicle={selected.vehicle} source={marineSource} connected={browserConnected} {now} removed={selected.removed} />
            {:else if selected.vehicle.rail}
              <RailTrainDetails vehicle={selected.vehicle} journey={railJourney} {now} removed={selected.removed} loading={routeLoading} error={routeError} />
            {:else}
            <span class="eyebrow">HSL / {selected.vehicle.mode.toUpperCase()}</span><h3>Route {route?.status === 'exact' ? route.routeLabel ?? routeName(selected.vehicle.routeId) : routeName(selected.vehicle.routeId)}</h3>
            {#if selected.removed || trafficShouldRemove(selected.vehicle, now)}<p class="notice">This vehicle has left the current feed or its position expired. Its last reported identity remains here.</p>{:else if trafficIsStale(selected.vehicle, now)}<p class="notice">Stale position. Held at its last received coordinates.</p>{/if}
            <dl class="properties"><div><dt>Mode</dt><dd>{label(selected.vehicle.mode)}</dd></div><div><dt>Route ID</dt><dd>{selected.vehicle.routeId}</dd></div><div><dt>Direction</dt><dd>{selected.vehicle.directionId === null ? 'Unknown' : `HFP ${selected.vehicle.directionId}`}</dd></div><div><dt>Destination</dt><dd>{route?.status === 'exact' ? route.destination ?? 'Unknown — not supplied' : 'Unknown — journey not verified'}</dd></div><div><dt>Owner / vehicle</dt><dd>{selected.vehicle.ownerOperatorId} / {selected.vehicle.vehicleId}</dd></div><div><dt>Schedule</dt><dd class:late={(selected.vehicle.delaySeconds ?? 0) > 60} class:early={(selected.vehicle.delaySeconds ?? 0) < -60}>{delayLabel(selected.vehicle.delaySeconds)}</dd></div><div><dt>Speed</dt><dd>{selected.vehicle.speedMetresPerSecond === null ? 'Unknown' : `${(selected.vehicle.speedMetresPerSecond * 3.6).toFixed(1)} km/h`}</dd></div><div><dt>Reported</dt><dd>{formatDate(selected.vehicle.reportedAt)}<small>{age(selected.vehicle)}</small></dd></div><div><dt>Received</dt><dd>{formatDate(selected.vehicle.receivedAt)}</dd></div><div><dt>Feed / position</dt><dd>{currentFeed ? 'Browser connected' : 'Browser paused / disconnected'} · {selected.removed ? 'expired' : trafficIsStale(selected.vehicle, now) ? 'stale' : 'current'}</dd></div></dl>
            <p class="panel-note">±60 seconds is an application display convention for “on time”. Exact signed deviation remains below.</p>
            <details class="vehicle-details"><summary>Exact report & journey details</summary><dl class="properties"><div><dt>Raw HFP deviation</dt><dd>{signedSeconds(selected.vehicle.rawDeviationSeconds)}<small>Negative means late in HFP.</small></dd></div><div><dt>Normalized delay</dt><dd>{signedSeconds(selected.vehicle.delaySeconds)}<small>{selected.vehicle.delaySeconds === null ? 'Unknown' : selected.vehicle.delaySeconds > 0 ? 'Positive = late' : selected.vehicle.delaySeconds < 0 ? 'Negative = early' : 'Exact zero'}</small></dd></div><div><dt>Journey</dt><dd>{selected.vehicle.journeyReference ?? 'Unknown'}</dd></div><div><dt>Service date</dt><dd>{selected.vehicle.serviceDate ?? 'Unknown'}</dd></div><div><dt>Start time</dt><dd>{selected.vehicle.startTime ?? 'Unknown'}</dd></div><div><dt>Operating operator</dt><dd>{selected.vehicle.operatingOperatorId ?? 'Unknown'}</dd></div><div><dt>Quality flags</dt><dd>{selected.vehicle.quality.join(', ') || 'No flags supplied'}</dd></div><div><dt>Position</dt><dd>{selected.vehicle.latitude?.toFixed(5) ?? 'Unknown'}, {selected.vehicle.longitude?.toFixed(5) ?? 'Unknown'}</dd></div></dl></details>
            {/if}
            <button class="follow-button" disabled={!scene || selected.removed || trafficIsStale(selected.vehicle, now)} onclick={() => { following = !following; scene?.followVehicle(following && selected?.kind === 'vehicle' ? selected.vehicle.id : null); }}>{following ? 'Stop following' : selected.vehicle.mode === 'ship' ? 'Follow ship' : selected.vehicle.mode === 'train' ? 'Follow train' : 'Follow vehicle'} <span>↗</span></button>
            <p class="panel-note">{!scene ? 'Follow requires the 3D scene. ' : ''}Moving the camera cancels follow. Positions stop when reports stop.</p>
            {#if selected.vehicle.mode !== 'ship'}<div class="route-context" data-route-status={routeLoading ? 'loading' : route?.status ?? 'unavailable'}><h4>Scheduled route context</h4><p class="panel-note">{routeLoading ? 'Checking the exact reported journey…' : routeError || route?.reason || (route?.status === 'exact' ? 'Verified journey shape and stops. The raw vehicle position is not snapped to this path.' : 'Journey mapping unavailable. No guessed path is drawn.')}</p>
              {#if route}<p class="route-match">Match: {route.status}</p>{/if}
              {#if route?.status === 'exact'}<dl class="properties"><div><dt>Trip</dt><dd>{route.tripId}</dd></div><div><dt>Departure</dt><dd>{formatDate(route.departureAt)}</dd></div><div><dt>Index prepared</dt><dd>{formatDate(route.generatedAt)}</dd></div><div><dt>GTFS retrieved</dt><dd>{formatDate(route.source?.retrievedAt)}</dd></div></dl><details><summary>{route.stops.length} scheduled stops in this area</summary><ol class="route-stop-list">{#each route.stops as stop (stop.sequence)}<li><strong>{stop.name}</strong><span>{formatDate(stop.arrivalAt ?? stop.departureAt)}</span></li>{/each}</ol></details>{/if}
            </div>{/if}
          {:else if selected?.kind === 'station' && selected.station.kind === 'rail'}
            <RailStationBoard station={selected.station} vehicles={availableVehicles} ontrain={(vehicle: Vehicle) => { layers.train = true; layers[vehicle.rail?.category ?? 'other'] = true; routeFilter = ''; selectObject({ kind: 'vehicle', vehicle }); }} />
          {:else if selected?.kind === 'station'}
            <span class="eyebrow">{selected.station.kind === 'weather' ? 'WEATHER' : 'AIR QUALITY'} / STATION</span><h3>{selected.station.name}</h3>
            <label class="filter-label">Station parameter<select value={displayedStationParameter} onchange={event => stationParameter = event.currentTarget.value}>{#each selectedStationParameters as parameter (parameter.id)}<option value={parameter.id}>{parameter.label}</option>{/each}</select></label>
            <dl class="properties"><div><dt>Station ID</dt><dd>{selected.station.id}</dd></div><div><dt>Latest value</dt><dd>{stationLatest?.value ?? 'Unknown'} {stationLatest?.value !== null ? stationLatest?.unit ?? '' : ''}</dd></div><div><dt>Observed</dt><dd>{formatDate(stationLatest?.observedAt)}</dd></div><div><dt>Received</dt><dd>{formatDate(stationLatest?.receivedAt)}</dd></div><div><dt>Quality</dt><dd>{stationLatest?.quality ?? 'Unknown — not supplied'}</dd></div><div><dt>Aggregation</dt><dd>{stationLatest?.aggregation ?? 'Unknown — not supplied'}</dd></div><div><dt>Scope</dt><dd>Station observation</dd></div><div><dt>Coordinates</dt><dd>{selected.station.latitude.toFixed(5)}, {selected.station.longitude.toFixed(5)}</dd></div></dl>
            {#each selectedStationSources as source (source.id)}<p class="notice">{label(source.state)} · {source.message}</p><a class="source-link" href={source.url} target="_blank" rel="noreferrer">{source.provider} source reference ↗</a>{/each}
            {#key `${selected.station.id}/${displayedStationParameter}`}<StationHistory history={stationHistory} parameter={selectedStationParameters.find(parameter => parameter.id === displayedStationParameter)?.label ?? displayedStationParameter} hours={observationSnapshot?.historyHours ?? 6} />{/key}
          {/if}
          {#if selectionMessage}<p class="notice" role="status">{selectionMessage}</p>{/if}
        </div>
      </section>
      {/if}
    </aside>
    <nav class="camera-presets" aria-label="Camera presets"><span>GO TO</span>{#each [['city', 'City Centre'], ['harbour', 'Harbour'], ['central', 'Central Station']] as [id, name] (id)}<button class:active={preset === id} aria-pressed={preset === id} disabled={!scene} onclick={() => choosePreset(id as CameraPreset)}>{name}</button>{/each}</nav>
    <div class="scene-footer"><span>{hovered || (keyboardNavigation ? 'WASD to pan · drag to orbit · scroll to zoom' : 'Drag to orbit · scroll to zoom')}</span>{#if stats}<span class="performance" aria-label="Scene performance" data-fps={stats.fps} data-draw-calls={stats.drawCalls} data-geometries={stats.geometries} data-triangles={stats.triangles} data-loaded-chunks={stats.loadedChunks} data-placed-vehicles={stats.vehicles} data-unplaced-vehicles={stats.unplacedVehicles} data-receipt-latency-ms={stats.lastReceiptLatencyMs ?? ''}>{stats.fps} FPS · {stats.drawCalls} draws · {stats.loadedChunks} chunks</span>{/if}</div>
    {#if sceneError && ready}<p class="scene-error" role="status">{sceneError}</p>{/if}
    <nav class="mobile-panel-nav" aria-label="Mobile city tools">{#each consoleTools as tool (tool.id)}<button aria-controls="scene-controls" aria-expanded={mobilePanel === 'controls' && activeTool === tool.id} onclick={() => mobilePanel === 'controls' && activeTool === tool.id ? setMobilePanel(null) : chooseTool(tool.id)}><ConsoleIcon name={tool.id} /><span>{tool.label === 'Environment' ? 'Weather' : tool.label}</span></button>{/each}<button disabled={!selected} aria-controls="identity-inspector" aria-expanded={mobilePanel === 'inspect'} onclick={() => setMobilePanel(mobilePanel === 'inspect' ? null : 'inspect')}><ConsoleIcon name="inspect" /><span>Inspect{selected ? ' •' : ''}</span></button></nav>
  </main>
</div>
{#if sourceOpen}
  <dialog class="source-drawer" id="sources" aria-labelledby="sources-heading" use:showSources onclose={() => sourceOpen = false}><div class="drawer-heading"><div><span class="eyebrow">EVIDENCE & PROVENANCE</span><h2 id="sources-heading">Sources & status</h2></div><button class="icon-button" aria-label="Close sources" onclick={event => event.currentTarget.closest('dialog')?.close()}>×</button></div>
    <div class="drawer-content"><p class="panel-note">HSL and Fintraffic positions are live reports. FMI weather and HSY air-quality values are dated station observations. Static building and terrain vintages are independent.</p><p class="panel-note">Juxtaposed weather and vehicle delay do not establish causation. A historical observation cursor does not replay traffic.</p>
      <h3>Environmental freshness & outages</h3>
      {#if observationLoading && !observationSnapshot}<p class="notice">Loading observations…</p>{/if}{#if observationError}<p class="notice">Unavailable refresh · {observationError}</p>{/if}
      {#each observationSnapshot?.sources ?? [] as source (source.id)}<details class="source-record" open><summary>{source.provider} · <span class="badge {source.state}">{source.state}</span></summary><p class="panel-note">{source.message}</p>{#if source.lastError}<p class="notice">Outage: {source.lastError}</p>{/if}<p class="panel-note">{source.attribution}</p><a href={source.url} target="_blank" rel="noreferrer">Source query reference ↗</a><dl class="properties"><div><dt>Observed</dt><dd>{formatDate(source.observedAt)}</dd></div><div><dt>Retrieved</dt><dd>{formatDate(source.retrievedAt)}</dd></div><div><dt>Metadata retrieved</dt><dd>{formatDate(source.metadataRetrievedAt)}</dd></div><div><dt>Last check</dt><dd>{formatDate(source.lastAttemptAt)}</dd></div><div><dt>Next eligible check</dt><dd>{formatDate(source.nextRefreshAt)}</dd></div><div><dt>Refresh check</dt><dd>{source.refreshMs / 60_000} min</dd></div><div><dt>Vintage / window</dt><dd>{source.vintage ?? 'Unknown'}</dd></div><div><dt>License</dt><dd>{source.license}</dd></div><div><dt>Coverage</dt><dd>{source.coverage}</dd></div><div><dt>Resolution</dt><dd>{source.resolution}</dd></div><div><dt>Units</dt><dd>{source.units.join(', ') || 'Unknown'}</dd></div><div><dt>Parameters</dt><dd>{source.parameters.join(', ')}</dd></div></dl><p class="panel-note">{source.method}</p>{#if source.requests?.length}<details><summary>Actual bounded source requests</summary>{#each source.requests as request, index (index)}<a href={request.url} target="_blank" rel="noreferrer">Request {index + 1} ↗</a><p class="panel-note">Retrieved {formatDate(request.retrievedAt)} · received {formatDate(request.receivedAt)}</p>{/each}</details>{/if}</details>{/each}
      <p class="panel-note">Weather refresh checks start at five minutes; air-quality checks at fifteen minutes. Provider publication cadence and per-parameter freshness differ. Refreshing never changes an observation time.</p>
      <h3>Rail traffic · Fintraffic Digitraffic</h3><p class="panel-note">Positions: {railLive ? 'connected' : traffic.sources?.rail?.state ?? 'connecting'} · last report {formatDate(traffic.sources?.rail?.lastPositionAt)}. {traffic.sources?.rail?.error ?? ''}</p><p class="panel-note">Position checks every five seconds; timetables every 30 seconds. Train display buffers 12 seconds of received reports. Stale at 30 seconds; removed at 120 seconds. Representative two-car model; approximate terrain height. GPS coverage is incomplete, including freight and yard operations.</p><p class="panel-note">Station catalog: {railStations?.state ?? 'loading'} · checked {formatDate(railStations?.retrievedAt)}. {railStationsError}</p><a href="https://www.digitraffic.fi/en/railway-traffic/" target="_blank" rel="noreferrer">Fintraffic railway data · CC BY 4.0 ↗</a>
      <h3>Ships · Fintraffic Digitraffic</h3><p class="panel-note">{marineState} · last local position report {formatDate(marineSource?.lastPositionAt)}. Last source update {formatDate(marineSource?.feedUpdatedAt)}. {marineSource?.positionError ?? marineSource?.error ?? ''}</p><p class="panel-note">Ship display delays received reports by 10 seconds to smooth movement. Reduced motion and interrupted feeds show the latest accepted position. Positions stop when reports stop. Moving or unknown-status reports become stale after 2 minutes and leave the scene after 10 minutes. At anchor or moored with low reported speed: stale after 10 minutes, removed after 30 minutes.</p><p class="panel-note">Partial Class A AIS coverage; fishing vessels are filtered upstream. Helsinki coverage excludes Vuosaari. An empty list is not evidence of an empty harbour. HSL ferries and AIS identities remain separate and can overlap; counts describe reports. Markers are schematic at the sea display datum.</p><p class="panel-note">Marine data: Fintraffic / Digitraffic, CC BY 4.0. Filtered to Helsinki; positions interpolated for display.</p><a href="https://www.digitraffic.fi/en/marine-traffic/" target="_blank" rel="noreferrer">Fintraffic marine data ↗</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0 ↗</a>
      <h3>HSL traffic</h3><p class="panel-note">Browser stream: {hslLive ? 'connected' : 'paused / disconnected'} · last upstream state: {traffic.status.state}. Last provider report {formatDate(traffic.status.lastPositionAt)}. {trafficError}</p><p class="panel-note">Motion buffer: 1.2 seconds of received reports. Stale after 30 seconds; removed after 120 seconds. Representative Blender models use real-world scale. Exact fleet variants are not supplied by HSL; route flags use prepared line labels.</p>
      <h3>Scheduled route data</h3><p class="panel-note">{routeCatalogLoading ? 'Loading route metadata…' : routeCatalog?.status === 'ready' ? `${routes.length} prepared routes available.` : routeCatalog?.reason ?? 'Route metadata unavailable.'}</p>{#if routeCatalog?.source}<a class="source-link" href={routeCatalog.source.url} target="_blank" rel="noreferrer">HSL GTFS source ↗</a><dl class="properties"><div><dt>Provider</dt><dd>Helsinki Region Transport (HSL)</dd></div><div><dt>Index prepared</dt><dd>{formatDate(routeCatalog.generatedAt)}</dd></div><div><dt>GTFS retrieved</dt><dd>{formatDate(routeCatalog.source.retrievedAt)}</dd></div><div><dt>Feed version</dt><dd>{routeCatalog.source.feedVersion ?? 'Unknown'}</dd></div><div><dt>Validity</dt><dd>{routeCatalog.source.validFrom}–{routeCatalog.source.validTo}</dd></div><div><dt>Archive SHA256</dt><dd>{routeCatalog.source.archiveSha256}</dd></div></dl><p class="panel-note">Only an exact active journey match supplies shape and stops. Missing or ambiguous matches show an explicit reason.</p>{/if}
      {#if sample.sampleError}<p class="notice">{sample.sampleError}</p>{/if}
      {#if city}<h3>City coverage</h3><p class="panel-note">{city.manifest.chunks.length} chunks · prepared {formatDate(city.manifest.generatedAt)}. {indexMessage} Buildings retain source dimensions. Sea surface is the N2000 0 m display datum, separate from live sea height.</p><p class="panel-note">Local origin: {city.manifest.origin.longitude}° E, {city.manifest.origin.latitude}° N. ETRS-GK25 / N2000 metres; scene axes east, elevation, −north.</p>{#each city.manifest.gaps as gap (gap)}<p class="notice">{gap}</p>{/each}{/if}
      <h3>City imagery & textures</h3><p class="panel-note">Helsinki orthophoto 2025 · textured LoD2 buildings. © City of Helsinki · CC BY 4.0.</p><a class="source-link" href="https://kartta.hel.fi/3d/" target="_blank" rel="noreferrer">Helsinki 3D source reference ↗</a>
      <h3>Prepared source records</h3>{#each [...new Map([...(sample.manifest?.sources ?? []), ...(city?.manifest.sources ?? []), ...(energy.catalog?.sources ?? []), ...(ryhti.catalog?.sources ?? [])].filter(source => !source.id.startsWith('fmi-')).map(source => [source.id, source])).values()] as source (source.id)}<details class="source-record"><summary>{source.provider} · {label(source.id)}</summary><p class="panel-note">{source.attribution}</p>{#if /^https?:\/\//.test(source.url)}<a href={source.url} target="_blank" rel="noreferrer">Source reference ↗</a>{:else}<p class="panel-note">{source.url}</p>{/if}<dl class="properties"><div><dt>Retrieved</dt><dd>{formatDate(source.retrievedAt)}</dd></div><div><dt>Vintage</dt><dd>{source.vintage ?? 'Unknown'}</dd></div><div><dt>License</dt><dd>{source.license ?? 'Unverified'}</dd></div><div><dt>Checksum</dt><dd>{source.checksum ?? 'Unknown — not supplied'}</dd></div><div><dt>Coordinates</dt><dd>{source.coordinateReference ?? 'Not applicable / unknown'}<small>{source.axisOrder ?? 'Axis order unknown'} · {source.verticalReference ?? 'Vertical reference unknown'}</small></dd></div><div><dt>Coverage</dt><dd>{source.coverage}</dd></div><div><dt>Units</dt><dd>{source.units.join(', ') || 'Unknown'}</dd></div></dl><p class="panel-note">{source.method}</p></details>{/each}
      <h3>Ryhti register & join coverage</h3><p class="panel-note">{ryhtiLoading ? 'Loading prepared catalog' : ryhti.status} · snapshot prepared {formatDate(ryhti.catalog?.generatedAt)} · last attempt {formatDate(ryhti.attemptedAt)}. {ryhti.message ?? ''}</p>
      {#if ryhti.catalog}<dl class="properties">{#each Object.entries(ryhti.catalog.coverage) as [key, value] (key)}<div><dt>{label(key)}</dt><dd>{value.toLocaleString()}</dd></div>{/each}</dl><p class="panel-note">Exact identifier joins only. Missing values and unresolved identities remain unclassified. Permit records include historical work. Source retrieval and modification dates describe this prepared snapshot, not live activity.</p>{/if}
      <h3>Energy catalog & join coverage</h3><p class="panel-note">{energyLoading ? 'Loading prepared catalog' : energy.status} · catalog prepared {formatDate(energy.catalog?.generatedAt)} · last refresh attempt {formatDate(energy.attemptedAt)}. {energy.message}</p><p class="panel-note">Energy months are historical property measurements. Demand and solar are source models, independent from live transit. Solar radiation is incident energy, not generated electricity; kW, kWh and kWh/m² are separate metrics.</p>
      {#each energy.catalog?.reports ?? [] as report (report.sourceId)}<details class="source-record"><summary>{report.sourceId} · {report.buildingsCovered.toLocaleString()} buildings covered</summary><p class="panel-note">{report.denominator} · vintage {report.sourceVintage ?? 'Unknown'}</p><dl class="properties"><div><dt>Source records</dt><dd>{report.totalSourceRecords.toLocaleString()}</dd></div><div><dt>Within scope</dt><dd>{report.recordsWithinScope.toLocaleString()}</dd></div><div><dt>Exact / reviewed</dt><dd>{report.exactMatches} / {report.reviewedMatches}</dd></div><div><dt>Unmatched</dt><dd>{report.unmatchedRecords}</dd></div><div><dt>Ambiguous / conflict</dt><dd>{report.ambiguousRecords} / {report.conflictingRecords}</dd></div></dl>{#each report.notes as note, index (index)}<p class="panel-note">{note}</p>{/each}</details>{/each}
      <h3>Foundation source probes · historical</h3><p class="panel-note">These probe gates were recorded {formatDate(sample.manifest?.generatedAt)}. Current modeled demand and solar coverage are the validated energy catalog and join reports above.</p>{#each Object.entries(sample.manifest?.gates ?? {}) as [name, gate] (name)}<details class="gate-row"><summary><span>{label(name)}</span><span class="badge {gate.status}">historical {gate.status}</span></summary>{#each gate.evidence as evidence, index (index)}<p class="panel-note">{evidence}</p>{/each}{#if gate.nextAction}<p class="notice">Next: {gate.nextAction}</p>{/if}</details>{/each}
      {#if stats}<p class="panel-note">Renderer: {stats.geometries} geometries · {stats.triangles.toLocaleString()} triangles · {stats.vehicles} placed vehicles.</p>{/if}
    </div>
  </dialog>
{/if}

<style>
  .rail-summary { display: grid; gap: 4px; margin: 9px 0; padding: 10px; border-left: 3px solid #b29bd8; background: #b29bd810; font-size: 11px; }
  .marine-summary { border-color: #79cbd7; background: #79cbd710; }
  .rail-summary strong { color: #d2bdf4; }
  .marine-summary strong { color: #9be1e9; }
  .rail-filters { margin: 5px 0; }
  .ryhti-legend { display: grid; gap: 0.3rem; }
  .ryhti-legend button { text-align: left; padding: 0.4rem; }
  .ryhti-legend button[aria-pressed="true"] { outline: 2px solid currentColor; outline-offset: -2px; }
  .theme-gradient { height: 8px; border-radius: 2px; margin: 10px 0 5px; }
  .theme-limits { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; margin-bottom: 8px; }
  .no-data-swatch { width: 10px; height: 10px; display: inline-block; margin-right: 5px; vertical-align: middle; border-radius: 2px; }
</style>
