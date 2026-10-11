// Run with playwright-cli run-code --filename against the local app.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize(), search = page.getByRole('searchbox');
  const catalog = await (await page.request.get(new URL('/api/catalog/status', page.url()).href)).json();
  const params = new URLSearchParams({ generation: catalog.generation, q: '', kind: 'building', limit: '60' });
  const fixture = await (await page.request.get(new URL(`/api/entities?${params}`, page.url()).href)).json();
  check(fixture.buildings.length === 60, 'Building pagination fixture unavailable');
  const routes = Array.from({ length: 6 }, (_, i) => ({ routeId: `fixture-bus-${i}`, label: `Unified Fixture Bus ${i}`, name: `Unified Fixture Route ${i}`, mode: 'bus' }));
  for (const mode of ['tram', 'ferry', 'train']) routes.push({ routeId: `fixture-${mode}`, label: `Unified Fixture ${mode}`, name: `Unified Fixture ${mode} route`, mode });
  routes.push({ routeId: 'fixture-empty', label: 'Empty Fixture', name: 'Empty Fixture Route', mode: 'bus' });
  const vehicles = routes.filter(route => route.routeId !== 'fixture-empty').map((route, i) => ({
    id: `fixture:${route.routeId}`, mode: route.mode, routeId: route.routeId, ownerOperatorId: 'fixture', vehicleId: String(i),
    operatingOperatorId: null, directionId: null, serviceDate: null, startTime: null, journeyReference: null,
    longitude: 24.95 + i * 0.0001, latitude: 60.17, speedMetresPerSecond: 0, headingDegrees: 0,
    rawDeviationSeconds: null, delaySeconds: null, quality: [], sourceId: route.mode === 'train' ? 'digitraffic-rail' : 'hsl-hfp',
    ...(route.mode === 'train' ? { rail: { trainNumber: '9999', departureDate: null, label: 'Unified Fixture train', category: 'commuter', trainType: 'K', operator: null,
      origin: null, destination: null, cancelled: false, nextEvent: null, timetableAt: null } } : {})
  }));
  vehicles.push({ ...vehicles[0], id: 'fixture:ship', vehicleId: '230999999', mode: 'ship', routeId: null, sourceId: 'fintraffic-ais',
    marine: { mmsi: '230999999', name: 'Unified Fixture ship', shipType: 60, navigationStatus: 5, positionSecond: null, trueHeading: null, positionSource: 'fixture' } });
  vehicles.push({ ...vehicles[0], id: 'fixture:expired', vehicleId: 'expired-fixture' });
  vehicles.push({ ...vehicles[0], id: 'fixture:unplaced', vehicleId: 'unplaced-fixture', routeId: 'No position fixture', longitude: null, latitude: null });
  const snapshot = () => {
    const generatedAt = new Date().toISOString();
    return { type: 'snapshot', generatedAt, vehicles: vehicles.map(vehicle => ({ ...vehicle, receivedAt: generatedAt,
      reportedAt: new Date(Date.now() - (vehicle.id === 'fixture:expired' ? 180000 : vehicle.routeId === 'fixture-bus-5' ? 45000 : 0)).toISOString() })),
      status: { state: 'live', connectedAt: generatedAt, lastPositionAt: generatedAt, retryAt: null } };
  };
  const stations = Array.from({ length: 6 }, (_, i) => ({ code: `UF${i}`, name: `Unified Fixture Station ${i}`, longitude: 24.95 + i * 0.0001, latitude: 60.17, passenger: true }));
  const requests = [], mocks = [];
  let phase = 'All previews';
  let releaseManifest = () => {};
  const mock = async (pattern, handler) => { await page.route(pattern, handler); mocks.push([pattern, handler]); };
  const entitiesRoute = async route => {
    const url = new URL(route.request().url()), q = url.searchParams.get('q'), cursor = url.searchParams.get('cursor');
    requests.push({ q, cursor });
    if (q === 'failure-fixture') return route.fulfill({ status: 503, json: { error: 'Fixture building search unavailable' } });
    if (q === 'slow-fixture') await new Promise(resolve => setTimeout(resolve, 700));
    const buildings = q === 'no-match-fixture' ? [] : fixture.buildings.slice(cursor ? 30 : 0, cursor ? 60 : 30)
      .map((building, i) => ({ ...building, attributes: { ...building.attributes, name: `${q} Building ${i + (cursor ? 30 : 0)}` } }));
    try { await route.fulfill({ json: { generation: catalog.generation, buildings, nextCursor: buildings.length && !cursor ? 'fixture-next' : null } }); }
    catch (error) { if (!/closed|cancel|abort|disposed/i.test(String(error))) throw error; }
  };
  const tab = name => page.getByRole('tab', { name, exact: true });
  const panel = () => page.getByRole('tabpanel');
  const group = name => panel().locator('.search-result-group').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const active = async name => {
    check(await tab(name).getAttribute('aria-selected') === 'true', `${name} tab inactive`);
    check(await panel().count() === 1, 'More than one search list visible');
    check(await panel().getAttribute('aria-labelledby') === await tab(name).getAttribute('id'), 'Panel label does not match tab');
  };
  const inspector = page.locator('#identity-inspector');
  const cameraPose = () => page.evaluate(() => ({
    compass: document.querySelector('.map-compass g')?.getAttribute('transform'),
    scale: document.querySelector('.map-scale')?.getAttribute('aria-label'),
    stations: [...document.querySelectorAll('.station-flag')].map(element => element.style.transform)
  }));
  const centeredMarker = async selector => {
    await page.waitForFunction(selector => {
      const marker = document.querySelector(selector), canvas = document.querySelector('.scene-canvas');
      const position = marker?.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
      return position && Math.abs(Number(position[1]) - canvas.clientWidth / 2) < 2
        && Math.abs(Number(position[2]) - canvas.clientHeight / 2) < 100;
    }, selector);
    const text = await page.locator('.map-scale span').first().innerText();
    check(parseFloat(text) * (text.includes('km') ? 1000 : 1) <= 100, 'Selection did not zoom in');
    check(await page.locator('#city-search-results').count() === 0, 'Selection did not close search');
    check(await inspector.isVisible(), 'Selection did not open the inspector');
  };
  const cityPreset = () => page.getByRole('navigation', { name: 'Camera presets' }).getByRole('button', { name: 'City Centre', exact: true }).click();
  const scroll = async () => {
    await panel().locator('.building-list > button').first().waitFor();
    const sizes = await panel().evaluate(element => ({ scroll: element.scrollHeight, client: element.clientHeight }));
    check(sizes.scroll > sizes.client, `Result list does not scroll: ${JSON.stringify(sizes)}`);
    await panel().hover(); await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => document.querySelector('.search-result-panel:not([hidden])').scrollTop > 0);
    check(await panel().evaluate(element => getComputedStyle(element).scrollbarWidth) === 'none', 'Scrollbar remains visible');
  };
  try {
    await mock(/\/api\/entities\?/, entitiesRoute);
    await mock('**/api/traffic', route => route.fulfill({ json: snapshot() }));
    await mock('**/api/traffic/stream', route => route.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n` }));
    await mock('**/api/observations', route => route.fulfill({ json: { generatedAt: new Date().toISOString(), observations: [], sources: [] } }));
    await mock('**/api/rail/stations', route => route.fulfill({ json: { state: 'ready', data: stations, retrievedAt: new Date().toISOString(), error: null } }));
    await mock('**/api/rail/stations/*/departures', route => route.fulfill({ json: { state: 'ready', data: [], retrievedAt: new Date().toISOString(), error: null } }));
    await mock(/\/api\/route(?:\?|$)/, route => route.fulfill({ json: new URL(route.request().url()).search
      ? { status: 'missing', vehicleId: '', routeId: null, routeLabel: null, destination: null, tripId: null, departureAt: null, candidates: [], shape: [], stops: [], reason: 'Fixture has no journey', sourceId: 'hsl-gtfs', generatedAt: null, source: null }
      : { status: 'ready', generatedAt: new Date().toISOString(), source: null, reason: null, routes } }));
    phase = 'Selection during loading';
    const manifestGate = new Promise(resolve => releaseManifest = resolve);
    await mock('**/data/city/manifest.json', async route => { await manifestGate; await route.continue(); });
    await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
    await page.waitForFunction(() => !!document.querySelector('.filter-label select option[value="fixture-bus-0"]'));
    await search.fill('Unified Fixture Bus 0'); await tab('Vehicles').click();
    await panel().locator('.object-list > button').first().click();
    await inspector.getByRole('heading', { name: 'Route Unified Fixture Bus 0', exact: true }).waitFor();
    check(await page.locator('main').getAttribute('data-scene-ready') === 'false', 'Loading fixture did not hold the map');
    check((await inspector.innerText()).includes('Map loading'), 'Loading selection lost its metadata');
    releaseManifest();
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-ready') === 'true');
    await centeredMarker('.vehicle-flag.selected');
    await page.unroute('**/data/city/manifest.json');
    await search.fill(''); await tab('All').click(); await search.press('Escape');
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click(); await cityPreset();
    requests.length = 0; phase = 'All previews';
    await search.click(); await active('All');
    check(await page.getByRole('tab').count() === 5, 'All tab missing');
    check(await panel().locator('.search-result-group').count() === 4, 'All category groups missing');
    check(await page.locator('.search-results details').count() === 0, 'Search accordions remain');
    await page.waitForTimeout(350); check(requests.length === 0, 'Blank All search fetched buildings');
    await search.fill('Unified Fixture');
    await group('Buildings').locator('.building-list > button').first().waitFor();
    for (const name of ['Vehicles', 'Routes', 'Buildings', 'Stations']) {
      check(await group(name).locator('.object-list > button').count() === 5, `${name} preview is not limited to five`);
      check(await group(name).getByRole('button', { name: `View all ${name.toLowerCase()}`, exact: true }).count() === 1, `${name} browse action missing`);
    }
    await group('Vehicles').getByRole('button', { name: 'View all vehicles', exact: true }).click(); await active('Vehicles');
    check(await search.inputValue() === 'Unified Fixture', 'View all changed the query');
    check(await panel().locator('.object-list > button').count() === 10, 'Retained vehicles or transport modes missing');
    check((await panel().innerText()).includes('stale'), 'Stale report label lost');
    await search.fill('230999999'); check((await panel().innerText()).includes('Unified Fixture ship'), 'MMSI search lost');
    await search.fill('expired-fixture'); check((await panel().innerText()).includes('No matching retained vehicle reports'), 'Expired report remains searchable');
    const beforeCategories = requests.length;
    await search.fill('fixture-query'); await page.waitForTimeout(350);
    check(requests.length === beforeCategories, 'Vehicles tab fetched building results');
    await tab('Routes').click(); await active('Routes');
    check((await panel().innerText()).includes('No matching prepared route labels'), 'Route empty state missing');
    await tab('Stations').click(); await active('Stations');
    check((await panel().innerText()).includes('No matching stations'), 'Station empty state missing');
    check(await search.inputValue() === 'fixture-query' && requests.length === beforeCategories, 'Category switch changed query or fetched buildings');
    phase = 'Building pagination';
    await tab('All').click(); await group('Buildings').locator('.building-list > button').first().waitFor();
    await group('Buildings').getByRole('button', { name: 'View all buildings', exact: true }).click(); await active('Buildings');
    check(requests.at(-1).q === 'fixture-query' && requests.at(-1).cursor === null, 'Building preview did not start on first page');
    await scroll(); await panel().focus(); await panel().press('Home'); await panel().press('PageDown');
    await page.waitForFunction(() => document.querySelector('.search-result-panel:not([hidden])').scrollTop > 0);
    await panel().getByRole('button', { name: 'Next buildings', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.search-pagination button:last-child')?.disabled && !document.querySelector('.search-pagination button:first-child')?.disabled);
    check(await panel().evaluate(element => element === document.activeElement), 'Pagination lost search focus');
    check(requests.at(-1).cursor === 'fixture-next', 'Next-page cursor lost');
    await tab('All').click(); await active('All');
    await group('Buildings').locator('.building-list > button').first().waitFor();
    check((await group('Buildings').innerText()).includes('fixture-query Building 0'), 'All preview retained a later page');
    await group('Buildings').getByRole('button', { name: 'View all buildings', exact: true }).click();
    check(await panel().getByRole('button', { name: 'Previous', exact: true }).isDisabled(), 'View all buildings did not reset pagination');
    await panel().getByRole('button', { name: 'Next buildings', exact: true }).click();
    await panel().getByRole('button', { name: 'Previous', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.search-pagination button:first-child')?.disabled);
    await panel().getByRole('button', { name: 'Previous', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.search-pagination button:first-child')?.disabled);
    await scroll(); await tab('Vehicles').click(); await tab('Buildings').click();
    check(await panel().evaluate(element => element.scrollTop) === 0, 'Tab switch did not reset scrolling');
    phase = 'Pending building results';
    await search.fill('slow-fixture');
    check(await panel().locator('.building-list > button').count() === 0, 'Old building results remained during debounce');
    await panel().getByText('Searching…', { exact: true }).waitFor();
    await page.waitForTimeout(250); await search.fill('second-fixture-query');
    await panel().getByText('second-fixture-query Building 0', { exact: true }).waitFor();
    await page.waitForTimeout(750);
    check(!await panel().getByText('slow-fixture Building 0', { exact: true }).count(), 'Delayed response replaced current results');
    check(requests.at(-1).q === 'second-fixture-query' && requests.at(-1).cursor === null, 'Query change retained pagination');
    const beforeClose = requests.length;
    await search.press('Escape');
    check(await page.locator('#city-search-results').count() === 0 && await search.evaluate(element => element === document.activeElement), 'Escape lost search focus');
    await search.fill('closed-fixture-query'); await search.press('Escape'); await page.waitForTimeout(350);
    check(requests.length === beforeClose, 'Closed search fetched buildings');
    await search.click(); await active('Buildings'); await panel().locator('.building-list > button').first().waitFor();
    await panel().getByRole('button', { name: 'Clear search', exact: true }).click(); await page.waitForTimeout(350);
    check((await panel().innerText()).includes('loaded buildings'), 'Blank search lost loaded buildings');
    check(await panel().locator('.building-list > button').count() > 0, 'Loaded building list missing');
    phase = 'Empty and error states';
    await search.fill('no-match-fixture'); await panel().getByText('No matching prepared building or address.', { exact: true }).waitFor();
    await tab('All').click(); await search.fill('failure-fixture');
    await group('Buildings').getByText('Fixture building search unavailable', { exact: true }).waitFor();
    check(await panel().locator('.search-result-group').count() === 4, 'Building error removed other categories');
    check(!await group('Buildings').getByText('No matching prepared building or address.', { exact: true }).count(), 'Building error was reported as no matches');
    await tab('Vehicles').click(); check(!await panel().getByText('Fixture building search unavailable', { exact: true }).count(), 'Building error leaked into Vehicles');
    await search.press('Escape');
    phase = 'Reveal hidden objects';
    const transport = page.locator('#exploration-panel > details > summary').filter({ hasText: 'Transport' });
    await transport.click();
    await page.getByRole('checkbox', { name: 'Buses', exact: true }).uncheck();
    await page.locator('#exploration-panel .filter-label select').selectOption('fixture-tram');
    await cityPreset();
    await search.fill('Unified Fixture'); await tab('All').click();
    await group('Vehicles').locator('.object-list > button').filter({ hasText: 'Unified Fixture Bus 0' }).click();
    await centeredMarker('.vehicle-flag.selected');
    await inspector.getByRole('heading', { name: 'Route Unified Fixture Bus 0', exact: true }).waitFor();
    check(await inspector.locator('.vehicle-follow').getAttribute('aria-pressed') === 'false', 'Selection started vehicle following');
    const pickedPose = await cameraPose();
    await page.locator('.vehicle-flag.selected').click();
    check(JSON.stringify(await cameraPose()) === JSON.stringify(pickedPose), 'Map marker click moved the camera');
    await cityPreset(); await search.fill('Unified Fixture Bus 0');
    await group('Vehicles').locator('.object-list > button').first().press('Enter');
    await centeredMarker('.vehicle-flag.selected');
    check(await page.getByRole('checkbox', { name: 'Buses', exact: true }).isChecked(), 'Selecting a hidden bus did not enable its layer');
    check(await page.locator('#exploration-panel .filter-label select').inputValue() === '', 'Conflicting route filter remains');
    check(await page.locator('#city-search-results').count() === 0, 'Selecting an object did not close search');
    await page.locator('.rail-filters > summary').click();
    await page.getByRole('checkbox', { name: 'commuter', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Trains', exact: true }).uncheck();
    await search.fill('Unified Fixture train');
    await group('Vehicles').locator('.object-list > button').first().click();
    check(await page.getByRole('checkbox', { name: 'Trains', exact: true }).isChecked(), 'Train layer remained hidden');
    await page.locator('.rail-filters > summary').click();
    check(await page.getByRole('checkbox', { name: 'commuter', exact: true }).isChecked(), 'Train category remained hidden');
    await page.getByRole('checkbox', { name: 'Rail stations', exact: true }).uncheck();
    await search.fill('Unified Fixture Station 0');
    await group('Stations').locator('.object-list > button').first().click();
    await centeredMarker('.station-flag.selected');
    check((await inspector.innerText()).includes('Unified Fixture Station 0'), 'Wrong station inspector opened');
    check(await page.getByRole('checkbox', { name: 'Rail stations', exact: true }).isChecked(), 'Station layer remained hidden');
    await page.locator('#exploration-panel > details > summary').filter({ hasText: 'Map' }).click();
    await page.getByRole('checkbox', { name: '3D buildings', exact: true }).uncheck();
    await cityPreset();
    await search.fill('building-selection-fixture');
    await group('Buildings').locator('.building-list > button').first().click();
    await inspector.getByRole('heading', { name: 'building-selection-fixture Building 0', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.map-scale')?.getAttribute('aria-label') === '50 m at view centre');
    check(await page.locator('#city-search-results').count() === 0, 'Building selection did not close search');
    check(await page.getByRole('checkbox', { name: '3D buildings', exact: true }).isChecked(), 'Building layer remained hidden');
    phase = 'Unavailable vehicle position';
    const beforeUnplaced = await cameraPose();
    await search.fill('unplaced-fixture');
    await group('Vehicles').locator('.object-list > button').first().click();
    await inspector.getByRole('heading', { name: 'Route No position fixture', exact: true }).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check(JSON.stringify(await cameraPose()) === JSON.stringify(beforeUnplaced), 'Unplaced vehicle moved the camera');
    check(await page.locator('#city-search-results').count() === 0, 'Unplaced vehicle left search open');
    await search.press('Escape'); await transport.click();
    await page.getByRole('checkbox', { name: 'Buses', exact: true }).uncheck();
    await page.locator('#exploration-panel .filter-label select').selectOption('fixture-tram');
    phase = 'Route selection';
    await search.fill('Empty Fixture'); await tab('Routes').click();
    check(await panel().locator('.object-list > button').count() === 1, 'Hidden route was excluded by map filters');
    await panel().locator('.object-list > button').first().click();
    await panel().getByText('No current vehicle report for route Empty Fixture.', { exact: true }).waitFor();
    check(await page.getByRole('checkbox', { name: 'Buses', exact: true }).isChecked(), 'Route selection did not enable its mode');
    check(await page.locator('#exploration-panel .filter-label select').inputValue() === 'fixture-empty', 'Route selection did not apply its filter');
    check(await search.inputValue() === 'Empty Fixture', 'Empty route selection lost query');
    await search.fill('Unified Fixture');
    await panel().locator('.object-list > button').filter({ hasText: 'Unified Fixture Bus 0' }).click();
    check(await page.locator('#exploration-panel .filter-label select').inputValue() === 'fixture-bus-0', 'Live route selection lost its filter');
    await centeredMarker('.vehicle-flag.selected');
    await search.fill('Unified Fixture'); await tab('All').click();
    phase = 'Keyboard navigation';
    await tab('All').focus(); await tab('All').press('ArrowLeft'); await active('Stations');
    check(await tab('Stations').evaluate(element => element === document.activeElement), 'Arrow key lost tab focus');
    await tab('Stations').press('ArrowRight'); await active('All');
    await tab('All').press('End'); await active('Stations');
    await tab('Stations').press('Home'); await active('All');
    await tab('All').press('ArrowRight'); await active('Vehicles');
    await tab('Vehicles').press('ArrowRight'); await active('Routes');
    await tab('Routes').press('ArrowRight'); await active('Buildings');
    await search.fill('fixture-query'); await panel().locator('.building-list > button').first().waitFor();
    phase = 'Responsive layouts';
    const layouts = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 },
      { width: 390, height: 844 }, { width: 320, height: 740 }, { width: 844, height: 390 }];
    for (const size of layouts) {
      await page.setViewportSize(size); await active('Buildings');
      for (const control of [page.locator('#city-search-results'), page.getByRole('tablist'), panel(), tab('All'), tab('Stations')]) {
        const box = await control.boundingBox();
        check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `Search outside ${size.width}x${size.height}`);
      }
      check(await panel().evaluate(element => element.scrollWidth <= element.clientWidth), 'Search list has horizontal overflow');
      check((await tab('Buildings').boundingBox()).height >= 44, 'Search tab target too small');
      const fixed = await page.getByRole('tablist').boundingBox(); await scroll();
      check((await page.getByRole('tablist').boundingBox()).y === fixed.y, 'Scrolling moved the tabs');
      await page.screenshot({ path: `output/playwright/all-search-buildings-${size.width}x${size.height}.png` });
      await tab('All').click(); await active('All');
      check(await panel().locator('.search-result-group').count() === 4, 'Responsive All groups missing');
      check(await panel().evaluate(element => element.scrollWidth <= element.clientWidth), 'All results overflow horizontally');
      await page.screenshot({ path: `output/playwright/all-search-${size.width}x${size.height}.png` });
      await tab('Buildings').click();
    }
    return { tabs: 5, groupedPreviews: true, queryPreserved: true, unfilteredSearch: true, revealSelection: true, selectionZoom: true, repeatSelection: true, loadingSelection: true, unplacedSelection: true,
      requestGating: true, pagination: true, pendingResults: true, delayedResponses: true, loadedBuildings: true,
      emptyStates: true, categoryErrors: true, hiddenScrollbar: true, keyboard: true, focus: true, layouts: layouts.length };
  } catch (error) {
    throw new Error(`${phase}: ${error.message}`);
  } finally {
    releaseManifest();
    for (const [pattern, handler] of mocks) await page.unroute(pattern, handler);
    await page.setViewportSize(viewport); await page.reload();
  }
}
