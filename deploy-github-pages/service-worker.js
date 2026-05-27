const CACHE_NAME = "ev-charge-finder-v4";
const APP_FILES = [
  "./",
  "./index.html",
  "./index.html?v=20260527d",
  "./styles.css",
  "./styles.css?v=20260527d",
  "./app.js",
  "./app.js?v=20260527d",
  "./manifest.webmanifest",
  "./manifest.webmanifest?v=20260527d",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);

  // Prefer fresh HTML to prevent stale app shells after updates.
  if (event.request.mode === "navigate" || requestUrl.pathname.endsWith(".html")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request)).then((response) => {
        if (response) return response;
        return caches.match("./index.html");
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
