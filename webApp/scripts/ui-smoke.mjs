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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
    localStorage.setItem('notepad.endpoint', 'https://ui-qa.invalid');
    sessionStorage.setItem('notepad.session', JSON.stringify({ endpoint: 'https://ui-qa.invalid', user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', identifier: 'UI preview' }, sessionToken: 'test-only', expiresAt: '2099-01-01T00:00:00Z' }));
  });
  await page.route('https://ui-qa.invalid/**', route => route.fulfill({ status: 503, body: 'Offline preview' }));
  await page.reload();
  await page.locator('#library-empty').waitFor({ state: 'visible' });
  await screenshot({ path: `${output}/empty-library.png` });
  for (const title of ['Everyday notes', 'Design explorations', 'บันทึกการเรียนรู้', 'Ideas & sketches', 'Reading journal']) {
    await page.locator('#library-new').click();
    await page.locator('#new-document-notebook').click();
    await page.locator('#notebook-title').fill(title);
    await page.locator('#notebook-form button[type=submit]').click();
    await page.locator('#editor-workspace').waitFor({ state: 'visible' });
    await page.locator('#back-library').click();
  }
  await screenshot({ path: `${output}/library-desktop.png` });
  await page.locator('.book-star').first().click();
  await page.locator('#library-favorites').click();
  assert.equal(await page.locator('.library-book').count(), 1);
  await page.locator('#library-documents').click();
  await page.locator('#library-layout').click();
  await screenshot({ path: `${output}/library-list.png` });
  await page.locator('#library-layout').click();
  await page.locator('#library-search').fill('ไม่มีสมุดชื่อนี้');
  await page.locator('#library-empty').waitFor({ state: 'visible' });
  await page.locator('#library-search').fill('');
  for (const width of [1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#library').waitFor({ state: 'visible' });
    assert(await page.locator('#library').evaluate(e => e.scrollWidth <= e.clientWidth), `Library overflows at ${width}`);
    await screenshot({ path: `${output}/library-${width}.png` });
    await page.locator('#library-new').click();
    await screenshot({ path: `${output}/new-document-${width}.png` });
    await page.locator('#cancel-new-document').click();
    await page.locator('.book-open').first().click();
    assert(await page.locator('#editor-workspace').evaluate(e => e.scrollWidth <= e.clientWidth), `Editor overflows at ${width}`);
    await page.locator('#highlighter-tool').click();
    await page.locator('#pen-tool').click();
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
    await page.locator('#close-inspector').click();
    await page.locator('#back-library').click();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: library, favorites, search, list, creation, tools, popup hit targets and details at 1440/1024/768/390/360px; no page errors.');
} finally {
  await browser?.close();
  server.kill();
}
