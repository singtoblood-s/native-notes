import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Disposable local browser data; no real account or sync server is used.
const url = 'http://127.0.0.1:4186/native-notes/';
const output = 'test-results/ui';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '4186', '--strictPort'], { windowsHide: true, stdio: 'ignore' });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(url).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
  const page = await context.newPage();
  const screenshot = async options => {
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    await page.screenshot(options);
  };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.locator('#auth-dialog').waitFor({ state: 'visible' });
  await screenshot({ path: `${output}/sign-in.png` });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    localStorage.setItem('notepad.endpoint', 'https://ui-qa.invalid');
    sessionStorage.setItem('notepad.session', JSON.stringify({ endpoint: 'https://ui-qa.invalid', user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', identifier: 'UI preview' }, sessionToken: 'test-only', expiresAt: '2099-01-01T00:00:00Z' }));
  });
  await page.route('https://ui-qa.invalid/**', route => route.fulfill({ status: 503, body: 'Offline preview' }));
  await page.reload();
  await page.locator('#library-empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('dialog').evaluateAll(dialogs => dialogs.every(d => document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim())), true);
  await screenshot({ path: `${output}/empty-library.png` });
  for (const title of ['Everyday notes', 'Design explorations', 'บันทึกการเรียนรู้', 'Ideas & sketches', 'Reading journal']) {
    if (title === 'Everyday notes') {
      await page.getByRole('button', { name: 'New notebook', exact: true }).click();
    } else {
      await page.locator('#library-new').click();
      await page.locator('#new-document-notebook').click();
    }
    await page.locator('#notebook-title').fill(title);
    if (title === 'Design explorations') await page.locator('[data-paper="grid"]').click();
    if (title === 'Ideas & sketches') await page.locator('[data-paper="blank"]').click();
    await page.locator('#notebook-form button[type=submit]').click();
    await page.locator('#editor-workspace').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'editor-workspace');
    await page.locator('#back-library').click();
  }
  await screenshot({ path: `${output}/library-desktop.png` });
  await page.locator('#library-favorites').click();
  await page.getByRole('button', { name: 'Browse documents' }).click();
  assert.equal(await page.locator('#library-documents').getAttribute('aria-current'), 'page');
  await page.locator('.book-star').first().click();
  await page.locator('#library-favorites').click();
  assert.equal(await page.locator('.library-book').count(), 1);
  await page.locator('#library-documents').click();
  await page.locator('#library-layout').click();
  assert.equal(await page.locator('#library-layout').getAttribute('aria-pressed'), 'false');
  await screenshot({ path: `${output}/library-grid.png` });
  await page.locator('#library-layout').click();
  await page.locator('#library-search').fill('ไม่มีสมุดชื่อนี้');
  await page.locator('#library-empty').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  assert.equal(await page.locator('#library-search').inputValue(), '');
  assert(await page.locator('#library-search').evaluate(e => e === document.activeElement));
  for (const width of [1440, 1024, 768, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#library').waitFor({ state: 'visible' });
    assert(await page.locator('#library').evaluate(e => e.scrollWidth <= e.clientWidth), `Library overflows at ${width}`);
    await screenshot({ path: `${output}/library-${width}.png` });
    await page.locator('#library-new').click();
    await screenshot({ path: `${output}/new-document-${width}.png` });
    await page.locator('#cancel-new-document').click();
    await page.locator('.book-open').first().click();
    await page.waitForFunction(() => document.activeElement?.id === 'editor-workspace');
    assert(await page.locator('#editor-workspace').evaluate(e => e.scrollWidth <= e.clientWidth), `Editor overflows at ${width}`);
    assert(await page.locator('.stage-foot').evaluate(e => e.scrollWidth <= e.clientWidth), `Zoom controls overflow at ${width}`);
    await page.locator('#highlighter-tool').click();
    await page.locator('#pen-tool').click();
    const inkToggle = page.locator('#ink-options-toggle');
    const widthRange = page.locator('#width-range');
    if (width <= 480) {
      assert(await inkToggle.isVisible());
      assert(!(await widthRange.isVisible()));
      await inkToggle.press('Enter');
      assert.equal(await inkToggle.getAttribute('aria-expanded'), 'true');
      assert(await widthRange.isVisible());
      assert(await page.locator('#ink-options').evaluate(e => e.scrollWidth <= e.clientWidth), `Ink options overflow at ${width}`);
      const initial = Number(await widthRange.inputValue());
      await widthRange.press('ArrowRight');
      assert.equal(Number(await widthRange.inputValue()), initial + 0.5);
      await widthRange.press('ArrowLeft');
      await inkToggle.press('Enter');
      assert(!(await widthRange.isVisible()));
      await page.locator('#page-menu').click();
      await page.locator('#page-menu-popup [data-action="export-media"]').click();
      await page.locator('#export-dialog').waitFor({ state: 'visible' });
      await page.locator('#export-cancel').click();
    } else {
      assert(!(await inkToggle.isVisible()));
      assert(await widthRange.isVisible());
    }
    await page.locator('#toolbar-insert').click();
    await page.locator('#insert-picture').waitFor({ state: 'visible' });
    const box = await page.locator('#insert-menu').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width, `Insert popup clipped at ${width}`);
    // Hit testing catches popups hidden beneath the paper despite being "visible".
    assert(await page.locator('#insert-picture').evaluate(e => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
    await page.keyboard.press('Escape');
    await screenshot({ path: `${output}/editor-${width}.png` });
    await page.locator('#text-toggle').click();
    await page.locator('#page-text').fill('บันทึกความคิด\nA little space to think.');
    await screenshot({ path: `${output}/details-${width}.png` });
    const moreActions = page.locator('#inspector .inspector-secondary-actions > summary');
    assert(!(await page.locator('#export-button').isVisible()));
    await moreActions.press('Enter');
    assert(await page.locator('#export-button').isVisible());
    await moreActions.press('Enter');
    await page.locator('#close-inspector').click();
    await page.locator('#back-library').click();
  }
  await page.setViewportSize({ width: 390, height: 720 });
  await page.locator('.book-open').first().click();
  await page.locator('#editor-workspace').waitFor();
  await page.locator('#mobile-menu').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'close-sidebar');
  await page.keyboard.press('Shift+Tab');
  assert(await page.locator('#sidebar').evaluate(e => e.contains(document.activeElement)));
  await page.locator('#search-input').focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'mobile-menu');
  await page.locator('#text-toggle').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'page-text');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'text-toggle');
  await page.locator('#page-menu').click();
  await page.keyboard.press('Escape');
  assert(await page.locator('#page-menu').evaluate(e => e === document.activeElement));
  await page.locator('#back-library').click();

  await page.locator('#library-trash').click();
  await page.locator('#sidebar.is-open').waitFor();
  assert.equal(await page.locator('#notebook-list [data-notebook]').count(), 0);
  assert.equal(await page.locator('#editor-empty-title').textContent(), 'Trash is empty');
  assert(await page.locator('#text-toggle').isDisabled());
  await page.keyboard.press('Escape');
  await page.locator('#back-library').click();
  await page.locator('.book-menu-button').first().click();
  await page.locator('.library-book .quick-menu:not([hidden]) [data-action=trash-notebook]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-open-book]').length === 4);
  await page.locator('#library-trash').click();
  await page.locator('#sidebar.is-open').waitFor();
  assert.equal(await page.locator('#notebook-list [data-notebook]').count(), 1);
  await page.locator('#page-list .nav-menu-button').first().click();
  await page.locator('#page-list .quick-menu:not([hidden]) [data-action=restore-notebook]').click();
  await page.waitForFunction(() => document.querySelector('#editor-empty-title').textContent === 'Trash is empty');
  await page.keyboard.press('Escape');
  await page.locator('#back-library').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-open-book]').length === 5);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
  });
  await page.locator('#library-sync-button').click();
  await page.waitForFunction(() => document.querySelector('#library-sync-button').dataset.state === 'error');
  const errorMessage = await page.locator('#library-sync-button').getAttribute('aria-label');
  assert.equal(await page.locator('#editor-toast').textContent(), errorMessage);
  assert(await page.locator('#editor-toast').isVisible());
  console.log('PASS: drawer focus and Escape, menu focus, empty Trash, and restoring a parent from its page.');
  assert.deepEqual(errors, []);
  console.log('PASS: library, favorites, search, list/grid, creation, tools, popup hit targets and details at 1440/1024/768/390/360/320px with touch; no page errors.');
} finally {
  await browser?.close();
  server.kill();
}
