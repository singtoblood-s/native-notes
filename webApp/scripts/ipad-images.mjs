import { webkit, chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

// Isolated local data. Desktop WebKit catches engine regressions, not iPad GPU speed.
const port = "4188";
const url = process.env.QA_URL || `http://127.0.0.1:${port}/native-notes/`;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error("QA_URL must be a local test server.");
const server = process.env.QA_URL ? null : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", port, "--strictPort"], { windowsHide: true, stdio: "ignore" });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(url).then(response => response.ok).catch(() => false)) break;
    if (attempt === 59) throw new Error("Local server did not start");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const engine = process.env.QA_ENGINE === "chromium" ? chromium : webkit;
  browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ ...devices["iPad (gen 7)"], serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("notepad.endpoint", "https://qa.invalid");
    sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://qa.invalid", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "QA" }, sessionToken: "qa-only", expiresAt: "2099-01-01T00:00:00Z" }));
    window.qa = { saves: [], persistence: null, copies: 0 };
    const send = Worker.prototype.postMessage;
    const pending = new WeakMap();
    Worker.prototype.postMessage = function (request, ...args) {
      if (!pending.has(this)) {
        const requests = new Map();
        pending.set(this, requests);
        this.addEventListener("message", ({ data }) => {
          const entry = requests.get(data.id);
          if (!entry) return;
          requests.delete(data.id);
          if (entry.method === "open") window.qa.persistence = data.value?.persistence;
          if (entry.method === "savePage" && data.ok && data.value.status === "saved") {
            window.qa.saves.push({ strokes: entry.strokes, images: entry.images, ms: performance.now() - entry.start });
          }
        });
      }
      pending.get(this).set(request.id, { method: request.method, start: performance.now(), strokes: request.args?.[0]?.strokes?.length, images: request.args?.[0]?.images?.length });
      return send.call(this, request, ...args);
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.id === "ink-canvas") window.qa.copies++;
      return draw.apply(this, args);
    };
  });
  await page.route("https://qa.invalid/**", route => route.fulfill({ status: 503, body: "Offline QA" }));
  await page.goto(url);
  await page.locator("#library-new").click();
  await page.locator("#new-document-notebook").click();
  await page.locator("#notebook-title").fill("iPad image regression");
  await page.locator("#notebook-form button[type=submit]").click();
  await page.waitForFunction(() => !document.querySelector("#editor-workspace").hidden);
  await page.evaluate(async () => {
    const source = document.createElement("canvas"); source.width = 2400; source.height = 1800;
    const ctx = source.getContext("2d");
    ctx.fillStyle = "#287bb5"; ctx.fillRect(0, 0, source.width, source.height);
    ctx.fillStyle = "#ffffff"; ctx.font = "100px sans-serif"; ctx.fillText("Photo + Pencil", 150, 250);
    const blob = await new Promise(resolve => source.toBlob(resolve, "image/jpeg", .95));
    const files = new DataTransfer(); files.items.add(new File([blob], "Camera.jpg", { type: "image/jpeg" }));
    const input = document.querySelector("#image-input"); input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    source.width = source.height = 1;
  });
  await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 1);
  const imageSource = await page.locator(".image-select img").getAttribute("src");
  await page.waitForFunction(() => window.qa.saves.some(save => save.images === 1));
  assert.equal(await page.evaluate(() => window.qa.persistence), "indexeddb");
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  const paperPosition = () => page.evaluate(() => {
    const scroll = document.querySelector("#paper-scroll");
    const rect = document.querySelector("#ink-canvas").getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft };
  });
  await page.evaluate(() => document.querySelector("#paper-scroll").scrollTo(80, 120));
  const writingPosition = await paperPosition();
  const frames = [];
  for (const tool of ["pen", "highlighter"]) {
    await page.locator(`#${tool}-tool`).click();
    frames.push(...await page.evaluate(async () => {
      const canvas = document.querySelector("#ink-canvas");
      const rect = canvas.getBoundingClientRect();
      const event = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 11, pointerType: "pen", bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pressure: type === "pointerup" ? 0 : .5, clientX: rect.left + x, clientY: rect.top + y }));
      const times = []; let previous = performance.now();
      event("pointerdown", 90, 180);
      for (let index = 0; index < 40; index++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(); times.push(now - previous); previous = now;
        event("pointermove", 90 + index * 7, 180 + index * 2);
      }
      event("pointerup", 363, 258);
      return times;
    }));
  }
  await page.waitForFunction(() => window.qa.saves.some(save => save.strokes === 2 && save.images === 1));
  assert.equal(await page.evaluate(() => window.qa.copies), 0, "Live ink must not copy the full photo canvas");
  const geometry = await page.evaluate(() => {
    const ink = document.querySelector("#ink-canvas"); const background = document.querySelector(".paper-background-canvas");
    const a = ink.getBoundingClientRect(); const b = background.getBoundingClientRect();
    return { delta: Math.abs(a.x-b.x) + Math.abs(a.y-b.y) + Math.abs(a.width-b.width) + Math.abs(a.height-b.height), imagePixel: [...background.getContext("2d").getImageData(300, 300, 1, 1).data] };
  });
  assert(geometry.delta < .05, "Preview ink and committed ink must have identical page coordinates");
  assert.equal(geometry.imagePixel[3], 255);
  assert.deepEqual(await paperPosition(), writingPosition, "Lifting the Pencil and saving must not move the zoomed page");

  let notebookChange;
  await page.route("https://qa.invalid/v1/sync/**", route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname.endsWith("/push")) {
      const results = request.postDataJSON().operations.map(operation => {
        const revision = operation.baseRevision + 1;
        if (operation.entityType === "notebook") {
          notebookChange = {
            sequence: 1, entityType: "notebook", entityId: operation.entityId, revision: revision + 1, action: "upsert",
            payload: { ...operation.payload, title: "Synced iPad notebook", revision: revision + 1, updatedAt: new Date().toISOString() },
          };
        }
        return { opId: operation.opId, status: "acked", revision };
      });
      return route.fulfill({ headers, json: { results, cursor: 0 } });
    }
    const cursor = Number(url.searchParams.get("cursor"));
    return route.fulfill({ headers, json: {
      changes: notebookChange && cursor === 0 ? [notebookChange] : [],
      nextCursor: notebookChange ? 1 : 0, hasMore: false,
    } });
  });
  await page.locator("#sync-button").click();
  await page.waitForFunction(() => document.querySelector("#notebook-name").textContent === "Synced iPad notebook");
  assert.deepEqual(await paperPosition(), writingPosition, "A pulled change must preserve the active page's zoom and scroll position");
  await mkdir("test-results/ipad", { recursive: true });
  await page.screenshot({ path: `test-results/ipad/${engine.name()}-photo-ink.png` });
  await page.locator("#add-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
  await page.locator("#previous-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2");
  const scrollPhoto = () => page.evaluate(async () => {
    const surface = document.querySelector("#ink-canvas");
    const scroller = document.querySelector("#paper-scroll");
    const before = scroller.scrollTop;
    const rect = surface.getBoundingClientRect();
    const pointer = (type, id, y) => surface.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", bubbles: true, cancelable: true, isPrimary: id === 22, clientX: rect.left + (id === 22 ? 30 : 180), clientY: y, button: 0, buttons: 1 }));
    pointer("pointerdown", 22, rect.top + 370);
    pointer("pointermove", 22, rect.top + 350);
    await new Promise(resolve => setTimeout(resolve, 115));
    pointer("pointermove", 22, rect.top + 325);
    pointer("pointermove", 22, rect.top + 300);
    const single = scroller.scrollTop - before;
    pointer("pointerdown", 23, rect.top + 300);
    pointer("pointermove", 22, rect.top + 235);
    pointer("pointermove", 23, rect.top + 235);
    await new Promise(requestAnimationFrame);
    const after = scroller.scrollTop;
    pointer("pointercancel", 22, rect.top + 250);
    pointer("pointercancel", 23, rect.top + 250);
    scroller.scrollTop = before;
    return { single, pair: after - before - single };
  });
  const normal = await scrollPhoto();
  assert(normal.single > 10 && normal.pair > 10, "One intentional finger and two fingers must each scroll the photo page");
  await page.locator("#auth-button").click();
  const scrollChoice = page.getByRole("group", { name: "Scroll while writing" });
  const oneFinger = scrollChoice.getByRole("radio", { name: "One finger", exact: true });
  const strict = scrollChoice.getByRole("radio", { name: "Two fingers only", exact: true });
  assert.equal(await oneFinger.isChecked(), true);
  await strict.check();
  await page.locator("#cancel-settings").click();
  const guarded = await scrollPhoto();
  assert.equal(guarded.single, 0, "The writing preference must hold the page still with one finger");
  assert(guarded.pair > 10, "The writing preference must preserve two-finger pan");
  const saves = await page.evaluate(() => window.qa.saves);
  await page.reload();
  await page.locator("[data-open-book]").click();
  await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 1);
  assert.equal(await page.locator(".image-select img").getAttribute("src"), imageSource, "The original-quality image must persist locally while sync is unavailable");
  await page.locator("#text-toggle").click();
  await page.locator("[data-image-select]").click();
  await page.locator("#close-inspector").click();
  await page.locator(".image-delete-button").tap();
  await page.waitForFunction(() => window.qa.saves.some(save => save.strokes === 2 && save.images === 0));

  await page.locator("#add-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "3 / 3");
  await page.locator("#pen-tool").click();
  await page.locator("#pen-style").selectOption("ball");
  const color = page.getByRole("button", { name: "Terracotta", exact: true });
  await color.click();
  await page.locator('button[data-width="6"]').click();
  const contact = (x, y) => page.evaluate(({ x, y }) => {
    const canvas = document.querySelector("#ink-canvas");
    const rect = canvas.getBoundingClientRect();
    const event = (type, offset) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: 31, pointerType: "pen", isPrimary: true, bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, pressure: type === "pointerup" ? 0 : .5,
      clientX: rect.left + x + offset, clientY: rect.top + y,
    }));
    event("pointerdown", 0);
    event("pointermove", 16);
    const eraserDuringContact = document.querySelector("#eraser-tool").getAttribute("aria-pressed");
    event("pointerup", 16);
    return eraserDuringContact;
  }, { x, y });
  const clearSaves = () => page.evaluate(() => { window.qa.saves.length = 0; });
  const waitForStrokes = (strokes) => page.waitForFunction(strokes =>
    window.qa.saves.some(save => save.strokes === strokes && save.images === 0), strokes);
  await clearSaves();
  await contact(95, 155);
  await waitForStrokes(1);
  await page.locator("#float-tools").click();
  const eraser = page.locator("#floating-eraser-button");
  await eraser.tap();
  assert.equal(await eraser.getAttribute("aria-pressed"), "true");
  await contact(280, 230);
  assert.equal(await eraser.getAttribute("aria-pressed"), "true", "A miss keeps the eraser ready");
  assert.equal(await contact(95, 155), "true", "Keep erasing until the Pencil lifts");
  await waitForStrokes(0);
  await page.waitForFunction(() => document.querySelector("#pen-tool").getAttribute("aria-pressed") === "true");
  assert.equal(await page.locator("#pen-style").inputValue(), "ball");
  assert.equal(await page.locator("#width-range").inputValue(), "6");
  assert.equal(await page.locator('[aria-label="Terracotta"]').getAttribute("aria-pressed"), "true");
  assert.equal(await eraser.getAttribute("aria-pressed"), "false");
  await page.locator("#floating-tools-button").click();
  assert.equal(await eraser.isVisible(), false, "The palette should show only one eraser");
  await page.locator("#more-floating-tools").click();
  await page.locator("#dock-tools").click();
  await page.locator("#auth-button").click();
  const settings = page.locator("#settings-form");
  await settings.locator("#return-after-erase").uncheck();
  await settings.locator("#show-eraser-shortcut").uncheck();
  await settings.getByRole("button", { name: "Save settings" }).click();
  await settings.waitFor({ state: "hidden" });
  await clearSaves();
  await contact(95, 155);
  await waitForStrokes(1);
  await page.keyboard.press("e");
  await contact(95, 155);
  await waitForStrokes(0);
  assert.equal(await page.locator("#eraser-tool").getAttribute("aria-pressed"), "true", "Turning off auto-return keeps eraser selected");
  await page.locator("#float-tools").click();
  assert.equal(await eraser.isVisible(), false);
  await page.locator("#floating-tools-button").click();
  await page.locator("#more-floating-tools").click();
  await page.locator("#back-library").click();
  await page.reload();
  await page.locator("#library-settings").click();
  assert.equal(await strict.isChecked(), true, "The two-finger preference must persist after reopening");
  await oneFinger.check();
  await page.locator("#cancel-settings").click();
  await page.reload();
  await page.locator("#library-settings").click();
  assert.equal(await oneFinger.isChecked(), true, "Changing back to one finger must persist without Save settings");
  assert.equal(await settings.locator("#return-after-erase").isChecked(), false);
  assert.equal(await settings.locator("#show-eraser-shortcut").isChecked(), false);
  assert.deepEqual(errors, []);
  frames.sort((a, b) => a - b);
  console.log(JSON.stringify({ engine: engine.name(), persistence: "indexeddb", photoSurvivedReload: true, strokesSurvivedReload: true, eraserSettingsVerified: true, fullPageCopies: 0, frameP95Ms: Math.round(frames[Math.floor(frames.length * .95)]), saves }, null, 2));
} finally {
  await browser?.close();
  server?.kill();
}
