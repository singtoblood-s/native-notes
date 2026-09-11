import { chromium } from "playwright";
import { PDFDocument, rgb } from "pdf-lib";
import { mkdir } from "node:fs/promises";
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
  const pdfFile = { name: "Mixed pages.pdf", mimeType: "application/pdf", buffer: Buffer.from(await source.save()) };
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 260;
    const context = canvas.getContext("2d"); context.fillStyle = "#eeb530"; context.fillRect(30, 30, 340, 200); context.fillStyle = "#252429"; context.font = "24px sans-serif"; context.fillText("PASTE IMAGE", 100, 140);
    return canvas.toDataURL().split(",")[1];
  });
  const picture = { name: "Picture.png", mimeType: "image/png", buffer: Buffer.from(imageData, "base64") };
  await page.locator("#library-new").click();
  await page.locator("#new-document-pdf").click();
  await page.locator("#media-input").setInputFiles(pdfFile);
  await page.waitForFunction(() => !document.querySelector("#media-dialog").open, {}, { timeout: 30_000 });
  assert.equal(await page.locator("#page-position").textContent(), "1 / 2");
  await page.evaluate(() => { window.qaSlots = [...document.querySelectorAll(".flow-page")]; });
  const geometry = () => page.evaluate(() => [...document.querySelectorAll(".flow-page")].map(element => [element.dataset.flowPage, element.offsetWidth, element.offsetHeight]));
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
    assert((await page.locator("#paper-viewport").boundingBox()).height > 100, `${mode} must have a usable writing viewport`);
    await page.locator("#next-page").click(); await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
    await page.locator("#previous-page").click(); await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2");
  }
  await page.reload(); await page.locator("[data-open-book]").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2" && !document.querySelector("#editor-workspace").hidden);
  assert.equal(await page.locator("#page-text").inputValue(), "ทดสอบข้อความไทย — pasted text");
  assert.equal(await page.locator(".image-list-row").count(), 3);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.locator("#notebook-menu").click();
  const menu = page.locator("#notebook-menu-popup");
  assert.equal(await menu.locator("button").first().evaluate(element => getComputedStyle(element).color), "rgb(37, 36, 41)");
  await page.screenshot({ path: `${output}/tablet-menu.png` });
  await page.keyboard.press("Escape");
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
  assert.deepEqual(errors, []);
  console.log("PASS: PDF/image import, annotation, native file chooser, text/image clipboard, long press, stable page slots, all view modes, PDF/PNG export, reload, tablet menu, damaged-file recovery.");
} finally {
  await browser?.close();
  server?.kill();
}
