// Run with playwright-cli run-code --filename against the local app.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize(), inspector = page.locator('#identity-inspector');
  const snapshot = await (await page.request.get(new URL('/api/traffic', page.url()).href)).json();
  const trafficRoute = route => {
    const fresh = JSON.parse(JSON.stringify(snapshot), (key, value) => typeof value === 'string' && /At$/.test(key) && Number.isFinite(Date.parse(value)) ? new Date(Date.now() - 1000).toISOString() : value);
    return route.fulfill(route.request().url().includes('/stream') ? { status: 200, contentType: 'text/event-stream', body: 'event: snapshot\ndata: ' + JSON.stringify(fresh) + '\n\n' } : { json: fresh });
  };
  const property = { id: 'fixture-property', name: 'Fixture property', memberSourceIds: ['fixture-source'], matchedBuildingIds: [], unmatchedSourceIds: [], shared: false };
  const detailRoute = async route => {
    const response = await route.fetch(), detail = await response.json();
    property.matchedBuildingIds = [detail.building.id];
    detail.energy.catalog.properties = [property];
    return route.fulfill({ response, json: detail });
  };
  const records = [0,1].map(day => ({ id: `fixture-${day}`, scope: 'property', scopeId: property.id, matchedBuildingIds: [], unmatchedSourceIds: [],
    metric: 'electricity_consumption', value: 100 + day * 20, unit: 'kWh', method: 'measured', scenario: null, sourceId: 'helsinki-nuuka',
    period: { start: `2026-09-0${day + 1}`, end: `2026-09-0${day + 2}` } }));
  const energyRoute = route => route.fulfill({ json: { status: 'current', property, metric: 'electricity_consumption', unit: 'kWh', method: 'measured', scope: 'property',
    period: { start: '2026-09-01', end: '2026-10-01' }, timezone: 'Europe/Helsinki', resolution: 'daily', records, historyRecords: records,
    complete: false, total: null, availableMonths: ['2026-09'], availableCompleteMonths: [], source: null, retrievedAt: new Date().toISOString(), message: null } });
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
    check((await inspector.innerText()).includes('Helsinki time'), 'Departure time attribution lost');
    await page.route(/\/api\/entities\/building\/[^/]+\?/, detailRoute);
    await page.route(/\/api\/energy\?/, energyRoute);
    await search.fill('Mannerheimintie'); await page.getByRole('tab', { name: 'Buildings', exact: true }).click(); await page.locator('.search-results .building-list > button').first().click();
    await inspector.getByRole('button', { name: 'View electricity history', exact: true }).click();
    const history = page.locator('.energy-history-dialog'); await history.waitFor();
    check(await history.locator('.monthly-chart').isVisible(), 'Electricity history chart missing');
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await history.boundingBox(); check(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, 'History dialog overflows');
    await page.keyboard.press('Escape'); await history.waitFor({ state: 'detached' });
    check(await inspector.getByRole('button', { name: 'View electricity history', exact: true }).evaluate(element => element === document.activeElement), 'History focus not restored');
    await inspector.getByRole('button', { name: 'Details', exact: true }).click();
    check(await inspector.getByText('Source identifiers', { exact: true }).isVisible(), 'Building details lost');
    return { routeFilter: true, vehicleFollow: true, itinerary: true, departureBoard: true, buildingRecords: true, energyHistory: true, historyDialogMobile: true };
  } finally {
    await page.unroute(/\/api\/entities\/building\/[^/]+\?/, detailRoute); await page.unroute(/\/api\/energy\?/, energyRoute);
    await page.unroute('**/api/rail/stations/*/departures', boardRoute);
    await page.unroute('**/api/traffic', trafficRoute); await page.unroute('**/api/traffic/stream', trafficRoute);
    await page.setViewportSize(viewport); await page.reload();
  }
}
