<script lang="ts">
  import '#lib/city-console.css';
  import ConsoleIcon from '#lib/components/ConsoleIcon.svelte';
  import SensorReadings from '#lib/components/SensorReadings.svelte';
  import VehicleModelPreview from '#lib/components/VehicleModelPreview.svelte';
  import MarineVesselDetails from '#lib/components/MarineVesselDetails.svelte';
  import RailTrainDetails from '#lib/components/RailTrainDetails.svelte';
  import VehicleItinerary from '#lib/components/VehicleItinerary.svelte';
  import { buildItinerary } from '#lib/itinerary.ts';
  import RailStationBoard from '#lib/components/RailStationBoard.svelte';
  import { RAIL_CATEGORIES, vehicleLabel, railJourneyUrl, type RailStation, type RailJourney, type RailResult } from '#lib/rail.ts';
  import { vehicleVisible } from '#lib/live-fleet.ts';
  import { stationVisible } from '#lib/station-flags.ts';
  import { onMount, tick } from 'svelte';
  import { browser } from '$app/env';
  import { createQuery, createQueries } from '@tanstack/svelte-query';
  import { fetchEntity } from '#lib/entity-query.ts';
  import type { EntityCatalog, EntityDetail, EntitySearch, EntityThemeValues } from '#lib/entity-types.ts';
  import CityScene from '#lib/components/CityScene.svelte';
  import BuildingRyhti from '#lib/components/BuildingRyhti.svelte';
  import BuildingPhoto from '#lib/components/BuildingPhoto.svelte';
  import WebcamModal from '#lib/components/WebcamModal.svelte';
  import PortCameraModal from '#lib/components/PortCameraModal.svelte';
  import type { PortHarbour } from '#lib/port-cameras.ts';
  import type { Webcam } from '#lib/webcams.ts';
  import { RYHTI_THEMES, RYHTI_DIM_COLOUR } from '#lib/ryhti-display.ts';
  import type { RyhtiCatalogState } from '#lib/ryhti-types.ts';
  import BuildingEnergy from '#lib/components/BuildingEnergy.svelte';
  import { ENERGY_COLOURS, NO_ENERGY_COLOUR, humanizeEnergyUsage, closestHeatDemandTheme } from '#lib/energy-display.ts';
  import type { EnergyCatalogState } from '#lib/energy-types.ts';
  import StationHistory from '#lib/components/StationHistory.svelte';
  import { loadCityManifest, loadCityBase, type CityManifest, type CityBase } from '#lib/city-assets.ts';
  import { CityAssetCache } from '#lib/city-cache.ts';
  import { INITIAL_LAYERS, type SceneLoadState, type Layers, type Selection, type SceneStation, type SceneStats, type CitySceneController, type CameraPreset } from '#lib/scene.ts';
  import { MODE_COLOURS } from '#lib/live-fleet.ts';
  import { trafficAge, trafficIsStale, trafficShouldRemove, type TrafficSnapshot, type TrafficEvent } from '#lib/traffic.ts';
  import { groupObservationStations, observationHistory, OBSERVATION_PARAMETERS, type ObservationSnapshot } from '#lib/observations.ts';
  import { loadRouteCatalog, routeRequestUrl, type RouteCatalog, type RouteContext } from '#lib/route-context.ts';
  import { buildingName, buildingAddress, buildingAttribute, knownValue, matchesVehicle, searchText, hslSchedule, signedSeconds, formatDate, label, vehicleSourceLabel, marineSourceLabel } from '#lib/inspection.ts';
  import type { Building, TransitMode, Vehicle } from '#lib/types.ts';
  const appearanceLayers = [
    { key: 'imagery', label: 'Aerial imagery' }, { key: 'buildings', label: '3D buildings' },
    { key: 'terrain', label: 'Land & islands' }, { key: 'roads', label: 'Roads & rail' }
  ] as const;
  let buildingTab = $state<'overview' | 'details'>('overview');
  let themeKey = $state('');
  let city = $state.raw<{ manifest: CityManifest; base: CityBase; cache: CityAssetCache } | null>(null);
  let selectedRyhtiCategories = $state<string[]>([]);
  const changeTheme = (key: string) => {
    themeKey = themeKey === key ? '' : key;
    if (themeKey) layers.buildings = true;
    selectedRyhtiCategories = catalog?.themes.find(theme => theme.key === themeKey)?.categories.map(category => category.key) ?? [];
  };
  let scene = $state.raw<CitySceneController | null>(null);
  let layers = $state<Layers>({ ...INITIAL_LAYERS, weather: true, airQuality: true });
  let keyboardNavigation = $state(true);
  let buildings = $state.raw<Building[]>([]);
  let selected = $state.raw<Selection | null>(null);
  let activeWebcam = $state.raw<Webcam | null>(null);
  let activePortHarbour = $state.raw<PortHarbour | null>(null);
  let selectionMessage = $state('');
  let hovered = $state('');
  let sceneError = $state('');
  let appearanceStatus = $state('');
  let trafficError = $state('');
  let ready = $state(false);
  let mapLoad = $state.raw<SceneLoadState>({ phase: 'discovering', completed: 0, total: 0, failed: 0, cacheIssue: '', background: { phase: 'idle', completed: 0, total: 0, failed: 0 } });
  let sourceOpen = $state(false);
  let informationSection = $state<'data' | 'about' | 'collaboration'>('data');
  const informationSections = [
    { key: 'data', label: 'Data & Sources' },
    { key: 'about', label: 'About this project' },
    { key: 'collaboration', label: 'Open for collaboration' }
  ] as const;
  const potentialSources = [
    { name: 'Allu street works & public-space permits',
      url: 'https://kartta.hel.fi/paikkatietohakemisto/pth/?id=28',
      description: 'Excavations, temporary traffic arrangements, events and leased public areas.',
      limitation: 'Dated permit areas do not establish whether a street is currently blocked.' },
    { name: 'City-bike availability',
      url: 'https://digitransit.fi/en/developers/apis/1-routing-api/bicycles-scooters-cars/',
      description: 'Stations, available bikes and return spaces for the last part of a journey.',
      limitation: 'Digitransit API access requires a key. Rental services are seasonal.' },
    { name: 'Service Map & accessibility',
      url: 'https://kaupunkialustana.hel.fi/ohjeet-2/tpr-rajapinnat/',
      description: 'Schools, libraries, public services, entrances and reported accessibility.',
      limitation: 'Accessibility information and links to building identifiers vary by service.' },
    { name: 'Planning & zoning',
      url: 'https://hri.fi/data/en_GB/dataset/helsingin-kaavayksikot',
      description: 'Valid plan units, land-use categories, boundaries and planning references.',
      limitation: 'Generalized open-data categories need the authoritative planning material for decisions.' },
    { name: 'Traffic noise zones',
      url: 'https://kartta.hel.fi/paikkatietohakemisto/pth/?id=33',
      description: 'Modeled road and rail noise exposure for comparing streets and areas.',
      limitation: 'Study-period estimates, not live sound measurements; retain the study year and noise metric.' },
    { name: 'Coastal flood hazard',
      url: 'https://luontotieto.syke.fi/en/aineisto/tulvavaaravyohykkeet-perusskenaariot-flood-hazard-zones-basic-scenarios-2/',
      description: 'Modeled flood probability and depth zones around the waterfront.',
      limitation: 'Scenario maps are not live forecasts or building-level assessments. Sustained API use needs a SYKE application identifier.' },
    { name: 'Walking, cycling & vehicle counters',
      url: 'https://hri.fi/data/en/dataset/helsingin-liikennemittausten-tilastorajapinta',
      description: 'Measured activity and historical patterns at instrumented streets.',
      limitation: 'Sparse sensor locations cannot describe activity across the whole city. Access and freshness need verification.' },
    { name: 'Linked Events',
      url: 'https://www.hel.fi/en/business-and-work/helsinki-tourism-and-event-data',
      description: 'Time-filtered events and their venues alongside transport and city context.',
      limitation: 'Event listings do not measure attendance or crowding. Read-access limits need verification.' },
    { name: 'Paavo population & area profiles',
      url: 'https://stat.fi/en/services/statistical-data-services/statistical-databases/paavo',
      description: 'Postal-code statistics for population, housing, income and workplaces.',
      limitation: 'Annual area aggregates, not building or person records; changing postal boundaries affect comparisons.' },
    { name: 'Broader air quality',
      url: 'https://www.hsy.fi/en/environmental-information/open-data/avoin-data---sivut/real-time-air-quality-at-hsy-monitoring-sites-/',
      description: 'Additional monitoring stations, pollutants and an air-quality classification.',
      limitation: 'Verify available station readings first. Point observations do not establish a city-wide pollution surface.' }
  ];
  let preset = $state<CameraPreset>('city');
  let following = $state(false);
  let query = $state('');
  let searchOpen = $state(false);
  const searchTabs = [
    { key: 'vehicles', label: 'Vehicles' }, { key: 'routes', label: 'Routes' },
    { key: 'buildings', label: 'Buildings' }, { key: 'stations', label: 'Stations' }
  ] as const;
  let searchTab = $state<typeof searchTabs[number]['key']>('vehicles');
  const navigateSearchTabs = (event: KeyboardEvent) => {
    const index = searchTabs.findIndex(tab => tab.key === searchTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? searchTabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % searchTabs.length
      : event.key === 'ArrowLeft' ? (index + searchTabs.length - 1) % searchTabs.length : -1;
    if (next < 0) return;
    event.preventDefault();
    searchTab = searchTabs[next].key;
    void tick().then(() => document.getElementById(`city-search-tab-${searchTab}`)?.focus());
  };
  const closeSearch = () => { document.getElementById('city-search')?.focus(); searchOpen = false; };
  let routeFilter = $state('');
  let now = $state(Date.now());
  let observationSnapshot = $state.raw<ObservationSnapshot | null>(null);
  let observationLoading = $state(true);
  let observationError = $state('');
  let route = $state.raw<RouteContext | null>(null);
  let routeLoading = $state(false);
  let routeError = $state('');
  let railJourney = $state.raw<RailResult<RailJourney> | null>(null);
  let railStations = $state.raw<RailResult<RailStation[]> | null>(null);
  let railStationsError = $state('');
  let routeCatalog = $state.raw<RouteCatalog | null>(null);
  let routeCatalogLoading = $state(true);
  let activePanel = $state<'layers' | 'inspect' | 'legend' | null>(null);
  let panelTrigger: HTMLElement | null = null;
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
  let heatDemandTheme = $derived(closestHeatDemandTheme(themeOptions, new Date(now).getFullYear()));
  let solarTheme = $derived(themeOptions.find(option => option.kind === 'solar' && option.metric === 'global_solar_radiation') ?? null);
  let buildingLayers = $derived([
    { key: heatDemandTheme?.key ?? 'heat-demand-unavailable', label: 'Heat demand', available: !!heatDemandTheme },
    { key: 'ryhti:heating_method', label: 'Heating method', available: !!ryhti.catalog },
    { key: 'ryhti:heating_energy_source', label: 'Heating energy source', available: !!ryhti.catalog },
    { key: solarTheme?.key ?? 'solar-unavailable', label: 'Solar radiation', available: !!solarTheme },
    { key: 'ryhti:main_purpose', label: 'Use', available: !!ryhti.catalog },
    { key: 'ryhti:permits', label: 'Permits', available: !!ryhti.catalog }
  ]);
  let activeTheme = $derived(themeOptions.find(option => option.key === themeKey) ?? null);
  let activeRyhtiTheme = $derived(ryhti.catalog ? RYHTI_THEMES.find(option => option.key === themeKey) ?? null : null);
  let activeThemeSummary = $derived(catalog?.themes.find(theme => theme.key === themeKey));
  let legendVisible = $derived(layers.buildings && (!!activeTheme || !!activeRyhtiTheme));
  let legendLabel = $derived(buildingLayers.find(layer => layer.key === themeKey)?.label ?? '');
  let debouncedQuery = $state('');
  $effect(() => {
    const value = query.trim();
    const timer = setTimeout(() => debouncedQuery = value, 200);
    return () => clearTimeout(timer);
  });
  let searchEnabled = $derived(searchOpen && searchTab === 'buildings' && !!generation && !!(debouncedQuery || (sceneError && !scene)));
  let searchSignature = $derived(JSON.stringify([generation, debouncedQuery]));
  let pagination = $state<{ signature: string; cursors: (string | null)[] }>({ signature: '', cursors: [null] });
  let cursor = $derived(pagination.signature === searchSignature ? pagination.cursors.at(-1) ?? null : null);
  const changeSearchPage = (cursors: (string | null)[]) => {
    document.getElementById(`city-search-panel-${searchTab}`)?.focus({ preventScroll: true });
    pagination = { signature: searchSignature, cursors };
  };
  const searchQuery = createQuery(() => {
    const params = new URLSearchParams({ generation, q: debouncedQuery, kind: 'building', limit: '30' });
    if (cursor) params.set('cursor', cursor);
    const version = generation;
    return { queryKey: ['entities', version, debouncedQuery, cursor],
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
  let themeColours = $derived(new Map(themeQueries.values.map(([id, colour, category]) => [id, activeRyhtiTheme && !selectedRyhtiCategories.includes(category ?? '') ? RYHTI_DIM_COLOUR : colour])));
  let ryhtiColors = $derived({ colours: themeColours, categories: activeThemeSummary?.categories ?? [] });
  let theme = $derived({ colours: themeColours, minimum: activeThemeSummary?.minimum ?? null,
    maximum: activeThemeSummary?.maximum ?? null, count: activeThemeSummary?.count ?? 0 });
  let mapCovered = $derived(loading || !ready);
  const modes: TransitMode[] = ['tram', 'bus', 'ferry', 'train', 'ship'];
  const modeNames: Record<TransitMode, string> = { tram: 'Trams', bus: 'Buses', ferry: 'HSL Ferries', train: 'Trains', ship: 'Ships' };
  const age = (vehicle: { reportedAt: string }) => `${Math.max(0, Math.floor(trafficAge(vehicle, now) / 1000))} s ago`;
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
  let matchingStations = $derived(stations.filter(station => stationVisible(station, layers)
    && (!query || searchText(`${station.id} ${station.name} ${station.id === 'rail:HKI' ? 'Helsinki Central' : ''}`).includes(searchText(query)))));
  let staleCount = $derived(visibleVehicles.filter(vehicle => trafficIsStale(vehicle, now)).length);
  let hslLive = $derived(browserConnected && traffic.status.state === 'live');
  let railLive = $derived(browserConnected && traffic.sources?.rail?.state === 'live');
  let marineSource = $derived(traffic.sources?.marine);
  let marineLive = $derived(browserConnected && marineSource?.state === 'live' && !marineSource.stale && !marineSource.periodic);
  let currentFeed = $derived(hslLive || railLive || marineLive);
  let liveStatus = $derived(currentFeed ? 'Live' : browserConnected ? 'Connecting' : 'Paused');
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
  let observationInspector = $derived(selected?.kind === 'station' && (selected.station.kind === 'weather' || selected.station.kind === 'air-quality'));
  let selectedStation = $derived.by(() => { const selection = selected; return selection?.kind === 'station' ? observationStations.find(station => station.id === selection.station.id) : null; });
  let selectedStationParameters = $derived(OBSERVATION_PARAMETERS.filter(parameter => selectedStation?.parameters.includes(parameter.id)));
  let itinerary = $derived(selected?.kind === 'vehicle' && ['train', 'tram', 'bus'].includes(selected.vehicle.mode)
    ? buildItinerary(selected.vehicle, route, railJourney, railStations?.data ?? [], now, selected.removed || !browserConnected) : null);
  let journeyUrl = $derived(selected?.kind === 'vehicle' ? selected.vehicle.mode === 'ship' ? null : selected.vehicle.rail ? railJourneyUrl(selected.vehicle.rail) : routeRequestUrl(selected.vehicle) : null);
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
      if (selection) { activePanel = 'inspect'; searchOpen = false; focusInspector(); }
      else { if (activePanel === 'inspect') activePanel = null; closeSearch(); }
    }
    if (selection?.kind === 'vehicle' && selection.vehicle.mode === 'ship') { route = null; railJourney = null; routeError = ''; }
    selected = selection; selectionMessage = message;
  };
  const selectObject = (selection: Selection) => {
    if (activePanel !== 'inspect') panelTrigger = document.activeElement as HTMLElement | null;
    if (scene && ready) scene.select(selection);
    else setSelection(selection, sceneError ? '3D rendering unavailable. Showing available source metadata.' : 'Map loading. Showing source metadata.');
    if (identity(selected) === identity(selection)) { searchOpen = false; activePanel = 'inspect'; focusInspector(); }
  };
  const clearSelection = () => { if (scene) scene.clearSelection(); else setSelection(null); };
  const setActivePanel = (panel: typeof activePanel) => {
    if (panel && !activePanel) panelTrigger = document.activeElement as HTMLElement | null;
    activePanel = panel;
    void tick().then(() => {
      if (panel) document.getElementById(panel === 'inspect' ? 'inspection-heading' : panel === 'legend' ? 'building-legend-heading' : 'exploration-heading')?.focus({ preventScroll: true });
      else [panelTrigger, document.getElementById(selected ? 'context-trigger' : 'layers-trigger'), document.getElementById('city-search')]
        .find(element => element?.isConnected && element.getClientRects().length)?.focus({ preventScroll: true });
    });
  };
  function showDialog(dialog: HTMLDialogElement) {
    const trigger = document.activeElement as HTMLElement | null, section = informationSection;
    dialog.showModal();
    return { destroy() {
      dialog.close();
      const target = [trigger, document.getElementById('project-menu-trigger'),
        document.querySelector<HTMLElement>(`.header-actions [data-information-section="${section}"]`)]
        .find(element => element?.isConnected && element.getClientRects().length);
      target?.focus({ preventScroll: true });
    } };
  }
  const choosePreset = (value: CameraPreset) => { preset = value; following = false; scene?.preset(value); };
  const chooseRoute = (id: string) => {
    searchOpen = false;
    routeFilter = id;
    const vehicle = availableVehicles.find(vehicle => vehicle.routeId === id && layers[vehicle.mode]);
    if (vehicle) selectObject({ kind: 'vehicle', vehicle });
    else selectionMessage = 'No current vehicle report for this route. No journey shape can be inferred.';
  };
  const openSources = (section: typeof informationSection = 'data') => {
    const menu = document.getElementById('project-menu');
    if (menu?.matches(':popover-open')) { menu.hidePopover(); document.getElementById('project-menu-trigger')?.focus(); }
    informationSection = section; sourceOpen = true;
  };
  const showInformationSection = (section: typeof informationSection) => {
    informationSection = section;
    document.querySelector('#sources .drawer-content')?.scrollTo({ top: 0 });
  };
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

<svelte:head><title>Helsinki Lens · Digital Twin</title><meta name="description" content="Inspect central Helsinki buildings, live HSL, rail and AIS ship reports and dated environmental station observations." /></svelte:head>
<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !document.querySelector('[popover]:popover-open')) { if (searchOpen) { event.preventDefault(); closeSearch(); } else if (activePanel && window.matchMedia('(max-width: 1199px)').matches) { event.preventDefault(); setActivePanel(null); } else clearSelection(); } }} onpointerdown={event => { if (searchOpen && event.target instanceof Element && !event.target.closest('.navbar-search')) searchOpen = false; }} />
<a class="skip-link" href="#city-search">Skip to city search</a>
<div class="app-shell city-console">
  <header class="masthead">
    <a class="brand" href="/" aria-label="Helsinki Lens home"><span class="brand-symbol" aria-hidden="true">▥</span><span class="brand-name">HELSINKI <em>LENS</em><small>DIGITAL TWIN</small></span></a>
    <search class="navbar-search" aria-label="City search" onfocusout={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) searchOpen = false; }}>
      <input id="city-search" type="search" bind:value={query} placeholder="Find a building, route or station…" aria-label="Vehicle, route, building, address or station" aria-controls="city-search-results" onfocus={() => searchOpen = true} onclick={() => searchOpen = true} oninput={() => searchOpen = true} />
      {#if searchOpen}
        <div class="panel object-browser search-results" id="city-search-results">
          <div class="panel-heading"><h2>Search results</h2><button class="icon-button" aria-label="Close search results" onclick={closeSearch}>×</button></div>
          <div class="search-tabs" role="tablist" aria-label="Search categories">
            {#each searchTabs as tab (tab.key)}<button id={`city-search-tab-${tab.key}`} role="tab" aria-selected={searchTab === tab.key} aria-controls={`city-search-panel-${tab.key}`} tabindex={searchTab === tab.key ? 0 : -1} onclick={() => searchTab = tab.key} onkeydown={navigateSearchTabs}>{tab.label}</button>{/each}
          </div>
          {#key `${searchTab}:${query}`}
            {#each searchTabs as tab (tab.key)}
              <div class="search-result-panel" id={`city-search-panel-${tab.key}`} role="tabpanel" aria-labelledby={`city-search-tab-${tab.key}`} hidden={searchTab !== tab.key} tabindex="0">
                {#if searchTab === tab.key}
                  {#if query}<button class="text-button clear-search" onclick={() => { query = ''; document.getElementById('city-search')?.focus(); }}>Clear search</button>{/if}
                  {#if searchTab === 'vehicles'}
                    <p class="panel-note">{matchingVehicles.length} vehicle reports</p>
                    <div class="object-list">{#each matchingVehicles.slice(0, 60) as vehicle (vehicle.id)}<button class:selected={selected?.kind === 'vehicle' && selected.vehicle.id === vehicle.id} onclick={() => selectObject({ kind: 'vehicle', vehicle })}><span class="mode-swatch" style:background={MODE_COLOURS[vehicle.mode]}></span><span><strong>{label(vehicle.mode)} · {vehicleLabel(vehicle, routeName(vehicle.routeId))}</strong><small>{vehicleSourceLabel(vehicle)} · {vehicle.marine ? `MMSI ${vehicle.marine.mmsi}` : vehicle.rail ? `${vehicle.rail.trainNumber} · ${vehicle.rail.destination ?? 'Destination unavailable'}` : `${vehicle.ownerOperatorId}/${vehicle.vehicleId}`} · {trafficIsStale(vehicle, now) ? `stale · ${age(vehicle)}` : age(vehicle)}</small></span></button>{:else}<p class="panel-note">No matching retained vehicle reports in visible modes / transit route.</p>{/each}{#if matchingVehicles.length > 60}<p class="panel-note">First 60 results. Refine your search.</p>{/if}</div>
                  {:else if searchTab === 'routes'}
                    <p class="panel-note">{matchingRoutes.length} routes</p>
                    <div class="object-list">{#each matchingRoutes.slice(0, 60) as item (item.routeId)}<button onclick={() => chooseRoute(item.routeId)}><span class="mode-swatch" style:background={MODE_COLOURS[item.mode]}></span><span><strong>Route {item.label} · {label(item.mode)}</strong><small>{item.name} · {item.routeId}</small></span></button>{:else}<p class="panel-note">{routeCatalogLoading ? 'Loading prepared route labels…' : routeCatalog?.reason ?? 'No matching prepared route labels.'}</p>{/each}{#if matchingRoutes.length > 60}<p class="panel-note">First 60 routes. Refine your search.</p>{/if}</div>
                  {:else if searchTab === 'buildings'}
                    {#if indexState !== 'current'}<p class="panel-note search-status" role="status" data-index-state={indexState}>{indexState === 'loading' ? 'Loading buildings…' : indexMessage}</p>{/if}{#if searchEnabled && searchQuery.isFetching}<p class="panel-note search-status" role="status">Searching…</p>{/if}{#if searchEnabled && searchQuery.error}<p class="notice search-status" role="status">{searchQuery.error.message}</p>{/if}
                    <p class="panel-note">{filteredBuildings.length} {query ? 'matching buildings' : sceneError && !scene ? 'available buildings' : 'loaded buildings'}</p>
                    <div class="object-list building-list">{#each filteredBuildings.slice(0, 60) as building (building.id)}<button class:selected={selected?.kind === 'building' && selected.building.id === building.id} onclick={() => selectObject({ kind: 'building', building })}><span><strong>{buildingName(building)}</strong>{#if buildingAddress(building) && buildingAddress(building) !== buildingName(building)}<small>{buildingAddress(building)}</small>{/if}</span></button>{:else}<p class="panel-note">{query ? 'No matching prepared building or address.' : 'Buildings appear as the district loads.'}</p>{/each}{#if filteredBuildings.length > 60}<p class="panel-note">First 60 buildings. Refine your search.</p>{/if}{#if searchEnabled}<div class="search-pagination"><button class="text-button" disabled={!cursor || searchQuery.isFetching} onclick={() => changeSearchPage(pagination.cursors.slice(0, -1))}>Previous</button><button class="text-button" disabled={!searchQuery.data?.nextCursor || searchQuery.isFetching} onclick={() => changeSearchPage([...(pagination.signature === searchSignature ? pagination.cursors : [null]), searchQuery.data!.nextCursor])}>Next buildings</button></div>{/if}</div>
                  {:else}
                    <p class="panel-note">{matchingStations.length} stations</p>
                    <div class="object-list">{#each matchingStations as station (station.id)}<button class:selected={selected?.kind === 'station' && selected.station.id === station.id} onclick={() => selectObject({ kind: 'station', station })}><span class="station-swatch {station.kind}" aria-hidden="true">{station.kind === 'weather' ? '○' : station.kind === 'rail' ? '▣' : '◇'}</span><span><strong>{station.name}</strong><small>{label(station.kind)} · {station.id}</small></span></button>{:else}<p class="panel-note">{observationLoading ? 'Loading stations…' : 'No matching stations in the available coverage / layers.'}</p>{/each}</div>
                  {/if}
                {/if}
              </div>
            {/each}
          {/key}
        </div>
      {/if}
    </search>
    <button class="live-feed-button" popovertarget="live-feed-status" aria-label="Show live feed status" aria-haspopup="dialog" title={`Live feeds: ${liveStatus.toLowerCase()}`}><span class:connected={currentFeed} class="status-dot" aria-hidden="true"></span><span>{liveStatus}</span></button>
    <div class="live-feed-popover" id="live-feed-status" popover="auto" role="dialog" aria-labelledby="live-feed-heading">
      <h2 id="live-feed-heading">Live feeds</h2>
      {#each liveFeeds as feed (feed.name)}<div class="live-feed-row"><strong><span class:connected={feed.live} class="status-dot" aria-hidden="true"></span>{feed.name}</strong><span>{feed.state}</span><small>Last report: {feed.lastAt ? formatDate(feed.lastAt) : 'No report yet'}</small>{#if feed.error}<p>{feed.error}</p>{/if}</div>{/each}
      {#if trafficError}<p class="panel-note">{trafficError}</p>{/if}
    </div>
    {#snippet projectLinks()}
      <button class="source-button" data-information-section="about" onclick={() => openSources('about')} aria-haspopup="dialog" aria-expanded={sourceOpen && informationSection === 'about'} aria-controls="sources">About this project</button>
      <button class="source-button collaboration-button" data-information-section="collaboration" onclick={() => openSources('collaboration')} aria-haspopup="dialog" aria-expanded={sourceOpen && informationSection === 'collaboration'} aria-controls="sources">Open for collaboration</button>
      <button class="source-button" data-information-section="data" onclick={() => openSources()} aria-haspopup="dialog" aria-expanded={sourceOpen && informationSection === 'data'} aria-controls="sources">Data & sources <span aria-hidden="true">↗</span></button>
    {/snippet}
    <nav class="header-actions" aria-label="Project information">{@render projectLinks()}</nav>
    <button id="project-menu-trigger" class="project-menu-trigger" popovertarget="project-menu" aria-label="Project information menu">···</button>
    <nav id="project-menu" class="project-menu" popover="auto" aria-label="Project information">{@render projectLinks()}</nav>
  </header>
  <main class="city-workspace" class:has-open-panel={!!activePanel} data-scene-ready={!mapCovered} aria-busy={mapCovered}>
    {#if city}
      <CityScene manifest={city.manifest} base={city.base} cache={city.cache} onloadstate={value => mapLoad = value} {traffic} {layers} marinePaused={!browserConnected} {keyboardNavigation} {stations} {route} {itinerary} {routes} routeFilter={routeFilter || null} buildingColours={activeRyhtiTheme ? ryhtiColors.colours : theme.colours} buildingTheme={!!activeTheme || !!activeRyhtiTheme} onappearance={value => appearanceStatus = value} onselection={setSelection} onwebcamselect={camera => activeWebcam = camera} onportcameraselect={harbour => activePortHarbour = harbour}
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
          {#if sceneError && !scene}<p>Use search and Data &amp; Sources for available data.</p>{/if}
        </div>
      </div>
    {/if}
    {#if mapLoad.cacheIssue}<div class="map-cache-status" role="status">{mapLoad.cacheIssue}</div>
    {:else if ready && ['discovering', 'loading'].includes(mapLoad.background.phase)}
      <div class="map-cache-status" role="status" aria-live="polite">
        {mapLoad.background.phase === 'discovering' ? 'Preparing the shared map cache…'
          : `Caching area on the server: ${mapLoad.background.completed.toLocaleString()} / ${mapLoad.background.total.toLocaleString()}`}
      </div>
    {/if}
    {#if city?.manifest.gaps.length}<button class="coverage-notice" onclick={() => openSources()}>Building coverage incomplete <span>View evidence ↗</span></button>{/if}
    <aside class="left-stack" class:mobile-active={activePanel === 'layers' || activePanel === 'legend'} class:legend-active={activePanel === 'legend'} aria-label="Explore the city">
      <div class="mobile-sheet-heading"><strong>{activePanel === 'legend' ? legendLabel : 'Explore the layers'}</strong>{#if legendVisible && activePanel === 'layers'}<button class="text-button" onclick={() => setActivePanel('legend')}>View legend</button>{/if}<button class="icon-button" aria-label="Close exploration panel" onclick={() => setActivePanel(null)}>×</button></div>
      <div class="console-intro"><span class="eyebrow">60° N / 24° E · HELSINKI, FINLAND</span><h1>A city of<br />connections<span>.</span></h1><p>Explore Helsinki.<br />One city. Connected perspectives.</p></div>
      <section class="panel layers-panel exploration-content" id="exploration-panel" aria-labelledby="exploration-heading">
        <h2 id="exploration-heading" tabindex="-1">Explore the layers</h2>
        <details name="exploration" open><summary><ConsoleIcon name="explore" /><span>Map<small>The city in three dimensions</small></span></summary>
          <div class="layer-list">{#each appearanceLayers as layer (layer.key)}<label class="layer-control"><ConsoleIcon name={layer.key} /><span>{layer.label}</span><input type="checkbox" bind:checked={layers[layer.key]} /></label>{/each}</div>
          {#if layers.imagery && appearanceStatus}<p class="panel-note group-note" role="status">{appearanceStatus}</p>{/if}
        </details>
        <details name="exploration"><summary><ConsoleIcon name="transport" /><span>Transport<small>Movement &amp; connection</small></span></summary>
    <div class="layer-list">{#each modes as mode (mode)}<label class="layer-control"><input type="checkbox" aria-label={modeNames[mode]} bind:checked={layers[mode]} /><span class="mode-swatch" style:background={MODE_COLOURS[mode]}></span><span class="mode-label">{modeNames[mode]}</span><small aria-label={`${availableVehicles.filter(vehicle => vehicle.mode === mode).length} reports`}>{availableVehicles.filter(vehicle => vehicle.mode === mode).length}</small></label>{/each}
          <label class="layer-control"><input type="checkbox" bind:checked={layers.railStations} /><span class="station-swatch rail" aria-hidden="true">▣</span><span>Rail stations</span></label>
          {#if layers.train}<details class="rail-filters"><summary>Train categories</summary>{#each RAIL_CATEGORIES as category (category)}<label class="layer-control"><input type="checkbox" bind:checked={layers[category]} /><span>{label(category)}</span></label>{/each}</details>{/if}
          <div class="rail-summary"><strong>Rail · {railLive ? 'connected' : traffic.sources?.rail?.state ?? 'connecting'}</strong><span>{freshRail.length} fresh · {railVehicles.length - freshRail.length} stale</span><span>{railDelayed} delayed · {railUnknown} delay unknown</span></div>
          {#if traffic.sources?.rail?.error}<p class="notice">{traffic.sources.rail.error}</p>{/if}
          {#if railStationsError}<p class="panel-note">{railStationsError}</p>{/if}
          <div class="rail-summary marine-summary"><strong>Ships · {marineState}</strong><span>{freshMarine.length} fresh reports · {marineVehicles.length - freshMarine.length} stale reports</span>{#if !marineVehicles.length}<span>No retained reports in this coverage.</span>{/if}</div>
          {#if marineSource?.error}<p class="notice">{marineSource.error}</p>{/if}
          <label class="filter-label">Transit route filter<select bind:value={routeFilter}><option value="">All received routes</option>{#each [...new Set(availableVehicles.flatMap(vehicle => vehicle.routeId === null ? [] : [vehicle.routeId]))].sort() as id (id)}<option value={id}>{routeName(id)} · {id}</option>{/each}</select></label>
          {#if routeFilter}<button class="text-button" onclick={() => routeFilter = ''}>Clear route filter</button>{/if}
          </div>
    <section class="panel feed-panel" aria-label="Traffic status"><div class="panel-heading"><h2>Reported traffic</h2><span class:connected={currentFeed} class="status-dot"></span></div>
        <div class="feed-summary"><strong>{visibleVehicles.length}</strong><span>reports in visible modes / transit route<br />{staleCount ? `${staleCount} stale · held at last position` : 'Latest received positions'}</span></div>
        <p class="panel-note">{trafficError || (traffic.status.lastPositionAt ? `Last report ${formatDate(traffic.status.lastPositionAt)}` : 'Waiting for real position reports.')}</p>
        {#if stats?.unplacedVehicles}<p class="panel-note">{stats.unplacedVehicles} ground vehicles omitted where terrain height is unknown.</p>{/if}
      </section>
        </details>
        <details name="exploration"><summary><ConsoleIcon name="buildings" /><span>Buildings<small>Use &amp; register records</small></span></summary>
          {@render themeChoices(false)}
        </details>
        <details name="exploration"><summary><ConsoleIcon name="energy" /><span>Energy<small>Demand, heating &amp; sunlight</small></span></summary>
          {@render themeChoices(true)}
        </details>
      </section>
      {#if legendVisible}
        <section class="panel building-layer-legend" aria-labelledby="building-legend-heading" data-building-theme={activeRyhtiTheme ? 'ryhti' : activeTheme?.kind}>
          <div class="panel-heading"><h2 id="building-legend-heading" tabindex="-1">{legendLabel}</h2></div>
          <div class="building-legend-body" id="building-legend-body" data-theme-covered={theme.count}>
            {#if themeQueries.pending}<p class="notice" role="status">Loading colors for the current view…</p>{/if}
            {#if themeQueries.error}<p class="notice" role="status">{themeQueries.error.message}</p>{/if}
            {#if activeRyhtiTheme}
              <div class="category-actions"><button class="text-button" onclick={() => selectedRyhtiCategories = ryhtiColors.categories.map(category => category.key)}>Select all</button><button class="text-button" onclick={() => selectedRyhtiCategories = []}>Clear all</button></div>
              <fieldset class="ryhti-legend"><legend>{selectedRyhtiCategories.length} of {ryhtiColors.categories.length} highlighted</legend>
                {#each ryhtiColors.categories as category (category.key)}<label class="layer-control"><input type="checkbox" value={category.key} bind:group={selectedRyhtiCategories} /><span class="no-data-swatch" style:background={category.colour}></span><span>{category.label}</span><small>{category.count.toLocaleString()}</small></label>{:else}<p class="notice" role="status">No categories available.</p>{/each}
              </fieldset>
              {#if ryhti.status !== 'ready'}<p class="notice" role="status">{ryhti.status === 'stale' ? 'Dated catalog retained' : 'Ryhti catalog unavailable'} · {ryhti.message}</p>{/if}
            {:else if activeTheme}
              {#if theme.minimum !== null && theme.maximum !== null}
                {@const minimum = humanizeEnergyUsage(theme.minimum, activeTheme.unit)}{@const maximum = humanizeEnergyUsage(theme.maximum, activeTheme.unit)}
                <div class="theme-gradient" style:background={theme.minimum === theme.maximum ? ENERGY_COLOURS[1] : `linear-gradient(to right, ${ENERGY_COLOURS[0]} 0% 33.333%, ${ENERGY_COLOURS[1]} 33.333% 66.666%, ${ENERGY_COLOURS[2]} 66.666% 100%)`} aria-hidden="true"></div>
                <div class="theme-limits"><span>{minimum.value} {minimum.unit}</span>{#if theme.minimum !== theme.maximum}<span>{maximum.value} {maximum.unit}</span>{/if}</div>
              {:else}<p class="notice" role="status">No values available.</p>{/if}
              <div class="legend-no-data"><span class="no-data-swatch" style:background={NO_ENERGY_COLOUR}></span>No data</div>
              {#if energy.status !== 'ready'}<p class="notice" role="status">{energy.status === 'stale' ? 'Dated catalog retained' : 'Energy catalog unavailable'} · {energy.message}</p>{/if}
            {/if}
          </div>
        </section>
      {/if}
    </aside>
    {#if legendVisible}<button id="legend-trigger" class="legend-shortcut" aria-expanded={activePanel === 'legend'} aria-controls="building-legend-body" onclick={() => setActivePanel(activePanel === 'legend' ? null : 'legend')}>{legendLabel}<span>Legend ↗</span></button>{/if}
    {#if selected}
    <aside class="right-stack" class:mobile-active={activePanel === 'inspect'} aria-label="Map information">
      <section class="panel inspector" class:observation-inspector={observationInspector} id="identity-inspector" aria-label="Inspector">
        {#if !observationInspector}
        <div class="mobile-sheet-heading"><strong>Inspect</strong><button class="icon-button" aria-label="Close inspector sheet" onclick={() => setActivePanel(null)}>×</button></div><div class="panel-heading"><h2 id="inspection-heading" tabindex="-1"><ConsoleIcon name={selected.kind === 'building' ? 'buildings' : selected.kind === 'vehicle' || selected.station.kind === 'rail' ? 'transport' : 'environment'} />{selected.kind === 'building' ? 'Building' : selected.kind === 'vehicle' ? 'Vehicle information' : selected.station.kind === 'rail' ? 'Station departures' : 'Station observations'}</h2><button class="icon-button" aria-label="Clear selection" onclick={() => clearSelection()}>×</button></div>
        {/if}
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
              <button class="text-button" onclick={() => openSources()}>Data coverage & sources ↗</button>
            </div>
          {:else if selected?.kind === 'vehicle'}
            {#snippet vehicleFollow()}
              {#if selected?.kind === 'vehicle'}
                <button type="button" class="vehicle-follow" aria-pressed={following} disabled={!scene || (!following && (selected.removed || trafficIsStale(selected.vehicle, now)))} onclick={() => { following = scene?.followVehicle(!following && selected?.kind === 'vehicle' ? selected.vehicle.id : null) ?? false; }}>{following ? 'Stop following' : selected.vehicle.mode === 'ship' ? 'Follow ship' : selected.vehicle.mode === 'train' ? 'Follow train' : 'Follow vehicle'} <span aria-hidden="true">↗</span></button>
              {/if}
            {/snippet}
            {#if selected.vehicle.mode === 'ship'}
              <MarineVesselDetails follow={vehicleFollow} vehicle={selected.vehicle} source={marineSource} {now} removed={selected.removed} />
            {:else if selected.vehicle.rail}
              <RailTrainDetails follow={vehicleFollow} vehicle={selected.vehicle} journey={railJourney} {now} loading={routeLoading} error={routeError} />
            {:else}
            {@const schedule = hslSchedule(selected.vehicle.delaySeconds)}
            <span class="eyebrow">HSL / {selected.vehicle.mode.toUpperCase()}</span><h3>Route {route?.status === 'exact' ? route.routeLabel ?? routeName(selected.vehicle.routeId) : routeName(selected.vehicle.routeId)}</h3>
            {#key selected.vehicle.mode}<VehicleModelPreview mode={selected.vehicle.mode} />{/key}
            {#if selected.removed || trafficShouldRemove(selected.vehicle, now)}<p class="notice">This vehicle has left the current feed or its position expired. Its last reported identity remains here.</p>{:else if trafficIsStale(selected.vehicle, now)}<p class="notice">Stale position. Held at its last received coordinates.</p>{/if}
            <p class="vehicle-schedule {schedule.state}"><ConsoleIcon name={`schedule-${schedule.state}`} /><span>{schedule.label}</span>{#if schedule.state !== 'unknown'}<strong title="Signed delay: positive is late, negative is early">{signedSeconds(selected.vehicle.delaySeconds)}</strong>{/if}</p>
            <dl class="properties"><div><dt>Mode</dt><dd>{label(selected.vehicle.mode)}</dd></div><div><dt>Direction</dt><dd>{selected.vehicle.directionId === null ? 'Unknown' : `HFP ${selected.vehicle.directionId}`}</dd></div><div><dt>Speed</dt><dd>{selected.vehicle.speedMetresPerSecond === null ? 'Unknown' : `${(selected.vehicle.speedMetresPerSecond * 3.6).toFixed(1)} km/h`}</dd></div></dl>
            {@render vehicleFollow()}
            {/if}
            {#if itinerary}<VehicleItinerary {itinerary} loading={routeLoading} error={routeError} />{/if}
          {:else if selected?.kind === 'station' && selected.station.kind === 'rail'}
            <RailStationBoard station={selected.station} vehicles={availableVehicles} ontrain={(vehicle: Vehicle) => { layers.train = true; layers[vehicle.rail?.category ?? 'other'] = true; routeFilter = ''; selectObject({ kind: 'vehicle', vehicle }); }} />
          {:else if selected?.kind === 'station'}
            <span class="eyebrow">{selected.station.kind === 'weather' ? 'WEATHER' : 'AIR QUALITY'} / STATION</span>
            <div class="observation-station-heading"><h3 id="inspection-heading" tabindex="-1">{selected.station.name}</h3><button class="icon-button" aria-label="Clear selection" onclick={() => clearSelection()}>×</button></div>
            <dl class="properties"><div><dt>Station ID</dt><dd>{selected.station.id}</dd></div></dl>
            {#key selected.station.id}
              {#each selectedStationParameters as parameter (parameter.id)}
                <StationHistory history={observationSnapshot ? observationHistory(observationSnapshot.observations, selected.station.id, parameter.id) : []} parameter={parameter.label} hours={observationSnapshot?.historyHours ?? 6} />
              {/each}
            {/key}
          {/if}
          {#if selectionMessage}<p class="notice" role="status">{selectionMessage}</p>{/if}
        </div>
      </section>
    </aside>
    {/if}
    <SensorReadings snapshot={observationSnapshot} {now} loading={observationLoading} error={observationError} onstation={id => { const station = stations.find(item => item.id === id); if (station) selectObject({ kind: 'station', station }); }} />
    <nav class="camera-presets" aria-label="Camera presets">{#each [{ id: 'city', name: 'City Centre', detail: 'Buildings & urban life' }, { id: 'harbour', name: 'Harbour', detail: 'Ships & waterfront connections' }, { id: 'central', name: 'Central Station', detail: 'Rail & everyday movement' }] as view, index (view.id)}<button class:active={preset === view.id} aria-label={view.name} aria-pressed={preset === view.id} disabled={!scene} onclick={() => choosePreset(view.id as CameraPreset)}><span class="tour-number">0{index + 1}</span><span class="tour-copy"><strong>{view.name}</strong><small>{view.detail}</small></span><span class="tour-arrow" aria-hidden="true">↗</span></button>{/each}</nav>
    <div class="scene-footer"><span class="scene-guidance">{hovered || (keyboardNavigation ? 'WASD to pan · drag to orbit · scroll to zoom' : 'Drag to orbit · scroll to zoom')}</span>{#if stats}<span class="performance" aria-label="Scene performance" data-fps={stats.fps} data-draw-calls={stats.drawCalls} data-geometries={stats.geometries} data-triangles={stats.triangles} data-loaded-chunks={stats.loadedChunks} data-placed-vehicles={stats.vehicles} data-unplaced-vehicles={stats.unplacedVehicles} data-receipt-latency-ms={stats.lastReceiptLatencyMs ?? ''}>{stats.fps} FPS · {stats.drawCalls} draws · {stats.loadedChunks} chunks</span>{/if}<a class="project-copyright" href="https://ai.ro/" target="_blank" rel="noreferrer">© {new Date(now).getFullYear()} ai.ro</a></div>
    {#if sceneError && ready}<p class="scene-error" role="status">{sceneError}</p>{/if}
    <nav class="mobile-panel-nav" aria-label="City panels">
      <button aria-pressed={!activePanel} onclick={() => setActivePanel(null)}><ConsoleIcon name="explore" /><span>Explore</span></button>
      <button id="layers-trigger" aria-controls="exploration-panel" aria-expanded={activePanel === 'layers'} onclick={() => setActivePanel(activePanel === 'layers' ? null : 'layers')}><ConsoleIcon name="layers" /><span>Layers</span></button>
      {#if selected}<button id="context-trigger" aria-controls="identity-inspector" aria-expanded={activePanel === 'inspect'} onclick={() => setActivePanel(activePanel === 'inspect' ? null : 'inspect')}><ConsoleIcon name="inspect" /><span>Inspect</span></button>{/if}
    </nav>
  </main>
</div>
{#if activeWebcam}
  <WebcamModal camera={activeWebcam} onclose={() => activeWebcam = null} />
{/if}
{#if activePortHarbour}
  <PortCameraModal harbour={activePortHarbour} onclose={() => activePortHarbour = null} />
{/if}
{#snippet themeChoices(energyGroup: boolean)}
  <div class="layer-list building-theme" data-building-theme={activeRyhtiTheme ? 'ryhti' : activeTheme?.kind ?? 'neutral'}>
    <div class="building-layer-choices" role="group" aria-label={energyGroup ? 'Energy building colours' : 'Building record colours'}>
      {#each buildingLayers.filter(layer => energyGroup === !['ryhti:main_purpose', 'ryhti:permits'].includes(layer.key)) as layer (layer.key)}<button aria-pressed={themeKey === layer.key} disabled={!layer.available} onclick={() => changeTheme(layer.key)}>{layer.label}</button>{/each}
    </div>
    {#if energyGroup && energyLoading}<p class="notice" role="status">Loading available energy themes…</p>{:else if energyGroup && energy.status !== 'ready'}<p class="notice">{energy.status === 'stale' ? 'Dated catalog retained' : 'Energy catalog unavailable'} · {energy.message}</p>{/if}
    {#if !energyGroup && ryhti.status !== 'ready'}<p class="notice">{ryhti.status === 'stale' ? 'Dated catalog retained' : 'Ryhti catalog unavailable'} · {ryhti.message}</p>{/if}
  </div>
{/snippet}
{#if sourceOpen}
  <dialog class="source-drawer project-information" id="sources" aria-labelledby="sources-heading" use:showDialog onclose={() => sourceOpen = false}>
    <div class="drawer-heading"><div><span class="eyebrow">HELSINKI LENS / AN AI.RO PROJECT</span><h2 id="sources-heading">{informationSections.find(section => section.key === informationSection)?.label}</h2></div><button class="icon-button" aria-label="Close sources" onclick={event => event.currentTarget.closest('dialog')?.close()}>×</button></div>
    <div class="information-nav" role="group" aria-label="Project information sections">
      {#each informationSections as section (section.key)}<button type="button" aria-pressed={informationSection === section.key} aria-controls="project-information-content" onclick={() => showInformationSection(section.key)}>{section.label}</button>{/each}
    </div>
    <div class="drawer-content" id="project-information-content">
      {#if informationSection === 'data'}
        <div class="information-intro"><span class="eyebrow">PUBLIC DATA. SHARED CONTEXT.</span><h3>A city, with its sources in view.</h3><p>Helsinki Lens brings public city models, transport reports, station observations and building records together. Each source has its own coverage, date and interpretation.</p></div>
        <div class="information-grid source-overview">
          <article><h4>City models & imagery</h4><p>City of Helsinki terrain, streets, semantic buildings and textured 3D models, with 2025 aerial imagery. Prepared coverage extends from Lauttasaari and Munkkiniemi through Pasila/Käpylä to Herttoniemi.</p><a href="https://kartta.hel.fi/3d/" target="_blank" rel="noreferrer">© City of Helsinki · CC BY 4.0 ↗</a></article>
          <article><h4>Transport</h4><p>Reported HSL tram, bus and ferry positions; Fintraffic rail and AIS ship reports; prepared routes and timetables. Source timestamps distinguish recent reports from retained positions.</p><a href="https://digitransit.fi/en/developers/apis/" target="_blank" rel="noreferrer">HSL / Digitransit ↗</a><a href="https://www.digitraffic.fi/en/" target="_blank" rel="noreferrer">Fintraffic / Digitraffic · CC BY 4.0 ↗</a></article>
          <article><h4>Environment</h4><p>FMI weather observations at Helsinki Kaisaniemi and HSY air-quality observations via FMI at Mannerheimintie. Current air-quality coverage is one station’s nitrogen dioxide reading.</p><a href="https://en.ilmatieteenlaitos.fi/open-data" target="_blank" rel="noreferrer">FMI / HSY · CC BY 4.0 ↗</a></article>
          <article><h4>Building records & energy</h4><p>Ryhti building and permit records, Nuuka property electricity, modeled building demand and annual solar radiation. Property measurements, modeled demand and incoming sunlight describe different things; coverage varies by building.</p><a href="https://ryhti.syke.fi/en/" target="_blank" rel="noreferrer">Ryhti / SYKE ↗</a><a href="https://helsinki-openapi.nuuka.cloud/swagger/Nuuka%20Open%20API/swagger.json" target="_blank" rel="noreferrer">Nuuka source reference ↗</a></article>
          <article class="information-wide"><h4>Cameras & photographs</h4><p>Six selected Fintraffic road-weather cameras show dated snapshots. Port of Helsinki cameras provide harbour views; the Vuosaari camera is outside the map’s prepared area. Some building photos are matched through Wikidata identifiers and supplied by Wikimedia Commons.</p><p>Camera availability depends on its provider. Building photographs retain their author, source page and individual licence in the inspector; port-camera media follows the provider’s terms.</p><a href="https://www.digitraffic.fi/en/road-traffic/" target="_blank" rel="noreferrer">Road cameras · Fintraffic · CC BY 4.0 ↗</a><a href="https://www.portofhelsinki.fi/en/about-us/port-of-helsinki/web-camera-south-harbour/" target="_blank" rel="noreferrer">Port of Helsinki cameras ↗</a><a href="https://commons.wikimedia.org/" target="_blank" rel="noreferrer">Wikimedia Commons · per-photo licences ↗</a></article>
        </div>
        <section class="information-status" aria-label="Current data status"><h3>Current data status</h3><p>HSL: {hslLive ? 'connected' : traffic.status.state} · Rail: {railLive ? 'connected' : traffic.sources?.rail?.state ?? 'connecting'} · Ships: {marineState}</p><p>Energy: {energyLoading ? 'loading' : energy.status} · Ryhti: {ryhtiLoading ? 'loading' : ryhti.status}</p>{#each observationSnapshot?.sources ?? [] as source (source.id)}<p>{source.provider}: {source.state} · {source.message}</p>{/each}{#if observationError}<p class="notice">Observation refresh unavailable · {observationError}</p>{/if}<p>Expand the source details below for timestamps, outages, individual licences and coverage evidence.</p></section>
        <section class="potential-sources" aria-labelledby="potential-sources-heading"><h3 id="potential-sources-heading">Potential sources — not yet integrated</h3><p class="panel-note">Research directions checked on 10 October 2026. These datasets are candidates for future work and are not displayed in this view.</p><ol>{#each potentialSources as source (source.name)}<li><h4><a href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a></h4><p>{source.description}</p><p class="panel-note">{source.limitation}</p></li>{/each}</ol></section>
        <details class="source-diagnostics"><summary>Live status, attribution & technical details</summary>
      <h3>Environmental freshness & outages</h3>
      {#if observationLoading && !observationSnapshot}<p class="notice">Loading observations…</p>{/if}{#if observationError}<p class="notice">Unavailable refresh · {observationError}</p>{/if}
      {#each observationSnapshot?.sources ?? [] as source (source.id)}<details class="source-record"><summary>{source.provider} · <span class="badge {source.state}">{source.state}</span></summary><p class="panel-note">{source.message}</p>{#if source.lastError}<p class="notice">Outage: {source.lastError}</p>{/if}<p class="panel-note">{source.attribution}</p><a href={source.url} target="_blank" rel="noreferrer">Source query reference ↗</a><dl class="properties"><div><dt>Observed</dt><dd>{formatDate(source.observedAt)}</dd></div><div><dt>Retrieved</dt><dd>{formatDate(source.retrievedAt)}</dd></div><div><dt>Metadata retrieved</dt><dd>{formatDate(source.metadataRetrievedAt)}</dd></div><div><dt>Last check</dt><dd>{formatDate(source.lastAttemptAt)}</dd></div><div><dt>Next eligible check</dt><dd>{formatDate(source.nextRefreshAt)}</dd></div><div><dt>Refresh check</dt><dd>{source.refreshMs / 60_000} min</dd></div><div><dt>Vintage / window</dt><dd>{source.vintage ?? 'Unknown'}</dd></div><div><dt>License</dt><dd>{source.license}</dd></div><div><dt>Coverage</dt><dd>{source.coverage}</dd></div><div><dt>Resolution</dt><dd>{source.resolution}</dd></div><div><dt>Units</dt><dd>{source.units.join(', ') || 'Unknown'}</dd></div><div><dt>Parameters</dt><dd>{source.parameters.join(', ')}</dd></div></dl>{#if source.requests?.length}<details><summary>Actual bounded source requests</summary>{#each source.requests as request, index (index)}<a href={request.url} target="_blank" rel="noreferrer">Request {index + 1} ↗</a><p class="panel-note">Retrieved {formatDate(request.retrievedAt)} · received {formatDate(request.receivedAt)}</p>{/each}</details>{/if}</details>{/each}

      <h3>Rail traffic · Fintraffic Digitraffic</h3><p class="panel-note">Positions: {railLive ? 'connected' : traffic.sources?.rail?.state ?? 'connecting'} · last report {formatDate(traffic.sources?.rail?.lastPositionAt)}. {traffic.sources?.rail?.error ?? ''}</p><p class="panel-note">Station catalog: {railStations?.state ?? 'loading'} · checked {formatDate(railStations?.retrievedAt)}. {railStationsError}</p><a href="https://www.digitraffic.fi/en/railway-traffic/" target="_blank" rel="noreferrer">Fintraffic railway data · CC BY 4.0 ↗</a>
      <h3>Ships · Fintraffic Digitraffic</h3><p class="panel-note">{marineState} · last local position report {formatDate(marineSource?.lastPositionAt)}. Last source update {formatDate(marineSource?.feedUpdatedAt)}. {marineSource?.positionError ?? marineSource?.error ?? ''}</p><p class="panel-note">Marine data: Fintraffic / Digitraffic, CC BY 4.0.</p><a href="https://www.digitraffic.fi/en/marine-traffic/" target="_blank" rel="noreferrer">Fintraffic marine data ↗</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0 ↗</a>
      <h3>HSL traffic</h3><p class="panel-note">Browser stream: {hslLive ? 'connected' : 'paused / disconnected'} · last upstream state: {traffic.status.state}. Last provider report {formatDate(traffic.status.lastPositionAt)}. {trafficError}</p>
      <h3>Scheduled route data</h3><p class="panel-note">{routeCatalogLoading ? 'Loading route metadata…' : routeCatalog?.status === 'ready' ? `${routes.length} prepared routes available.` : routeCatalog?.reason ?? 'Route metadata unavailable.'}</p>{#if routeCatalog?.source}<a class="source-link" href={routeCatalog.source.url} target="_blank" rel="noreferrer">HSL GTFS source ↗</a><dl class="properties"><div><dt>Provider</dt><dd>Helsinki Region Transport (HSL)</dd></div><div><dt>Index prepared</dt><dd>{formatDate(routeCatalog.generatedAt)}</dd></div><div><dt>GTFS retrieved</dt><dd>{formatDate(routeCatalog.source.retrievedAt)}</dd></div><div><dt>Feed version</dt><dd>{routeCatalog.source.feedVersion ?? 'Unknown'}</dd></div><div><dt>Validity</dt><dd>{routeCatalog.source.validFrom}–{routeCatalog.source.validTo}</dd></div><div><dt>Archive SHA256</dt><dd>{routeCatalog.source.archiveSha256}</dd></div></dl>{/if}
      {#if sample.sampleError}<p class="notice">{sample.sampleError}</p>{/if}
      {#if city}<h3>City coverage</h3><p class="panel-note">{city.manifest.chunks.length} chunks · prepared {formatDate(city.manifest.generatedAt)}. {indexMessage}</p><p class="panel-note">Local origin: {city.manifest.origin.longitude}° E, {city.manifest.origin.latitude}° N. ETRS-GK25 / N2000 metres.</p>{#each city.manifest.gaps as gap (gap)}<p class="notice">{gap}</p>{/each}{/if}
      <h3>City imagery & textures</h3><p class="panel-note">Helsinki orthophoto 2025 · textured LoD2 buildings. © City of Helsinki · CC BY 4.0.</p><a class="source-link" href="https://kartta.hel.fi/3d/" target="_blank" rel="noreferrer">Helsinki 3D source reference ↗</a>
      <h3>Prepared source records</h3>{#each [...new Map([...(sample.manifest?.sources ?? []), ...(city?.manifest.sources ?? []), ...(energy.catalog?.sources ?? []), ...(ryhti.catalog?.sources ?? [])].filter(source => !source.id.startsWith('fmi-')).map(source => [source.id, source])).values()] as source (source.id)}<details class="source-record"><summary>{source.provider} · {label(source.id)}</summary><p class="panel-note">{source.attribution}</p>{#if /^https?:\/\//.test(source.url)}<a href={source.url} target="_blank" rel="noreferrer">Source reference ↗</a>{:else}<p class="panel-note">{source.url}</p>{/if}<dl class="properties"><div><dt>Retrieved</dt><dd>{formatDate(source.retrievedAt)}</dd></div><div><dt>Vintage</dt><dd>{source.vintage ?? 'Unknown'}</dd></div><div><dt>License</dt><dd>{source.license ?? 'Unverified'}</dd></div><div><dt>Checksum</dt><dd>{source.checksum ?? 'Unknown — not supplied'}</dd></div><div><dt>Coordinates</dt><dd>{source.coordinateReference ?? 'Not applicable / unknown'}<small>{source.axisOrder ?? 'Axis order unknown'} · {source.verticalReference ?? 'Vertical reference unknown'}</small></dd></div><div><dt>Coverage</dt><dd>{source.coverage}</dd></div><div><dt>Units</dt><dd>{source.units.join(', ') || 'Unknown'}</dd></div></dl></details>{/each}
      <h3>Ryhti register & join coverage</h3><p class="panel-note">{ryhtiLoading ? 'Loading prepared catalog' : ryhti.status} · snapshot prepared {formatDate(ryhti.catalog?.generatedAt)} · last attempt {formatDate(ryhti.attemptedAt)}. {ryhti.message ?? ''}</p>
      {#if ryhti.catalog}<dl class="properties">{#each Object.entries(ryhti.catalog.coverage) as [key, value] (key)}<div><dt>{label(key)}</dt><dd>{value.toLocaleString()}</dd></div>{/each}</dl>{/if}
      <h3>Energy catalog & join coverage</h3><p class="panel-note">{energyLoading ? 'Loading prepared catalog' : energy.status} · catalog prepared {formatDate(energy.catalog?.generatedAt)} · last refresh attempt {formatDate(energy.attemptedAt)}. {energy.message}</p>
      {#each energy.catalog?.reports ?? [] as report (report.sourceId)}<details class="source-record"><summary>{report.sourceId} · {report.buildingsCovered.toLocaleString()} buildings covered</summary><p class="panel-note">{report.denominator} · vintage {report.sourceVintage ?? 'Unknown'}</p><dl class="properties"><div><dt>Source records</dt><dd>{report.totalSourceRecords.toLocaleString()}</dd></div><div><dt>Within scope</dt><dd>{report.recordsWithinScope.toLocaleString()}</dd></div><div><dt>Exact / reviewed</dt><dd>{report.exactMatches} / {report.reviewedMatches}</dd></div><div><dt>Unmatched</dt><dd>{report.unmatchedRecords}</dd></div><div><dt>Ambiguous / conflict</dt><dd>{report.ambiguousRecords} / {report.conflictingRecords}</dd></div></dl></details>{/each}
      <h3>Foundation source probes · historical</h3><p class="panel-note">Recorded {formatDate(sample.manifest?.generatedAt)}</p>{#each Object.entries(sample.manifest?.gates ?? {}) as [name, gate] (name)}<details class="gate-row"><summary><span>{label(name)}</span><span class="badge {gate.status}">historical {gate.status}</span></summary>{#each gate.evidence as evidence, index (index)}<p class="panel-note">{evidence}</p>{/each}{#if gate.nextAction}<p class="notice">Next: {gate.nextAction}</p>{/if}</details>{/each}
      {#if stats}<p class="panel-note">Renderer: {stats.geometries} geometries · {stats.triangles.toLocaleString()} triangles · {stats.vehicles} placed vehicles.</p>{/if}
        </details>
      {:else if informationSection === 'about'}
        <div class="information-intro"><span class="eyebrow">ONE CITY. CONNECTED PERSPECTIVES.</span><h3>See the city.<br />Explore the connections.</h3><p>Helsinki Lens is an interactive city explorer by <a href="https://ai.ro/" target="_blank" rel="noreferrer">ai.ro</a>. It connects Helsinki’s buildings, mobility, environmental observations and energy information in a shared 3D view, with the evidence behind each layer close at hand.</p></div>
        <div class="information-grid">
          <article><h4>Planners & public institutions</h4><p>Explore the built environment alongside movement and environmental context, and find questions worth investigating together.</p></article>
          <article><h4>Researchers & educators</h4><p>Inspect patterns, compare sources and discuss how data dates, coverage and methods shape what a city view can tell us.</p></article>
          <article><h4>Building owners & teams</h4><p>Bring building records and available energy information into the same conversation, with source identities and missing values visible.</p></article>
          <article><h4>Communities & curious people</h4><p>Look closer at familiar streets, follow reported transport and discover the public information behind the city around you.</p></article>
        </div>
        <section class="information-note"><h4>A shared starting point</h4><p>This is an exploratory prototype covering a prepared area of Helsinki, rather than the whole city or Finland. Sources have different dates and levels of detail; some records are incomplete or unavailable. Station readings describe their locations, modeled energy and solar values are estimates, and vehicle reports retain their source timestamps. Local knowledge and domain expertise give these layers their context.</p></section>
        <div class="information-actions"><a href="https://ai.ro/" target="_blank" rel="noreferrer">Explore ai.ro ↗</a><button type="button" onclick={() => showInformationSection('data')}>Data & Sources ↗</button><button type="button" onclick={() => showInformationSection('collaboration')}>Open for collaboration ↗</button></div>
      {:else}
        <div class="information-intro"><span class="eyebrow">AI.RO / RESEARCH & ENGINEERING</span><h3>Bring a useful question.<br />Let’s explore it together.</h3><p><a href="https://ai.ro/" target="_blank" rel="noreferrer">ai.ro</a> welcomes collaboration with businesses, researchers, public institutions and domain experts. Helsinki Lens is one example of how places, data and practical tools can meet; your challenge can come from any industry.</p></div>
        <div class="information-grid">
          <article><h4>Digital twins & data explorers</h4><p>Connect spatial or operational data in interactive views that help teams inspect a place, understand a system and discuss possibilities.</p></article>
          <article><h4>Knowledge & domain assistants</h4><p>Make documents, data and team expertise easier to find and use, with answers connected to their sources.</p></article>
          <article><h4>Workflow automation</h4><p>Make document processing, reporting and repetitive work easier, with human review where the task needs it.</p></article>
          <article><h4>Research & focused prototypes</h4><p>Test an idea with representative data, clear evaluation criteria and outcomes you can inspect before expanding its scope.</p></article>
        </div>
        <section class="information-note"><h4>A useful first step</h4><p>Bring your domain context, representative data and a problem worth solving. Together, we can define a focused question, build something useful and establish how to evaluate it.</p></section>
        <div class="information-actions"><a class="information-contact" href="https://ai.ro/#contact" target="_blank" rel="noreferrer">Let’s talk ↗</a><a href="https://ai.ro/" target="_blank" rel="noreferrer">Explore ai.ro ↗</a></div>
      {/if}
    </div>
    <footer class="information-footer"><a class="project-copyright" href="https://ai.ro/" target="_blank" rel="noreferrer">© {new Date(now).getFullYear()} ai.ro</a><span>Source data and photographs retain their own attribution and licences.</span></footer>
  </dialog>
{/if}

<style>
  .rail-summary { display: grid; gap: 4px; margin: 9px 0; padding: 10px; border-left: 3px solid #b29bd8; background: #b29bd810; font-size: 11px; }
  .marine-summary { border-color: #79cbd7; background: #79cbd710; }
  .rail-summary strong { color: #d2bdf4; }
  .marine-summary strong { color: #9be1e9; }
  .rail-filters { margin: 5px 0; }
  .ryhti-legend { display: grid; gap: 0.3rem; }
  .theme-gradient { height: 8px; border-radius: 2px; margin: 10px 0 5px; }
  .theme-limits { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; margin-bottom: 8px; }
  .no-data-swatch { width: 10px; height: 10px; display: inline-block; margin-right: 5px; vertical-align: middle; border-radius: 2px; }
</style>
