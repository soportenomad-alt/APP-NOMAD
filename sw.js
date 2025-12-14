/* Simple offline cache for static assets (GitHub Pages friendly). */
const CACHE_NAME = "nomad-ui-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/css/styles.css",
  "./assets/js/app.js",
  "./assets/img/nomad-logo.png",
  "./assets/img/icon-192.png",
  "./assets/img/icon-512.png",
  "./assets/img/carousel/dna-helix.jpg",
  "./assets/img/carousel/doctor-consult.jpg",
  "./assets/img/carousel/microscope.jpg",
  "./assets/img/carousel/researcher-microscope.jpg",
  "./assets/data/catalogo_nomad_oficial.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // No tocar requests cross-origin (dejar al navegador)
  if (url.origin !== self.location.origin) return;

  // Navegación: intenta red primero para evitar UI vieja, fallback a cache
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || caches.match("./index.html");
      }
    })());
    return;
  }

  // Otros assets: cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
