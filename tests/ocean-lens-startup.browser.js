// Run with playwright-cli run-code --filename against the local app.
// Real prepared data and retained server assets; held requests test ordering, not a performance SLO.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const startup = await context.newPage();
  let releaseManifest, releaseAppearance, manifestRequested;
  const manifestGate = new Promise(resolve => releaseManifest = resolve);
  const appearanceGate = new Promise(resolve => releaseAppearance = resolve);
  const manifestStarted = new Promise(resolve => manifestRequested = resolve);
  let appearanceRequests = 0, streamRequests = 0, earlyStream = false;
  await startup.route('**/data/city/manifest.json', async route => { manifestRequested(); await manifestGate; await route.continue(); });
  await startup.route('**/api/city-asset?*', async route => {
    appearanceRequests++;
    if (appearanceRequests === 1) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Fixture map detail unavailable' });
    await appearanceGate; await route.continue();
  });
  await startup.route('**/api/city-cache', route => route.fulfill({ json: {
    phase: 'partial', completed: 0, total: 1, failed: 1, cacheIssue: 'Fixture shared map cache unavailable'
  } }));
  await startup.route('**/models/ship-generic.glb', route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Optional ship model unavailable' }));
  startup.on('request', request => {
    if (new URL(request.url()).pathname === '/api/traffic/stream') {
      streamRequests++;
      void startup.locator('main').getAttribute('data-scene-ready').then(ready => { if (ready !== 'true') earlyStream = true; });
    }
  });
  try {
    await startup.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await manifestStarted;
    const main = startup.locator('main'), inspector = startup.locator('#identity-inspector');
    const checkWorkspaceLayout = async () => {
      check(await startup.locator('.map-feedback').count() === 0, 'Removed notice bar remains');
      const header = await startup.locator('.masthead').boundingBox(), bounds = await main.boundingBox();
      check(Math.abs(bounds.y - header.y - header.height) <= 1, 'Unused space remains below the header');
      check(Math.abs(bounds.y + bounds.height - startup.viewportSize().height) <= 1, 'Map does not fill the remaining viewport');
    };
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await startup.setViewportSize({ width, height });
      await checkWorkspaceLayout();
      check(await startup.locator('.scene-status p').count() === 1, 'Loading screen retains explanatory paragraphs');
      check(await startup.getByRole('progressbar', { name: 'Loading current map view' }).isVisible(), 'Loading progress missing');
    }
    await startup.setViewportSize({ width: 1440, height: 900 });
    const search = startup.getByRole('searchbox');
    await search.fill('Mannerheimintie');
    await startup.getByRole('tab', { name: 'Buildings', exact: true }).click();
    const building = startup.locator('.search-results .building-list > button').first();
    await building.waitFor(); await building.click(); await inspector.waitFor();
    check((await inspector.innerText()).includes('Building'), 'Metadata inspector unavailable while manifest is held');
    check(await main.getAttribute('data-scene-ready') === 'false', 'Held manifest falsely reported ready');
    check(await startup.locator('.scene-canvas > canvas').count() === 0, 'Manifest gate did not hold scene creation');
    check(streamRequests === 0 && appearanceRequests === 0, 'Optional network demand started before the semantic map');
    await inspector.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await search.fill(''); await startup.keyboard.press('Escape');
    const initialWorkspaceBounds = await main.boundingBox();
    releaseManifest();
    await startup.waitForFunction(() => {
      const main = document.querySelector('main');
      return main?.getAttribute('data-scene-ready') === 'true' && main.getAttribute('data-semantic-phase') === 'ready';
    }, null, { timeout: 120_000 });
    const canvas = startup.locator('.scene-canvas > canvas'); await canvas.waitFor({ state: 'visible' });
    check(await main.getAttribute('data-scene-complete') === 'false', 'Held appearance falsely reported full detail');
    check(await startup.locator('.map-loading-cover').count() === 0, 'Optional appearance still covers the map');
    // Select a real semantic roof through the canvas, not a metadata search result.
    const box = await canvas.boundingBox(); let picked = false;
    for (const y of [.35, .45, .55, .65]) {
      for (const x of [.35, .45, .55, .65, .75]) {
        const point = { x: box.x + box.width * x, y: box.y + box.height * y };
        const exposed = await startup.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('.scene-canvas > canvas'), point);
        if (!exposed) continue;
        await startup.mouse.click(point.x, point.y);
        if (await inspector.isVisible() && (await inspector.locator('#inspection-heading').innerText()).trim() === 'Building') { picked = true; break; }
      }
      if (picked) break;
    }
    check(picked, 'No semantic building could be selected while all appearance requests were held');
    check(appearanceRequests > 0, 'No optional appearance refinement started after semantic readiness');
    check(!earlyStream, 'Live stream competed with initial semantic loading');
    // Keep refinement held while errors and retry controls remain available in Sources.
    await inspector.getByRole('button', { name: 'Clear selection', exact: true }).click();
    for (const [width, height] of [[1440, 900], [1200, 900], [1199, 768], [390, 844], [844, 390]]) {
      await startup.setViewportSize({ width, height });
      await checkWorkspaceLayout();
      const workspaceBounds = await main.boundingBox();
      if (width < 1200) await startup.getByRole('button', { name: 'Project information menu' }).click();
      const sourcesButton = startup.locator(width < 1200 ? '#project-menu' : '.header-actions').getByRole('button', { name: 'Data & sources' });
      await sourcesButton.focus(); await sourcesButton.press('Enter');
      const status = startup.getByRole('region', { name: 'Current data status' });
      await status.locator('.scene-error').waitFor({ state: 'visible' });
      check((await status.innerText()).includes('Fixture shared map cache unavailable'), 'Cache issue missing from Sources');
      const retry = status.getByRole('button', { name: 'Retry missing map parts' });
      await retry.waitFor({ state: 'visible' }); await retry.focus();
      check(await retry.evaluate(element => document.activeElement === element), 'Retry control is not keyboard reachable');
      check(await status.evaluate(element => element.scrollWidth <= element.clientWidth), 'Status overflows horizontally');
      check(JSON.stringify(await main.boundingBox()) === JSON.stringify(workspaceBounds), 'Sources dialog resized the map');
      await startup.keyboard.press('Escape');
      await startup.locator('#sources').waitFor({ state: 'detached' });
      if (width < 1200) {
        await startup.getByRole('button', { name: 'Layers', exact: true }).click();
        await checkWorkspaceLayout();
        await startup.getByRole('button', { name: 'Close exploration panel', exact: true }).click();
      }
    }
    await startup.setViewportSize({ width: 1440, height: 900 });
    await startup.locator('.header-actions').getByRole('button', { name: 'Data & sources' }).click();
    await startup.getByRole('button', { name: 'Retry missing map parts' }).press('Enter');
    await startup.keyboard.press('Escape');
    releaseAppearance();
    await startup.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-complete') === 'true', null, { timeout: 120_000 });
    check(await main.getAttribute('data-refinement-phase') === 'ready', 'Full detail did not finish and render');
    await checkWorkspaceLayout();
    check(JSON.stringify(await main.boundingBox()) === JSON.stringify(initialWorkspaceBounds), 'Loading changes resized the map between startup and completed refinement');
    check(streamRequests > 0, 'Live stream never resumed after semantic readiness');
    await startup.close();
    const fallback = await context.newPage();
    await fallback.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) { return /^webgl/.test(type) ? null : getContext.call(this, type, ...args); };
    });
    const fallbackStream = fallback.waitForRequest(request => new URL(request.url()).pathname === '/api/traffic/stream');
    await fallback.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await fallback.getByText('City scene unavailable', { exact: true }).waitFor();
    await fallbackStream;
    check(await fallback.locator('main').getAttribute('data-scene-ready') === 'false', 'Renderer failure falsely reported a semantic map');
    return { metadataBeforeManifest: true, coarseSemanticPicking: true, nonblockingRefinement: true, fullMapSpace: true, sourceErrorsAndRetry: true, fullDetailRendered: true, streamDeferred: true, fallbackLiveTransport: true };
  } finally { releaseManifest(); releaseAppearance(); await context.close(); }
}
