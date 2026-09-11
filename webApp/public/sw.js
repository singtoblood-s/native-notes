const CACHE_PREFIX = "notepad-static-";
const CACHE_NAME = "notepad-static-v2";

function appRoot() {
  return new URL("./", self.registration.scope).pathname;
}

function isAppRequest(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(appRoot())) return false;
  if (request.headers.has("Authorization")) return false;
  // Never cache the API, even when it happens to share the Pages origin.
  return !url.pathname.startsWith(`${appRoot()}v1/`);
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(new URL("./", self.registration.scope).toString())));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !isAppRequest(event.request)) return;
  const url = new URL(event.request.url);
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match(new URL("./", self.registration.scope).toString()))));
    return;
  }
  // Cache app JS/CSS/WASM after the first successful load. This keeps the
  // service worker compatible with GitHub Pages, which cannot set COOP/COEP.
  if (!/\.(?:js|css|wasm|json|svg|png|webmanifest|woff2?)$/i.test(url.pathname)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
