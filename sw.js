// ============================================================================
// Engineering App — service worker (offline resilience for site connectivity).
// ----------------------------------------------------------------------------
// Strategy is NETWORK-FIRST and safe by construction:
//   • Only same-origin GET requests are handled. Writes (POST/PATCH/DELETE) and
//     ALL cross-origin requests (Supabase REST/auth) pass straight through —
//     never cached, never queued — so data operations are unaffected.
//   • Online: always fetch from the network first (so the app is never stale),
//     then update the cache in the background.
//   • Offline: fall back to the last cached copy (app shell + last-seen data
//     GETs), and to the last cached page for navigations.
// Because it tries the network first, this can only ADD an offline fallback —
// it cannot serve stale content while online. Bump CACHE to force a purge.
// ============================================================================
// ⚠️ CACHE NAME AND PURGE SCOPE — both the Planners Dashboard and the
// Engineering App are served from the SAME ORIGIN (pmodepartment.github.io), and
// Cache Storage is per-ORIGIN, not per service-worker scope. The original
// activate handler deleted every cache key that was not its own, so each app's
// service worker would wipe the OTHER app's offline cache every time it
// activated. Purging is therefore scoped to this app's own PREFIX.
var PREFIX = 'eng-shell-';
var CACHE = PREFIX + 'v1';

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                                   // never touch writes
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;                    // never cache Supabase / CDNs
  // HTML pages (navigations) must ALWAYS come fresh from origin — the default fetch() respects the
  // HTTP cache, so on GitHub Pages (HTML cached ~10 min) the SW could re-serve a stale module even
  // after a hard-refresh. Bypass the HTTP cache for HTML so deploys apply immediately.
  var isHTML = req.mode === 'navigate' || /\.html($|\?)/.test(url.pathname) || (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  e.respondWith((async function () {
    try {
      var res = await fetch(isHTML ? new Request(url.href, { cache: 'reload', credentials: 'same-origin' }) : req);
      if (res && res.ok && res.type === 'basic') {
        var c = await caches.open(CACHE);
        c.put(req, res.clone());                                      // refresh cache on every success
      }
      return res;
    } catch (err) {
      var cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {                                  // offline navigation → last cached page
        var page = await caches.match(url.pathname) || await caches.match(url.href);
        if (page) return page;
      }
      throw err;
    }
  })());
});
