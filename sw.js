/* ================================================================
   Service Worker — minimal install/activate.
   Background-sync cannot meaningfully resume chunk uploads because
   File object references don't survive across sessions.  The main
   app already persists state to IndexedDB and recovers on reload.
================================================================ */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
