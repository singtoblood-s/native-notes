import { webkit, chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

// Isolated local data. Desktop WebKit catches engine regressions, not iPad GPU speed.
const port = "4188";
const url = `http://127.0.0.1:${port}/native-notes/`;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", port, "--strictPort"], { windowsHide: true, stdio: "ignore" });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(url).then(response => response.ok).catch(() => false)) break;
    if (attempt === 59) throw new Error("Local server did not start");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const engine = process.env.QA_ENGINE === "chromium" ? chromium : webkit;
  browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ ...devices["iPad (gen 7)"] });
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
  const frames = [];
  for (const tool of ["pen", "highlighter"]) {
    await page.locator(`#${tool}-tool`).click();
    frames.push(...await page.evaluate(async () => {
      const canvas = document.querySelector("#ink-canvas");
      const rect = canvas.getBoundingClientRect();
      const event = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 11, pointerType: "pen", bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pressure: .5, clientX: rect.left + x, clientY: rect.top + y }));
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
  assert(geometry.delta < 5, "Photo and ink layers must align");
  assert.equal(geometry.imagePixel[3], 255);
  await mkdir("test-results/ipad", { recursive: true });
  await page.screenshot({ path: `test-results/ipad/${engine.name()}-photo-ink.png` });
  await page.locator("#add-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
  await page.locator("#previous-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2");
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
  assert.deepEqual(errors, []);
  frames.sort((a, b) => a - b);
  console.log(JSON.stringify({ engine: engine.name(), persistence: "indexeddb", photoSurvivedReload: true, strokesSurvivedReload: true, fullPageCopies: 0, frameP95Ms: Math.round(frames[Math.floor(frames.length * .95)]), saves }, null, 2));
} finally {
  await browser?.close();
  server.kill();
}
