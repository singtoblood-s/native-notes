import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const generator = fileURLToPath(new URL("./generate-sw.mjs", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "notepad-offline-upgrade-"));
const releases = new Map();
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

async function buildRelease(version) {
  const path = join(directory, version);
  await mkdir(join(path, "assets"), { recursive: true });
  const files = new Map([
    ["index.html", Buffer.from(`<!doctype html><title>${version}</title>`)],
    [`assets/lazy-${version}.js`, Buffer.from(`export default "${version}";`)],
    [`assets/module-${version}.wasm`, wasm],
  ]);
  for (const [name, content] of files) await writeFile(join(path, name), content);
  execFileSync(process.execPath, [generator, path], { windowsHide: true });
  files.set("sw.js", await readFile(join(path, "sw.js")));
  releases.set(version, files);
}

async function testUpgrade(engine) {
  let version = "one";
  let offline = false;
  let staleShell = false;
  const server = createServer((request, response) => {
    if (offline) { request.socket.destroy(); return; }
    const name = new URL(request.url, "http://localhost").pathname.slice("/notes/".length) || "index.html";
    const release = staleShell && name === "index.html" ? "two" : version;
    const content = releases.get(release).get(name);
    const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : "text/html";
    response.writeHead(content ? 200 : 404, { "Cache-Control": "no-store", "Content-Type": type });
    response.end(content);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/notes/`;
  let browser;
  try {
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext();
    const oldTab = await context.newPage();
    await oldTab.goto(url);
    await oldTab.evaluate(() => navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(() => true));
    await oldTab.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
    assert.equal(await oldTab.title(), "one");
    version = "two";
    const newTab = await context.newPage();
    await newTab.goto(url);
    assert.equal(await newTab.title(), "two");
    await newTab.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const previous = registration.active;
      if ((await caches.keys()).length > 1 && !registration.installing && !registration.waiting) return;
      await new Promise((resolve, reject) => {
        const observe = () => {
          const worker = registration.installing ?? registration.waiting ?? registration.active;
          if (!worker || worker === previous) return;
          const changed = () => {
            if (worker.state === "activated") resolve();
            if (worker.state === "redundant") reject(new Error("upgrade failed"));
          };
          worker.addEventListener("statechange", changed);
          changed();
        };
        registration.addEventListener("updatefound", observe);
        registration.update().catch(reject);
        observe();
      });
    });
    assert.equal(await newTab.evaluate(async () => (await caches.keys()).length), 2);

    // The new worker reaches the CDN before its matching shell. Installation must fail atomically.
    version = "three";
    staleShell = true;
    const state = await newTab.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const candidate = new Promise(resolve => registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker.addEventListener("statechange", () => {
          if (["redundant", "activated"].includes(worker.state)) resolve(worker.state);
        });
      }, { once: true }));
      await registration.update();
      return candidate;
    });
    assert.equal(state, "redundant");
    assert.equal(await newTab.evaluate(async () => (await caches.keys()).length), 2);

    // Drop actual sockets so offline verification also applies to fetches made in the worker.
    offline = true;
    assert.equal(await oldTab.evaluate(async () => (await import("./assets/lazy-one.js")).default), "one");
    const offlineTab = await context.newPage();
    await offlineTab.goto(url);
    assert.equal(await offlineTab.title(), "two");
    assert.equal(await offlineTab.evaluate(async () => (await import("./assets/lazy-two.js")).default), "two");
    assert(await offlineTab.evaluate(async () => {
      const response = await fetch("./assets/module-two.wasm");
      return WebAssembly.validate(await response.arrayBuffer());
    }));
    console.log(`${engine.name()} passed first install, live update, failed update, offline reload, lazy import and WASM`);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

try {
  for (const version of ["one", "two", "three"]) await buildRelease(version);
  for (const engine of [chromium, webkit]) await testUpgrade(engine);
} finally { await rm(directory, { recursive: true, force: true }); }
