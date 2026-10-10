// Run with playwright-cli run-code --filename against the local app.
// Uses bounded fixtures to check source outages without depending on providers.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const viewport = page.viewportSize();
  const trigger = page.getByRole('button', { name: 'Data & sources ↗', exact: true });
  const dialog = page.locator('#sources');
  const sections = dialog.getByRole('group', { name: 'Project information sections' });
  const content = dialog.locator('.drawer-content');
  const observedAt = new Date(Date.now() - 3600_000).toISOString();
  const observations = {
    generatedAt: new Date().toISOString(), historyHours: 6, observations: [],
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
  const select = async name => {
    const button = sections.getByRole('button', { name, exact: true });
    await button.focus(); await button.press('Enter');
    await page.waitForFunction(label => document.querySelector('#sources-heading')?.textContent === label, name);
    check(await button.getAttribute('aria-pressed') === 'true', 'Section selection is not exposed');
    check(await sections.locator('button[aria-pressed="true"]').count() === 1, 'Multiple sections selected');
    check(await content.evaluate(element => element.scrollTop) === 0, 'Section retains previous scroll offset');
  };
  const inViewport = async locator => {
    const box = await locator.boundingBox(), size = page.viewportSize();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, 'Content leaves viewport');
  };
  try {
    if (await dialog.count()) await dialog.getByRole('button', { name: 'Close sources' }).click();
    await page.route('**/api/observations', observationsRoute);
    await page.route('**/api/catalog/status', catalogRoute);
    const loadedObservations = page.waitForResponse(response => new URL(response.url()).pathname === '/api/observations');
    await page.reload();
    await loadedObservations;
    await trigger.focus(); await trigger.press('Enter');
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('.information-status')?.textContent.includes('Fixture retained weather observations.'));
    await page.waitForFunction(() => document.querySelector('.information-status')?.textContent.includes('Energy: unavailable'));
    check(await sections.getByRole('button', { name: 'Data & Sources', exact: true }).getAttribute('aria-pressed') === 'true', 'Wrong default section');
    await dialog.getByRole('button', { name: 'Close sources' }).focus();
    await page.keyboard.press('Tab');
    check(await sections.getByRole('button', { name: 'Data & Sources', exact: true }).evaluate(element => element === document.activeElement), 'Tab did not reach the section controls');
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
    await select('About this project');
    check((await content.innerText()).includes('Planners & public institutions'), 'Project audiences missing');
    await dialog.getByRole('button', { name: 'Open for collaboration ↗', exact: true }).click();
    check(await dialog.getByRole('link', { name: 'Let’s talk ↗', exact: true }).getAttribute('href') === 'https://ai.ro/#contact', 'Contact destination incorrect');
    check(await dialog.getByRole('link', { name: 'Explore ai.ro ↗', exact: true }).getAttribute('href') === 'https://ai.ro/', 'Studio destination incorrect');
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 1000, height: 450 }]) {
      await page.setViewportSize(size);
      for (const name of ['Data & Sources', 'About this project', 'Open for collaboration']) {
        await select(name);
        await inViewport(dialog); await inViewport(dialog.locator('.information-footer'));
        check(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Panel overflows horizontally');
        for (const button of await sections.getByRole('button').all()) {
          await inViewport(button);
          check((await button.boundingBox()).height >= 44, 'Section touch target too small');
        }
        await page.screenshot({ path: `output/playwright/project-information-${name.split(' ')[0].toLowerCase()}-${size.width}.png` });
      }
    }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    check(await trigger.evaluate(element => element === document.activeElement), 'Escape did not return focus');
    const copyright = page.locator('.scene-footer .project-copyright');
    await inViewport(copyright);
    check(await copyright.innerText() === `© ${new Date().getFullYear()} ai.ro`, 'Map copyright year incorrect');
    check(await copyright.getAttribute('href') === 'https://ai.ro/', 'Map copyright destination incorrect');
    check(await copyright.evaluate(element => getComputedStyle(element).pointerEvents) === 'auto', 'Map copyright cannot receive clicks');
    await trigger.press('Enter'); await dialog.waitFor();
    check(await sections.getByRole('button', { name: 'Data & Sources', exact: true }).getAttribute('aria-pressed') === 'true', 'Reopening did not reset section');
    check(await dialog.locator('.information-footer .project-copyright').getAttribute('href') === 'https://ai.ro/', 'Panel copyright destination incorrect');
    await dialog.getByRole('button', { name: 'Close sources' }).click(); await dialog.waitFor({ state: 'detached' });
    check(await trigger.evaluate(element => element === document.activeElement), 'Close button did not return focus');
    console.log('PASS: project information, source provenance, outages, keyboard focus, links and responsive layouts');
  } finally {
    await page.unroute('**/api/observations', observationsRoute);
    await page.unroute('**/api/catalog/status', catalogRoute);
    if (await dialog.count()) await dialog.getByRole('button', { name: 'Close sources' }).click();
    if (viewport) await page.setViewportSize(viewport);
    await page.reload();
  }
}
