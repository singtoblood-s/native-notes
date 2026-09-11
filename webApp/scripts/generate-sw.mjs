import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist", import.meta.url));
const files = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (!entry.name.endsWith(".map") && entry.name !== "sw.js") files.push(path);
  }
}

await visit(root);
files.sort();
const digest = createHash("sha256");
for (const file of files) {
  digest.update(relative(root, file).split(sep).join("/"));
  digest.update(await readFile(file));
}
const cacheName = `notepad-static-${digest.digest("hex").slice(0, 12)}`;
const precache = files.map((file) => `./${relative(root, file).split(sep).join("/")}`);
const source = `const CACHE_PREFIX = "notepad-static-";
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE = ${JSON.stringify(precache)};

function appRoot() { return new URL("./", self.registration.scope).pathname; }
function isAppRequest(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(appRoot())) return false;
  if (request.headers.has("Authorization")) return false;
  return !url.pathname.startsWith(appRoot() + "v1/");
}

function notifyCacheError(error) {
  const message = error instanceof Error ? error.message : "precache failed";
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    clients.forEach((client) => client.postMessage({ type: "notepad-cache-error", message }));
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).catch((error) => notifyCacheError(error).then(() => { throw error; })));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !isAppRequest(event.request)) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const fallback = await caches.match(new URL("./index.html", self.registration.scope).toString())
        || await caches.match(new URL("./", self.registration.scope).toString());
      return fallback || new Response("NotePad is offline and its app shell is not cached yet. Open it once while online, then try again.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
`;
await writeFile(join(root, "sw.js"), source);
