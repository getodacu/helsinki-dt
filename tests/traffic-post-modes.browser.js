// Run with playwright-cli run-code --filename=tests/traffic-post-modes.browser.js.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize();
  const counter = { id: 'EcoCounter:99999', upstreamId: '99999', source: 'EcoCounter', sourceId: null,
    name: 'Traffic mode fixture', longitude: 24.94, latitude: 60.1695, modes: ['vehicles', 'cycling', 'walking'], firstObservedAt: null, lastObservedAt: null };
  const snapshot = () => {
    const generatedAt = new Date().toISOString();
    return { generatedAt, state: 'ready', counters: [counter], sources: [], error: null,
      summaries: counter.modes.map(mode => {
        const latest = { counterId: counter.id, mode, observedAt: new Date(Date.now() - 900_000).toISOString(), retrievedAt: generatedAt,
          durationSeconds: 900, value: 12, hourlyEquivalent: 48, complete: true };
        return { counterId: counter.id, mode, latest, maximum: latest, partial: false };
      }) };
  };
  const snapshotRoute = route => route.fulfill({ json: snapshot() });
  const detailRoute = route => { const data = snapshot(); return route.fulfill({ json: { ...data, counter, counts: data.summaries.map(row => row.latest), measurements: [],
    window: { start: new Date(Date.now() - 86400_000).toISOString(), end: data.generatedAt }, retrievedAt: data.generatedAt } }); };
  const flag = page.locator('.station-flag.traffic-counter');
  try {
    await page.route('**/api/traffic-measurements', snapshotRoute);
    await page.route('**/api/traffic-measurements/counters/*', detailRoute);
    const hydrated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/traffic-measurements');
    await page.reload(); await hydrated;
    await page.waitForFunction(() => document.querySelector('main')?.dataset.sceneReady === 'true');
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.locator('#city-search').click(); await page.locator('#city-search').fill('99999');
      await page.getByRole('tab', { name: 'Stations', exact: true }).click();
      await page.locator('#city-search-panel-stations .object-list > button').first().click();
      await page.waitForFunction(() => {
        const position = document.querySelector('.station-flag.traffic-counter')?.style.transform.match(/translate3d\(([-\d.]+)px/);
        return position && Math.abs(Number(position[1]) - document.querySelector('.scene-canvas').clientWidth / 2) < 2;
      });
      await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
      if (size.width < 1200) await page.locator('#layers-trigger').click();
      else if (await page.locator('#desktop-layers-trigger').isVisible()) await page.locator('#desktop-layers-trigger').click();
      const transport = page.locator('details[name="exploration"]').filter({ has: page.locator('summary', { hasText: 'Transport' }) });
      if (!await transport.evaluate(element => element.open)) await transport.locator('summary').first().click();
      const chooser = page.getByLabel('Measurement mode');
      await flag.waitFor();
      const original = await flag.elementHandle(), icons = new Set();
      for (const [mode, label] of [['vehicles', 'Vehicle'], ['cycling', 'Bicycle'], ['walking', 'Pedestrian'], ['vehicles', 'Vehicle']]) {
        await chooser.selectOption(mode);
        await page.waitForFunction(mode => document.querySelector('.station-flag.traffic-counter')?.dataset.mode === mode, mode);
        check(await original.evaluate(element => element.isConnected && element === document.querySelector('.station-flag.traffic-counter')), 'Mode switch replaced the existing post');
        check(await flag.locator('small').innerText() === label, 'Incorrect mode label');
        check((await flag.getAttribute('aria-label')).startsWith(`${label} counter ·`), 'Accessible mode description stale');
        const layout = await flag.evaluate(element => {
          const text = element.querySelector('small'), icon = element.querySelector('svg'), range = document.createRange();
          range.selectNodeContents(text);
          const bounds = element.getBoundingClientRect(), textBounds = range.getBoundingClientRect(), graphic = icon.getBoundingClientRect();
          return { width: element.offsetWidth, height: element.offsetHeight, pole: getComputedStyle(element, '::after').height,
            color: getComputedStyle(element).color, iconWidth: graphic.width, iconHeight: graphic.height,
            fits: textBounds.left >= bounds.left + 3 && textBounds.right <= bounds.right - 3 && text.scrollWidth <= text.clientWidth,
            casing: getComputedStyle(text).textTransform };
        });
        check(layout.width === 44 && layout.height === 48 && layout.pole === '14px', 'Incorrect smaller dimensions');
        check(layout.iconWidth === 18 && layout.iconHeight === 18, 'Incorrect icon dimensions');
        check(layout.color === 'rgb(239, 68, 68)' && layout.casing === 'none' && layout.fits, `${label} label is clipped or styling changed`);
        icons.add(await flag.locator('svg').innerHTML());
        await page.locator(size.width < 1200 ? '#layers-trigger' : '#desktop-layers-minimize').click();
        await page.screenshot({ path: `output/playwright/traffic-${mode}-${size.width}.png` });
        await page.locator(size.width < 1200 ? '#layers-trigger' : '#desktop-layers-trigger').click();
      }
      check(icons.size === 3, 'Modes do not have distinct icons');
    }
    return { layouts: 2, modes: 3, reusedButton: true, labelsFit: true, accessibleModes: true, smallerGeometry: true, redAccents: true };
  } finally {
    await page.unroute('**/api/traffic-measurements', snapshotRoute);
    await page.unroute('**/api/traffic-measurements/counters/*', detailRoute);
    await page.setViewportSize(viewport); await page.reload();
  }
}
