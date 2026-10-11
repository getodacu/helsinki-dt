// Bounded observation fixtures exercise values and refresh failures without provider dependence.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize(), sensors = page.locator('.sensor-readings');
  const sourceSnapshot = await (await page.request.get(new URL('/api/observations', page.url()).href)).json();
  let mode = 'current';
  const observationsRoute = route => {
    if (mode === 'failed') return route.fulfill({ status: 503, body: 'Fixture observation refresh unavailable' });
    const now = Date.now(), time = new Date(now - (mode === 'stale' ? 3 * 3600_000 : 120_000)).toISOString();
    const observations = [['t2m', 'degC'], ['ws_10min', 'm/s'], ['NO2_PT1H_avg', 'ug/m3']].map(([parameter, unit]) => ({
      parameter, unit, value: mode === 'missing' ? null : 0, observedAt: time, receivedAt: new Date(now).toISOString(),
      stationId: parameter === 'NO2_PT1H_avg' ? '100742' : '100971',
      stationName: parameter === 'NO2_PT1H_avg' ? 'Helsinki Mannerheimintie' : 'Helsinki Kaisaniemi',
      longitude: 24.94, latitude: 60.17, sourceId: parameter === 'NO2_PT1H_avg' ? 'fmi-air-quality' : 'fmi-weather', quality: null, aggregation: null
    }));
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
    const wind = sensors.locator('[data-parameter="ws_10min"]');
    await wind.focus(); await wind.press('Enter');
    const inspector = page.locator('#identity-inspector'); await inspector.waitFor();
    check((await inspector.innerText()).includes('Wind speed') && await inspector.locator('.history-section').count() > 0, 'Wind station history lost');
    await page.keyboard.press('Escape'); check(await wind.evaluate(element => element === document.activeElement), 'Wind focus not restored');
    mode = 'failed'; await refresh(); await state('stale');
    check((await sensors.locator('strong').allTextContents()).join('|') === '0°C|0m/s|0µg/m³', 'Failed refresh discarded retained values');
    check((await wind.getAttribute('aria-label')).includes('503') && (await wind.innerText()).includes('stale'), 'Failed refresh not exposed');
    mode = 'current'; await refresh(); await state('current');
    mode = 'stale'; await refresh(); await state('stale');
    check(await sensors.locator('small').count() === 3, 'Dated readings lack visible stale labels');
    mode = 'missing'; await refresh(); await state('unavailable');
    check((await sensors.locator('strong').allTextContents()).join('|') === '—|—|—', 'Missing readings invented values');
    for (const button of await sensors.getByRole('button').all()) check(await button.isDisabled(), 'Missing reading opens inspection');
    mode = 'newer-missing'; await refresh(); await state('current');
    check((await wind.getAttribute('aria-label')).includes('newest reading is missing') && (await wind.locator('strong').innerText()) === '0m/s', 'Latest valid reading fallback lost');
    return { sensors: 3, zeroValues: true, units: true, provenance: true, windHistory: true, failedRefreshRetained: true, recovery: true, stale: true, missing: true, latestValid: true };
  } finally {
    await page.unroute('**/api/observations', observationsRoute);
    await page.setViewportSize(viewport); await page.reload();
  }
}
