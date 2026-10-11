// Run with playwright-cli run-code --filename against the local app.
// Catalog fixtures exercise long labels, equal ranges, missing values and stale status.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const picker = page.locator('#layers-dialog'), legend = page.locator('.building-layer-legend');
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
  const choose = async name => {
    await trigger.click(); await picker.waitFor();
    check(await picker.locator('.panel-note, .ryhti-legend, .theme-gradient').count() === 0, 'Legend or notes remain in picker');
    await picker.getByRole('button', { name, exact: true }).click();
    await picker.waitFor({ state: 'detached' });
    check(await trigger.evaluate(element => element === document.activeElement), 'Layer selection did not restore focus');
    if (name !== 'Default appearance') {
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
        inspectorBottom: inspector && getComputedStyle(inspector).display !== 'none' ? inspector.getBoundingClientRect().bottom : null };
    });
    const viewport = page.viewportSize();
    check(result.legend.x >= 0 && result.legend.right <= viewport.width && result.legend.y >= 0 && result.legend.bottom <= viewport.height, 'Legend leaves viewport');
    check(result.bodyHeight <= result.mapHeight * .4 + 1, 'Legend body exceeds 40% of map height');
    check(result.bodyScrollWidth <= result.bodyWidth + 1, 'Category label creates horizontal overflow');
    if (result.inspectorBottom !== null) check(result.legend.y >= result.inspectorBottom + 6, 'Legend overlaps inspector');
  };
  try {
    if (await picker.count()) await picker.getByRole('button', { name: 'Close layers' }).click();
    await page.route('**/api/catalog/status', catalogRoute);
    await page.setViewportSize({ width: 928, height: 1104 });
    await reload();
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
    }
    await choose('Use');
    await page.screenshot({ path: 'output/playwright/building-legend-928.png' });
    await page.getByRole('button', { name: '3D buildings', exact: true }).click();
    check(await legend.count() === 0, 'Legend remains when buildings hidden');
    await page.getByRole('button', { name: '3D buildings', exact: true }).click(); await legend.waitFor();
    await choose('Default appearance'); check(await legend.count() === 0, 'Default appearance retains legend');
    await choose('Use');
    const search = page.getByRole('searchbox', { name: 'Vehicle, route, building, address or station' });
    await search.fill('Mannerheimintie');
    await page.locator('.search-results').getByRole('button', { name: /Helsinki Mannerheimintie/ }).click();
    await page.locator('#identity-inspector').waitFor();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 928, height: 1104 }, { width: 390, height: 844 }, { width: 1000, height: 450 }]) {
      await page.setViewportSize(viewport);
      const mobile = viewport.width <= 780 || viewport.width <= 1100 && viewport.height <= 500;
      if (mobile) {
        const toggle = legend.locator('.legend-toggle');
        if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
        check(!await body.isVisible(), 'Mobile legend starts expanded');
        await toggle.focus(); await page.keyboard.press('Enter'); check(await body.isVisible(), 'Keyboard expansion failed');
        check((await legend.locator('.layer-control').first().boundingBox()).height >= 44, 'Mobile category target too small');
        await toggle.focus(); await page.keyboard.press('Space'); check(!await body.isVisible(), 'Keyboard collapse failed');
        await toggle.click();
      }
      await bounds();
      check(await body.evaluate(element => element.scrollHeight > element.clientHeight), 'Long category list does not scroll');
      await page.screenshot({ path: `output/playwright/building-legend-${viewport.width}-inspector.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Close inspector sheet' }).click();
    check(await legend.isVisible() && !await page.locator('#identity-inspector').isVisible(), 'Closing inspector hides legend');
    await choose('Heating method'); check(!await body.isVisible(), 'Switching layers did not collapse mobile legend');
    await page.setViewportSize({ width: 928, height: 1104 });
    await page.locator('.map-appearance').getByRole('button', { name: 'Transport', exact: true }).click();
    const transport = page.locator('#transport-dialog'); await transport.waitFor();
    check(!(await transport.innerText()).includes('Transit models use real-world scale'), 'Transport explanation remains');
    await transport.getByRole('button', { name: 'Close transport' }).click();
    await page.getByRole('button', { name: 'Data & sources', exact: true }).click();
    const sources = page.locator('#sources'); await sources.waitFor();
    const sourceText = await sources.innerText();
    check(!/Juxtaposed weather|Motion buffer:|Exact identifier joins only|Energy months are historical/.test(sourceText), 'Source explanations remain');
    check(sourceText.includes('CC BY 4.0') && await sources.locator('a[href]').count() > 0, 'Attribution or source links lost');
    await sources.getByRole('button', { name: 'Close sources' }).click();
    for (mode of ['equal', 'missing', 'stale', 'unavailable']) {
      await reload();
      if (mode === 'unavailable') {
        await trigger.click(); await picker.waitFor();
        check(await picker.getByRole('button', { name: 'Heat demand', exact: true }).isDisabled(), 'Unavailable layer selectable');
        check(await legend.count() === 0, 'Unavailable layer has a legend');
        await picker.getByRole('button', { name: 'Close layers' }).click();
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
