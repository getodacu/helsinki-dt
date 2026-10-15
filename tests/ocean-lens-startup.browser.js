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
  await startup.route('**/api/city-asset?*', async route => { appearanceRequests++; await appearanceGate; await route.continue(); });
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
    await startup.waitForFunction(() => /aerial imagery|textured detail/.test(document.querySelector('.map-cache-status')?.textContent ?? ''));
    check((await startup.locator('.map-cache-status').innerText()).includes('You can use the map now'), 'Nonblocking refinement context missing');
    check(await startup.locator('.map-loading-cover').count() === 0, 'Optional appearance still covers the map');
    await startup.locator('.map-feedback .scene-error').waitFor({ state: 'visible' });
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
    // Keep the real refinement requests held while an optional model has failed.
    await inspector.getByRole('button', { name: 'Clear selection', exact: true }).click();
    const checkFeedbackLayout = async () => {
      const result = await startup.evaluate(() => {
        const region = document.querySelector('.map-feedback');
        const bounds = region.getBoundingClientRect();
        const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const notices = [...region.children];
        const errors = [];
        if (!region.querySelector('.scene-error') || !region.querySelector('.map-cache-status')) errors.push('simultaneous notices missing');
        if (document.querySelector('main').dataset.refinementPhase === 'ready') errors.push('refinement no longer held');
        if (bounds.left < 0 || bounds.right > innerWidth || bounds.top < 0 || bounds.bottom > innerHeight || region.scrollWidth > region.clientWidth) errors.push('feedback overflows viewport');
        for (let i = 0; i < notices.length; i++) {
          if (notices[i].scrollWidth > notices[i].clientWidth) errors.push('notice overflows horizontally');
          for (const sibling of notices.slice(i + 1)) if (overlaps(notices[i].getBoundingClientRect(), sibling.getBoundingClientRect())) errors.push('notices overlap');
        }
        for (const element of document.querySelectorAll('.map-camera-controls, .map-scale, .sensor-readings, .camera-presets, .left-stack, .right-stack, .mobile-panel-nav')) {
          const rect = element.getBoundingClientRect();
          if (rect.width && rect.height && overlaps(bounds, rect)) errors.push(`feedback overlaps ${element.className}`);
        }
        return errors;
      });
      check(result.length === 0, result.join('; '));
      const feedback = startup.locator('.map-feedback');
      check(await feedback.getAttribute('open') !== null, 'Availability notices must start expanded');
      const expandedBounds = await main.boundingBox();
      await feedback.locator('summary').click();
      check(JSON.stringify(await main.boundingBox()) === JSON.stringify(expandedBounds), 'Collapsing feedback changed the map extent');
      await feedback.locator('summary').click();
      await feedback.locator('summary').focus();
      check(await feedback.locator('summary').evaluate(element => document.activeElement === element), 'Feedback has no native keyboard entry point');
      if (await feedback.evaluate(element => element.scrollHeight > element.clientHeight)) {
        await startup.keyboard.press('End');
        await startup.waitForFunction(() => document.querySelector('.map-feedback').scrollTop > 0);
      }
      // Every message and action remains reachable in the bounded native scroller.
      for (const item of await startup.locator('.map-feedback p, .map-feedback button').all()) {
        await item.scrollIntoViewIfNeeded();
        check(await item.evaluate(element => {
          const rect = element.getBoundingClientRect(), region = element.closest('.map-feedback').getBoundingClientRect();
          const x = (rect.left + rect.right) / 2, y = Math.max(rect.top, region.top) + Math.min(rect.bottom - Math.max(rect.top, region.top), region.bottom - Math.max(rect.top, region.top)) / 2;
          const hit = document.elementFromPoint(x, y);
          return rect.bottom > region.top && rect.top < region.bottom && (hit === element || element.contains(hit));
        }), 'A feedback message or action is obscured or unreachable');
      }
    };
    for (const [width, height] of [[1440, 900], [1200, 900], [1199, 768], [390, 844], [844, 390]]) {
      await startup.setViewportSize({ width, height });
      await checkFeedbackLayout();
      if (width < 1200) {
        await startup.getByRole('button', { name: 'Layers', exact: true }).click();
        await checkFeedbackLayout();
        await startup.getByRole('button', { name: 'Close exploration panel', exact: true }).click();
      }
    }
    await startup.setViewportSize({ width: 1440, height: 900 });
    releaseAppearance();
    await startup.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-complete') === 'true', null, { timeout: 120_000 });
    check(await main.getAttribute('data-refinement-phase') === 'ready', 'Full detail did not finish and render');
    check(JSON.stringify(await main.boundingBox()) === JSON.stringify(initialWorkspaceBounds), 'Feedback changes resized the map between startup and completed refinement');
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
    return { metadataBeforeManifest: true, coarseSemanticPicking: true, nonblockingRefinement: true, simultaneousFeedbackLayout: true, fullDetailRendered: true, streamDeferred: true, fallbackLiveTransport: true };
  } finally { releaseManifest(); releaseAppearance(); await context.close(); }
}
