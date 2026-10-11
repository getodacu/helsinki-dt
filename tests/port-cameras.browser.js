// Run with playwright-cli run-code --filename against the local app.
// Media responses below are deliberate fixtures; verify actual provider playback separately.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const modal = page.locator('dialog.port-camera-modal'), chooser = page.getByRole('combobox', { name: 'Port camera', exact: true });
  if (await modal.count()) { await page.getByRole('button', { name: 'Close port cameras' }).click(); await modal.waitFor({ state: 'detached' }); }
  const marker = name => page.getByRole('button', { name: `Port cameras · ${name}`, exact: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-ready') === 'true');
  await page.getByRole('button', { name: 'City Centre', exact: true }).click();
  await page.mouse.move(720, 400);
  for (let step = 0; step < 6 && (!await marker('South Harbour').isVisible() || !await marker('West Harbour').isVisible()); step++) {
    await page.mouse.wheel(0, 400); await page.waitForTimeout(500);
  }
  await marker('South Harbour').waitFor(); await marker('West Harbour').waitFor();
  await page.getByRole('button', { name: 'Air quality station · Helsinki Mannerheimintie', exact: true }).click();
  const requests = [], record = request => { if (/camstreamer\.com\/embed|portofhelsinki\.fi\/webcams/.test(request.url())) requests.push(request.url()); };
  page.on('request', record);
  let failImages = false;
  const playerRoute = async route => route.fulfill({ contentType: 'text/html', body: '<p>Fixture camera player</p><button>Play fixture</button><a href="#">Fixture controls</a>' });
  const imageRoute = async route => route.fulfill(failImages ? { status: 503, body: 'Fixture unavailable' } : { contentType: 'image/svg+xml', headers: { 'Cache-Control': 'max-age=3600' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#24504f"/></svg>' });
  await page.route('https://camstreamer.com/embed/**', playerRoute);
  await page.route('https://www.portofhelsinki.fi/webcams/**', imageRoute);
  await page.clock.install();
  const settled = () => page.waitForFunction(() => document.querySelector('.port-camera-modal .camera-media')?.getAttribute('aria-busy') === 'false');
  const close = async () => { await page.getByRole('button', { name: 'Close port cameras' }).click(); await modal.waitFor({ state: 'detached' }); };
  const hidden = async value => page.evaluate(value => { Object.defineProperty(document, 'hidden', { configurable: true, value }); document.dispatchEvent(new Event('visibilitychange')); }, value);
  try {
    await page.clock.fastForward(60_001); check(requests.length === 0, 'Media loaded before opening');
    await marker('South Harbour').click(); await settled(); check(await chooser.inputValue() === 'south', 'Wrong South default');
    check(await chooser.locator('option').count() === 6, 'Missing port views');
    check(await chooser.locator('optgroup').count() === 3, 'Missing harbour groups');
    check((await chooser.locator('option[value="vuosaari"]').innerText()).includes('outside map area'), 'Vuosaari coverage label missing');
    const box = await modal.boundingBox(), viewport = page.viewportSize();
    check(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2 && Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2, 'Modal not centered');
    await hidden(true); await page.waitForFunction(() => !document.querySelector('.port-camera-modal iframe'));
    const paused = requests.length; await page.clock.fastForward(60_001); check(requests.length === paused, 'Hidden player still loading');
    await hidden(false); await settled(); check(await modal.locator('iframe').count() === 1, 'Player did not resume');
    for (const id of ['south', 'west-lt1', 'west-lt2']) {
      await chooser.selectOption(id); await settled();
      check(await modal.locator('iframe').count() === 1 && await modal.locator('img').count() === 0, 'Multiple media views mounted');
      check((await modal.locator('iframe').getAttribute('src')).includes('cookie=off&autoplay=0&mute=1'), 'Wrong player privacy mode');
    }
    for (const [id, file] of [['west', 'Lansisatama.jpg'], ['west-parking', 'lansisatama_p_alue.jpg'], ['vuosaari', 'vuosa00001.jpg']]) {
      await chooser.selectOption(id); await settled();
      check(await modal.locator('iframe').count() === 0 && await modal.locator('img').count() === 1, 'Wrong snapshot view');
      check((await modal.locator('img').getAttribute('src')).includes(file + '?'), 'Wrong snapshot source');
    }
    await chooser.selectOption('west'); await settled();
    const oldUrl = await modal.locator('img').getAttribute('src'), oldTime = await modal.locator('time').getAttribute('datetime');
    failImages = true; await page.clock.fastForward(60_001); await settled();
    check(await modal.locator('img').getAttribute('src') === oldUrl && await modal.locator('time').getAttribute('datetime') === oldTime, 'Refresh failure replaced last image/time');
    check((await modal.innerText()).includes('previously loaded snapshot'), 'Refresh failure notice missing');
    await hidden(true); const hiddenCount = requests.length; await page.clock.fastForward(120_001); check(requests.length === hiddenCount, 'Hidden snapshots kept polling');
    await hidden(false); await settled();
    failImages = false; await page.clock.fastForward(60_001); await settled();
    check(await modal.locator('img').getAttribute('src') !== oldUrl && !(await modal.innerText()).includes('previously loaded snapshot'), 'Snapshot recovery failed');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await modal.boundingBox(); check(mobile.x >= 0 && mobile.x + mobile.width <= 390 && mobile.y >= 0 && mobile.y + mobile.height <= 844, 'Mobile overflow');
    await page.screenshot({ path: 'output/playwright/port-camera-fixture-mobile.png' });
    const button = page.getByRole('button', { name: 'Close port cameras' }); await button.focus();
    for (let i = 0; i < 9; i++) { await page.keyboard.press('Tab'); check(await page.evaluate(() => !!document.activeElement.closest('.port-camera-modal')), 'Focus escaped'); }
    for (let i = 0; i < 9; i++) { await page.keyboard.press('Shift+Tab'); check(await page.evaluate(() => !!document.activeElement.closest('.port-camera-modal')), 'Reverse focus escaped'); }
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' });
    const closed = requests.length; await page.clock.fastForward(120_001); check(requests.length === closed, 'Closed modal kept polling');
    await page.setViewportSize({ width: 1440, height: 1000 });
    check(await page.evaluate(() => document.activeElement.getAttribute('aria-label')) === 'Port cameras · South Harbour', 'Focus not restored');
    check((await page.locator('[aria-label="Inspector"]').innerText()).includes('Helsinki Mannerheimintie'), 'Inspector selection changed');
    await page.keyboard.press('Enter'); await modal.waitFor(); await close();
    await page.keyboard.press('Space'); await modal.waitFor(); await page.mouse.click(4, 4); await modal.waitFor({ state: 'detached' });
    // The desktop exploration column can cover this projected marker; use its keyboard entry point.
    await marker('West Harbour').focus(); await page.keyboard.press('Enter'); await settled(); check(await chooser.inputValue() === 'west-lt2', 'Wrong West default');
    failImages = true; await chooser.selectOption('west-parking'); await settled();
    check(await modal.locator('img').count() === 0 && (await modal.innerText()).includes('Camera snapshot unavailable.'), 'Initial unavailable state missing');
    await page.evaluate(() => {
      window.portOriginalImage = window.Image;
      window.Image = function () { const image = new window.portOriginalImage(); let src = ''; Object.defineProperty(image, 'src', { get: () => src, set: value => src = value }); window.portPendingImage = image; return image; };
    });
    await chooser.selectOption('vuosaari'); await page.waitForFunction(() => !!window.portPendingImage?.src);
    await chooser.selectOption('south'); await settled();
    check(await page.evaluate(() => window.portPendingImage.src === '' && window.portPendingImage.onload === null && window.portPendingImage.onerror === null), 'Switch left snapshot pending');
    await chooser.selectOption('west'); await page.waitForFunction(() => !!window.portPendingImage?.src); await close();
    check(await page.evaluate(() => window.portPendingImage.src === '' && window.portPendingImage.onload === null), 'Close left snapshot pending');
    return { markers: 2, views: 6, desktop: true, mobile: true, keyboard: true, inspectorPreserved: true, refreshRecovery: true, hiddenCleanup: true, switchCleanup: true, closeCleanup: true };
  } finally {
    if (await modal.count()) await close();
    await page.evaluate(() => { delete document.hidden; if (window.portOriginalImage) window.Image = window.portOriginalImage; delete window.portOriginalImage; delete window.portPendingImage; });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.unroute('https://camstreamer.com/embed/**', playerRoute); await page.unroute('https://www.portofhelsinki.fi/webcams/**', imageRoute); page.off('request', record);
  }
}
