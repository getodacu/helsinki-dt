// Run with playwright-cli run-code --filename=tests/traffic-measurements.browser.js.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const originalViewport = page.viewportSize(), requests = new Map();
  let held = null, releaseHeld = null, fixtureState = 'ready';
  const counters = [3869, 3870, 3871].map((id, index) => ({ id: `SmartJunction:${id}`, upstreamId: String(id), source: 'SmartJunction', sourceId: null,
    name: `vdetector.fixture.${index}.json`, longitude: 24.94, latitude: 60.1695, modes: ['vehicles'], firstObservedAt: null, lastObservedAt: null }));
  const history = (counter) => Array.from({ length: 8 }, (_, index) => ({ counterId: counter.id, mode: 'vehicles',
    observedAt: new Date(Date.now() - (8 - index) * 900_000).toISOString(), retrievedAt: new Date().toISOString(), durationSeconds: 900,
    value: index === 2 ? null : index === 3 ? 0 : index === 7 ? 12 + Number(counter.upstreamId) - 3869 : 20 + index,
    hourlyEquivalent: index === 2 ? null : index === 3 ? 0 : index === 7 ? (12 + Number(counter.upstreamId) - 3869) * 4 : (20 + index) * 4, complete: index !== 2 }));
  const summary = counter => { const rows = history(counter); return { counterId: counter.id, mode: 'vehicles', latest: rows.at(-1), maximum: rows[6], partial: fixtureState === 'partial' }; };
  const snapshot = () => ({ generatedAt: new Date().toISOString(), state: fixtureState === 'failed' ? 'partial' : fixtureState, counters, summaries: counters.map(summary), sources: [], error: null });
  const detail = counter => {
    const rows = history(counter), last = rows.at(-1);
    const measurement = (type, vehicleClass, value, unit) => ({ counterId: counter.id, source: counter.source, type, mode: 'vehicles', vehicleClass,
      direction: 'departing', value, unit, durationSeconds: 900, observedAt: last.observedAt, retrievedAt: last.retrievedAt });
    return { generatedAt: new Date().toISOString(), state: fixtureState, counter, counts: rows, summaries: [summary(counter)],
      measurements: [measurement('count', 'Passenger car', 11, 'n'), measurement('count', 'Short Truck', 1, 'n'), measurement('speed', 'Passenger car', 45, 'km/h')],
      window: { start: new Date(Date.now() - 86400_000).toISOString(), end: new Date().toISOString() }, retrievedAt: last.retrievedAt, error: null };
  };
  const snapshotRoute = route => route.fulfill({ json: snapshot() });
  const detailRoute = async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
    requests.set(id, (requests.get(id) ?? 0) + 1);
    if (id === held) await new Promise(resolve => releaseHeld = resolve);
    if (fixtureState === 'failed') { await route.fulfill({ status: 503, json: { error: 'Fixture history unavailable' } }).catch(() => {}); return; }
    await route.fulfill({ json: detail(counters.find(counter => counter.id === id)) }).catch(() => {});
  };
  const inspector = page.locator('#identity-inspector'), popup = page.locator('.traffic-history-popup');
  const heading = inspector.locator('#inspection-heading');
  const trigger = id => inspector.getByRole('button', { name: `Show last 24 hours for SmartJunction counter ${id}`, exact: true });
  const selectCounter = async () => {
    await page.locator('#city-search').click();
    await page.locator('#city-search').fill('3869');
    await page.getByRole('tab', { name: 'Stations', exact: true }).click();
    await page.locator('#city-search-panel-stations .object-list > button').first().click();
    await inspector.waitFor();
    await inspector.getByRole('table', { name: 'Traffic measurement breakdown' }).waitFor();
  };
  try {
    await page.route('**/api/traffic-measurements', snapshotRoute);
    await page.route('**/api/traffic-measurements/counters/*', detailRoute);
    const hydrated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/traffic-measurements');
    await page.reload(); await hydrated;
    const layouts = [{ width: 1440, height: 900 }, { width: 1187, height: 1104 }, { width: 390, height: 844 }];
    for (const size of layouts) {
      await page.setViewportSize(size);
      await selectCounter();
      check(await heading.innerText() === 'SmartJunction · counter 3869', 'Source/counter title missing');
      check(await heading.evaluate(element => document.activeElement === element), 'Inspector title not focused');
      check(await inspector.locator('.mobile-sheet-heading, select').count() === 0, 'Duplicate heading or dropdown remains');
      check(await inspector.getByRole('button', { name: 'Clear selection', exact: true }).count() === 1, 'Close button duplicated');
      check(await inspector.locator('.counter-summaries tbody tr').count() === 3, 'Colocated summaries missing');
      for (const [index, id] of [3869, 3870, 3871].entries()) {
        const values = await trigger(id).locator('xpath=ancestor::tr').innerText();
        check(values.includes(`${12 + index} / 15 min`) && values.includes(String((12 + index) * 4)), 'A counter summary shows another counter’s values');
      }
      check(await inspector.locator('.history-section').count() === 0, 'Inline history remains');
      const content = await inspector.innerText();
      check(!/vdetector|Peak measured|Retrieved|Age|Available speeds|Unknown classifications|Counts describe|CC BY/.test(content), 'Removed content remains');
      check(content.includes('45') && content.includes('Passenger car') && content.includes('Maximum'), 'Compact measurements lost');
      const before = requests.get(counters[0].id);
      const anchor = await trigger(3869).boundingBox();
      await trigger(3869).click(); await popup.getByRole('slider').waitFor();
      check(requests.get(counters[0].id) === before, 'Selected history fetched twice');
      const box = await popup.boundingBox();
      check(box.width <= 302 && box.height <= 192 && box.x >= 7 && box.y >= 7 && box.x + box.width <= size.width - 7 && box.y + box.height <= size.height - 7, 'Popup not small or escapes viewport');
      if (anchor.x + anchor.width / 2 > 310) check(box.x + box.width < anchor.x + anchor.width / 2, 'Popup not left of click');
      check(await popup.locator('.traffic-bar').count() === 6 && await popup.locator('.zero-reading').count() === 1, 'Missing/zero histogram readings incorrect');
      await page.screenshot({ path: `output/playwright/traffic-compact-${size.width}.png` });
      check(await popup.evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'Histogram clips its readings');
      const chart = popup.getByRole('slider');
      await chart.focus(); await chart.press('Home'); check(await chart.getAttribute('aria-valuenow') === '0', 'Histogram keyboard navigation lost');
      await chart.press('ArrowRight'); check(await chart.getAttribute('aria-valuenow') === '1', 'Histogram interval navigation lost');
      await chart.press('Escape'); await popup.waitFor({ state: 'detached' });
      check(await inspector.isVisible() && await trigger(3869).evaluate(element => document.activeElement === element), 'Escape dismissed inspector or lost focus');
      await trigger(3869).press('Enter'); await popup.getByRole('slider').waitFor();
      await popup.getByRole('button', { name: 'Close traffic history' }).click(); await popup.waitFor({ state: 'detached' });
      await trigger(3869).click(); await popup.getByRole('slider').waitFor();
      await heading.click(); await popup.waitFor({ state: 'detached' });
      await trigger(3870).click(); await popup.getByRole('slider').waitFor();
      check(await heading.innerText() === 'SmartJunction · counter 3869', 'Popup changed selection');
      check(await popup.getAttribute('aria-label') === 'SmartJunction counter 3870 · last 24 hours', 'Popup shows wrong counter');
      await trigger(3869).click(); await popup.getByRole('slider').waitFor();
      check(await popup.getAttribute('aria-label') === 'SmartJunction counter 3869 · last 24 hours', 'Switching popups lost the new counter');
      await inspector.evaluate(element => element.dispatchEvent(new Event('scroll'))); await popup.waitFor({ state: 'detached' });
      await trigger(3869).click(); await popup.getByRole('slider').waitFor();
      if (size.width < 1200) {
        await page.locator('#context-trigger').click(); await popup.waitFor({ state: 'detached' });
        await page.locator('#context-trigger').click(); await inspector.waitFor();
      } else {
        await page.setViewportSize({ ...size, width: size.width - 1 }); await popup.waitFor({ state: 'detached' });
      }
      await inspector.getByRole('button', { name: 'Clear selection', exact: true }).click();
    }
    await selectCounter();
    held = counters[2].id;
    await page.evaluate(() => {
      window.trafficHistoryAborted = false;
      const originalFetch = window.fetch;
      window.fetch = (...args) => { if (String(args[0]).includes('3871')) args[1]?.signal?.addEventListener('abort', () => window.trafficHistoryAborted = true); return originalFetch(...args); };
    });
    await trigger(3871).click(); await popup.getByRole('status').waitFor();
    await popup.getByRole('button', { name: 'Close traffic history' }).click();
    await page.waitForFunction(() => window.trafficHistoryAborted === true);
    releaseHeld?.(); held = null;
    fixtureState = 'failed';
    await trigger(3870).click(); await popup.getByText('Fixture history unavailable').waitFor();
    await popup.getByRole('button', { name: 'Close traffic history' }).click();
    const failedRefresh = page.waitForResponse(response => decodeURIComponent(response.url()).endsWith('/counters/SmartJunction:3869') && response.status() === 503);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await failedRefresh;
    await inspector.getByRole('status').filter({ hasText: 'Fixture history unavailable' }).waitFor();
    await trigger(3869).click(); await popup.getByRole('slider').waitFor();
    await popup.getByRole('status').filter({ hasText: 'Partial history' }).waitFor();
    await popup.getByRole('button', { name: 'Close traffic history' }).click();
    fixtureState = 'partial';
    await trigger(3870).click(); await popup.getByText('Partial history').waitFor();
    await popup.getByRole('slider').waitFor();
    await popup.getByRole('slider').press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    const flag = page.locator('.station-flag.traffic-counter').first();
    if (await flag.count()) {
      const geometry = await flag.evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight, pole: getComputedStyle(element, '::after').height, color: getComputedStyle(element).color }));
      check(geometry.width === 44 && geometry.height === 48 && geometry.pole === '14px' && geometry.color === 'rgb(239, 68, 68)', 'Traffic post geometry/red styling differs from plan');
    }
    return { layouts: layouts.length, compactInspector: true, completeSummaryTable: true, lazyHistory: true, leftPlacement: true, viewportClamping: true, keyboardFocus: true, requestCancellation: true, errorState: true, partialHistory: true, retainedHistory: true, markerChecked: await flag.count() > 0 };
  } finally {
    releaseHeld?.();
    await page.unroute('**/api/traffic-measurements', snapshotRoute);
    await page.unroute('**/api/traffic-measurements/counters/*', detailRoute);
    await page.setViewportSize(originalViewport); await page.reload();
  }
}
