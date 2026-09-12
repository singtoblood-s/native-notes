import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const port = process.env.QA_PORT ?? "4181";
const url = process.env.QA_URL ?? `http://127.0.0.1:${port}/native-notes/`;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error("Local QA only");
const server = process.env.QA_URL ? null : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", port, "--strictPort"], { windowsHide: true, stdio: "ignore" });
const output = "test-results/feature-audit";
await mkdir(output, { recursive: true });
const timestamp = "2026-09-12T00:00:00.000Z";
const ids = Array.from({ length: 6 }, (_, index) => `${String(index + 1).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
const book = (id, title) => ({ id, title, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, revision: 0 });
const sheet = (id, notebookId, title, text, order) => ({ id, notebookId, title, text, order, formatVersion: 2, background: "ruled", width: 1024, height: 1366, strokes: [], images: [], revision: 0, updatedAt: timestamp, deletedAt: null });
const archive = {
  version: 1, account: "QA", exportedAt: timestamp,
  notebooks: [book(ids[0], "Alpha"), book(ids[1], "Beta")],
  pages: [sheet(ids[2], ids[0], "One", "First", 0), sheet(ids[3], ids[0], "Two", "Cafe\u0301\n THAI", 1), sheet(ids[4], ids[1], "Three", "ข้อความครบ\n".repeat(100), 0)],
  versions: [{ id: ids[5], entityType: "page", entityId: ids[3], payload: sheet(ids[3], ids[0], "Earlier version", "Preserved history", 1), createdAt: timestamp, reason: "QA", sequence: 0 }],
};
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(url).then(response => response.ok).catch(() => false)) break;
    if (attempt === 59) throw new Error("Vite did not start");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true, ...(process.env.QA_BROWSER_CHANNEL ? { channel: process.env.QA_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("notepad.endpoint", "https://qa.invalid");
    sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://qa.invalid", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "QA" }, sessionToken: "qa-only", expiresAt: "2099-01-01T00:00:00Z" }));
  });
  await page.route("https://qa.invalid/**", route => route.fulfill({ status: 503, body: "Offline QA" }));
  await page.goto(url);
  const importBackup = async value => page.locator("#import-input").setInputFiles({ name: "qa.notepad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
  await page.locator("#library-settings").click();
  await importBackup(archive);
  await page.waitForFunction(() => document.querySelector("#settings-message").textContent.includes("Imported 3 pages"));
  await page.locator("#cancel-settings").click();
  await page.locator("#library-search").fill("café thai");
  assert.equal(await page.locator("[data-search-page]").count(), 1);
  await page.screenshot({ animations: "disabled", path: `${output}/search.png` });
  await page.locator("[data-search-page]").click();
  await page.waitForFunction(() => document.querySelector("#page-title-label").textContent === "Two");
  await page.locator("#page-menu").click();
  await page.locator("#page-menu-popup [data-action='organize-page']").click();
  await page.locator("#organize-notebook").selectOption({ label: "Beta" });
  await page.locator("#organize-position").selectOption("0");
  await page.screenshot({ animations: "disabled", path: `${output}/move-dialog.png` });
  await page.locator("#organize-submit").click();
  await page.waitForFunction(() => !document.querySelector("#organize-dialog").open && document.querySelector("#notebook-name").textContent === "Beta");
  assert.equal(await page.locator("#page-position").textContent(), "1 / 2");
  await page.locator("#page-menu").click();
  await page.locator("#page-menu-popup [data-action='organize-page']").click();
  await page.locator("#organize-position").selectOption("1");
  await page.locator("#organize-submit").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
  await page.locator("#page-position").click();
  await page.locator("#jump-page-number").fill("1");
  await page.locator("#jump-form button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector("#page-title-label").textContent === "Three");
  await page.locator("#page-menu").click();
  const textDownload = page.waitForEvent("download");
  await page.locator("#page-menu-popup [data-action=export-text]").click();
  assert.equal(await readFile(await (await textDownload).path(), "utf8"), archive.pages[2].text);
  await page.locator("#notebook-menu").click();
  const backupDownload = page.waitForEvent("download");
  await page.locator("#notebook-menu-popup [data-action=export-notebook-backup]").click();
  const backup = JSON.parse(await readFile(await (await backupDownload).path(), "utf8"));
  assert.deepEqual(backup.notebooks.map(book => book.title), ["Beta"]);
  assert.deepEqual(backup.pages.map(page => page.title), ["Three", "Two"]);
  await page.locator("#notebook-menu").click();
  await page.locator("#notebook-menu-popup [data-action=duplicate-notebook]").click();
  await page.waitForFunction(() => document.querySelector("#notebook-name").textContent === "Beta (copy)");
  assert.equal(await page.locator("#page-position").textContent(), "1 / 2");
  await page.locator("#back-library").click();
  await page.locator("#library-documents").click();
  assert.equal(await page.locator("[data-open-book]").count(), 3);
  await page.locator("#library-settings").click();
  await page.locator("#saved-versions").click();
  await page.locator("[data-restore-version]").first().click();
  await page.waitForFunction(() => document.querySelector("#versions-message").textContent.includes("Restored 1 page"));
  assert.equal(await page.locator("[data-restore-version]").count(), 1);
  await page.locator("#close-versions").click();
  await page.locator("#cancel-settings").click();
  assert.equal(await page.locator("[data-open-book]").count(), 4);
  await page.locator("#library-sort").selectOption("name");
  await page.locator("#library-layout").click();
  await page.reload();
  await page.locator("[data-open-book]").first().waitFor();
  assert.equal(await page.locator("#library-sort").inputValue(), "name");
  assert.equal(await page.locator("#library-layout").getAttribute("aria-pressed"), "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#library-search").fill("Preserved history");
  await page.screenshot({ animations: "disabled", path: `${output}/mobile-search.png` });
  assert.equal(await page.locator("[data-search-page]").count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator("#library-documents").click();
  await page.locator("#library-settings").click();
  // Cancelling the native share sheet must not start an unwanted download.
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: async () => { window.qaShared = true; throw new DOMException("Cancelled", "AbortError"); } });
  });
  await page.locator("#settings-share").click();
  await page.waitForFunction(() => window.qaShared);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  assert.equal(downloads, 0);
  // Simulate a slow file read completing after logout.
  await page.evaluate(() => {
    File.prototype.text = function () { return new Promise(resolve => { window.qaFinishRead = resolve; }); };
  });
  await importBackup(archive);
  await page.waitForFunction(() => Boolean(window.qaFinishRead));
  await page.locator("#logout-button").click();
  await page.waitForFunction(() => document.querySelector("#auth-dialog").open);
  await page.evaluate(value => window.qaFinishRead(JSON.stringify(value)), archive);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  await page.reload();
  await page.locator("[data-open-book]").first().waitFor();
  assert.equal(await page.locator("[data-open-book]").count(), 4);
  assert.deepEqual(errors, []);
  console.log("PASS: Unicode page search, move/reorder, jump, full text and selected notebook exports, atomic duplicate, version restore, persistent preferences, mobile layout, share cancellation, logout during backup read.");
} finally {
  await browser?.close();
  server?.kill();
}
