// Run with playwright-cli run-code --filename against the local app.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize(), search = page.getByRole('searchbox');
  const catalog = await (await page.request.get(new URL('/api/catalog/status', page.url()).href)).json();
  const params = new URLSearchParams({ generation: catalog.generation, q: '', kind: 'building', limit: '60' });
  const fixture = await (await page.request.get(new URL(`/api/entities?${params}`, page.url()).href)).json();
  check(fixture.buildings.length === 60, 'Building pagination fixture unavailable');
  const requests = [];
  const entitiesRoute = route => {
    const url = new URL(route.request().url()), q = url.searchParams.get('q'), cursor = url.searchParams.get('cursor');
    requests.push({ q, cursor });
    if (q === 'failure-fixture') return route.fulfill({ status: 503, json: { error: 'Fixture building search unavailable' } });
    const buildings = q === 'no-match-fixture' ? [] : fixture.buildings.slice(cursor ? 30 : 0, cursor ? 60 : 30);
    return route.fulfill({ json: { generation: catalog.generation, buildings, nextCursor: buildings.length && !cursor ? 'fixture-next' : null } });
  };
  const tab = name => page.getByRole('tab', { name, exact: true });
  const panel = () => page.getByRole('tabpanel');
  const active = async name => {
    check(await tab(name).getAttribute('aria-selected') === 'true', `${name} tab inactive`);
    check(await panel().count() === 1, 'More than one search list visible');
    check(await panel().getAttribute('aria-labelledby') === await tab(name).getAttribute('id'), 'Panel label does not match tab');
  };
  const scroll = async () => {
    await panel().locator('.building-list > button').first().waitFor();
    const sizes = await panel().evaluate(element => ({ scroll: element.scrollHeight, client: element.clientHeight, buttons: element.querySelectorAll('.building-list > button').length }));
    check(sizes.scroll > sizes.client, `Result list does not scroll: ${JSON.stringify({ sizes, viewport: page.viewportSize(), request: requests.at(-1) })}`);
    await panel().hover(); await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => document.querySelector('.search-result-panel:not([hidden])').scrollTop > 0);
    check(await panel().evaluate(element => getComputedStyle(element).scrollbarWidth) === 'none', 'Scrollbar remains visible');
  };
  try {
    await page.route(/\/api\/entities\?/, entitiesRoute);
    await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-ready') === 'true');
    await search.click(); await active('Vehicles');
    check(await page.locator('.search-results details').count() === 0, 'Search accordions remain');
    await search.fill('fixture-query'); await page.waitForTimeout(350);
    check(requests.length === 0, 'Inactive Buildings tab fetched search results');
    check((await panel().innerText()).includes('No matching retained vehicle reports'), 'Vehicle empty state missing');
    await tab('Routes').click(); await active('Routes');
    check((await panel().innerText()).includes('No matching prepared route labels'), 'Route filtering changed');
    await tab('Stations').click(); await active('Stations');
    check((await panel().innerText()).includes('No matching stations'), 'Station filtering changed');
    check(await search.inputValue() === 'fixture-query' && requests.length === 0, 'Tab switch changed query or fetched buildings');
    await tab('Buildings').click(); await active('Buildings');
    await panel().locator('.building-list > button').first().waitFor();
    check(requests.at(-1).q === 'fixture-query' && requests.at(-1).cursor === null, 'Building query not requested');
    await scroll();
    await panel().focus(); await panel().press('Home');
    await panel().press('PageDown');
    await page.waitForFunction(() => document.querySelector('.search-result-panel:not([hidden])').scrollTop > 0);
    await panel().getByRole('button', { name: 'Next buildings', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.search-pagination button:last-child')?.disabled && !document.querySelector('.search-pagination button:first-child')?.disabled);
    check(await panel().evaluate(element => element === document.activeElement), 'Pagination lost focus outside search');
    check(requests.at(-1).cursor === 'fixture-next', 'Next-page cursor lost');
    await panel().getByRole('button', { name: 'Previous', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.search-pagination button:first-child').disabled);
    await scroll(); await tab('Vehicles').click(); await tab('Buildings').click();
    check(await panel().evaluate(element => element.scrollTop) === 0, 'Tab switch did not reset scrolling');
    await scroll(); await search.fill('second-fixture-query');
    await page.waitForFunction(() => document.querySelector('.search-result-panel:not([hidden])').scrollTop === 0);
    await page.waitForTimeout(350);
    check(requests.at(-1).q === 'second-fixture-query' && requests.at(-1).cursor === null, 'Query change retained pagination');
    const beforeClose = requests.length;
    await search.press('Escape');
    check(await page.locator('#city-search-results').count() === 0 && await search.evaluate(element => element === document.activeElement), 'Escape lost search focus');
    await search.fill('closed-fixture-query'); await search.press('Escape'); await page.waitForTimeout(350);
    check(requests.length === beforeClose, 'Closed search fetched buildings');
    await search.click(); await active('Buildings');
    await panel().locator('.building-list > button').first().waitFor();
    await panel().getByRole('button', { name: 'Clear search', exact: true }).click(); await page.waitForTimeout(350);
    check((await panel().innerText()).includes('loaded buildings'), 'Blank search no longer shows loaded buildings');
    check(await panel().locator('.building-list > button').count() > 0, 'Loaded building list missing');
    await search.fill('no-match-fixture'); await panel().getByText('No matching prepared building or address.', { exact: true }).waitFor();
    await search.fill('failure-fixture'); await panel().getByText('Fixture building search unavailable', { exact: true }).waitFor();
    await tab('Vehicles').click();
    check(!await panel().getByText('Fixture building search unavailable', { exact: true }).count(), 'Building error leaked into another tab');
    await tab('Vehicles').focus(); await tab('Vehicles').press('ArrowLeft'); await active('Stations');
    check(await tab('Stations').evaluate(element => element === document.activeElement), 'Arrow key did not move focus');
    await tab('Stations').press('ArrowRight'); await active('Vehicles');
    await tab('Vehicles').press('End'); await active('Stations');
    await tab('Stations').press('Home'); await active('Vehicles');
    await tab('Vehicles').press('ArrowRight'); await active('Routes');
    await tab('Routes').press('ArrowRight'); await active('Buildings');
    await search.fill('fixture-query'); await panel().locator('.building-list > button').first().waitFor();
    const layouts = [{ width: 1440, height: 900 }, { width: 1376, height: 1104 }, { width: 1280, height: 720 },
      { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
    for (const size of layouts) {
      await page.setViewportSize(size); await active('Buildings');
      for (const control of [page.locator('#city-search-results'), page.getByRole('tablist'), panel(), tab('Vehicles'), tab('Stations')]) {
        const box = await control.boundingBox();
        check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `Search outside ${size.width}x${size.height}`);
      }
      check(await panel().evaluate(element => element.scrollWidth <= element.clientWidth), 'Search list has horizontal overflow');
      check((await tab('Buildings').boundingBox()).height >= 44, 'Search tab target too small');
      const fixed = await page.getByRole('tablist').boundingBox(); await scroll();
      check((await page.getByRole('tablist').boundingBox()).y === fixed.y, 'Scrolling moved the tabs');
      check(await page.locator('.tour-label').count() === 0, 'Camera preset label remains');
      await page.screenshot({ path: `output/playwright/ocean-search-tabs-${size.width}x${size.height}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await search.press('Escape');
    const cameraCards = page.getByRole('navigation', { name: 'Camera presets' }).getByRole('button');
    check(await cameraCards.count() === 3, 'Camera presets lost');
    await cameraCards.nth(1).click(); check(await cameraCards.nth(1).getAttribute('aria-pressed') === 'true', 'Camera preset did not activate');
    return { tabs: 4, selectedCategory: true, requestGating: true, pagination: true, loadedBuildings: true,
      emptyStates: true, errors: true, scrollReset: true, hiddenScrollbar: true, keyboard: true, focus: true, layouts: layouts.length, presets: true };
  } finally {
    await page.unroute(/\/api\/entities\?/, entitiesRoute);
    await page.setViewportSize(viewport); await page.reload();
  }
}
