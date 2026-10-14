/* Easy Edit service worker — lets the installed app run with no network at all.
 *
 * Everything the editor needs is static and same-origin (the fonts are bundled, not fetched
 * from a CDN), so the shell is precached and served from the cache when offline. /bg/ is the
 * one server-side feature, so it is never cached — offline, `syncBgSection()` in app.js sees
 * the probe fail and simply hides the Remove-BG section.
 *
 * Bump CACHE whenever the shell changes to make every client drop its old copy.
 */
const CACHE = 'easyedit-v1';

// Precache the whole app. One missing file must not sink the install, so each is caught
// individually (the test suite asserts they all resolve, which is what catches typos).
const SHELL = [
  './', './index.html', './mobile.html',
  './app.js', './desktop.css', './mobile.css',
  './manifest.webmanifest',
  './favicon.svg', './favicon-32.png', './favicon-16.png', './apple-touch-icon.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png',
  './fonts/anton-400.woff2', './fonts/caveat-var.woff2', './fonts/comic-neue-400.woff2',
  './fonts/comic-neue-700.woff2', './fonts/inter-var.woff2',
  './fonts/playfair-display-var.woff2', './fonts/roboto-var.woff2',
];

// The HTML and the JS/CSS it loads must never disagree about each other, so these are
// network-first: always fresh when online, the cached copy only when offline. Everything
// else (fonts, icons) is immutable and served cache-first for speed.
const FRESH = new Set(['./', './index.html', './mobile.html', './app.js', './desktop.css', './mobile.css']
  .map(p => new URL(p, self.location).pathname));

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // Only same-origin GETs are ours; anything else (the POST to /bg/) goes straight to the net.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/bg' || url.pathname.startsWith('/bg/')) return;

  if (req.mode === 'navigate' || FRESH.has(url.pathname)) {
    e.respondWith(
      fetch(req).then(r => { save(req, r.clone()); return r; })
        .catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('./') : undefined)))
    );
    return;
  }

  // Immutable assets: cache-first, refreshed in the background for next time.
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { save(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

function save(req, res) {
  if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res));
}
