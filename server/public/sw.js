'use strict';

// Offline support: network first (so updates arrive immediately), cache as fallback.
// The site loads instantly on later visits (playing still needs the PeerJS broker).
// The game server's health check and WebSockets are never cached.

const CACHE = 'ploink-v16';
const ASSETS = [
  './', 'index.html', 'shooter.html', 'gallery.html', 'control.html', 'brawl.html', 'ninja.html', 'bake.html', 'style.css', 'bake.css', 'favicon.svg',
  'game.js', 'shooter.js', 'gallery.js', 'control.js', 'brawl.js', 'ninja.js', 'bake.js', 'sfx.js', 'sounds.html', 'sounds.js', 'screen-mode.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'shared/net.js', 'shared/pong-hub.js', 'shared/blaster-hub.js', 'shared/gallery-hub.js', 'shared/control-hub.js', 'shared/brawl-hub.js', 'shared/ninja-hub.js', 'shared/bake-hub.js',
  'vendor/peerjs-1.5.5.min.js',
  ...['jump', 'swish', 'blade', 'juice', 'crunch', 'coins', 'splat', 'buzz', 'ouch', 'clash', 'block', 'throw',
    'lava-warn', 'lava-start', 'blub', 'sizzle', 'collect', 'beep', 'go'].map((name) => `sounds/${name}.mp3`),
];

self.addEventListener('install', (event) => {
  // One by one: a single file that fails (e.g. eaten by a content blocker) must not stop
  // the whole update, or browsers stay on the old worker forever.
  event.waitUntil(caches.open(CACHE)
    .then((cache) => Promise.allSettled(ASSETS.map((asset) => cache.add(asset))))
    .then(() => self.skipWaiting()));
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
