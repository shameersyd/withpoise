const CACHE_NAME = "yoga-pose-v3";
const RUNTIME_CACHE = "yoga-pose-runtime-v3";
const ASSETS = ["/", "/index.html", "/manifest.json", "/pose-worker.js"];

// The MediaPipe runtime and the model files are large, immutable and versioned
// in their URLs — worth keeping once fetched, so a second visit starts offline
// and instantly instead of pulling 13–30 MB again.
const RUNTIME_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/** Network first, falling back to cache — for app code under active development. */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const copy = response.clone();
    caches.open(CACHE_NAME).then((c) => c.put(request, copy));
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || caches.match("/index.html");
  }
}

/** Cache first, populating on miss — for immutable third-party assets. */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(cacheName).then((c) => c.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(e.request, RUNTIME_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return;   // let anything else through

  // index.html and the worker are the two files that actually change.
  const isAppCode =
    e.request.mode === "navigate" ||
    e.request.destination === "document" ||
    url.pathname.endsWith("index.html") ||
    url.pathname.endsWith("pose-worker.js");

  e.respondWith(isAppCode ? networkFirst(e.request) : cacheFirst(e.request, CACHE_NAME));
});
