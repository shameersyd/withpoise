// Bump when the app shell changes. Network-first means a stale shell is rarely
// what you get anyway; this decides what a *first offline visit* after a deploy
// finds waiting for it.
const APP_CACHE = "yoga-pose-app-v4";

// Versioned separately, and deliberately not tied to the app version. This
// holds the MediaPipe runtime and a 9-30 MB model file, both immutable and both
// versioned in their own URLs. Tying it to the app version would mean every
// deploy re-downloading thirty megabytes onto someone's phone. Bump it only if
// those URLs change shape.
const RUNTIME_CACHE = "yoga-pose-runtime-v1";

// Relative, not host-absolute. "/index.html" is only correct when the app is
// deployed at a domain root; under any subpath — a project page, a preview
// deploy, anything shared from a folder — precaching failed outright and took
// the whole install with it. These resolve against the worker's own scope.
//
// Precached so a first visit that goes offline mid-load still has a whole app.
// A test asserts this list covers everything the app imports; it had silently
// fallen behind twice before that existed.
const ASSETS = ["./", "./index.html", "./manifest.json",
                "./pose-core.js", "./poses.js", "./pose-schema.js", "./scoring.js",
                "./gravity.js", "./calibration.js", "./depth.js",
                "./pose-worker.js",
                "./coach.js", "./voice.js", "./pacing.js"];

// The MediaPipe runtime and the model files are large, immutable and versioned
// in their URLs — worth keeping once fetched, so a second visit starts offline
// and instantly instead of pulling 13–30 MB again.
const RUNTIME_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== RUNTIME_CACHE)
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
    caches.open(APP_CACHE).then((c) => c.put(request, copy));
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || caches.match("./index.html");
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

  // Anything we wrote is under active development and must not be served from
  // a stale cache. Matching on destination rather than on a list of filenames,
  // because the last list silently stopped covering the app when the scoring
  // core was split into its own modules.
  const isAppCode =
    e.request.mode === "navigate" ||
    e.request.destination === "document" ||
    e.request.destination === "script" ||
    e.request.destination === "worker";

  e.respondWith(isAppCode ? networkFirst(e.request) : cacheFirst(e.request, APP_CACHE));
});
