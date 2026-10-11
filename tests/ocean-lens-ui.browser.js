// Run with playwright-cli run-code --filename against the local app.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const original = page.viewportSize();
  const overview = page.locator('#city-overview'), inspector = page.locator('#identity-inspector');
  const layers = page.locator('#exploration-panel'), context = page.locator('#context-trigger');
  const presets = page.getByRole('navigation', { name: 'Camera presets' });
  const sizeCheck = async locator => {
    const box = await locator.boundingBox(), size = page.viewportSize();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, 'Panel leaves viewport');
    check(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Panel overflows horizontally');
  };
  const group = name => layers.locator('details[name="exploration"]').nth(['Map', 'Transport', 'Buildings', 'Energy', 'Environment'].indexOf(name));
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-scene-ready') === 'true');
    await overview.waitFor();
    check(await overview.locator('.overview-feed').count() === 3, 'Feed overview incomplete');
    check(await overview.locator('.overview-feed small').count() === 3, 'Feed timestamps missing');
    check(await overview.locator('.overview-reading small').count() === 2, 'Observation timestamps missing');
    check(await group('Map').evaluate(element => element.open), 'Map is not initially expanded');
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page overflows');
      await sizeCheck(page.locator('.masthead')); await sizeCheck(presets);
      for (const button of await presets.getByRole('button').all()) check((await button.boundingBox()).height >= 44, 'Preset touch target too small');
      if (size.width >= 1200) {
        check(Math.round((await page.locator('.left-stack').boundingBox()).width) === 280, 'Wrong exploration width');
        check(Math.round((await page.locator('.right-stack').boundingBox()).width) === 340, 'Wrong context width');
        await sizeCheck(layers); await sizeCheck(overview);
      } else {
        await page.locator('#layers-trigger').focus(); await page.keyboard.press('Enter');
        await layers.waitFor(); await sizeCheck(page.locator('.left-stack'));
        check(!await presets.isVisible() && !await overview.isVisible(), 'Compact panel overlap');
        check(await page.locator('#exploration-heading').evaluate(element => element === document.activeElement), 'Layers heading not focused');
        await page.keyboard.press('Escape'); check(!await layers.isVisible() && await presets.isVisible(), 'Escape did not close panel');
        check(await page.locator('#layers-trigger').evaluate(element => element === document.activeElement), 'Panel trigger focus not restored');
        await context.click(); await overview.waitFor(); await sizeCheck(overview);
        await page.getByRole('button', { name: 'Close overview panel' }).click();
        check(await context.evaluate(element => element === document.activeElement), 'Overview focus not restored');
      }
      await page.screenshot({ path: `output/playwright/ocean-lens-${size.width}x${size.height}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await context.click();
    const station = overview.getByRole('button', { name: /Helsinki Kaisaniemi/ });
    await station.click(); await inspector.waitFor();
    check(await inspector.locator('.history-section').count() > 0, 'Station history lost');
    await page.getByRole('button', { name: 'Close inspector sheet' }).click();
    check(!await inspector.isVisible() && await context.innerText() === 'Inspect', 'Sheet close cleared selection');
    await context.click(); check((await inspector.innerText()).includes('Helsinki Kaisaniemi'), 'Selection not retained');
    await page.keyboard.press('Escape'); check(!await inspector.isVisible(), 'Escape failed to close inspector');
    await page.locator('#layers-trigger').click();
    await group('Environment').locator(':scope > summary').click();
    await layers.getByRole('button', { name: /Helsinki Kaisaniemi/ }).click();
    await inspector.waitFor();
    check((await inspector.innerText()).includes('Helsinki Kaisaniemi'), 'Environment did not reopen retained station');
    check(await page.locator('#inspection-heading').evaluate(element => element === document.activeElement), 'Retained station inspector not focused');
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
    check(await context.innerText() === 'Overview', 'Clear selection failed');
    await page.locator('#layers-trigger').click();
    if (!await group('Environment').evaluate(element => element.open)) await group('Environment').locator(':scope > summary').click();
    for (const name of ['Weather stations', 'Air-quality stations']) {
      const toggle = layers.getByRole('checkbox', { name, exact: true });
      await toggle.uncheck(); check(!await toggle.isChecked(), 'Environment switch failed'); await toggle.check();
    }
    await page.keyboard.press('Escape');
    // A popover owns Escape without clearing an existing station selection.
    const search = page.getByRole('searchbox');
    await search.fill('Mannerheimintie');
    await page.locator('.search-results').getByRole('button', { name: /Helsinki Mannerheimintie/ }).click();
    await inspector.waitFor();
    await page.locator('#project-menu-trigger').click(); await page.keyboard.press('Escape');
    check(await inspector.isVisible(), 'Project popover Escape closed inspection');
    await page.getByRole('button', { name: 'Help using the city' }).click();
    check(await page.locator('dialog[open]').count() === 1, 'Help dialog missing');
    await page.keyboard.press('Escape');
    check(await page.getByRole('button', { name: 'Help using the city' }).evaluate(element => element === document.activeElement), 'Help focus not restored');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
    for (const name of ['Harbour', 'Central Station', 'City Centre']) {
      await presets.getByRole('button', { name, exact: true }).click();
      check(await presets.getByRole('button', { name, exact: true }).getAttribute('aria-pressed') === 'true', 'Preset state lost');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(await page.locator('.layer-control').first().evaluate(element => getComputedStyle(element).transitionDuration === '0s'), 'Reduced motion ignored');
    // Search and native accordion keys must not pan the scene.
    await page.waitForTimeout(1200);
    const flag = page.locator('.station-flag.weather');
    const before = await flag.getAttribute('style');
    await search.focus(); await page.keyboard.down('w'); await page.waitForTimeout(600); await page.keyboard.up('w');
    check(await flag.getAttribute('style') === before, 'Typing pans the camera');
    await search.fill(''); await page.keyboard.press('Escape');
    return { layouts: 5, overview: true, panels: true, selectionPreserved: true, environment: true, keyboard: true, reducedMotion: true, cameraPresets: true };
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize(original); await page.reload();
  }
}
