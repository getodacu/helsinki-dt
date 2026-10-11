// Run with playwright-cli run-code --filename against the local app.
// Catalog fixtures exercise long labels, equal ranges, missing values and stale status.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const picker = page.locator('#exploration-panel'), legend = page.locator('.building-layer-legend');
  const trigger = page.locator('#layers-trigger'), body = page.locator('#building-legend-body');
  const originalViewport = page.viewportSize();
  const reload = async () => { await page.reload(); await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-ready') === 'true'); };
  const catalog = await (await page.request.get(new URL('/api/catalog/status', page.url()).href)).json();
  const heat = catalog.themes.find(theme => theme.energy?.kind === 'modeled-demand' && theme.energy.metric === 'heat_dhw_demand');
  check(heat, 'Heat demand fixture unavailable');
  let mode = 'normal';
  const catalogRoute = route => {
    const data = structuredClone(catalog);
    for (const scalar of data.themes.filter(theme => theme.energy?.kind === 'modeled-demand' && theme.energy.metric === 'heat_dhw_demand')) {
      if (mode === 'equal') scalar.minimum = scalar.maximum = 1000;
      if (mode === 'missing') scalar.minimum = scalar.maximum = null;
    }
    if (mode === 'stale') { data.energy.status = 'stale'; data.energy.message = 'Fixture catalog refresh unavailable'; }
    if (mode === 'unavailable') { data.energy.status = 'unavailable'; data.energy.catalog = null; data.themes = data.themes.filter(theme => !theme.energy); }
    const use = data.themes.find(theme => theme.key === 'ryhti:main_purpose');
    if (use?.categories.length) {
      use.categories[0].label += ' · Fixture category with a long label that wraps across several lines';
      use.categories.push(...Array.from({ length: 20 }, (_, index) => ({ key: `fixture-${index}`, label: `Fixture category ${index + 1}`, colour: '#0072b2', count: 0 })));
    }
    return route.fulfill({ json: data });
  };
  const openLayers = async () => {
    if (!await picker.isVisible()) await trigger.click();
  };
  const choose = async name => {
    await openLayers();
    const group = picker.locator('details[name="exploration"]').filter({ has: page.getByRole('button', { name, exact: true, includeHidden: true }) });
    if (!await group.evaluate(element => element.open)) await group.locator(':scope > summary').click();
    const button = group.getByRole('button', { name, exact: true });
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
    check(await picker.locator('.building-layer-choices button[aria-pressed="true"]').count() === 1, 'Multiple colouring themes active');
    {
      if (page.viewportSize().width < 1200) await page.getByRole('button', { name: 'View legend', exact: true }).click();
      await legend.waitFor();
      check((await legend.locator('#building-legend-heading').innerText()).includes(name), 'Wrong legend title');
      check(await legend.count() === 1, 'Multiple legends mounted');
    }
  };
  const bounds = async () => {
    const result = await page.evaluate(() => {
      const legend = document.querySelector('.building-layer-legend').getBoundingClientRect();
      const map = document.querySelector('.city-workspace').getBoundingClientRect();
      const content = document.querySelector('#building-legend-body');
      const inspector = document.querySelector('#identity-inspector');
      return { legend: { x: legend.x, y: legend.y, right: legend.right, bottom: legend.bottom }, mapHeight: map.height,
        bodyHeight: content.getBoundingClientRect().height, bodyWidth: content.clientWidth, bodyScrollWidth: content.scrollWidth,
        inspectorBox: inspector && inspector.getClientRects().length ? { x: inspector.getBoundingClientRect().x, right: inspector.getBoundingClientRect().right } : null };
    });
    const viewport = page.viewportSize();
    check(result.legend.x >= 0 && result.legend.right <= viewport.width && result.legend.y >= 0 && result.legend.bottom <= viewport.height, 'Legend leaves viewport');
    if (viewport.width >= 1200) check(result.bodyHeight <= result.mapHeight * .4 + 1, 'Desktop legend body exceeds 40% of map height');
    check(result.bodyScrollWidth <= result.bodyWidth + 1, 'Category label creates horizontal overflow');
    if (result.inspectorBox) check(result.legend.right <= result.inspectorBox.x || result.legend.x >= result.inspectorBox.right, 'Legend overlaps inspector');
  };
  try {

    await page.route('**/api/catalog/status', catalogRoute);
    await page.setViewportSize({ width: 928, height: 1104 });
    await reload();
    check(await picker.getByRole('button', { name: 'Default appearance', exact: true, includeHidden: true }).count() === 0, 'Default appearance button remains');
    check(await picker.getByRole('button', { name: 'Reset building colours', exact: true, includeHidden: true }).count() === 0, 'Redundant reset button remains');
    for (const name of ['Heating method', 'Heating energy source', 'Use', 'Permits', 'Heat demand', 'Solar radiation']) {
      await choose(name); await bounds();
      if (['Heat demand', 'Solar radiation'].includes(name)) {
        check(await legend.locator('.theme-gradient').count() === 1, 'Missing energy scale');
        check((await legend.locator('.theme-limits').innerText()).includes('Wh'), 'Missing scale units');
        check((await legend.locator('.legend-no-data').innerText()) === 'No data', 'Missing no-data swatch');
      } else {
        const categories = legend.getByRole('checkbox');
        check(await categories.count() > 0, 'Category legend empty');
        check(await legend.locator('input:checked').count() === await categories.count(), 'Categories not initially selected');
        await categories.first().uncheck();
        check(await legend.locator('input:checked').count() === await categories.count() - 1, 'Category toggle failed');
        await legend.getByRole('button', { name: 'Clear all', exact: true }).click();
        check(await legend.locator('input:checked').count() === 0 && await legend.isVisible(), 'Clear all hides legend or leaves selections');
        await legend.getByRole('button', { name: 'Select all', exact: true }).click();
        check(await legend.locator('input:checked').count() === await categories.count(), 'Select all failed');
      }
      await openLayers();
      const activeButton = picker.getByRole('button', { name, exact: true });
      await activeButton.focus(); await activeButton.press('Enter');
      check(await picker.locator('.building-layer-choices button[aria-pressed="true"]').count() === 0 && await legend.count() === 0, 'Repeated theme click did not restore default appearance');
      await choose(name);
      if (!['Heat demand', 'Solar radiation'].includes(name)) check(await legend.locator('input:checked').count() === await legend.getByRole('checkbox').count(), 'Reactivated theme did not restore category filters');
    }
    await choose('Use');
    await page.screenshot({ path: 'output/playwright/building-legend-928.png' });
    await openLayers();
    await picker.locator('details[name="exploration"]').first().locator(':scope > summary').click();
    await picker.getByRole('checkbox', { name: '3D buildings', exact: true }).uncheck();
    check(await legend.count() === 0, 'Legend remains when buildings hidden');
    await picker.getByRole('checkbox', { name: '3D buildings', exact: true }).check();
    await openLayers();
    const useGroup = picker.locator('details[name="exploration"]').nth(2);
    if (!await useGroup.evaluate(element => element.open)) await useGroup.locator(':scope > summary').click();
    await useGroup.getByRole('button', { name: 'Use', exact: true }).click();
    check(await legend.count() === 0, 'Active theme toggle retains legend');
    check(await picker.locator('.building-layer-choices button[aria-pressed="true"]').count() === 0, 'Default appearance has a pressed theme');
    await choose('Use');
    const search = page.getByRole('searchbox', { name: 'Vehicle, route, building, address or station' });
    await search.fill('Mannerheimintie');
    await page.locator('.search-results').getByRole('button', { name: /Helsinki Mannerheimintie/ }).click();
    await page.locator('#identity-inspector').waitFor();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 928, height: 1104 }, { width: 390, height: 844 }, { width: 1000, height: 450 }]) {
      await page.setViewportSize(viewport);
      if (viewport.width < 1200) {
        if (!await body.isVisible()) {
          if (await page.locator('#legend-trigger').isVisible()) await page.locator('#legend-trigger').click();
          else { await trigger.click(); await page.getByRole('button', { name: 'View legend', exact: true }).click(); }
        }
        check(await body.isVisible() && !await page.locator('#identity-inspector').isVisible(), 'Shared panel overlaps inspector');
        check((await legend.locator('.layer-control').first().boundingBox()).height >= 44, 'Category target too small');
      }
      await bounds();
      check(await body.evaluate(element => element.scrollHeight > element.clientHeight), 'Long category list does not scroll');
      await page.screenshot({ path: `output/playwright/building-legend-${viewport.width}-inspector.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#context-trigger').click();
    await page.getByRole('button', { name: 'Close inspector sheet' }).click();
    check(!await page.locator('#identity-inspector').isVisible(), 'Inspector sheet remains open');
    await page.locator('#context-trigger').click();
    check((await page.locator('#identity-inspector').innerText()).includes('Helsinki Mannerheimintie'), 'Closing sheet cleared selection');
    await choose('Heating method');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Data & sources', exact: true }).click();
    const sources = page.locator('#sources'); await sources.waitFor();
    const sourceText = await sources.innerText();
    check(!/Juxtaposed weather|Motion buffer:|Exact identifier joins only|Energy months are historical/.test(sourceText), 'Source explanations remain');
    check(sourceText.includes('CC BY 4.0') && await sources.locator('a[href]').count() > 0, 'Attribution or source links lost');
    await sources.getByRole('button', { name: 'Close sources' }).click();
    for (mode of ['equal', 'missing', 'stale', 'unavailable']) {
      await reload();
      if (mode === 'unavailable') {
        await openLayers();
        const energyGroup = picker.locator('details[name="exploration"]').filter({ has: page.getByRole('button', { name: 'Heat demand', exact: true, includeHidden: true }) });
        if (!await energyGroup.evaluate(element => element.open)) await energyGroup.locator(':scope > summary').click();
        check(await picker.getByRole('button', { name: 'Heat demand', exact: true }).isDisabled(), 'Unavailable layer selectable');
        check(await legend.count() === 0, 'Unavailable layer has a legend');
        continue;
      }
      await choose('Heat demand');
      if (mode === 'equal') {
        check(await legend.locator('.theme-limits span').count() === 1, 'Equal range repeats endpoints');
        check(!await legend.locator('.theme-gradient').evaluate(element => element.style.background.includes('gradient')), 'Equal range uses multiple colors');
      }
      if (mode === 'missing') check((await legend.innerText()).includes('No values available.'), 'Missing-value state absent');
      if (mode === 'stale') check((await legend.innerText()).includes('Fixture catalog refresh unavailable'), 'Catalog failure message lost');
    }
    return { layers: 6, categoryControls: true, visibility: true, viewports: 4, keyboard: true, inspectorPreserved: true, equalRange: true, missingValues: true, staleStatus: true, unavailable: true, notesRemoved: true, attributionPreserved: true };
  } finally {
    await page.unroute('**/api/catalog/status', catalogRoute);
    await page.setViewportSize(originalViewport); await page.reload();
  }
}
