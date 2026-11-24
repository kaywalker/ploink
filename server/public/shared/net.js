'use strict';

// Ploink networking: gives the game clients one WebSocket-like "link", whatever the
// transport is.
//
// - Server mode: the page was served by the Ploink Node server (GET health answers
//   {ploink: true}) -> a plain WebSocket to that server.
// - PeerJS mode (e.g. static hosting): the first phone that enters a code claims the
//   PeerJS id "ploink-v1-<mode>-<code>" and becomes the host; the game hub runs in its
//   browser. Everyone else gets "unavailable-id" and connects to that host directly via
//   WebRTC. PeerJS' public broker is only used to find each other.
//
// A link behaves like a WebSocket: addEventListener('open' | 'message' | 'close'),
// send(string), close(), readyState (1 = open). link.role is 'server', 'host' or 'guest'.
// Force a transport with ?net=server or ?net=p2p.

(function (root) {
  const PEER_PREFIX = 'ploink-v1-';
  const HEARTBEAT_MS = 3000;
  const SILENCE_TIMEOUT_MS = 12_000;
  const CONNECT_TIMEOUT_MS = 12_000;
  const HB = '{"type":"__hb"}';

  // Read lazily: Pong switches rooms without reloading the page.
  const currentHash = () => location.hash.replace(/^#/, '');

  /** 'server' | 'p2p' | 'auto' (server when the page comes from the Ploink server). */
  function chosenTransport() {
    const forced = new URLSearchParams(location.search).get('net');
    return forced === 'server' || forced === 'p2p' ? forced : 'auto';
  }

  /** Two-digit room code from "#42". */
  function roomCodeFromHash() {
    const m = /^(\d{2})$/.exec(currentHash());
    return m ? m[1] : '';
  }

  let serverDetection = null;
  /** Resolves to true when the page is served by the Ploink game server. */
  function detectServer() {
    if (!serverDetection) {
      serverDetection = (async () => {
        if (location.protocol === 'file:') return false;
        try {
          const res = await fetch('health', { cache: 'no-store' });
          if (!res.ok) return false;
          const body = await res.json();
          return !!(body && body.ploink === true);
        } catch {
          return false;
        }
      })();
    }
    return serverDetection;
  }

  const scripts = new Map();
  /** Load a classic script once (vendor libraries, optional modules). */
  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => {
          scripts.delete(src);
          reject(new Error(`${src} could not be loaded`));
        };
        document.head.append(script);
      }));
    }
    return scripts.get(src);
  }

  /** The hub side of a connection, shaped like a "ws" server socket. */
  class HubSocket {
    constructor(sendFn, closeFn) {
      this.OPEN = 1;
      this.readyState = 1;
      this.listeners = { message: [], close: [] };
      this.sendFn = sendFn;
      this.closeFn = closeFn;
    }

    on(event, fn) {
      (this.listeners[event] ||= []).push(fn);
    }

    send(data) {
      if (this.readyState === 1) this.sendFn(data);
    }

    close() {
      if (this.readyState !== 1) return;
      this.closeFn();
      this.markClosed();
    }

    emit(event, data) {
      for (const fn of this.listeners[event] || []) fn(data);
    }

    markClosed() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close');
    }
  }

  /**
   * Wrap a peer connection (host side) for a game hub, with heartbeats. `conn` is a
   * PeerJS DataConnection or anything with the same on('data'|'close'|'error'), send, close.
   */
  function hubSocketFromConnection(conn) {
    let lastSeen = Date.now();
    const sock = new HubSocket((data) => conn.send(data), () => conn.close());
    const beat = setInterval(() => {
      if (Date.now() - lastSeen > SILENCE_TIMEOUT_MS) {
        conn.close();
        finish();
        return;
      }
      try { conn.send(HB); } catch { finish(); }
    }, HEARTBEAT_MS);
    function finish() {
      clearInterval(beat);
      sock.markClosed();
    }
    conn.on('data', (data) => {
      lastSeen = Date.now();
      if (data === HB) return;
      sock.emit('message', String(data));
    });
    conn.on('close', finish);
    conn.on('error', finish);
    return sock;
  }

  class Link extends EventTarget {
    constructor(options) {
      super();
      this.options = options;
      this.readyState = 0;
      this.role = null;
      this.transport = null;
      this.ws = null;
      this.peer = null;
      this.conn = null;
      this.loopback = null;
      this.timers = [];
      this.cleanups = [];
      this.start().catch((err) => {
        console.warn('[ploink] connection failed:', err && err.message ? err.message : err);
        this.finish();
      });
    }

    async start() {
      const choice = chosenTransport();
      const useServer = choice === 'server' || (choice === 'auto' && await detectServer());
      if (useServer) {
        this.transport = 'server';
        this.startServer();
        return;
      }
      this.transport = 'peerjs';
      await loadScript('vendor/peerjs-1.5.5.min.js');
      if (this.readyState === 3) return;
      await this.startPeer();
    }

    // ------------------------------------------------------------------ server
    startServer() {
      if (this.readyState === 3) return;
      this.role = 'server';
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${location.host}${this.options.wsPath}`);
      this.ws = ws;
      ws.addEventListener('open', () => this.opened());
      ws.addEventListener('message', (e) => this.receive(e.data));
      ws.addEventListener('close', () => this.finish());
    }

    // ----------------------------------------------------------------- PeerJS
    peerId() {
      return `${PEER_PREFIX}${this.options.mode}-${this.options.code}`;
    }

    startPeer() {
      return new Promise((resolve, reject) => {
        const peer = new root.Peer(this.peerId(), { debug: 1 });
        this.peer = peer;
        const timeout = setTimeout(() => reject(new Error('broker timeout')), CONNECT_TIMEOUT_MS);
        this.timers.push(timeout);
        peer.on('open', () => {
          clearTimeout(timeout);
          this.hostGame();
          peer.on('connection', (conn) => {
            conn.on('open', () => this.acceptPeer(conn));
          });
          // Keep the id reserved on the broker so new guests can still find us.
          peer.on('disconnected', () => {
            if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
          });
          resolve();
        });
        peer.on('error', (err) => {
          clearTimeout(timeout);
          if (err.type === 'unavailable-id' && !this.role) {
            // Somebody already hosts this room: join as a guest.
            peer.destroy();
            this.joinPeerAsGuest().then(resolve, reject);
          } else if (!this.role) {
            reject(err);
          } else {
            console.warn('[ploink] peer error:', err.type);
          }
        });
      });
    }

    joinPeerAsGuest() {
      this.role = 'guest';
      const peer = new root.Peer({ debug: 1 });
      this.peer = peer;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('host not reachable')), CONNECT_TIMEOUT_MS);
        this.timers.push(timeout);
        peer.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
          this.finish();
        });
        peer.on('open', () => {
          const conn = peer.connect(this.peerId(), { serialization: 'raw', reliable: true });
          this.useGuestConnection(conn).then(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      });
    }

    // ------------------------------------------------------- PeerJS host/guest
    /** Run the game hub in this browser and join it through an in-memory loopback. */
    hostGame() {
      this.role = 'host';
      const hub = this.options.hub;
      if (!hub) throw new Error('no hub for this game');
      const server = new HubSocket(
        (data) => queueMicrotask(() => this.receive(data)),
        () => queueMicrotask(() => this.finish()),
      );
      this.loopback = server;
      hub.handleConnection(server);
      const destroy = () => this.finish();
      root.addEventListener('pagehide', destroy, { once: true });
      this.opened();
    }

    /**
     * Host side: a guest's connection is open; hand it to the hub. The hosting phone runs
     * exactly one room, so every paired guest joins it — whatever room code the guest's
     * page happened to pick before scanning (otherwise host and guest end up alone in
     * two different rooms on the same hub).
     */
    acceptPeer(conn) {
      const sock = hubSocketFromConnection(conn);
      const hostCode = this.options.code;
      const emit = sock.emit.bind(sock);
      sock.emit = (event, data) => {
        if (event === 'message' && typeof data === 'string' && data.includes('"join"')) {
          try {
            const msg = JSON.parse(data);
            if (msg && msg.type === 'join') data = JSON.stringify({ ...msg, code: hostCode });
          } catch { /* not JSON: leave it to the hub */ }
        }
        emit(event, data);
      };
      this.options.hub.handleConnection(sock);
    }

    /** Guest side: use `conn` (PeerJS-like) as this link's transport. Resolves on open. */
    useGuestConnection(conn) {
      this.role = 'guest';
      this.conn = conn;
      let lastSeen = Date.now();
      return new Promise((resolve) => {
        conn.on('open', () => {
          const beat = setInterval(() => {
            if (Date.now() - lastSeen > SILENCE_TIMEOUT_MS) {
              this.finish();
              return;
            }
            try { conn.send(HB); } catch { this.finish(); }
          }, HEARTBEAT_MS);
          this.timers.push(beat);
          this.opened();
          resolve();
        });
        conn.on('data', (data) => {
          lastSeen = Date.now();
          if (data !== HB) this.receive(String(data));
        });
        conn.on('close', () => this.finish());
        conn.on('error', () => this.finish());
      });
    }

    onCleanup(fn) {
      this.cleanups.push(fn);
    }

    // ----------------------------------------------------------------- common
    opened() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      requestWakeLock();
    }

    receive(data) {
      if (this.readyState !== 1) return;
      this.dispatchEvent(new MessageEvent('message', { data }));
    }

    send(data) {
      if (this.readyState !== 1) return;
      if (this.ws) this.ws.send(data);
      else if (this.loopback) {
        const server = this.loopback;
        queueMicrotask(() => server.emit('message', data));
      } else if (this.conn) this.conn.send(data);
    }

    close() {
      this.finish();
    }

    finish() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      this.cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
      if (this.ws && this.ws.readyState <= 1) this.ws.close();
      if (this.loopback) this.loopback.markClosed();
      if (this.conn) this.conn.close();
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
      this.dispatchEvent(new Event('close'));
    }
  }

  let wakeLock = null;
  async function requestWakeLock() {
    // Keeps the screen on; especially important for the hosting phone.
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* not supported, denied or no secure context */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  // Offline cache (needs a secure context): the site loads instantly on later visits.
  // Playing still needs internet for the PeerJS broker.
  // Only on static hosting: next to the Node server (often localhost:<port> shared with
  // other projects) a lingering worker would cache foreign files.
  if ('serviceWorker' in navigator && root.isSecureContext && location.protocol !== 'file:') {
    detectServer().then((isServer) => {
      if (!isServer) navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  root.PloinkNet = {
    /**
     * @param {{mode: 'pong'|'blaster'|'gallery', code: string, wsPath: string, hub: object}} options
     */
    open: (options) => new Link(options),
    detectServer,
    roomCodeFromHash,
    loadScript,
    hubSocketFromConnection,
  };

})(typeof self !== 'undefined' ? self : this);
