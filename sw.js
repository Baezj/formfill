// Service worker: caches the app shell so FormFill works offline once visited.
// Bump VERSION on every deploy that touches vendor/ (pdf.js main + worker must match).
const VERSION = 'formfill-v3';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/editor.js', './js/export.js', './js/loaders.js', './js/signature.js', './js/smart.js', './js/store.js', './js/ui.js',
  './vendor/pdf-lib.min.js', './vendor/signature_pad.umd.min.js', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './vendor/mammoth.browser.min.js', './vendor/html2canvas.min.js',
  './vendor/fonts/GreatVibes-Regular.woff2', './vendor/fonts/Allura-Regular.woff2', './vendor/fonts/Sacramento-Regular.woff2', './vendor/fonts/DancingScript.woff2', './vendor/fonts/HomemadeApple-Regular.woff2', './vendor/fonts/Caveat.woff2',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Network first for the shell (so updates land), cache first for vendor assets.
  const cacheFirst = url.pathname.includes('/vendor/');
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (cacheFirst) {
      const hit = await cache.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }
      catch { return hit || Response.error(); }
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
      return hit || Response.error();
    }
  })());
});
