import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const port = "4181", base = `http://127.0.0.1:${port}/native-notes/`;
const output = "test-results/sync-regression";
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", port, "--strictPort"], { windowsHide: true, stdio: "ignore" });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(base).then(response => response.ok).catch(() => false)) break;
    if (attempt === 59) throw new Error("Local test server did not start");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`${base}seed`, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated sync test</title>" }));
  await page.route("https://qa.invalid/**", async route => {
    const request = route.request();
    const operations = request.method() === "POST" ? request.postDataJSON().operations : null;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(operations
      ? { results: operations.map(operation => ({ opId: operation.opId, status: "acked", revision: operation.baseRevision + 1 })), cursor: 0 }
      : { changes: [], nextCursor: 0, hasMore: false }) });
  });
  await page.goto(`${base}seed`);
  await page.evaluate(async () => {
    const endpoint = "https://qa.invalid", userID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    localStorage.setItem("notepad.endpoint", endpoint);
    sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint, user: { id: userID, identifier: "QA" }, sessionToken: "QA", expiresAt: "2099-01-01T00:00:00Z" }));
    const { SQLiteNoteStore } = await import("/native-notes/src/storage.ts");
    const { createNotebook, createPage, id } = await import("/native-notes/src/models.ts");
    const store = await SQLiteNoteStore.open(`${endpoint}:${userID}`);
    for (let index = 0; index < 20; index++) await store.saveNotebook({ ...createNotebook("My notebook · conflict"), revision: 1 }, false);
    const notebook = { ...createNotebook("Real notes"), revision: 1 };
    await store.saveNotebook(notebook, false);
    const page = { ...createPage(notebook.id, "My page"), text: "Current text", revision: 1 };
    await store.savePage(page, false);
    await store.createConflictCopyFromOperation({ opId: id(), entityId: page.id, entityType: "page", baseRevision: 0, action: "upsert", payload: { ...page, text: "Preserved offline version" }, createdAt: page.updatedAt, state: "sending" });
    await store.close();
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll("[data-open-book]").length === 1);
  assert.match(await page.locator("[data-open-book]").textContent(), /Real notes/);
  await page.screenshot({ path: `${output}/library.png` });
  await page.locator("#library-settings").click();
  await page.locator("#saved-versions").click();
  const version = page.locator("#versions-list .recovery-row").filter({ hasText: "My page" });
  await version.waitFor();
  const downloaded = page.waitForEvent("download");
  await version.locator("button").click();
  await (await downloaded).saveAs(`${output}/version.notepad.json`);
  const archive = JSON.parse(await readFile(`${output}/version.notepad.json`, "utf8"));
  assert.equal(archive.pages[0].text, "Preserved offline version");
  assert.equal(archive.notebooks[0].title, "Real notes");
  await page.screenshot({ path: `${output}/saved-versions.png` });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("[data-open-book]").length === 1);
  await page.locator("#library-settings").click();
  await page.locator("#saved-versions").click();
  await page.locator("#versions-list .recovery-row").filter({ hasText: "My page" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: 20 empty copies leave the library, real notes remain, saved versions survive reload and export as restorable archives.");
} finally {
  await browser?.close();
  server.kill();
}
