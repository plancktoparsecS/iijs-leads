// Offline cache for IIJS Lead Capture.
// Bump CACHE when any file changes so phones pick up the new version.
var CACHE = 'iijs-leads-v3.0.0';
var ASSETS = [
  './',
  './index.html',
  './config.js',
  './lib.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Pages and files: served from the cache (works with no signal) and refreshed in the background.
// config.js: network first, so a changed server address reaches phones on the next open.
// Calls to Supabase go to another site and are never cached.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  var isPage = req.mode === 'navigate';
  var networkFirst = /\/config\.js$/.test(url.pathname);

  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      var fromNet = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return null; });

      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit && !networkFirst) { e.waitUntil(fromNet); return hit; }
        return fromNet.then(function (res) {
          if (res) return res;
          if (hit) return hit;
          return isPage ? cache.match('./index.html') : new Response('', { status: 504 });
        });
      });
    })
  );
});
