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
  const temperature = sensors.locator('[data-parameter="t2m"]');
  const presets = page.getByRole('navigation', { name: 'Camera presets' });
  const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 1032, height: 1104 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
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
    check(await layers.locator(':scope > .panel-heading').count() === 0, 'Redundant exploration heading remains');
    check(await layers.locator('details[name="exploration"]').count() === 4, 'Environment controls remain');
    check(await layers.locator('details[name="exploration"]').first().evaluate(element => element.open), 'Map is not initially expanded');
    for (const size of sizes) {
      await page.setViewportSize(size);
      check(await page.getByRole('button', { name: 'Help using the city' }).count() === 0, 'Help button remains');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page overflows');
      await sizeCheck(page.locator('.masthead')); await sizeCheck(presets); await sizeCheck(sensors);
      const sensorBox = await sensors.boundingBox();
      check(Math.round(sensorBox.width) === 260 && Math.round(sensorBox.height) === 52, 'Sensor display is not compact');
      for (const button of [...await sensors.getByRole('button').all(), ...await presets.getByRole('button').all()]) check((await button.boundingBox()).height >= 44, 'Touch target too small');
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
    return { layouts: sizes.length, sensors: 3, panels: true, selectionPreserved: true, keyboard: true, reducedMotion: true, cameraPresets: true };
  } finally {
    await page.unroute('**/api/observations', observationsRoute);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize(original); await page.reload();
  }
}
