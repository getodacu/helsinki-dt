// Run with playwright-cli run-code --filename against the local app.
// Uses bounded fixtures to check source outages without depending on providers.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize();
  const navigation = page.locator('.header-actions');
  const compactNavigation = page.locator('#project-menu');
  const menuTrigger = page.locator('#project-menu-trigger');
  const modals = [
    { key: 'about', id: 'about-project', heading: 'About this project', close: 'Close about this project', width: 1040 },
    { key: 'collaboration', id: 'collaboration', heading: 'Open for collaboration', close: 'Close collaboration', width: 720 },
    { key: 'data', id: 'sources', heading: 'Data & Sources', close: 'Close sources', width: 960 }
  ];
  const openMenu = async () => {
    const compact = page.viewportSize().width < 1200;
    if (compact && !await compactNavigation.evaluate(element => element.matches(':popover-open'))) await menuTrigger.click();
    return compact ? compactNavigation : navigation;
  };
  const inViewport = async locator => {
    const box = await locator.boundingBox(), size = page.viewportSize();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, 'Content leaves viewport');
  };
  const open = async modal => {
    const button = (await openMenu()).locator(`[data-information-section="${modal.key}"]`);
    await inViewport(button);
    check((await button.boundingBox()).height >= 44, 'Header touch target too small');
    check(await button.getAttribute('aria-controls') === modal.id, 'Header controls the wrong dialog');
    await button.focus(); await button.press('Enter');
    const dialog = page.locator(`#${modal.id}`);
    await dialog.waitFor();
    check(await page.locator('dialog[open]').count() === 1, 'Multiple dialogs open');
    check(await dialog.getAttribute('aria-labelledby') === `${modal.id}-heading`, 'Dialog heading is not associated');
    check(await dialog.getByRole('heading', { name: modal.heading, exact: true }).isVisible(), 'Header opened the wrong dialog');
    check(await button.getAttribute('aria-expanded') === 'true', 'Open dialog is not exposed by the header');
    check(await dialog.locator('.information-nav').count() === 0, 'Shared section navigation remains');
    check(await dialog.locator('.drawer-content').evaluate(element => element.scrollTop) === 0, 'Dialog retains previous scroll offset');
    check(await dialog.evaluate(element => element.contains(document.activeElement)), 'Focus did not enter the dialog');
    if (page.viewportSize().width < 1200) check(!await compactNavigation.evaluate(element => element.matches(':popover-open')), 'Compact menu stayed open behind dialog');
    return dialog;
  };
  const close = async (modal, method = 'escape') => {
    const dialog = page.locator(`#${modal.id}`);
    if (method === 'button') await dialog.getByRole('button', { name: modal.close, exact: true }).click();
    else if (method === 'backdrop') await page.mouse.click(2, 2);
    else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    const target = page.viewportSize().width < 1200 ? menuTrigger : navigation.locator(`[data-information-section="${modal.key}"]`);
    check(await target.evaluate(element => element === document.activeElement), 'Opener did not regain focus');
    check(await navigation.locator('[aria-expanded="true"]').count() === 0, 'Closed dialog remains expanded');
    check(await page.locator('.observation-station-heading h3').innerText() === 'Helsinki Kaisaniemi', 'Closing the dialog cleared map selection');
  };
  const observedAt = new Date(Date.now() - 3600_000).toISOString();
  const observations = {
    generatedAt: new Date().toISOString(), historyHours: 6,
    observations: [{ parameter: 't2m', unit: 'degC', value: 5.2, observedAt, receivedAt: observedAt,
      stationId: '100971', stationName: 'Helsinki Kaisaniemi', longitude: 24.94, latitude: 60.17,
      sourceId: 'fmi-weather', quality: null, aggregation: null }],
    sources: [{ id: 'fmi-weather', state: 'stale', message: 'Fixture retained weather observations.',
      provider: 'Finnish Meteorological Institute', url: 'https://opendata.fmi.fi/wfs',
      license: 'CC BY 4.0', attribution: 'Finnish Meteorological Institute; FMI Open Data',
      coverage: 'Helsinki Kaisaniemi only.', method: 'Station observations.', resolution: '10 minutes',
      vintage: observedAt, units: ['°C'], parameters: ['t2m'], retrievedAt: observedAt,
      metadataRetrievedAt: observedAt, observedAt, lastAttemptAt: new Date().toISOString(),
      nextRefreshAt: null, refreshMs: 300_000, staleAfterMs: 1800_000,
      lastError: 'Fixture weather refresh unavailable',
      requests: [{ url: 'https://opendata.fmi.fi/wfs?request=GetFeature', retrievedAt: observedAt, receivedAt: observedAt }] }]
  };
  const observationsRoute = route => route.fulfill({ json: observations });
  const catalogRoute = async route => {
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.energy.status = 'unavailable'; catalog.energy.message = 'Fixture energy catalog unavailable';
    catalog.ryhti.status = 'stale'; catalog.ryhti.message = 'Fixture dated Ryhti catalog retained';
    return route.fulfill({ response, json: catalog });
  };
  try {
    if (await page.locator('dialog[open]').count()) await page.keyboard.press('Escape');
    await page.route('**/api/observations', observationsRoute);
    await page.route('**/api/catalog/status', catalogRoute);
    const loadedObservations = page.waitForResponse(response => new URL(response.url()).pathname === '/api/observations');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await loadedObservations;
    await page.locator('.sensor-reading[data-parameter="t2m"]').click();
    await page.locator('#identity-inspector').waitFor();
    const dialog = await open(modals[2]);
    await page.waitForFunction(() => document.querySelector('.information-status')?.textContent.includes('Fixture retained weather observations.'));
    await page.waitForFunction(() => document.querySelector('.information-status')?.textContent.includes('Energy: unavailable'));
    check(await dialog.locator('.source-overview article').count() === 5, 'Source overview incomplete');
    check(await dialog.locator('.potential-sources li').count() === 10, 'Potential shortlist incomplete');
    check((await dialog.locator('.potential-sources li').first().innerText()).includes('Allu'), 'Allu is not first');
    check((await dialog.locator('.potential-sources').innerText()).includes('not yet integrated'), 'Candidates presented as integrated');
    check((await dialog.locator('.source-overview').innerText()).includes('per-photo licences'), 'Photo rights missing');
    const diagnostics = dialog.locator('.source-diagnostics');
    await diagnostics.locator(':scope > summary').click();
    const weather = diagnostics.locator('.source-record').filter({ hasText: 'Fixture retained weather observations.' });
    await weather.locator(':scope > summary').click();
    check((await weather.innerText()).includes('Fixture weather refresh unavailable'), 'Weather outage missing');
    check((await weather.innerText()).includes('CC BY 4.0'), 'Source licence missing');
    check((await weather.innerText()).includes('Observed'), 'Observation timestamps missing');
    await weather.getByText('Actual bounded source requests', { exact: true }).click();
    check(await weather.getByRole('link', { name: 'Request 1 ↗' }).getAttribute('href') === 'https://opendata.fmi.fi/wfs?request=GetFeature', 'Request provenance missing');
    check((await diagnostics.innerText()).includes('Fixture energy catalog unavailable'), 'Energy unavailable state missing');
    check((await diagnostics.innerText()).includes('Fixture dated Ryhti catalog retained'), 'Ryhti stale state missing');
    check((await diagnostics.innerText()).includes('Foundation source probes · historical'), 'Historical probes lost');
    // Retain the existing source-dialog regression assertions.
    const sourceText = await dialog.innerText();
    check(!/Juxtaposed weather|Motion buffer:|Exact identifier joins only|Energy months are historical/.test(sourceText), 'Removed source explanations returned');
    check(sourceText.includes('CC BY 4.0') && await dialog.locator('a[href]').count() > 0, 'Attribution or source links lost');
    await close(modals[2], 'button');
    const about = await open(modals[0]);
    const aboutText = await about.innerText();
    for (const fact of ['What you can explore', 'How it was built', 'ETRS-GK25', 'N2000', 'SQLite', 'SSE', 'Planners & public institutions', 'Researchers & educators', 'unavailable records remain unavailable']) {
      check(aboutText.includes(fact), `Project explanation missing: ${fact}`);
    }
    check(await about.locator('figure.architecture-diagram').count() === 2, 'Architecture diagrams missing');
    check(await about.locator('.architecture-flow li').count() === 10, 'Architecture stages missing');
    for (const figure of await about.locator('figure.architecture-diagram').all()) {
      check(await figure.getAttribute('aria-labelledby') === await figure.locator('figcaption').getAttribute('id'), 'Diagram caption is not associated');
      check((await figure.locator('figcaption').innerText()).includes('Reading the flow:'), 'Diagram text equivalent missing');
    }
    await close(modals[0], 'backdrop');
    const collaboration = await open(modals[1]);
    check((await collaboration.innerText()).includes('We’ll bring the diagrams.'), 'Collaboration invitation missing');
    check(await collaboration.locator('.collaboration-capabilities article').count() === 4, 'Collaboration capabilities incomplete');
    check(await collaboration.getByRole('link', { name: 'Let’s talk ↗', exact: true }).getAttribute('href') === 'https://ai.ro/#contact', 'Contact destination incorrect');
    check(await collaboration.getByRole('link', { name: 'Explore ai.ro ↗', exact: true }).getAttribute('href') === 'https://ai.ro/', 'Studio destination incorrect');
    await close(modals[1]);
    const copyright = page.locator('.scene-footer .project-copyright');
    await inViewport(copyright);
    check(await copyright.innerText() === `© ${new Date().getFullYear()} ai.ro`, 'Map copyright year incorrect');
    check(await copyright.getAttribute('href') === 'https://ai.ro/', 'Map copyright destination incorrect');
    check(await copyright.evaluate(element => getComputedStyle(element).pointerEvents) === 'auto', 'Map copyright cannot receive clicks');
    check((await navigation.getByRole('button').allTextContents()).map(text => text.trim()).join('|') === 'About this project|Open for collaboration|Data & sources ↗', 'Header menu order changed');
    for (const size of [{ width: 1440, height: 1000 }, { width: 928, height: 1104 }, { width: 781, height: 844 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 1000, height: 450 }]) {
      await page.setViewportSize(size);
      await inViewport(size.width < 1200 ? menuTrigger : navigation);
      await inViewport(page.locator('#city-search'));
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Header causes page overflow at ${size.width}×${size.height}`);
      for (const modal of modals) {
        const dialog = await open(modal), content = dialog.locator('.drawer-content');
        await inViewport(dialog); await inViewport(dialog.locator('.drawer-heading')); await inViewport(dialog.locator('.information-footer'));
        const box = await dialog.boundingBox();
        check(box.width <= modal.width + 1, 'Dialog exceeds its maximum width');
        check(Math.abs(box.x - (size.width - box.width) / 2) < 2 && Math.abs(box.y - (size.height - box.height) / 2) < 2, 'Dialog is not centered');
        if (size.width <= 780) check(Math.abs(box.x - 8) < 1, 'Phone dialog does not have 8px outer margins');
        check(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Dialog overflows horizontally');
        const closeButton = dialog.getByRole('button', { name: modal.close, exact: true });
        const closeBox = await closeButton.boundingBox();
        check(closeBox.height >= 44 && closeBox.width >= 44, 'Close touch target too small');
        await closeButton.focus(); await page.keyboard.press('Shift+Tab');
        // Native dialogs keep the page inert; Chromium may visit browser chrome at a Tab boundary.
        if (!await page.evaluate(() => document.hasFocus())) await page.keyboard.press('Shift+Tab');
        check(await dialog.locator('.information-footer .project-copyright').evaluate(element => element === document.activeElement), `Reverse Tab escaped ${modal.id} at ${size.width}×${size.height}: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200))}`);
        await page.keyboard.press('Tab');
        if (!await page.evaluate(() => document.hasFocus())) await page.keyboard.press('Tab');
        check(await closeButton.evaluate(element => element === document.activeElement), `Tab did not wrap to ${modal.id} close button at ${size.width}×${size.height}`);
        check(await dialog.locator('.information-footer .project-copyright').getAttribute('href') === 'https://ai.ro/', 'Dialog copyright destination incorrect');
        await page.screenshot({ path: `output/playwright/project-information-${modal.key}-${size.width}.png` });
        if (modal.key === 'about') {
          for (const [index, figure] of (await dialog.locator('figure.architecture-diagram').all()).entries()) {
            await figure.scrollIntoViewIfNeeded();
            check(await figure.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Diagram overflows horizontally');
            const stages = await figure.locator('.architecture-flow li').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width }; }));
            if (size.width <= 780) check(stages.every(stage => Math.abs(stage.x - stages[0].x) < 1) && stages[4].y > stages[0].y, 'Phone diagram stages are not stacked');
            else check(stages.every(stage => Math.abs(stage.y - stages[0].y) < 1), 'Wide diagram stages are not connected in a row');
            await page.screenshot({ path: `output/playwright/project-architecture-${index + 1}-${size.width}.png` });
          }
        }
        if (modal.key === 'collaboration') {
          for (const link of await dialog.locator('.information-actions a').all()) {
            await link.scrollIntoViewIfNeeded();
            check((await link.boundingBox()).height >= 44, 'Contact touch target too small');
          }
        }
        await content.evaluate(element => element.scrollTop = element.scrollHeight);
        check(await content.evaluate(element => element.scrollHeight <= element.clientHeight || element.scrollTop > 0), 'Long dialog body does not scroll');
        await inViewport(closeButton);
        await close(modal, 'button');
        await open(modal); await close(modal, 'backdrop');
        await open(modal); await close(modal);
      }
      await inViewport(copyright);
      await page.screenshot({ path: `output/playwright/project-menu-${size.width}.png` });
    }
    // Closing after a responsive layout change must find a visible focus target.
    for (const modal of modals) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(modal);
      await page.setViewportSize({ width: 1000, height: 450 });
      await close(modal);
      await open(modal);
      await page.setViewportSize({ width: 1440, height: 900 });
      await close(modal);
    }
    return { projectModals: 3, diagrams: 2, provenance: true, outages: true, keyboardFocus: true, dismissal: true, freshScroll: true, compactMenu: true, viewports: 6 };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/project-information-failure.png' });
    throw error;
  } finally {
    await page.unroute('**/api/observations', observationsRoute);
    await page.unroute('**/api/catalog/status', catalogRoute);
    if (await page.locator('dialog[open]').count()) await page.keyboard.press('Escape');
    if (viewport) await page.setViewportSize(viewport);
    await page.reload();
  }
}
