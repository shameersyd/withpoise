const CACHE_NAME = "yoga-pose-v2";
const ASSETS = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// The app is a single HTML file under active development, so serve it
// network-first (falling back to cache offline) — otherwise an installed
// phone keeps replaying an old build. Everything else stays cache-first.
self.addEventListener("fetch", (e) => {
  const isPage = e.request.mode === "navigate" ||
                 e.request.destination === "document" ||
                 new URL(e.request.url).pathname.endsWith("index.html");

  if (isPage) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match("/index.html")))
    );
    return;
  }

  e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});
