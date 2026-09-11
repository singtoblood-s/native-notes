import { chromium } from "playwright";
import { PDFDocument, rgb } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Isolated browser storage and a deliberately unavailable sync endpoint; never uses personal notes.
const port = process.env.QA_PORT ?? "4177";
const url = process.env.QA_URL ?? `http://127.0.0.1:${port}/native-notes/`;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error("QA_URL must be a local test server.");
const output = "test-results/editor";
await mkdir(output, { recursive: true });
const server = process.env.QA_URL ? null : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", port, "--strictPort"], { windowsHide: true, stdio: "ignore" });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(url).then(response => response.ok).catch(() => false)) break;
    if (attempt === 59) throw new Error("Local test server did not start.");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true, ...(process.env.QA_BROWSER_CHANNEL ? { channel: process.env.QA_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("notepad.endpoint", "https://qa.invalid");
    sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://qa.invalid", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "QA" }, sessionToken: "qa-only", expiresAt: "2099-01-01T00:00:00Z" }));
  });
  await page.route("https://qa.invalid/**", route => route.fulfill({ status: 503, body: "Offline QA" }));
  await page.goto(url);
  if (process.env.QA_OFFLINE === "1") {
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), {}, { timeout: 30_000 });
    await context.setOffline(true);
    await page.reload();
  }
  const source = await PDFDocument.create();
  for (const [title, dimensions] of [["Portrait", [595, 842]], ["Landscape", [842, 595]]]) {
    const sheet = source.addPage(dimensions);
    sheet.drawRectangle({ x: 0, y: 0, width: dimensions[0], height: dimensions[1], color: rgb(.93, .96, 1) });
    sheet.drawText(`${title} PDF test`, { x: 40, y: dimensions[1] - 80, size: 26, color: rgb(.1, .25, .45) });
  }
  if (process.env.QA_LARGE_MEDIA === "1") source.context.register(source.context.stream(new Uint8Array(55 * 1024 * 1024)));
  const pdfFile = { name: "Mixed pages.pdf", mimeType: "application/pdf", buffer: Buffer.from(await source.save()) };
  const pdfPath = `${output}/source.pdf`;
  await writeFile(pdfPath, pdfFile.buffer);
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 260;
    const context = canvas.getContext("2d"); context.fillStyle = "#eeb530"; context.fillRect(30, 30, 340, 200); context.fillStyle = "#252429"; context.font = "24px sans-serif"; context.fillText("PASTE IMAGE", 100, 140);
    return canvas.toDataURL().split(",")[1];
  });
  const picture = { name: "Picture.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from(imageData, "base64"), Buffer.alloc(process.env.QA_LARGE_MEDIA === "1" ? 13 * 1024 * 1024 : 0)]) };
  await page.locator("#library-new").click();
  await page.locator("#new-document-pdf").click();
  await page.locator("#media-input").setInputFiles(pdfPath);
  await page.waitForFunction(() => !document.querySelector("#media-dialog").open, {}, { timeout: 30_000 });
  assert.equal(await page.locator("#page-position").textContent(), "1 / 2");
  await page.evaluate(() => { window.qaSlots = [...document.querySelectorAll(".flow-page")]; });
  const geometry = () => page.evaluate(() => [...document.querySelectorAll(".flow-page")].map(element => [element.dataset.flowPage, element.offsetWidth, element.offsetHeight]));
  const checkTwoFingerPan = async (mode = "continuous") => {
    await page.locator("#fit-button").click();
    const scroll = page.locator("#paper-scroll");
    const axis = mode === "horizontal" ? "scrollLeft" : "scrollTop";
    await scroll.evaluate((element, axis) => { element.scrollLeft = element.scrollTop = 0; element[axis] = 100; }, axis);
    const rect = await scroll.boundingBox();
    const start = mode === "horizontal" ? [
      { id: 1, x: rect.x + 180, y: rect.y + 6 },
      { id: 2, x: rect.x + 240, y: rect.y + rect.height / 2 },
    ] : [
      { id: 1, x: rect.x + 6, y: rect.y + 180 },
      { id: 2, x: rect.x + rect.width / 2, y: rect.y + 240 },
    ];
    assert(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.id !== "ink-canvas", start[0]), "One finger must start outside the active canvas");
    const before = await scroll.evaluate((element, axis) => element[axis], axis);
    const sheets = await geometry();
    const scale = await page.locator("#zoom-label").textContent();
    // Native multi-touch exercises hit testing, touch-action and real pointer capture.
    const touchSession = await context.newCDPSession(page);
    try {
      await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: start });
      for (let step = 1; step <= 5; step++) {
        await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: start.map(point => ({ ...point, [mode === "horizontal" ? "x" : "y"]: point[mode === "horizontal" ? "x" : "y"] - step * 20 })) });
      }
      assert(Math.abs(await scroll.evaluate((element, axis) => element[axis], axis) - before - 100) < 2, `${mode}: two fingers moving together must scroll 100px without zooming`);
      assert.equal(await page.locator("#zoom-label").textContent(), scale);
      assert.deepEqual(await geometry(), sheets);
      await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await touchSession.detach(); }
    await scroll.evaluate((element, axis) => { element[axis] = 0; }, axis);
  };
  await checkTwoFingerPan();
  const checkDocumentZoom = async (mode) => {
    await page.locator("#fit-button").click();
    const original = await geometry();
    const scrollSize = () => page.locator("#paper-scroll").evaluate((element, mode) => mode === "horizontal" ? element.scrollWidth : element.scrollHeight, mode);
    const originalScroll = await scrollSize();
    await page.locator("#zoom-in").click();
    const zoomed = await geometry();
    for (let i = 0; i < original.length; i++) {
      assert(Math.abs(zoomed[i][1] / original[i][1] - 1.16) < .005, `${mode}: every page width must zoom`);
      assert(Math.abs(zoomed[i][2] / original[i][2] - 1.16) < .005, `${mode}: every page height must zoom`);
    }
    assert(await scrollSize() > originalScroll, `${mode}: scrolling must include the enlarged pages`);
    const scale = await page.locator("#zoom-label").textContent();
    await page.locator("#next-page").click();
    await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
    assert.deepEqual(await geometry(), zoomed, `${mode}: switching page must preserve all dimensions`);
    assert.equal(await page.locator("#zoom-label").textContent(), scale);
    const paper = await page.locator("#paper").boundingBox();
    const slot = await page.locator("#active-page-slot").boundingBox();
    assert(Math.abs(paper.width - slot.width) < 2 && Math.abs(paper.height - slot.height) < 2, `${mode}: the entire sheet must fit its scroll slot`);
    assert(Math.abs(paper.x - slot.x) < 2 && Math.abs(paper.y - slot.y) < 2, `${mode}: ink must align with the preview`);
    await page.locator("#previous-page").click();
    await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2");
    const pinchGeometry = await geometry();
    const pinchPaper = await page.locator("#paper").boundingBox();
    const finger = { pointerType: "touch", clientY: 400, button: 0, buttons: 1 };
    await page.locator("#ink-canvas").dispatchEvent("pointerdown", { ...finger, pointerId: 83, clientX: 300 });
    await page.locator("#ink-canvas").dispatchEvent("pointerdown", { ...finger, pointerId: 84, clientX: 500 });
    await page.locator("#ink-canvas").dispatchEvent("pointermove", { ...finger, pointerId: 83, clientX: 290 });
    await page.locator("#ink-canvas").dispatchEvent("pointermove", { ...finger, pointerId: 84, clientX: 510 });
    const pinched = await geometry();
    for (let i = 0; i < pinched.length; i++) {
      assert(Math.abs(pinched[i][1] / pinchGeometry[i][1] - 1.1) < .005, `${mode}: pinch must resize every sheet equally`);
    }
    const anchored = await page.locator("#paper").boundingBox();
    assert(Math.abs(anchored.y + (400 - pinchPaper.y) * 1.1 - 400) < 2, `${mode}: pinch must preserve its vertical anchor`);
    await page.locator("#ink-canvas").dispatchEvent("pointercancel", { ...finger, pointerId: 83, clientX: 290 });
    await page.locator("#ink-canvas").dispatchEvent("pointercancel", { ...finger, pointerId: 84, clientX: 510 });
    await page.locator("#ink-canvas").dispatchEvent("wheel", { ctrlKey: true, deltaY: -100, clientX: 400, clientY: 400 });
    const wheeled = await geometry();
    for (let i = 0; i < wheeled.length; i++) {
      assert(Math.abs(wheeled[i][1] / pinched[i][1] - 1.08) < .005, `${mode}: wheel zoom must resize every sheet equally`);
    }
    await page.locator("#hand-tool").click();
    const beforeDrag = await page.locator("#paper-scroll").evaluate((element, mode) => mode === "horizontal" ? element.scrollLeft : element.scrollTop, mode);
    const contact = { pointerId: 81, pointerType: "touch", clientX: 450, clientY: 450, button: 0, buttons: 1 };
    await page.locator("#ink-canvas").dispatchEvent("pointerdown", contact);
    await page.locator("#ink-canvas").dispatchEvent("pointermove", { ...contact, clientX: mode === "horizontal" ? 350 : 450, clientY: mode === "continuous" ? 350 : 450 });
    const afterDrag = await page.locator("#paper-scroll").evaluate((element, mode) => mode === "horizontal" ? element.scrollLeft : element.scrollTop, mode);
    assert(Math.abs(afterDrag - beforeDrag - 100) < 2, `${mode}: hand dragging after zoom must scroll between sheets`);
    await page.locator("#ink-canvas").dispatchEvent("pointercancel", contact);
    await page.locator("#pen-tool").click();
    await page.screenshot({ path: `${output}/${mode}-zoom.png` });
    await page.locator("#fit-button").click();
  };
  await checkDocumentZoom("continuous");
  const before = await geometry();
  await page.locator("#next-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
  assert.deepEqual(await geometry(), before);
  assert(await page.evaluate(() => window.qaSlots.every(element => element.isConnected)));
  await page.locator("#previous-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2");
  const box = await page.locator("#ink-canvas").boundingBox();
  await page.mouse.move(box.x + 130, box.y + 170); await page.mouse.down();
  await page.mouse.move(box.x + 370, box.y + 250, { steps: 15 }); await page.mouse.up();
  await page.locator("#toolbar-insert").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#insert-picture").click();
  await (await chooser).setFiles(picture);
  await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 2);
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData("text/plain", "ทดสอบข้อความไทย — pasted text");
    document.querySelector("#ink-canvas").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const ink = page.locator("#ink-canvas");
  const touch = { pointerId: 91, pointerType: "touch", clientX: 400, clientY: 440, button: 0, buttons: 1, isPrimary: true };
  await ink.dispatchEvent("pointerdown", touch);
  await ink.dispatchEvent("pointermove", { ...touch, clientX: 430 });
  await page.waitForTimeout(600);
  assert.equal(await page.locator("#paper-clipboard-menu").evaluate(element => element.hidden), true);
  await ink.dispatchEvent("pointercancel", touch);
  await ink.dispatchEvent("pointerdown", touch);
  await ink.dispatchEvent("pointerdown", { ...touch, pointerId: 92, clientX: 480 });
  await page.waitForTimeout(600);
  assert.equal(await page.locator("#paper-clipboard-menu").evaluate(element => element.hidden), true);
  await ink.dispatchEvent("pointercancel", touch);
  await ink.dispatchEvent("pointercancel", { ...touch, pointerId: 92 });
  await ink.dispatchEvent("pointerdown", touch);
  await page.waitForTimeout(600);
  assert.equal(await page.locator("#paper-clipboard-menu").evaluate(element => element.hidden), false);
  await ink.dispatchEvent("pointerup", touch);
  await ink.dispatchEvent("click");
  assert.equal(await page.locator("#paper-clipboard-menu").evaluate(element => element.hidden), false);
  await page.screenshot({ path: `${output}/long-press.png` });
  await page.keyboard.press("Escape");
  await page.locator("#text-toggle").click();
  await page.locator("#copy-image").click(); await page.locator("#paste-image").click();
  await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 3);
  await page.locator("#close-inspector").click();
  await page.locator("#toolbar-export").click();
  const pngDownload = page.waitForEvent("download"); await page.locator("#export-png").click();
  await (await pngDownload).saveAs(`${output}/page.png`);
  const pdfDownload = page.waitForEvent("download"); await page.locator("#export-book-pdf").click();
  const exported = await pdfDownload;
  await exported.saveAs(`${output}/notebook.pdf`);
  const { readFile } = await import("node:fs/promises");
  const reopened = await PDFDocument.load(await readFile(`${output}/notebook.pdf`));
  assert.deepEqual(reopened.getPages().map(sheet => [Math.round(sheet.getWidth()), Math.round(sheet.getHeight())]), [[595, 842], [842, 595]]);
  await page.locator("#export-cancel").click();
  for (const mode of ["horizontal", "paged", "continuous"]) {
    await page.locator("#page-view-mode").selectOption(mode);
    if (mode !== "paged") await checkTwoFingerPan(mode);
    if (mode !== "paged") await checkDocumentZoom(mode);
    assert((await page.locator("#paper-viewport").boundingBox()).height > 100, `${mode} must have a usable writing viewport`);
    await page.locator("#next-page").click(); await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
    await page.locator("#previous-page").click(); await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2");
  }
  await page.reload(); await page.locator("[data-open-book]").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2" && !document.querySelector("#editor-workspace").hidden);
  assert.equal(await page.locator("#page-text").inputValue(), "ทดสอบข้อความไทย — pasted text");
  assert.equal(await page.locator(".image-list-row").count(), 3);
  // Touch removal must work on the selected image even with the pen active.
  await page.locator("#text-toggle").click();
  await page.locator("[data-image-select]").last().click();
  await page.locator("#close-inspector").click();
  await page.locator("#pen-tool").click();
  await page.locator(".image-delete-button").tap();
  await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 2);
  // Clicking an image in hand mode must retain focus for keyboard deletion.
  await page.locator("#hand-tool").click();
  await page.locator(".paper-image-object").last().click({ position: { x: 15, y: 15 } });
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 1);
  // Full-page imported images remain removable from Text, without deleting ink.
  await page.locator("#text-toggle").click();
  await page.locator("[data-image-select]").click();
  await page.locator("#page-text").focus();
  await page.keyboard.press("Backspace");
  assert.equal(await page.locator(".image-list-row").count(), 1);
  await page.locator("[data-image-remove]").click();
  await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 0);
  await page.locator("#close-inspector").click();
  await page.locator("#next-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
  await page.locator("#previous-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2");
  await page.reload(); await page.locator("[data-open-book]").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2");
  assert.equal(await page.locator(".image-list-row").count(), 0, "Deleted images must stay deleted after reload");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.locator("#notebook-menu").click();
  const menu = page.locator("#notebook-menu-popup");
  assert.equal(await menu.locator("button").first().evaluate(element => getComputedStyle(element).color), "rgb(37, 36, 41)");
  await page.screenshot({ path: `${output}/tablet-menu.png` });
  await page.keyboard.press("Escape");
  await checkDocumentZoom("continuous");
  await checkTwoFingerPan();
  // A corrupt PDF must leave the existing notebook intact.
  await page.locator("#toolbar-insert").click(); await page.locator("#insert-pdf").click();
  await page.locator("#media-input").setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("invalid PDF") });
  await page.waitForFunction(() => document.querySelector("#media-status").textContent.includes("Could not import"));
  assert.equal(await page.locator("#page-position").textContent(), "1 / 2");
  await page.locator("#media-cancel").click();
  await page.locator("#back-library").click(); await page.locator("#library-new").click(); await page.locator("#new-document-picture").click();
  await page.locator("#media-input").setInputFiles([picture, { ...picture, name: "Second.png" }]);
  await page.waitForFunction(() => !document.querySelector("#media-dialog").open);
  assert.equal(await page.locator("#page-position").textContent(), "1 / 2");
  const pageCount = await page.locator(".flow-page").count();
  await page.evaluate(base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], "Dropped.png", { type: "image/png" }));
    document.querySelector("#paper").dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, imageData);
  await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 2);
  assert.equal(await page.locator(".flow-page").count(), pageCount);
  const smallPage = await page.locator("#paper").boundingBox();
  const smallSlot = await page.locator("#active-page-slot").boundingBox();
  assert(Math.abs(smallPage.width - smallSlot.width) < 2, "Small picture pages must match preview geometry");
  if (process.env.QA_LARGE_MEDIA === "1") {
    const compression = await page.evaluate(async () => {
      const { imageCanvas, encodePageImage } = await import(`${location.pathname}src/media.ts`);
      const source = document.createElement("canvas"); source.width = 3000; source.height = 1800;
      const context = source.getContext("2d");
      const pixels = context.createImageData(source.width, source.height);
      let seed = 12345;
      const values = new Uint32Array(pixels.data.buffer);
      for (let i = 0; i < values.length; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        values[i] = (seed & 0xffffff) | 0xff000000;
      }
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise(resolve => source.toBlob(resolve, "image/png"));
      const canvas = await imageCanvas(new File([blob], "Large camera image.png", { type: "image/png" }));
      const encoded = await encodePageImage(canvas);
      const files = new DataTransfer();
      files.items.add(new File([blob], "Camera photo.png", { type: "image/png" }));
      const input = document.querySelector("#image-input");
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { originalBytes: blob.size, compressedBytes: atob(encoded.split(",")[1]).length, width: canvas.width, height: canvas.height };
    });
    assert(compression.originalBytes > 12 * 1024 * 1024);
    assert(compression.compressedBytes <= 512 * 1024);
    assert.deepEqual([compression.width, compression.height], [2000, 1200]);
    await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 3);
    const insertedBytes = await page.locator(".image-select img").last().evaluate(image => atob(image.src.split(",")[1]).length);
    assert(insertedBytes <= 512 * 1024, "The actual Insert flow must store the compressed photo");
    await page.screenshot({ path: `${output}/compressed-photo.png` });
    await page.locator(".image-delete-button").tap();
    await page.waitForFunction(() => document.querySelectorAll(".image-list-row").length === 2);
    console.log("Large media compression:", JSON.stringify(compression));
  }
  assert.deepEqual(errors, []);
  console.log("PASS: PDF/image import, annotation, native file chooser, text/image clipboard, long press, stable page slots, all view modes, PDF/PNG export, reload, tablet menu, damaged-file recovery.");
} finally {
  await browser?.close();
  server?.kill();
}
