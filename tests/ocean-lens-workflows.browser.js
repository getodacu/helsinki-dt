// Run with playwright-cli run-code --filename against the local app.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize(), inspector = page.locator('#identity-inspector');
  const inspectorChrome = async title => {
    check(await inspector.locator(':scope > .mobile-sheet-heading').count() === 1, 'Non-observation mobile heading removed');
    const heading = inspector.locator(':scope > .panel-heading');
    check((await heading.innerText()).includes(title), 'Non-observation heading lost');
    check(await inspector.evaluate(element => getComputedStyle(element).scrollbarWidth === 'none' && getComputedStyle(element, '::-webkit-scrollbar').display === 'none'), 'Non-observation scrollbar remains');
    check(await heading.evaluate(element => getComputedStyle(element).borderBottomWidth !== '0px'), 'Non-observation divider removed');
    check(!await inspector.evaluate(element => element.classList.contains('observation-inspector')), 'Non-observation inspector simplified');
  };
  const snapshot = await (await page.request.get(new URL('/api/traffic', page.url()).href)).json();
  const trafficRoute = route => {
    const fresh = JSON.parse(JSON.stringify(snapshot), (key, value) => typeof value === 'string' && /At$/.test(key) && Number.isFinite(Date.parse(value)) ? new Date(Date.now() - 1000).toISOString() : value);
    return route.fulfill(route.request().url().includes('/stream') ? { status: 200, contentType: 'text/event-stream', body: 'event: snapshot\ndata: ' + JSON.stringify(fresh) + '\n\n' } : { json: fresh });
  };
  const properties = new Map();
  let energyState = 'current', heldEnergy = null;
  let energyHeld, energyReleased;
  const heldRequest = new Promise(resolve => { energyHeld = resolve; });
  const releasedRequest = new Promise(resolve => { energyReleased = resolve; });
  const retrievedAt = '2026-09-15T10:00:00.000Z', lastAttemptAt = '2026-10-15T10:00:00.000Z';
  const detailRoute = async route => {
    const response = await route.fetch(), detail = await response.json();
    const property = { id: `fixture-property-${detail.building.id}`, name: `Fixture property ${detail.building.id}`,
      memberSourceIds: ['fixture-source', 'fixture-unresolved'], matchedBuildingIds: [detail.building.id], unmatchedSourceIds: ['fixture-unresolved'], shared: true };
    properties.set(property.id, property);
    detail.energy.catalog.properties = [property];
    return route.fulfill({ response, json: detail });
  };
  const energyRoute = async route => {
    const propertyId = new URL(route.request().url()).searchParams.get('property');
    check(properties.has(propertyId), `Unknown fixture property: ${propertyId}`);
    const boundary = JSON.parse(JSON.stringify(properties.get(propertyId))), state = energyState;
    const records = [0, null, 120].map((value, day) => ({ id: `fixture-${day}`, scope: 'property', scopeId: boundary.id, matchedBuildingIds: [], unmatchedSourceIds: [],
      metric: 'electricity_consumption', value: ['empty', 'unavailable'].includes(state) ? null : value, unit: 'kWh', method: 'measured', scenario: null, sourceId: 'helsinki-nuuka',
      period: { start: `2026-09-0${day + 1}`, end: `2026-09-0${day + 2}` } }));
    const series = { status: state === 'delayed' ? 'stale' : state, property: boundary, metric: 'electricity_consumption', unit: 'kWh', method: 'measured', scope: 'property',
      period: { start: '2026-09-01', end: '2026-10-01' }, timezone: 'Europe/Helsinki', resolution: 'daily', records, historyRecords: records,
      complete: false, total: null, availableMonths: ['2026-09'], availableCompleteMonths: [], source: null,
      retrievedAt: state === 'unavailable' ? null : retrievedAt, lastAttemptAt, message: `Fixture ${state} context` };
    if (state === 'delayed') await new Promise(resolve => { heldEnergy = { resolve, propertyId: boundary.id }; energyHeld(); });
    if (state === '503') return route.fulfill({ status: 503, body: 'Fixture unavailable' });
    try { return await route.fulfill({ json: series }); }
    catch (error) { if (state !== 'delayed') throw error; }
    finally { if (state === 'delayed') energyReleased(); }
  };
  const boardRoute = route => route.fulfill({ json: { state: 'ready', data: [], retrievedAt: new Date().toISOString(), error: null } });
  const search = page.getByRole('searchbox');
  try {
    await page.route('**/api/traffic', trafficRoute); await page.route('**/api/traffic/stream', trafficRoute);
    await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-ready') === 'true');
    const transport = page.locator('#exploration-panel details[name="exploration"]').nth(1);
    await transport.locator(':scope > summary').click();
    const filter = transport.getByRole('combobox', { name: 'Transit route filter' });
    const value = await filter.locator('option').nth(1).getAttribute('value');
    check(value, 'Route filter options missing'); await filter.selectOption(value);
    check(await filter.inputValue() === value, 'Route filter selection lost');
    await transport.getByRole('button', { name: 'Clear route filter', exact: true }).click();
    check(await filter.inputValue() === '', 'Route filter did not clear');
    const vehicle = page.locator('.vehicle-flag').filter({ has: page.locator('strong') }).filter({ hasText: /^\d/ }).first();
    await vehicle.focus(); await vehicle.press('Enter'); await inspector.waitFor();
    await inspectorChrome('Vehicle information');
    check(await inspector.locator('.vehicle-itinerary').isVisible(), 'Itinerary lost');
    const follow = inspector.locator('.vehicle-follow');
    check(!await follow.isDisabled(), 'Fresh vehicle follow disabled'); await follow.click();
    check(await follow.getAttribute('aria-pressed') === 'true', 'Follow failed');
    await follow.click(); check(await follow.getAttribute('aria-pressed') === 'false', 'Stop following failed');
    await page.route('**/api/rail/stations/*/departures', boardRoute);
    await search.fill('Helsinki asema');
    await page.getByRole('tab', { name: 'Stations', exact: true }).click();
    await page.locator('.search-results').getByRole('button', { name: /^Helsinki asema rail/ }).click();
    await inspector.getByText('No upcoming passenger departures reported.', { exact: true }).waitFor();
    await inspectorChrome('Station departures');
    check((await inspector.innerText()).includes('Helsinki time'), 'Departure time attribution lost');
    await page.route(/\/api\/entities\/building\/[^/]+\?/, detailRoute);
    await page.route(/\/api\/energy\?/, energyRoute);
    await search.fill('Mannerheimintie'); await page.getByRole('tab', { name: 'Buildings', exact: true }).click(); await page.locator('.search-results .building-list > button').first().click();
    await inspectorChrome('Building');
    await inspector.getByRole('button', { name: 'View electricity history', exact: true }).click();
    const history = page.locator('.energy-history-dialog'); await history.waitFor();
    check(await history.locator('.monthly-chart').isVisible(), 'Electricity history chart missing');
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await history.boundingBox(); check(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, 'History dialog overflows');
    await page.keyboard.press('Escape'); await history.waitFor({ state: 'detached' });
    check(await inspector.getByRole('button', { name: 'View electricity history', exact: true }).evaluate(element => element === document.activeElement), 'History focus not restored');
    await inspector.getByRole('button', { name: 'Details', exact: true }).click();
    check(await inspector.getByText('Source identifiers', { exact: true }).isVisible(), 'Building details lost');
    await inspector.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    const propertyBlock = inspector.locator('[data-energy-scope="property"]');
    const section = inspector.locator('section[aria-label="Electricity demand"]');
    let nextBuilding = 1;
    const selectBuilding = async state => {
      energyState = state;
      const previous = await propertyBlock.locator('strong').innerText();
      await search.click();
      await search.fill('Mannerheimintie');
      await page.getByRole('tab', { name: 'Buildings', exact: true }).click();
      await page.locator('.search-results .building-list > button').nth(nextBuilding).click();
      nextBuilding = nextBuilding === 1 ? 0 : 1;
      await page.waitForFunction(previousName => {
        const label = document.querySelector('[data-energy-scope="property"] strong');
        return label && label.textContent !== previousName;
      }, previous);
    };
    const assertState = async state => {
      await propertyBlock.locator(`[role="status"][data-energy-state="${state}"]`).waitFor();
      check(await section.isVisible(), `${state}: associated electricity section disappeared`);
      check(await propertyBlock.getByText('Measured shared property total', { exact: true }).isVisible(), `${state}: shared boundary lost`);
    };
    await assertState('current');
    check((await propertyBlock.locator('.energy-value').innerText()).includes('120 kWh'), 'Current recorded sum allocated or missing became zero');
    check(await propertyBlock.locator(`time[datetime="${retrievedAt}"]`).count() === 1, 'Current retrieval context missing');
    for (const state of ['stale', 'empty', 'unavailable', '503']) {
      await selectBuilding(state);
      await assertState(state === '503' ? 'request-error' : state);
      if (state === '503') {
        check((await propertyBlock.innerText()).includes('(503)'), 'HTTP failure context missing');
        check(await propertyBlock.locator('time').count() === 0, 'Previous property retrieval context leaked');
      } else {
        check((await propertyBlock.innerText()).includes(`Fixture ${state} context`), `${state}: API message missing`);
        check(await propertyBlock.locator(`time[datetime="${lastAttemptAt}"]`).count() === 1, `${state}: attempt context missing`);
        if (state === 'stale') {
          check((await propertyBlock.getByRole('status').innerText()).includes('Retained values'), 'Stale retention warning missing');
          check((await propertyBlock.locator('.energy-value').innerText()).includes('120 kWh'), 'Stale recorded values lost or allocated');
          check(await propertyBlock.locator(`time[datetime="${retrievedAt}"]`).count() === 1, 'Stale original retrieval date lost');
          check(await propertyBlock.getByRole('button', { name: 'View electricity history', exact: true }).isVisible(), 'Stale chart lost');
        }
      }
      if (state !== 'stale') {
        check(await propertyBlock.locator('.energy-value').count() === 0, `${state}: missing usage rendered as a number`);
        check(await propertyBlock.locator('[aria-label="No recorded electricity usage available"]').isVisible(), `${state}: missing usage not explicit`);
      }
    }
    await selectBuilding('delayed');
    await assertState('loading');
    await page.waitForFunction(() => document.querySelector('[data-energy-state="loading"]') !== null);
    await heldRequest;
    const superseded = heldEnergy;
    await selectBuilding('current'); await assertState('current');
    const acceptedProperty = await propertyBlock.innerText();
    superseded.resolve();
    await releasedRequest;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertState('current');
    check(await propertyBlock.innerText() === acceptedProperty, 'Aborted late response crossed building/property identity');
    check(!acceptedProperty.includes(superseded.propertyId), 'Superseded property identity retained');
    return { routeFilter: true, vehicleFollow: true, itinerary: true, departureBoard: true, buildingRecords: true, energyHistory: true, historyDialogMobile: true, energyStates: true, energyIdentityIsolation: true };
  } finally {
    heldEnergy?.resolve();
    await page.unroute(/\/api\/entities\/building\/[^/]+\?/, detailRoute); await page.unroute(/\/api\/energy\?/, energyRoute);
    await page.unroute('**/api/rail/stations/*/departures', boardRoute);
    await page.unroute('**/api/traffic', trafficRoute); await page.unroute('**/api/traffic/stream', trafficRoute);
    await page.setViewportSize(viewport); await page.reload();
  }
}
