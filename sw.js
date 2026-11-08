/* Bracket service worker: opens offline after the first visit.
   Network first, then the cache. Old caches are deleted on activate so a
   previous visit cannot keep serving a stale shell once this worker takes over.
   API responses are never cached. */
const CACHE = 'bracket-v7';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

function shellUrl(url) {
  return SHELL.some(function (path) {
    if (path === './') return url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
    return url.pathname.endsWith(path.slice(1));
  });
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.indexOf('/api/') !== -1) return;
  const put = (res) => {
    if (res && res.ok && url.origin === self.location.origin && shellUrl(url)) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    } else if (res && res.ok && url.origin !== self.location.origin) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
  } else if (/fonts\.(googleapis|gstatic)\.com$|cdnjs\.cloudflare\.com$|cdn\.jsdelivr\.net$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(put)));
  }
});
