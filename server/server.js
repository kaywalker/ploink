'use strict';

// Ploink server: serves the static client and connects WebSocket clients to the
// game hubs in public/shared. The same hubs run in the browser of the hosting phone
// when the site is used without this server (peer-to-peer mode via PeerJS).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const pongHub = require('./public/shared/pong-hub');
const blasterHub = require('./public/shared/blaster-hub');
const galleryHub = require('./public/shared/gallery-hub');
const controlHub = require('./public/shared/control-hub');
const brawlHub = require('./public/shared/brawl-hub');
const ninjaHub = require('./public/shared/ninja-hub');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const HUBS = { '/ws': pongHub, '/ws/shooter': blasterHub, '/ws/gallery': galleryHub, '/ws/control': controlHub, '/ws/brawl': brawlHub, '/ws/ninja': ninjaHub };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    // Clients use this endpoint to detect that a game server is available.
    const rooms = Object.values(HUBS).reduce((sum, hub) => sum + hub.rooms.size, 0);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ploink: true, rooms }));
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const hub = Object.hasOwn(HUBS, pathname) ? HUBS[pathname] : null;
  if (!hub) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    hub.handleConnection(ws);
  });
});

// Drop connections of phones that went to sleep without closing the socket.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 10_000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Ploink listening on http://0.0.0.0:${PORT}`);
});

module.exports = { server };
