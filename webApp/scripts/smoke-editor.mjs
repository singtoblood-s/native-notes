#!/usr/bin/env node
/**
 * Browser smoke test for the NotePad editor.
 *
 * This intentionally uses only Node's standard library plus Playwright. Run
 * it against a running Vite preview/dev server and a disposable local API:
 *
 *   PLAYWRIGHT_MODULE=playwright node scripts/smoke-editor.mjs
 *
 * Useful overrides are SMOKE_URL, SMOKE_API_URL, SMOKE_BROWSER (chromium or
 * webkit), SMOKE_HEADLESS=0, SMOKE_ARTIFACT_DIR, REQUIRE_PASTE=1, and
 * SMOKE_CONFLICT=0 to skip the two-context conflict convergence pass.
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_URL = "http://localhost:4174/native-notes/";
const DEFAULT_API_URL = "http://127.0.0.1:8789";
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG}`;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function describe(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function exactText(value) {
  return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

async function loadPlaywright() {
  const requested = process.env.PLAYWRIGHT_MODULE || "playwright";
  let specifier = requested;
  if (requested.includes("/") || requested.includes("\\")) {
    const resolved = isAbsolute(requested) ? requested : resolve(requested);
    const entry = existsSync(resolved) && statSync(resolved).isDirectory() ? join(resolved, "index.js") : resolved;
    specifier = pathToFileURL(entry).href;
  }
  try {
    const loaded = await import(specifier);
    return loaded.default?.chromium ? loaded.default : loaded;
  } catch (error) {
    throw new Error(`Could not load Playwright from ${requested}. Set PLAYWRIGHT_MODULE to the installed module path. ${error instanceof Error ? error.message : error}`);
  }
}

async function waitForPageTitles(page, expected, timeout = 12000) {
  try {
    await page.waitForFunction(
      (titles) => [...document.querySelectorAll("#page-list .page-row strong")].map((node) => node.textContent?.trim()) .join("\u0000") === titles.join("\u0000"),
      expected,
      { timeout },
    );
  } catch (error) {
    let diagnostics = "unavailable";
    try {
      diagnostics = await page.evaluate(() => JSON.stringify({
        actualTitles: [...document.querySelectorAll("#page-list .page-row strong")].map((node) => node.textContent?.trim()),
        pageTitle: document.querySelector("#page-title")?.value || document.querySelector("#page-title-label")?.textContent?.trim() || null,
        notebookTitle: document.querySelector("#notebook-name")?.textContent?.trim() || null,
        sync: [...document.querySelectorAll("[data-sync-button]")].map((node) => ({ id: node.id, state: node.dataset.state, label: node.getAttribute("aria-label") })),
      }));
    } catch (diagnosticError) {
      diagnostics = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}; page-title diagnostics: ${diagnostics}`);
  }
}

async function waitForImageCount(page, minimum, timeout = 12000) {
  await page.waitForFunction(
    (count) => document.querySelectorAll("#image-list .image-list-row").length >= count,
    minimum,
    { timeout },
  );
}

async function readDownload(download) {
  const temporaryPath = await download.path();
  if (temporaryPath) return (await readFile(temporaryPath)).toString("utf8");
  const stream = await download.createReadStream();
  assert(stream, "Export download did not provide a readable stream");
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function ensureInspector(page) {
  const inspector = page.locator("#inspector");
  if ((await inspector.getAttribute("aria-hidden")) !== "false") await page.locator("#text-toggle").click();
  await page.waitForFunction(() => document.getElementById("inspector")?.getAttribute("aria-hidden") === "false");
}

async function closeInspector(page) {
  if ((await page.locator("#inspector").getAttribute("aria-hidden")) === "false") {
    await page.locator("#close-inspector").evaluate((button) => button.click());
    await page.waitForFunction(() => document.getElementById("inspector")?.getAttribute("aria-hidden") === "true");
  }
}

async function chooseMenuAction(page, menuButton, menu, action) {
  await page.locator(menuButton).click();
  const item = page.locator(`${menu} [data-action="${action}"]`);
  await item.waitFor({ state: "visible" });
  await item.click();
}

async function assertMenuButtonHit(page, button, selector, label) {
  await button.hover();
  const box = await button.boundingBox();
  assert(box && box.width > 0 && box.height > 0, `${label} menu button has no bounds`);
  const hit = await page.evaluate(({ x, y, targetSelector }) => {
    const target = document.elementFromPoint(x, y);
    return Boolean(target?.closest(targetSelector));
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2, targetSelector: selector });
  assert(hit, `${label} menu center is covered by another element`);
}

async function libraryBook(page, title) {
  const book = page.locator("#library-books .library-book").filter({
    has: page.locator(".book-caption strong").filter({ hasText: exactText(title) }),
  });
  await book.waitFor({ state: "visible" });
  return book;
}

async function chooseBookMenuAction(page, title, action) {
  const book = await libraryBook(page, title);
  await book.locator(".book-menu-button").click();
  const item = book.locator(`.quick-menu [data-action="${action}"]`);
  await item.waitFor({ state: "visible" });
  await item.click();
}

async function waitForLibraryBookPages(page, title, expectedPages, timeout = 20000) {
  try {
    await page.waitForFunction(
      ({ title: wantedTitle, pages }) => [...document.querySelectorAll("#library-books button[data-open-book]")].some((node) => {
        const caption = node.querySelector(".book-caption small")?.textContent?.trim() || "";
        const pageLabel = `${pages} page${pages === 1 ? "" : "s"}`;
        return node.textContent?.includes(wantedTitle) && (caption === pageLabel || caption.startsWith(`${pageLabel} ·`));
      }),
      { title, pages: expectedPages },
      { timeout },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      url: location.href,
      online: navigator.onLine,
      books: [...document.querySelectorAll("#library-books button[data-open-book]")].map((node) => ({
        id: node.getAttribute("data-open-book"),
        text: node.textContent?.replace(/\s+/g, " ").trim(),
        aria: node.getAttribute("aria-label"),
      })),
      empty: {
        hidden: document.getElementById("library-empty")?.hidden ?? null,
        text: document.getElementById("library-empty")?.textContent?.trim() || null,
      },
      sync: [...document.querySelectorAll("[data-sync-button]")].map((node) => ({
        id: node.id,
        state: node.dataset.state || null,
        label: node.getAttribute("aria-label"),
        text: node.textContent?.replace(/\s+/g, " ").trim(),
      })),
      recovery: document.getElementById("recovery-count")?.textContent?.trim() || null,
      storageKeys: Object.keys(localStorage),
    }));
    let opened = false;
    let editor = null;
    let archive = null;
    const candidate = page.locator("#library-books button[data-open-book]").filter({ hasText: title }).first();
    if (await candidate.count()) {
      await candidate.click().catch(() => {});
      try {
        await page.locator("#editor-workspace").waitFor({ state: "visible", timeout: 5000 });
        opened = true;
        editor = await page.evaluate(() => ({
          notebook: document.getElementById("notebook-name")?.textContent?.trim() || null,
          pageTitle: document.getElementById("page-title-label")?.textContent?.trim() || null,
          pages: [...document.querySelectorAll("#page-list .page-row strong")].map((node) => node.textContent?.trim()),
          recovery: document.getElementById("recovery-count")?.textContent?.trim() || null,
          sync: [...document.querySelectorAll("[data-sync-button]")].map((node) => ({ id: node.id, state: node.dataset.state || null, label: node.getAttribute("aria-label") })),
        }));
        try {
          const exported = await exportArchive(page);
          archive = {
            notebooks: exported.notebooks?.map((notebook) => ({ id: notebook.id, title: notebook.title, deletedAt: notebook.deletedAt ?? null })) || [],
            pages: exported.pages?.map((candidatePage) => ({
              id: candidatePage.id,
              notebookId: candidatePage.notebookId,
              title: candidatePage.title,
              deletedAt: candidatePage.deletedAt ?? null,
              conflictOf: candidatePage.conflictOf ?? null,
              text: candidatePage.text,
              strokes: Array.isArray(candidatePage.strokes) ? candidatePage.strokes.length : null,
              images: Array.isArray(candidatePage.images) ? candidatePage.images.length : null,
            })) || [],
          };
        } catch (archiveError) {
          archive = { error: archiveError instanceof Error ? archiveError.message : String(archiveError) };
        }
      } catch (editorError) {
        editor = { error: editorError instanceof Error ? editorError.message : String(editorError) };
      }
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}; second-context library diagnostics: ${describe({ diagnostics, opened, editor, archive })}`);
  }
}

async function runLibraryCardMenuRegression(page, title) {
  await page.locator("#back-library").click();
  await page.locator("#library").waitFor({ state: "visible" });
  await page.locator("#editor-workspace").waitFor({ state: "hidden" });
  const book = await libraryBook(page, title);
  const menuButton = book.locator(".book-menu-button");
  await book.locator("[data-open-book]").hover();
  await assertMenuButtonHit(page, menuButton, ".book-menu-button", "Library notebook");
  await menuButton.click();
  const menu = book.locator(".book-quick-menu");
  await menu.waitFor({ state: "visible" });
  assert(await page.locator("#library").isVisible() && !(await page.locator("#editor-workspace").isVisible()), "Library menu click navigated into the editor");
  await page.locator("#library-title").click();
  await menu.waitFor({ state: "hidden" });
  await book.locator("[data-open-book]").click();
  await page.locator("#editor-workspace").waitFor({ state: "visible" });
  console.log("PASS library card menu hit target without navigation");
}

async function runSidebarAndHomeMenuRegression(page, title, context) {
  const copyTitle = `${title} (copy)`;
  const initialRecoveryCount = await recoveryCount(page);
  await context.setOffline(true);
  try {
    await page.locator("#back-library").click();
    await page.locator("#library").waitFor({ state: "visible" });
    await chooseBookMenuAction(page, title, "duplicate-notebook");
    await page.locator("#editor-workspace").waitFor({ state: "visible" });
    await waitForPageTitles(page, ["First page", "Page 2", "Page 3"]);

    const currentNotebook = await page.locator("#notebook-name").textContent();
    const currentPage = await page.locator("#page-title-label").textContent();
    await openSidebar(page);
    const sourceNotebook = page.locator("#notebook-list .nav-row-wrap").filter({
      has: page.locator(".nav-copy strong").filter({ hasText: exactText(title) }),
    });
    await sourceNotebook.waitFor({ state: "visible" });
    const sourceNotebookMenu = sourceNotebook.locator(".nav-menu-button");
    await assertMenuButtonHit(page, sourceNotebookMenu, ".nav-menu-button", "Sidebar notebook");
    await sourceNotebookMenu.click();
    await sourceNotebook.locator(".quick-menu").waitFor({ state: "visible" });
    assert(await page.locator("#notebook-name").textContent() === currentNotebook, "Sidebar notebook menu selected another notebook");
    await sourceNotebookMenu.click();
    await sourceNotebook.locator(".quick-menu").waitFor({ state: "hidden" });

    const otherPage = page.locator("#page-list .nav-row-wrap").filter({ hasText: "Page 2" });
    await otherPage.waitFor({ state: "visible" });
    const otherPageMenu = otherPage.locator(".nav-menu-button");
    await assertMenuButtonHit(page, otherPageMenu, ".nav-menu-button", "Sidebar page");
    await otherPageMenu.click();
    await otherPage.locator(".quick-menu").waitFor({ state: "visible" });
    assert(await page.locator("#page-title-label").textContent() === currentPage, "Sidebar page menu selected another page");
    await otherPageMenu.click();
    await otherPage.locator(".quick-menu").waitFor({ state: "hidden" });
    await closeSidebar(page);

    await page.locator("#back-library").click();
    await page.locator("#library").waitFor({ state: "visible" });
    const copyBook = await libraryBook(page, copyTitle);
    const copyMenu = copyBook.locator(".book-menu-button");
    await assertMenuButtonHit(page, copyMenu, ".book-menu-button", "Temporary notebook");
    await copyMenu.click();
    await copyBook.locator(".book-quick-menu").waitFor({ state: "visible" });
    await copyBook.locator('[data-action="trash-notebook"]').click();
    await page.waitForFunction((expected) => ![...document.querySelectorAll("#library-books [data-open-book]")].some((node) => node.textContent?.includes(expected)), copyTitle);
    assert(await page.locator("#library").isVisible() && !(await page.locator("#editor-workspace").isVisible()), "Home notebook trash navigated away from the library");

    const sourceBook = await libraryBook(page, title);
    await sourceBook.locator("[data-open-book]").click();
    await page.locator("#editor-workspace").waitFor({ state: "visible" });
  } finally {
    await context.setOffline(false).catch(() => {});
  }
  await syncAndWait(page);
  const fixtureArchive = await exportArchive(page);
  const recoveryPages = fixtureArchive.pages.filter((candidate) => typeof candidate.conflictOf === "string");
  assert(recoveryPages.length === initialRecoveryCount,
    `Offline home trash created recovery copies: before ${initialRecoveryCount}, after ${recoveryPages.length}`);
  const fixtureNotebook = fixtureArchive.notebooks.find((candidate) => candidate.title === copyTitle && candidate.deletedAt);
  assert(fixtureNotebook, `Trashed temporary notebook was not retained in the archive: ${copyTitle}`);
  const fixturePages = fixtureArchive.pages.filter((candidate) => candidate.notebookId === fixtureNotebook.id && !candidate.deletedAt);
  assert(fixturePages.length === 3 && fixturePages.some((candidate) => candidate.strokes.length > 0) && fixturePages.some((candidate) => candidate.images.length > 0),
    `Trashed temporary notebook lost child content: ${describe(fixturePages.map((candidate) => ({ title: candidate.title, strokes: candidate.strokes.length, images: candidate.images.length, deletedAt: candidate.deletedAt })))} `);
  console.log("PASS sidebar notebook/page menus, home notebook trash, and offline child ordering");
}

async function renameNotebookThroughMenu(page, title) {
  await chooseMenuAction(page, "#notebook-menu", "#notebook-menu-popup", "rename-notebook");
  await page.locator("#notebook-dialog").waitFor({ state: "visible" });
  await page.locator("#notebook-title").fill(title);
  await page.locator("#notebook-form button[type='submit']").click();
  await page.locator("#notebook-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction((expected) => document.getElementById("notebook-name")?.textContent === expected, title);
}

async function renamePageThroughMenu(page, title) {
  await chooseMenuAction(page, "#page-menu", "#page-menu-popup", "rename-page");
  await page.waitForFunction(() => document.getElementById("inspector")?.getAttribute("aria-hidden") === "false");
  await page.locator("#page-title").fill(title);
  await page.locator("#page-title").press("Tab");
  await page.waitForFunction((expected) => document.getElementById("page-title-label")?.textContent === expected, title);
  await page.waitForTimeout(450);
  await page.locator("#close-inspector").click();
  await page.waitForFunction(() => document.getElementById("inspector")?.getAttribute("aria-hidden") === "true");
}

async function openSidebar(page) {
  if ((await page.locator("#sidebar").getAttribute("aria-hidden")) !== "false") {
    await page.locator("#mobile-menu").click();
    await page.waitForFunction(() => document.getElementById("sidebar")?.getAttribute("aria-hidden") === "false");
  }
}

async function closeSidebar(page) {
  // Selection can close the drawer while its awaited store read is finishing.
  // Read and dispatch in one page task so a transformed close control cannot
  // race us between the state check and the click.
  await page.evaluate(() => {
    const sidebar = document.getElementById("sidebar");
    if (sidebar?.getAttribute("aria-hidden") === "false") document.getElementById("close-sidebar")?.click();
  });
  await page.waitForFunction(() => document.getElementById("sidebar")?.getAttribute("aria-hidden") === "true");
}

async function toggleTrashView(page) {
  await openSidebar(page);
  await page.locator("#trash-toggle").click();
  await closeSidebar(page);
}

async function selectPageFromSidebar(page, title) {
  await openSidebar(page);
  const row = page.locator("#page-list .page-row").filter({ hasText: title });
  await row.waitFor({ state: "visible" });
  await row.click();
  await closeSidebar(page);
  await page.waitForFunction((expected) => document.querySelector("#page-title")?.value === expected, title);
}

async function syncAndWait(page) {
  await closeInspector(page);
  const button = page.locator("#sync-button");
  const network = page.waitForResponse(
    (response) => response.url().includes("/v1/sync/") && response.status() < 500,
    { timeout: 20000 },
  );
  await button.click();
  await network;
  await page.waitForFunction(() => document.querySelector("#sync-button")?.dataset.state === "saved", undefined, { timeout: 20000 });
}

async function syncLibraryAndWait(page) {
  const network = page.waitForResponse(
    (response) => response.url().includes("/v1/sync/") && response.status() < 500,
    { timeout: 20000 },
  );
  await page.locator("#library-sync-button").click();
  await network;
  await page.waitForFunction(() => document.querySelector("#library-sync-button")?.dataset.state === "saved", undefined, { timeout: 20000 });
}

async function recoveryCount(page) {
  return await page.evaluate(() => Number.parseInt(document.getElementById("recovery-count")?.textContent || "0", 10) || 0);
}

async function runConflictConvergence(page, second, context, secondContext) {
  const route = "**/v1/sync/**";
  await closeInspector(page);
  await closeInspector(second);
  await selectPageFromSidebar(page, "Page 3");
  await selectPageFromSidebar(second, "Page 3");
  await ensureInspector(page);
  await ensureInspector(second);
  await context.route(route, (request) => request.abort());
  await secondContext.route(route, (request) => request.abort());
  try {
    await page.locator("#page-text").fill("offline edit from context A");
    await page.locator("#page-text").press("Tab");
    await second.locator("#page-text").fill("offline edit from context B");
    await second.locator("#page-text").press("Tab");
    await page.waitForTimeout(800);
    await second.waitForTimeout(800);

    await context.unroute(route);
    await syncAndWait(page);
    await secondContext.unroute(route);
    await syncAndWait(second);

    // Recovery copies may be created while a sync is already in flight. Drain
    // B first so its newly created copy reaches the server, then let A pull it.
    // Repeat a bounded number of real sync cycles so this catches a lost push
    // or a non-converging recovery loop instead of treating a stale saved state
    // as completion.
    let firstCount = 0;
    let secondCount = 0;
    let converged = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await syncAndWait(second);
      await syncAndWait(page);
      firstCount = await recoveryCount(page);
      secondCount = await recoveryCount(second);
      if (firstCount > 0 && firstCount === secondCount) {
        converged = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    assert(converged, `Conflict recovery counts did not converge: ${firstCount} vs ${secondCount}`);
    await syncAndWait(page);
    await syncAndWait(second);
    const stableFirst = await recoveryCount(page);
    const stableSecond = await recoveryCount(second);
    assert(stableFirst === firstCount && stableSecond === secondCount, `Conflict recovery count grew after an idempotent sync: ${firstCount}/${secondCount} -> ${stableFirst}/${stableSecond}`);
    const firstArchive = await exportArchive(page);
    const secondArchive = await exportArchive(second);
    const firstConflicts = firstArchive.pages.filter((candidate) => typeof candidate.conflictOf === "string");
    const secondConflicts = secondArchive.pages.filter((candidate) => typeof candidate.conflictOf === "string");
    assert(firstConflicts.length === secondConflicts.length && firstConflicts.length > 0, `Conflict archives did not converge: ${firstConflicts.length} vs ${secondConflicts.length}`);
    const findConflictPair = (archive) => {
      const original = archive.pages.find((candidate) => candidate.text === "offline edit from context A" && typeof candidate.conflictOf !== "string");
      const recovered = original
        ? archive.pages.find((candidate) => candidate.text === "offline edit from context B" && candidate.conflictOf === original.id)
        : undefined;
      return { original, recovered };
    };
    const firstPair = findConflictPair(firstArchive);
    const secondPair = findConflictPair(secondArchive);
    assert(firstPair.original && firstPair.recovered && secondPair.original && secondPair.recovered,
      `Conflict archives did not retain both edits: ${describe({ first: firstArchive.pages.map((candidate) => ({ id: candidate.id, text: candidate.text, conflictOf: candidate.conflictOf })), second: secondArchive.pages.map((candidate) => ({ id: candidate.id, text: candidate.text, conflictOf: candidate.conflictOf })) })}`);
    assert(firstPair.original.id === secondPair.original.id && firstPair.recovered.id === secondPair.recovered.id && firstPair.recovered.conflictOf === firstPair.original.id,
      "Conflict archives did not reference the same original and recovery page IDs");
    for (const [label, pair] of [["first", firstPair], ["second", secondPair]]) {
      assert(Array.isArray(pair.original.strokes) && pair.original.strokes.length > 0 && Array.isArray(pair.original.images) && pair.original.images.length > 0,
        `Conflict ${label} original page lost ink or images`);
      assert(Array.isArray(pair.recovered.strokes) && pair.recovered.strokes.length > 0 && Array.isArray(pair.recovered.images) && pair.recovered.images.length > 0,
        `Conflict ${label} recovery page lost ink or images`);
    }
    console.log(`PASS two-context conflict recovery (${firstConflicts.length} recovered page, both edits and page assets retained)`);
  } finally {
    await context.unroute(route).catch(() => {});
    await secondContext.unroute(route).catch(() => {});
  }
}

async function exportArchive(page) {
  await ensureInspector(page);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-button").click();
  const download = await downloadPromise;
  assert(!download.failure || !(await download.failure()), `Export failed: ${await download.failure()}`);
  return JSON.parse(await readDownload(download));
}

async function drawQuickStroke(page) {
  const canvas = page.locator("#ink-canvas");
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);
  const box = await canvas.boundingBox();
  const flowBox = await page.locator("#paper-scroll").boundingBox();
  assert(box && flowBox && box.width > 0 && box.height > 0 && flowBox.width > 0 && flowBox.height > 0, "Active canvas or paper flow has no bounds");
  const left = Math.max(box.x, flowBox.x) + 20;
  const right = Math.min(box.x + box.width, flowBox.x + flowBox.width) - 20;
  const top = Math.max(box.y, flowBox.y) + 20;
  const bottom = Math.min(box.y + box.height, flowBox.y + flowBox.height) - 20;
  assert(right >= left && bottom >= top, `Active canvas has no safe visible intersection: ${describe({ box, flowBox })}`);
  const x = Math.min(right, Math.max(left, box.x + box.width * 0.25));
  const y = Math.min(bottom, Math.max(top, box.y + box.height * 0.3));
  const hit = await page.evaluate(({ pointX, pointY }) => document.elementFromPoint(pointX, pointY)?.id || document.elementFromPoint(pointX, pointY)?.className || "none", { pointX: x, pointY: y });
  assert(hit === "ink-canvas", `Pointer test point did not hit the ink canvas: ${String(hit)}`);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let index = 1; index <= 12; index += 1) {
    await page.mouse.move(x + index * Math.min(8, box.width / 40), y + Math.sin(index / 2) * 14);
  }
  await page.mouse.up();
}

async function dispatchRapidPenBurst(page, contacts = 40) {
  await page.evaluate((count) => {
    const canvas = document.getElementById("ink-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing active ink canvas for rapid pen burst");
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error("Active ink canvas has no bounds for rapid pen burst");
    const pointerId = 913;
    const baseX = rect.left + rect.width * 0.55;
    const baseY = rect.top + rect.height * 0.45;
    const makeEvent = (type, index, buttons, pressure) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: "pen",
        isPrimary: true,
        button: 0,
        buttons,
        clientX: baseX + index * 3,
        clientY: baseY + index * 2,
        pressure,
      });
      // Event timestamps are read-only in a browser, but defining one where
      // the engine permits it keeps this burst deterministic in WebKit.
      try { Object.defineProperty(event, "timeStamp", { configurable: true, value: 10_000 + index }); } catch { /* native timestamp is sufficient */ }
      return event;
    };
    for (let index = 0; index < count; index += 1) {
      canvas.dispatchEvent(makeEvent("pointerdown", index * 2, 0, 0));
      // Leave a few contacts without pointerup. The next down with this
      // reused ID must commit the prior contact before starting the next one.
      if (index % 5 !== 0 || index === count - 1) canvas.dispatchEvent(makeEvent("pointerup", index * 2 + 1, 0, 0));
    }
  }, contacts);
}

async function dispatchPendingPreviewStroke(page, targetTitle) {
  await page.evaluate((title) => {
    const slot = [...document.querySelectorAll(".flow-preview")].find((candidate) => candidate.textContent?.includes(title));
    const preview = slot?.querySelector("canvas");
    if (!(preview instanceof HTMLCanvasElement)) throw new Error(`Missing preview canvas for ${title}`);
    const rect = preview.getBoundingClientRect();
    const pointerId = 701;
    const makeEvent = (type, x, y, buttons) => new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
      pressure: buttons ? 0.7 : 0,
    });
    const x = rect.left + rect.width * 0.35;
    const y = rect.top + rect.height * 0.25;
    preview.dispatchEvent(makeEvent("pointerdown", x, y, 1));
    document.dispatchEvent(makeEvent("pointermove", x + 18, y + 20, 1));
    document.dispatchEvent(makeEvent("pointermove", x + 36, y + 30, 1));
    document.dispatchEvent(makeEvent("pointerup", x + 54, y + 40, 0));
  }, targetTitle);
}

async function pasteTinyImage(page) {
  return await page.evaluate((dataUrl) => {
    const [header, encoded] = dataUrl.split(",", 2);
    if (!header || !encoded) return false;
    const mime = header.slice(5, header.indexOf(";"));
    const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "pasted-smoke.png", { type: mime }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  }, TINY_PNG_DATA_URL);
}

async function scrollMetrics(page) {
  return await page.locator("#paper-scroll").evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
  }));
}

async function assertActiveCanvas(page) {
  await page.locator("#ink-canvas").scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);
  const metrics = await page.locator("#ink-canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const parentRect = canvas.parentElement?.getBoundingClientRect();
    const flowRect = canvas.closest(".flow-page")?.getBoundingClientRect();
    return {
      canvasWidth: rect.width,
      canvasHeight: rect.height,
      parentHeight: parentRect?.height ?? 0,
      flowHeight: flowRect?.height ?? 0,
      visibleWidth: Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)),
      visibleHeight: Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)),
    };
  });
  assert(metrics.canvasWidth > 0 && metrics.canvasHeight > 0 && metrics.visibleWidth > 0 && metrics.visibleHeight > 0, `Active canvas is not visible: ${describe(metrics)}`);
  assert(metrics.parentHeight > 0 && metrics.flowHeight > 0, `Active canvas parent has no height: ${describe(metrics)}`);
}

async function makeSecondContext(browser, page, url) {
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  const context = await browser.newContext({
    acceptDownloads: true,
    serviceWorkers: "block",
    viewport: page.viewportSize(),
  });
  await context.addInitScript((values) => {
    for (const [key, value] of Object.entries(values.local)) localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(values.session)) sessionStorage.setItem(key, value);
  }, storage);
  const second = await context.newPage();
  second.setDefaultTimeout(12000);
  await second.goto(url, { waitUntil: "domcontentloaded" });
  return { context, page: second };
}

async function run() {
  const playwright = await loadPlaywright();
  const browserName = (option("--browser", process.env.SMOKE_BROWSER || "chromium")).toLowerCase();
  const browserType = playwright[browserName];
  assert(browserType?.launch, `Playwright browser '${browserName}' is unavailable`);
  const url = option("--url", process.env.SMOKE_URL || DEFAULT_URL);
  const apiUrl = option("--api", process.env.SMOKE_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
  const artifactDirectory = resolve(process.env.SMOKE_ARTIFACT_DIR || resolve(process.cwd(), "test-results"));
  await mkdir(artifactDirectory, { recursive: true });
  const screenshotPath = resolve(artifactDirectory, `smoke-editor-${browserName}.png`);
  const headless = process.env.SMOKE_HEADLESS !== "0" && !process.argv.includes("--headed");
  const width = Number.parseInt(process.env.SMOKE_WIDTH || "1440", 10);
  const height = Number.parseInt(process.env.SMOKE_HEIGHT || "1000", 10);
  const viewport = { width: Number.isFinite(width) && width > 0 ? width : 1440, height: Number.isFinite(height) && height > 0 ? height : 1000 };
  const launchOptions = { headless };
  if (process.env.SMOKE_EXECUTABLE_PATH) launchOptions.executablePath = process.env.SMOKE_EXECUTABLE_PATH;
  const browser = await browserType.launch(launchOptions);
  let context;
  let page;
  let secondContext;
  const pageErrors = [];
  try {
    context = await browser.newContext({
      acceptDownloads: true,
      serviceWorkers: "block",
      viewport,
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("#auth-dialog").waitFor({ state: "visible" });

    const identifier = `notepad-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Smoke-${crypto.randomUUID()}-pass`;
    await page.locator("#register-mode").click();
    await page.locator("#auth-endpoint").evaluate((input) => { input.closest("details")?.setAttribute("open", ""); });
    await page.locator("#auth-endpoint").fill(apiUrl);
    await page.locator("#auth-identifier").fill(identifier);
    await page.locator("#auth-password").fill(password);
    await page.locator("#auth-submit").click();
    await page.locator("#auth-dialog").waitFor({ state: "hidden" });
    await page.locator("#library").waitFor({ state: "visible" });

    await page.locator("#library-new").click();
    await page.locator("#new-document-notebook").click();
    await page.locator("#notebook-title").fill("Editor smoke notebook");
    await page.locator("#notebook-form button[type='submit']").click();
    await page.locator("#editor-workspace").waitFor({ state: "visible" });
    await waitForPageTitles(page, ["First page"]);
    await page.locator("#add-page").click();
    await waitForPageTitles(page, ["First page", "Page 2"]);
    await page.locator("#add-page").click();
    await waitForPageTitles(page, ["First page", "Page 2", "Page 3"]);
    console.log("PASS notebook and stable page order");
    await runLibraryCardMenuRegression(page, "Editor smoke notebook");

    await assertActiveCanvas(page);
    await drawQuickStroke(page);
    // Leave Page 3 dirty, then synchronously start a pen stroke on its Page 2
    // preview while activation is waiting for the dirty-page save. The flow
    // bridge must buffer the samples and replay them on the new active canvas.
    await ensureInspector(page);
    await page.locator("#page-text").fill("dirty source before preview pen");
    await dispatchPendingPreviewStroke(page, "Page 2");
    await page.waitForFunction((title) => document.querySelector("#page-title")?.value === title, "Page 2");
    await assertActiveCanvas(page);
    await page.waitForTimeout(450);
    // Keep a normal page activation path covered too. Selecting from the
    // sidebar avoids a flow scroll activation racing the preview's remount.
    await selectPageFromSidebar(page, "Page 3");
    await assertActiveCanvas(page);
    console.log("PASS active canvas and buffered pen input across preview activation");

    const rapidBefore = await exportArchive(page);
    const rapidBeforePage = rapidBefore.pages.find((candidate) => candidate.title === "Page 3");
    assert(rapidBeforePage, "Rapid pen burst could not find Page 3 before input");
    await closeInspector(page);
    await assertActiveCanvas(page);
    await dispatchRapidPenBurst(page);
    await page.waitForTimeout(500);
    const rapidAfter = await exportArchive(page);
    const rapidAfterPage = rapidAfter.pages.find((candidate) => candidate.title === "Page 3");
    assert(rapidAfterPage && rapidAfterPage.strokes.length === rapidBeforePage.strokes.length + 40,
      `Rapid pen burst lost contacts: ${describe({ before: rapidBeforePage.strokes.length, after: rapidAfterPage?.strokes.length })}`);
    console.log("PASS rapid same-ID pen burst (40 contacts, zero pressure/buttons)");

    await ensureInspector(page);
    await page.locator("#image-input").setInputFiles({
      name: "upload-smoke.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG, "base64"),
    });
    await waitForImageCount(page, 1);
    const pasted = await pasteTinyImage(page);
    if (pasted) {
      try {
        await waitForImageCount(page, 2, 5000);
        console.log("PASS image upload and paste");
      } catch (error) {
        if (process.env.REQUIRE_PASTE === "1") throw error;
        console.log(`SKIP paste image: ${error instanceof Error ? error.message : error}`);
      }
    } else if (process.env.REQUIRE_PASTE === "1") {
      throw new Error("Browser did not accept the synthetic paste event");
    } else {
      console.log("SKIP paste image: ClipboardEvent was not cancelable");
    }

    const beforeReloadArchive = await exportArchive(page);
    const drawnPages = beforeReloadArchive.pages.filter((candidate) => Array.isArray(candidate.strokes) && candidate.strokes.length > 0);
    const imagePages = beforeReloadArchive.pages.filter((candidate) => Array.isArray(candidate.images) && candidate.images.length > 0);
    const pageTwoArchive = beforeReloadArchive.pages.find((candidate) => candidate.title === "Page 2");
    const pageThreeArchive = beforeReloadArchive.pages.find((candidate) => candidate.title === "Page 3");
    assert(drawnPages.length >= 2 && pageTwoArchive && pageThreeArchive && pageTwoArchive.strokes.length > 0 && pageThreeArchive.strokes.length > 0, `Preview activation lost a stroke: ${describe(beforeReloadArchive.pages.map((candidate) => ({ title: candidate.title, strokes: Array.isArray(candidate.strokes) ? candidate.strokes.length : null, images: Array.isArray(candidate.images) ? candidate.images.length : null })))}`);
    assert(pageThreeArchive.text === "dirty source before preview pen", `Dirty source page text was lost during preview activation: ${describe(pageThreeArchive.text)}`);
    assert(imagePages.length > 0, `Exported archive has no uploaded image: ${describe(beforeReloadArchive.pages.map((candidate) => ({ title: candidate.title, strokes: Array.isArray(candidate.strokes) ? candidate.strokes.length : null, images: Array.isArray(candidate.images) ? candidate.images.length : null })))}`);
    console.log(`PASS archive persistence before reload (${drawnPages.length} drawn page, ${imagePages.length} image page)`);

    await page.locator("#close-inspector").click();
    await page.waitForFunction(() => document.getElementById("inspector")?.getAttribute("aria-hidden") === "true");
    await selectPageFromSidebar(page, "Page 3");

    await renameNotebookThroughMenu(page, "Editor smoke notebook renamed");
    await renameNotebookThroughMenu(page, "Editor smoke notebook");
    await renamePageThroughMenu(page, "Page 3 renamed");
    await renamePageThroughMenu(page, "Page 3");
    console.log("PASS notebook and page menu rename");

    await chooseMenuAction(page, "#page-menu", "#page-menu-popup", "trash-page");
    await waitForPageTitles(page, ["First page", "Page 2"]);
    await toggleTrashView(page);
    await waitForPageTitles(page, ["Page 3"]);
    await selectPageFromSidebar(page, "Page 3");
    await chooseMenuAction(page, "#page-menu", "#page-menu-popup", "restore-page");
    await waitForPageTitles(page, []);
    await toggleTrashView(page);
    await waitForPageTitles(page, ["First page", "Page 2", "Page 3"]);
    await selectPageFromSidebar(page, "Page 3");

    await chooseMenuAction(page, "#notebook-menu", "#notebook-menu-popup", "trash-notebook");
    await page.waitForFunction(() => document.querySelectorAll("#notebook-list [data-notebook]").length === 0);
    await toggleTrashView(page);
    await page.waitForFunction(() => [...document.querySelectorAll("#notebook-list [data-notebook]")].some((node) => node.textContent?.includes("Editor smoke notebook")));
    await chooseMenuAction(page, "#notebook-menu", "#notebook-menu-popup", "restore-notebook");
    await waitForPageTitles(page, []);
    await toggleTrashView(page);
    await waitForPageTitles(page, ["First page", "Page 2", "Page 3"]);
    await selectPageFromSidebar(page, "Page 3");
    console.log("PASS notebook and page trash/restore lifecycle");

    await page.locator("#page-view-mode").selectOption("paged");
    await page.waitForFunction(() => document.getElementById("paper-scroll")?.dataset.viewMode === "paged");
    const pagedPreviewCount = await page.locator(".flow-preview").count();
    assert(pagedPreviewCount === 0, `Page-turn mode rendered ${pagedPreviewCount} extra page slots`);
    await page.locator("#page-view-mode").selectOption("continuous");
    await page.waitForFunction(() => document.getElementById("paper-scroll")?.dataset.viewMode === "continuous");
    const vertical = await scrollMetrics(page);
    assert(vertical.scrollHeight > vertical.clientHeight, `Continuous mode has no vertical overflow: ${describe(vertical)}`);
    await page.locator("#paper-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const verticalScrolled = await scrollMetrics(page);
    assert(verticalScrolled.scrollTop > 0, `Continuous mode did not scroll vertically: ${describe(verticalScrolled)}`);
    await page.locator("#page-view-mode").selectOption("horizontal");
    await page.waitForFunction(() => document.getElementById("paper-scroll")?.dataset.viewMode === "horizontal");
    const horizontal = await scrollMetrics(page);
    assert(horizontal.scrollWidth > horizontal.clientWidth, `Book mode has no horizontal overflow: ${describe(horizontal)}`);
    await page.locator("#paper-scroll").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    const horizontalScrolled = await scrollMetrics(page);
    assert(horizontalScrolled.scrollLeft > 0, `Book mode did not scroll horizontally: ${describe(horizontalScrolled)}`);
    console.log(`PASS continuous scroll (${vertical.scrollHeight}x${vertical.clientHeight}) and book scroll (${horizontal.scrollWidth}x${horizontal.clientWidth})`);

    await page.locator("#page-view-mode").selectOption("continuous");
    await page.waitForFunction(() => document.getElementById("paper-scroll")?.dataset.viewMode === "continuous");
    const flowAdd = page.locator(".flow-add-page");
    // Let Playwright scroll and resolve the live end slot in one click. An
    // explicit scroll can trigger flow page activation and detach this node.
    await flowAdd.click();
    await waitForPageTitles(page, ["First page", "Page 2", "Page 3", "Page 4"]);
    await page.waitForFunction((title) => document.querySelector("#page-title")?.value === title, "Page 4");
    await assertActiveCanvas(page);
    await chooseMenuAction(page, "#page-menu", "#page-menu-popup", "trash-page");
    await waitForPageTitles(page, ["First page", "Page 2", "Page 3"]);
    console.log("PASS continuous flow add-page lifecycle");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#library").waitFor({ state: "visible" });
    const reloadedBook = page.locator("#library-books button[data-open-book]").filter({ hasText: "Editor smoke notebook" });
    await reloadedBook.waitFor({ state: "visible" });
    await reloadedBook.click();
    await page.locator("#editor-workspace").waitFor({ state: "visible" });
    await waitForPageTitles(page, ["First page", "Page 2", "Page 3"]);
    await selectPageFromSidebar(page, "Page 3");
    await assertActiveCanvas(page);
    await ensureInspector(page);
    await waitForImageCount(page, 1);
    const afterReloadArchive = await exportArchive(page);
    assert(afterReloadArchive.pages.some((candidate) => Array.isArray(candidate.strokes) && candidate.strokes.length > 0), "Pen stroke disappeared after reload");
    assert(afterReloadArchive.pages.some((candidate) => Array.isArray(candidate.images) && candidate.images.length > 0), "Image disappeared after reload");
    console.log("PASS reload persistence");

    await syncAndWait(page);
    try {
      secondContext = await makeSecondContext(browser, page, url);
      const second = secondContext.page;
      second.on("pageerror", (error) => pageErrors.push(`second: ${error.message}`));
      await second.locator("#library").waitFor({ state: "visible" });
      await syncLibraryAndWait(second);
      const secondBook = second.locator("#library-books button[data-open-book]").filter({ hasText: "Editor smoke notebook" });
      await secondBook.waitFor({ state: "visible", timeout: 20000 });
       await waitForLibraryBookPages(second, "Editor smoke notebook", 3);
      await secondBook.click();
      await second.locator("#editor-workspace").waitFor({ state: "visible" });
      await waitForPageTitles(second, ["First page", "Page 2", "Page 3"], 20000);
      const secondArchive = await exportArchive(second);
      const secondPage = secondArchive.pages.find((candidate) => candidate.title === "Page 3");
      const firstPage = beforeReloadArchive.pages.find((candidate) => candidate.title === "Page 3");
      assert(secondPage && firstPage, "Second context did not receive Page 3");
      assert(Array.isArray(secondPage.strokes) && secondPage.strokes.length >= firstPage.strokes.length && secondPage.strokes.length > 0, "Second context did not receive the ink stroke");
      assert(Array.isArray(secondPage.images) && secondPage.images.length >= firstPage.images.length && secondPage.images.length > 0, "Second context did not receive the page images");
      console.log("PASS second-context sync");
      await runSidebarAndHomeMenuRegression(page, "Editor smoke notebook", context);
      if (process.env.SMOKE_CONFLICT !== "0") await runConflictConvergence(page, second, context, secondContext.context);
    } catch (error) {
      if (process.env.REQUIRE_TWO_CONTEXT === "1" || process.env.SMOKE_CONFLICT !== "0") throw error;
      console.log(`SKIP second-context sync: ${error instanceof Error ? error.message : error}`);
    }

    await page.screenshot({ path: screenshotPath, fullPage: false });
    assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join(" | ")}`);
    console.log(`PASS screenshot ${screenshotPath}`);
  } catch (error) {
    await page?.screenshot({ path: screenshotPath.replace(/\.png$/i, "-failure.png"), fullPage: false }).catch(() => {});
    throw error;
  } finally {
    if (secondContext) await secondContext.context.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error(`FAIL smoke-editor: ${error instanceof Error ? error.stack || error.message : error}`);
  process.exitCode = 1;
});
