// Run with playwright-cli run-code --filename against the local app.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const fallback = await page.context().newPage();
  await fallback.setViewportSize({ width: 390, height: 844 });
  await fallback.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return /^webgl/.test(type) ? null : getContext.call(this, type, ...args); };
  });
  const photoRoute = route => {
    const url = new URL(route.request().url()), id = decodeURIComponent(url.pathname.split('/')[4]);
    return route.fulfill({ json: { generation: url.searchParams.get('generation'), buildingId: id, photo: {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Fixture.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:Fixture.jpg',
      title: 'Fixture', author: 'Fixture author', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/'
    } } });
  };
  let images = 0;
  await fallback.route(/\/api\/entities\/building\/[^/]+\/photo\?/, photoRoute);
  await fallback.route(/\/api\/entities\/building\/[^/]+\/photo\/image\?/, route => { images++; return route.fulfill({ status: 503, body: 'Fixture photograph unavailable' }); });
  try {
    await fallback.goto(page.url());
    await fallback.getByText('City scene unavailable', { exact: true }).waitFor();
    const search = fallback.getByRole('searchbox');
    await search.fill('Mannerheimintie');
    const building = fallback.locator('.search-results .building-list button').first();
    await building.waitFor(); await building.click();
    const inspector = fallback.locator('#identity-inspector'); await inspector.waitFor();
    check((await inspector.innerText()).includes('3D rendering unavailable'), 'WebGL metadata fallback missing');
    await fallback.waitForFunction(() => !document.querySelector('.building-photo'));
    // Confirm that a failed photograph leaves the building inspector usable.
    await fallback.waitForTimeout(500);
    check(images > 0 && await inspector.locator('.building-photo').count() === 0, 'Failed photograph remains visible');
    await inspector.getByRole('button', { name: 'Details', exact: true }).click();
    check(await inspector.getByText('Source identifiers', { exact: true }).isVisible(), 'Building identifiers missing');
    await inspector.getByText('Source identifiers', { exact: true }).click();
    check(await inspector.locator('.properties').last().isVisible(), 'Building record workflow lost');
    await fallback.getByRole('button', { name: 'Close inspector sheet' }).click();
    await fallback.locator('#context-trigger').click(); check(await inspector.isVisible(), 'Fallback selection not retained');
    await fallback.screenshot({ path: 'output/playwright/ocean-webgl-fallback.png' });
    return { webglFallback: true, buildingSearch: true, records: true, failedPhotograph: true, selectionPreserved: true };
  } finally { await fallback.close(); }
}
