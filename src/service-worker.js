const CACHE_VERSION = "v1";
const STATIC_CACHE = "gis-cli-static-" + CACHE_VERSION;
const PAGES_CACHE  = "gis-cli-pages-"  + CACHE_VERSION;

// Assets to pre-cache on install
const STATIC_ASSETS = [
  "/css/main.css",
  "/js/nav.js",
  "/js/copy-code.js",
  "/js/checkbox.js",
  "/js/accordion.js",
  "/js/main.js",
  "/icons/logo.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/favicon.svg",
  "/favicon.ico",
  "/manifest.json",
  "/offline/",
];

// ── Install: pre-cache static assets ─────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: clear old caches ────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== PAGES_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch strategy ────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Static assets (CSS, JS, images) → Cache-first
  if (
    url.pathname.startsWith("/css/") ||
    url.pathname.startsWith("/js/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/manifest.json"
  ) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(request, STATIC_CACHE))
    );
    return;
  }

  // HTML pages → Network-first, fall back to cache, then offline page
  if (request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(PAGES_CACHE).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/offline/"))
        )
    );
    return;
  }
});

async function fetchAndCache(request, cacheName) {
  const response = await fetch(request);
  const cache = await caches.open(cacheName);
  cache.put(request, response.clone());
  return response;
}

