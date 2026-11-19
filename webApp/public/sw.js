const CACHE_PREFIX = "notepad-static-";
const BUILD_ID = "development";
const SCOPE_PREFIX = CACHE_PREFIX + encodeURIComponent(new URL(self.registration.scope).pathname) + ":";
const CACHE_NAME = SCOPE_PREFIX + BUILD_ID;
const PRECACHE = ["./index.html", "./icon.svg", "./manifest.webmanifest"];
const INDEX_INTEGRITY = "";

function appRoot() { return new URL(self.registration.scope); }
function isAppRequest(request) {
  const root = appRoot();
  const url = new URL(request.url);
  return url.origin === root.origin && url.pathname.startsWith(root.pathname) &&
    !url.pathname.startsWith(root.pathname + "v1/") && !request.headers.has("Authorization");
}

async function installOfflineFiles() {
  const cache = await caches.open(CACHE_NAME);
  const shellURL = new URL("./index.html", appRoot()).href;
  const hadCompleteBuild = Boolean(await cache.match(shellURL, { ignoreVary: true }));
  // Bound concurrent connections on mobile, including the many small PDF fonts and maps.
  // The worker remains installing until every file has been cached.
  try {
    for (let i = 0; i < PRECACHE.length; i += 12) {
      const requests = PRECACHE.slice(i, i + 12).map(path => new Request(new URL(path, appRoot()), {
        cache: "reload", integrity: path === "./index.html" ? INDEX_INTEGRITY : "",
      }));
      await cache.addAll(requests);
    }
  } catch (error) {
    if (!hadCompleteBuild) await caches.delete(CACHE_NAME);
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const message = error instanceof Error ? error.message : "Could not download all offline files.";
    for (const client of clients) client.postMessage({ type: "notepad-cache-error", message });
    throw error;
  }
  await self.skipWaiting();
}

async function activateOfflineFiles() {
  const names = (await caches.keys()).filter(name =>
    name !== CACHE_NAME && (name.startsWith(SCOPE_PREFIX) || /^notepad-static-[a-f0-9]{12}$/.test(name)));
  // A tab opened before the upgrade may still request its previous hashed JS, worker or WASM.
  // Retain its complete build alongside this one. Offline navigation always uses the current shell.
  const shellURL = new URL("./index.html", appRoot()).href;
  const complete = (await Promise.all(names.map(async name =>
    (await caches.match(shellURL, { cacheName: name, ignoreVary: true })) ? name : null
  ))).filter(Boolean);
  const previous = complete.at(-1);
  await Promise.all(names.filter(name =>
    name !== previous && (name.startsWith(SCOPE_PREFIX) || complete.includes(name))
  ).map(name => caches.delete(name)));
  await self.clients.claim();
}

function cacheResponse(event, response) {
  if (!response.ok) return response;
  const copy = response.clone();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
    .catch(() => { /* Runtime caching is best effort when storage is full. */ }));
  return response;
}

async function navigate(request) {
  const root = appRoot();
  const index = new URL("./index.html", root);
  let online;
  try {
    online = await fetch(request);
    const path = new URL(request.url).pathname;
    const isShell = path === root.pathname || path === index.pathname;
    const temporarilyUnavailable = [404, 408, 429].includes(online.status) || online.status >= 500;
    if (!isShell || !temporarilyUnavailable) return online;
  } catch { /* Offline navigation falls back to the installed build. */ }
  const cached = await caches.match(index.href, { cacheName: CACHE_NAME, ignoreVary: true });
  return cached || online || new Response("NotePad's offline files are unavailable. Open it once while online.", {
    status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("install", event => event.waitUntil(installOfflineFiles()));
self.addEventListener("activate", event => event.waitUntil(activateOfflineFiles()));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || !isAppRequest(event.request)) return;
  if (event.request.mode === "navigate") {
    // A new deployment can serve newer HTML before its worker finishes installing.
    // Keep the installed shell paired with its own cached assets.
    event.respondWith(navigate(event.request));
    return;
  }
  event.respondWith((async () => {
    // Precache fetches and module requests can differ in their Origin headers.
    const current = await caches.match(event.request, { cacheName: CACHE_NAME, ignoreVary: true });
    if (current) return current;
    if (new URL(event.request.url).pathname.startsWith(appRoot().pathname + "assets/")) {
      const previous = await caches.match(event.request, { ignoreVary: true });
      if (previous) return previous;
    }
    return cacheResponse(event, await fetch(event.request));
  })());
});
