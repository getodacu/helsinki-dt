// Bounded observation fixtures exercise values and refresh failures without provider dependence.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize(), sensors = page.locator('.sensor-readings');
  const sourceSnapshot = await (await page.request.get(new URL('/api/observations', page.url()).href)).json();
  let mode = 'current';
  const observationsRoute = route => {
    if (mode === 'failed') return route.fulfill({ status: 503, body: 'Fixture observation refresh unavailable' });
    const now = Date.now(), time = new Date(now - (mode === 'stale' ? 3 * 3600_000 : 120_000)).toISOString();
    const observations = [['t2m', 'degC'], ['ws_10min', 'm/s'], ['wg_10min', 'm/s'], ['r_1h', 'mm'], ['NO2_PT1H_avg', 'ug/m3']].flatMap(([parameter, unit]) => Array.from({ length: parameter === 'NO2_PT1H_avg' || parameter === 'r_1h' ? 6 : 36 }, (_, index) => ({
      parameter, unit, value: mode === 'missing' ? null : 0, observedAt: new Date(Date.parse(time) - index * (parameter === 'NO2_PT1H_avg' || parameter === 'r_1h' ? 3600_000 : 600_000)).toISOString(), receivedAt: new Date(now).toISOString(),
      stationId: parameter === 'NO2_PT1H_avg' ? '100742' : '100971',
      stationName: parameter === 'NO2_PT1H_avg' ? 'Helsinki Mannerheimintie' : 'Helsinki Kaisaniemi',
      longitude: 24.94, latitude: 60.17, sourceId: parameter === 'NO2_PT1H_avg' ? 'fmi-air-quality' : 'fmi-weather', quality: null, aggregation: null
    })));
    if (mode === 'newer-missing') observations.push(...observations.map(value => ({ ...value, value: null, observedAt: new Date(now - 60_000).toISOString() })));
    const sources = sourceSnapshot.sources.map(source => ({ ...source, state: 'current', observedAt: time, lastError: null }));
    return route.fulfill({ json: { ...sourceSnapshot, generatedAt: new Date(now).toISOString(), observations, sources } });
  };
  const refresh = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/observations');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response;
  };
  const state = expected => page.waitForFunction(expected => [...document.querySelectorAll('.sensor-reading')].every(element => element.dataset.state === expected), expected);
  try {
    await page.route('**/api/observations', observationsRoute);
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await state('current');
    check((await sensors.locator('strong').allTextContents()).join('|') === '0°C|0m/s|0µg/m³', 'Zero readings or units lost');
    for (const button of await sensors.getByRole('button').all()) {
      check((await button.getAttribute('aria-label')).includes('Observed') && (await button.getAttribute('title')).includes('FMI Open Data'), 'Sensor provenance missing');
    }
    const inspector = page.locator('#identity-inspector'), heading = inspector.locator('#inspection-heading');
    const sizes = [{ width: 1440, height: 900 }, { width: 1032, height: 1104 }, { width: 390, height: 844 }];
    let scrollChecks = 0;
    for (const size of sizes) {
      await page.setViewportSize(size);
      for (const parameter of ['t2m', 'ws_10min', 'NO2_PT1H_avg']) {
        const sensor = sensors.locator(`[data-parameter="${parameter}"]`);
        await sensor.focus(); await sensor.press('Enter'); await inspector.waitFor();
        check(await inspector.locator(':scope > .mobile-sheet-heading, :scope > .panel-heading').count() === 0, 'Observation header bars remain');
        check(await inspector.getByRole('button', { name: 'Clear selection', exact: true }).count() === 1 && await inspector.locator('.icon-button').count() === 1, 'Observation close button duplicated');
        check(await heading.evaluate(element => element.tagName === 'H3' && element === document.activeElement), 'Station name not focused');
        check(await inspector.locator('.history-section').count() > 0, 'Station histories missing');
        const styles = await inspector.evaluate(element => ({
          scrollbar: getComputedStyle(element).scrollbarWidth,
          webkit: getComputedStyle(element, '::-webkit-scrollbar').display,
          rows: [...element.querySelectorAll('.properties > div')].every(row => getComputedStyle(row).borderBottomWidth === '0px'),
          sections: [...element.querySelectorAll('.history-section')].every(section => getComputedStyle(section).borderTopWidth === '0px'),
          gutter: element.offsetWidth - element.clientWidth - parseFloat(getComputedStyle(element).borderLeftWidth) - parseFloat(getComputedStyle(element).borderRightWidth),
          overflows: element.scrollHeight > element.clientHeight
        }));
        check(styles.scrollbar === 'none' && styles.webkit === 'none' && styles.gutter <= 1, 'Inspector scrollbar area remains');
        check(styles.rows && styles.sections, 'Observation separators remain');
        if (styles.overflows) {
          const box = await inspector.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 350);
          await page.waitForFunction(() => document.querySelector('#identity-inspector').scrollTop > 0);
          await heading.focus(); await inspector.evaluate(element => element.scrollTo({ top: 0 }));
          await page.keyboard.press('PageDown');
          await page.waitForFunction(() => document.querySelector('#identity-inspector').scrollTop > 0);
          scrollChecks++;
        }
        const chart = inspector.getByRole('slider').first();
        await chart.focus(); await chart.press('Home'); check(await chart.getAttribute('aria-valuenow') === '0', 'History keyboard navigation lost');
        check(await chart.evaluate(element => getComputedStyle(element).outlineStyle !== 'none'), 'History focus outline removed');
        if (size.width < 1200) {
          await heading.focus(); await page.keyboard.press('Escape');
          check(!await inspector.isVisible() && await sensor.evaluate(element => element === document.activeElement), 'Escape focus restoration lost');
          await page.locator('#context-trigger').click();
          check(await inspector.isVisible() && await heading.evaluate(element => element === document.activeElement), 'Inspect reopening lost focus');
          await page.locator('#context-trigger').click(); check(!await inspector.isVisible(), 'Inspect toggle did not dismiss');
          await page.locator('#context-trigger').click();
        }
        await inspector.getByRole('button', { name: 'Clear selection', exact: true }).click();
        check(await inspector.count() === 0 && await page.locator('#context-trigger').count() === 0, 'Close did not clear selection');
        check(await page.locator('#city-search').evaluate(element => element === document.activeElement), 'Clear-selection focus lost');
        await page.keyboard.press('Escape');
      }
    }
    check(scrollChecks > 0, 'Overflow scrolling not exercised');
    await page.setViewportSize({ width: 390, height: 844 });
    const wind = sensors.locator('[data-parameter="ws_10min"]');
    await wind.focus(); await wind.press('Enter');
    await inspector.waitFor();
    check((await inspector.innerText()).includes('Wind speed') && await inspector.locator('.history-section').count() > 0, 'Wind station history lost');
    await page.keyboard.press('Escape'); check(await wind.evaluate(element => element === document.activeElement), 'Wind focus not restored');
    mode = 'failed'; await refresh(); await state('stale');
    check((await sensors.locator('strong').allTextContents()).join('|') === '0°C|0m/s|0µg/m³', 'Failed refresh discarded retained values');
    check((await wind.getAttribute('aria-label')).includes('503') && (await wind.innerText()).includes('stale'), 'Failed refresh not exposed');
    mode = 'current'; await refresh(); await state('current');
    mode = 'stale'; await refresh(); await state('stale');
    check(await sensors.locator('small').count() === 3, 'Dated readings lack visible stale labels');
    await wind.click(); await inspector.waitFor();
    mode = 'missing'; await refresh(); await state('unavailable');
    check(await inspector.locator(':scope > .mobile-sheet-heading, :scope > .panel-heading').count() === 0 && (await heading.innerText()).includes('Helsinki Kaisaniemi'), 'Unavailable readings restored header bars');
    await inspector.getByRole('button', { name: 'Clear selection', exact: true }).click();
    check((await sensors.locator('strong').allTextContents()).join('|') === '—|—|—', 'Missing readings invented values');
    for (const button of await sensors.getByRole('button').all()) check(await button.isDisabled(), 'Missing reading opens inspection');
    mode = 'newer-missing'; await refresh(); await state('current');
    check((await wind.getAttribute('aria-label')).includes('newest reading is missing') && (await wind.locator('strong').innerText()) === '0m/s', 'Latest valid reading fallback lost');
    return { layouts: sizes.length, inspectorCleanup: true, scrollChecks, sensors: 3, zeroValues: true, units: true, provenance: true, windHistory: true, failedRefreshRetained: true, recovery: true, stale: true, missing: true, latestValid: true };
  } finally {
    await page.unroute('**/api/observations', observationsRoute);
    await page.setViewportSize(viewport); await page.reload();
  }
}
