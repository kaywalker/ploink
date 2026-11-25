'use strict';

// Offline support: network first (so updates arrive immediately), cache as fallback.
// The site loads instantly on later visits (playing still needs the PeerJS broker).
// The game server's health check and WebSockets are never cached.

const CACHE = 'ploink-v6';
const ASSETS = [
  './', 'index.html', 'shooter.html', 'gallery.html', 'control.html', 'brawl.html', 'ninja.html', 'style.css', 'favicon.svg',
  'game.js', 'shooter.js', 'gallery.js', 'control.js', 'brawl.js', 'ninja.js',
  'shared/net.js', 'shared/pong-hub.js', 'shared/blaster-hub.js', 'shared/gallery-hub.js', 'shared/control-hub.js', 'shared/brawl-hub.js', 'shared/ninja-hub.js',
  'vendor/peerjs-1.5.5.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/health') || url.pathname.startsWith('/ws')) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(event.request, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});
