import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

// Each browser has an empty profile. All notes stay in the test browser's storage.
const preview = process.env.QA_URL;
if (preview && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(preview)) throw new Error("QA_URL must be a local test server.");
const server = preview ? null : await createServer({ logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
await server?.listen();
const url = preview || `http://127.0.0.1:${server.httpServer.address().port}/native-notes/`;
const bookTitle = "Ink selection QA";

async function backupStrokes(page) {
  await page.locator("#notebook-menu").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#notebook-menu-popup [data-action=export-notebook-backup]").click(),
  ]);
  const archive = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(archive.notebooks[0].title, bookTitle);
  assert.equal(archive.pages.length, 1);
  return archive.pages[0].strokes;
}

async function paperPoint(page, [x, y]) {
  const box = await page.locator("#ink-canvas").boundingBox();
  assert(box, "The active writing canvas must be visible");
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}

async function drag(page, from, to) {
  const start = await paperPoint(page, from);
  const end = await paperPoint(page, to);
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, start), "ink-canvas");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function viewport(page) {
  return page.locator("#ink-canvas").evaluate(canvas => {
    const { x, y, width } = canvas.getBoundingClientRect();
    return [x, y, width];
  });
}

function sameViewport(actual, expected, label) {
  assert(actual.every((value, index) => Math.abs(value - expected[index]) < 1), label);
}

async function touch(page, phase, id, point) {
  await page.locator("#ink-canvas").dispatchEvent(`pointer${phase}`, {
    pointerId: id, pointerType: "touch", isPrimary: id === 1, button: 0,
    buttons: phase === "up" ? 0 : 1, clientX: point.x, clientY: point.y,
    bubbles: true, cancelable: true,
  });
}

async function checkFingerCounts(page) {
  const point = await paperPoint(page, [.52, .38]);
  const at = (dx, dy) => ({ x: point.x + dx, y: point.y + dy });
  const started = await viewport(page);
  // Start outside the ink. In Select, a finger can interact with the page
  // without dragging the viewport. The second contact takes over navigation.
  await touch(page, "down", 1, at(0, 0));
  await touch(page, "move", 1, at(-12, -16));
  await page.waitForTimeout(115);
  await touch(page, "move", 1, at(-25, -25));
  sameViewport(await viewport(page), started, "An intentional marquee drag must select instead of panning the page");
  await touch(page, "down", 2, at(66, 0));
  await touch(page, "move", 1, at(-40, -30));
  await touch(page, "move", 2, at(95, -20));
  const zoomed = await viewport(page);
  assert(zoomed[2] > started[2] + 10, "Two moving contacts must zoom the paper");
  await touch(page, "down", 3, at(0, 75));
  await touch(page, "move", 1, at(-65, -48));
  await touch(page, "move", 2, at(110, -45));
  await touch(page, "move", 3, at(0, 45));
  sameViewport(await viewport(page), zoomed, "Three contacts moved the page");
  await touch(page, "up", 3, at(0, 45));
  sameViewport(await viewport(page), zoomed, "Releasing the third contact jumped the viewport");
  await touch(page, "move", 1, at(-75, -85));
  await touch(page, "move", 2, at(100, -82));
  const panned = await viewport(page);
  assert(Math.abs(panned[1] - zoomed[1]) > 5, "The two remaining contacts must pan");
  await touch(page, "up", 2, at(100, -82));
  await touch(page, "move", 1, at(-105, -118));
  await touch(page, "up", 1, at(-105, -118));
  sameViewport(await viewport(page), panned, "The last finger moved the page after the second was released");
}

async function run(engine) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 810, height: 1000 }, hasTouch: true, acceptDownloads: true });
    await context.addInitScript(() => {
      localStorage.setItem("notepad.endpoint", "https://qa.invalid");
      sessionStorage.setItem("notepad.session", JSON.stringify({
        endpoint: "https://qa.invalid", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "QA" },
        sessionToken: "local-only", expiresAt: "2099-01-01T00:00:00Z",
      }));
    });
    await context.route("https://qa.invalid/**", route => route.fulfill({ status: 503, body: "Offline test" }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.goto(url);
    await page.locator("#library-new").click();
    await page.locator("#new-document-notebook").click();
    await page.locator("#notebook-title").fill(bookTitle);
    await page.locator("#notebook-form button[type=submit]").click();
    await page.locator("#pen-tool").click();
    await drag(page, [.22, .25], [.32, .27]);
    await drag(page, [.22, .30], [.32, .32]);
    await drag(page, [.64, .26], [.70, .28]);
    const original = await backupStrokes(page);
    assert.equal(original.length, 3);
    await page.locator("#select-tool").click();
    await drag(page, [.17, .20], [.37, .35]);
    await page.locator(".ink-selection-box:visible").waitFor();
    await drag(page, [.27, .28], [.38, .40]);
    const moved = await backupStrokes(page);
    assert.deepEqual(moved.map(s => s.id), original.map(s => s.id));
    assert.deepEqual(moved[2], original[2], "Ink outside the selection changed");
    const dx = moved[0].points[0].x - original[0].points[0].x;
    const dy = moved[0].points[0].y - original[0].points[0].y;
    assert(dx > 10 && dy > 10, "The selected ink did not move diagonally");
    for (let i = 0; i < 2; i++) {
      assert.equal(moved[i].points.length, original[i].points.length);
      moved[i].points.forEach((point, j) => {
        assert(Math.abs(point.x - original[i].points[j].x - dx) < .01);
        assert(Math.abs(point.y - original[i].points[j].y - dy) < .01);
      });
    }
    await page.locator("#undo-button").click();
    assert.deepEqual(await backupStrokes(page), original, "Undo move must restore both strokes");
    await page.locator("#redo-button").click();
    assert.deepEqual(await backupStrokes(page), moved, "Redo move changed the geometry");

    // Select the separate stroke and remove it while the toolbar is phone-sized.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#select-tool").click();
    await drag(page, [.60, .21], [.74, .32]);
    const remove = page.locator("#delete-selected-ink");
    await remove.click();
    const kept = moved.slice(0, 2);
    assert.deepEqual(await backupStrokes(page), kept, "Deleting one stroke changed the other two");
    await page.locator("#undo-button").click();
    assert.deepEqual(await backupStrokes(page), moved, "Undo delete did not restore the stroke");
    await page.locator("#redo-button").click();
    assert.deepEqual(await backupStrokes(page), kept, "Redo delete removed different ink");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "The phone toolbar widened the document");
    await page.locator("#back-library").click();
    await page.reload();
    await page.locator("[data-open-book]").filter({ hasText: bookTitle }).click();
    assert.deepEqual(await backupStrokes(page), kept, "Reopening changed the saved selection edits");

    await page.setViewportSize({ width: 810, height: 1000 });
    await page.locator("#select-tool").click();
    await checkFingerCounts(page);
    assert.deepEqual(await backupStrokes(page), kept, "Touch navigation wrote, moved, or deleted ink");
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine.name()}: group move, delete, undo/redo, phone toolbar, reload, one/two/three touch transitions`);
  } finally {
    await browser.close();
  }
}

try {
  for (const engine of [chromium, webkit]) await run(engine);
} finally {
  await server?.close();
}
