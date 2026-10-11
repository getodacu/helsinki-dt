// Run with playwright-cli run-code --filename against the local app.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const original = page.viewportSize();
  const snapshot = await (await page.request.get(new URL('/api/observations', page.url()).href)).json();
  const observationsRoute = route => {
    const time = new Date(Date.now() - 120_000).toISOString();
    const observations = [['t2m', 'degC', 6.5], ['ws_10min', 'm/s', 2.9], ['NO2_PT1H_avg', 'ug/m3', 15.2]].map(([parameter, unit, value]) => ({
      parameter, unit, value, observedAt: time, receivedAt: time, quality: null, aggregation: null,
      stationId: parameter === 'NO2_PT1H_avg' ? '100742' : '100971',
      stationName: parameter === 'NO2_PT1H_avg' ? 'Helsinki Mannerheimintie' : 'Helsinki Kaisaniemi',
      longitude: 24.94, latitude: 60.17, sourceId: parameter === 'NO2_PT1H_avg' ? 'fmi-air-quality' : 'fmi-weather'
    }));
    return route.fulfill({ json: { ...snapshot, observations, sources: snapshot.sources.map(source => ({ ...source, state: 'current', lastError: null })) } });
  };

  const sensors = page.locator('.sensor-readings'), inspector = page.locator('#identity-inspector');
  const layers = page.locator('#exploration-panel'), context = page.locator('#context-trigger');
  const desktopLayers = page.locator('#desktop-layers-trigger');
  const minimizeLayers = page.locator('#desktop-layers-minimize');
  const temperature = sensors.locator('[data-parameter="t2m"]');
  const presets = page.getByRole('navigation', { name: 'Camera presets' });
  const sizes = [{ width: 1440, height: 900 }, { width: 1283, height: 1104 }, { width: 1280, height: 720 }, { width: 1200, height: 900 }, { width: 1199, height: 900 }, { width: 1024, height: 768 }, { width: 1032, height: 1104 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
  const sizeCheck = async locator => {
    const box = await locator.boundingBox(), size = page.viewportSize();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, 'Panel leaves viewport');
    check(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Panel overflows horizontally');
  };
  const separated = async locator => {
    const a = await sensors.boundingBox(), b = await locator.boundingBox();
    check(a && b && (a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y), 'Sensor display overlaps an open panel');
  };
  try {
    await page.route('**/api/observations', observationsRoute);
    await page.setViewportSize(sizes[0]); await page.reload();
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-ready') === 'true');
    await sensors.waitFor();
    check(await sensors.getByRole('button').count() === 3, 'Sensor display incomplete');
    check(await page.locator('#city-overview').count() === 0 && await context.count() === 0, 'Overview navigation remains');
    check(await layers.locator(':scope > .desktop-layers-heading').count() === 1, 'Menu minimize heading missing');
    check(await layers.locator('details[name="exploration"]').count() === 4, 'Environment controls remain');
    check(await layers.locator('details[name="exploration"]').first().evaluate(element => element.open), 'Map is not initially expanded');
    check(await layers.isVisible() && await minimizeLayers.isVisible() && !await desktopLayers.isVisible(), 'Expanded menu should show only minimize icon');
    check(await minimizeLayers.getAttribute('aria-label') === 'Minimize layers menu' && await minimizeLayers.getAttribute('aria-controls') === 'exploration-panel', 'Minimize icon accessibility missing');
    check(await desktopLayers.getAttribute('aria-controls') === 'exploration-panel', 'Desktop toggle does not identify menu');
    check((await minimizeLayers.boundingBox()).height >= 44, 'Minimize target too small');
    const terrain = layers.getByRole('checkbox', { name: 'Land & islands', exact: true, includeHidden: true });
    await terrain.uncheck();
    const buildingsGroup = layers.locator('details[name="exploration"]').nth(2);
    await buildingsGroup.locator(':scope > summary').click();
    const useTheme = layers.getByRole('button', { name: 'Use', exact: true, includeHidden: true });
    await useTheme.click();
    const legend = page.locator('.building-layer-legend');
    await legend.waitFor();
    const menuScroll = await layers.evaluate(element => element.scrollTop);
    await minimizeLayers.focus(); await minimizeLayers.press('Enter');
    check(!await layers.isVisible() && await desktopLayers.getAttribute('aria-expanded') === 'false', 'Desktop menu did not minimize');
    check(await desktopLayers.getAttribute('aria-label') === 'Show layers', 'Minimized toggle label wrong');
    check(await desktopLayers.isVisible() && !await minimizeLayers.isVisible() && (await desktopLayers.innerText()).includes('+'), 'Minimized menu should show Layers + only');
    check((await desktopLayers.boundingBox()).height >= 44, 'Show layers target too small');
    check(await page.locator('.console-intro').isVisible() && await legend.isVisible(), 'Minimizing hides introduction or legend');
    check(await desktopLayers.evaluate(element => element === document.activeElement), 'Minimizing loses toggle focus');
    const mapExposed = await page.evaluate(() => {
      const box = document.querySelector('.left-stack').getBoundingClientRect();
      const element = document.elementFromPoint(box.x + box.width / 2, box.bottom - 10);
      return !!element?.closest('.scene-canvas');
    });
    check(mapExposed, 'Minimized menu still blocks map interaction');
    await desktopLayers.press('Space');
    check(await layers.isVisible() && await minimizeLayers.isVisible() && !await desktopLayers.isVisible(), 'Space did not restore minimize icon');
    check(await minimizeLayers.evaluate(element => element === document.activeElement), 'Reopening did not focus minimize icon');
    check(!await terrain.isChecked() && await useTheme.getAttribute('aria-pressed') === 'true', 'Layer or theme state lost');
    check(await buildingsGroup.evaluate(element => element.open), 'Open accordion section lost');
    check(await layers.evaluate(element => element.scrollTop) === menuScroll, 'Menu scroll position lost');
    await minimizeLayers.click();
    for (const width of [1199, 390]) {
      await page.setViewportSize({ width, height: 900 });
      check(!await desktopLayers.isVisible() && !await minimizeLayers.isVisible(), 'Desktop layers controls remain on mobile');
      await page.locator('#layers-trigger').click();
      check(await layers.isVisible(), 'Desktop minimized state blocks mobile Layers');
      check(!await terrain.isChecked() && await useTheme.getAttribute('aria-pressed') === 'true', 'Resizing resets layer state');
      await page.getByRole('button', { name: 'Close exploration panel', exact: true }).click();
      check(!await layers.isVisible(), 'Mobile close stopped working');
    }
    await page.setViewportSize(sizes[0]);
    check(!await layers.isVisible() && await desktopLayers.getAttribute('aria-expanded') === 'false', 'Returning to desktop loses minimized state');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-ready') === 'true');
    check(await layers.isVisible() && await minimizeLayers.isVisible() && !await desktopLayers.isVisible(), 'Reload did not restore open menu with minimize icon');
    for (const size of sizes) {
      await page.setViewportSize(size);
      check(await page.getByRole('button', { name: 'Help using the city' }).count() === 0, 'Help button remains');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page overflows');
      await sizeCheck(page.locator('.masthead')); await sizeCheck(presets); await sizeCheck(sensors);
      const sensorBox = await sensors.boundingBox();
      check(Math.round(sensorBox.width) === 260 && Math.round(sensorBox.height) === 52, 'Sensor display is not compact');
      for (const button of await sensors.getByRole('button').all()) check((await button.boundingBox()).height >= 44, 'Sensor target too small');
      for (const button of await presets.getByRole('button').all()) check((await button.boundingBox()).height >= (size.width >= 1200 ? 44 : 32), 'Camera preset target too small');
      if (size.width >= 1200) {
        check(Math.round((await page.locator('.left-stack').boundingBox()).width) === 280, 'Wrong exploration width');
        await sizeCheck(layers);
      } else {
        await page.locator('#layers-trigger').focus(); await page.keyboard.press('Enter');
        await layers.waitFor(); await sizeCheck(page.locator('.left-stack')); await separated(page.locator('.left-stack'));
        check(!await presets.isVisible() && await sensors.isVisible(), 'Compact panel overlap');
        check(await page.locator('#exploration-heading').evaluate(element => element === document.activeElement), 'Layers heading not focused');
        await page.keyboard.press('Escape'); check(!await layers.isVisible() && await presets.isVisible(), 'Escape did not close panel');
        check(await page.locator('#layers-trigger').evaluate(element => element === document.activeElement), 'Panel trigger focus not restored');
      }
      await temperature.focus(); await temperature.press('Enter'); await inspector.waitFor();
      await sizeCheck(page.locator('.right-stack')); await separated(page.locator('.right-stack'));
      if (size.width >= 1200) check(Math.round((await page.locator('.right-stack').boundingBox()).width) === 340, 'Wrong inspector width');
      else {
        check(await context.innerText() === 'Inspect', 'Inspection navigation missing');
        await page.locator('#context-trigger').click();
        check(!await inspector.isVisible(), 'Closing sheet failed');
        check(await temperature.evaluate(element => element === document.activeElement), 'Sensor opener focus not restored');
        await context.click(); check((await inspector.innerText()).includes('Helsinki Kaisaniemi'), 'Selection not retained');
      }
      await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
      check(await context.count() === 0, 'Clearing selection retains Inspect');
      check(await page.locator('#city-search').evaluate(element => element === document.activeElement), 'Clearing selection lost focus');
      await page.screenshot({ path: `output/playwright/ocean-sensors-${size.width}x${size.height}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await temperature.click(); await inspector.waitFor();
    check(await inspector.locator('.history-section').count() > 0, 'Station history lost');
    await page.keyboard.press('Escape');
    await page.locator('#layers-trigger').click();
    await temperature.click(); await inspector.waitFor();
    check(await page.locator('#inspection-heading').evaluate(element => element === document.activeElement), 'Retained station inspector not focused');
    await page.locator('#project-menu-trigger').click(); await page.keyboard.press('Escape');
    check(await inspector.isVisible(), 'Project popover Escape closed inspection');
    await page.setViewportSize(sizes[0]);
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
    for (const name of ['Harbour', 'Central Station', 'City Centre']) {
      await presets.getByRole('button', { name, exact: true }).click();
      check(await presets.getByRole('button', { name, exact: true }).getAttribute('aria-pressed') === 'true', 'Preset state lost');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(await page.locator('.layer-control').first().evaluate(element => getComputedStyle(element).transitionDuration === '0s'), 'Reduced motion ignored');
    await page.waitForTimeout(1200);
    const flag = page.locator('.station-flag.weather'), before = await flag.getAttribute('style');
    const search = page.getByRole('searchbox');
    for (const control of [search, page.getByRole('tabpanel'), temperature, layers.locator('details[name="exploration"]').first().locator(':scope > summary')]) {
      await control.focus(); await page.keyboard.down('w'); await page.waitForTimeout(600); await page.keyboard.up('w');
      check(await flag.getAttribute('style') === before, `Typing in ${await control.getAttribute('id') || 'sensor reading'} pans the camera`);
    }
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.down('w'); await page.waitForTimeout(600); await page.keyboard.up('w');
    check(await flag.getAttribute('style') !== before, 'Map keyboard navigation stopped working');
    await search.fill(''); await page.keyboard.press('Escape');
    return { layouts: sizes.length, desktopLayers: true, layerStatePreserved: true, sensors: 3, panels: true, selectionPreserved: true, keyboard: true, reducedMotion: true, cameraPresets: true };
  } finally {
    await page.unroute('**/api/observations', observationsRoute);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize(original); await page.reload();
  }
}
