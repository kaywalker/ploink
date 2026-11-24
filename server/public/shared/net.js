'use strict';

// Ploink networking: gives the game clients one WebSocket-like "link".
//
// - QR mode (shared/qr.js, the only mode players see): one phone hosts the round, the
//   game hub runs in its browser, and every guest pairs with it by exchanging two QR
//   codes. WebRTC, no broker, no internet needed. The room code is chosen by the host
//   and travels inside the QR code, so players never type one.
// - Server mode, for development only (?net=server): a plain WebSocket to the Ploink
//   Node server, used by the automated tests and the practice bots.
//
// A link behaves like a WebSocket: addEventListener('open' | 'message' | 'close'),
// send(string), close(), readyState (1 = open). link.role is 'server', 'host' or 'guest'.

(function (root) {
  const HEARTBEAT_MS = 3000;
  const SILENCE_TIMEOUT_MS = 12_000;
  const HB = '{"type":"__hb"}';

  // Read lazily: Pong switches rooms without reloading the page.
  const currentHash = () => location.hash.replace(/^#/, '');

  /** 'server' (development, ?net=server) or 'qr' (everything else). */
  function chosenTransport() {
    return new URLSearchParams(location.search).get('net') === 'server' ? 'server' : 'qr';
  }

  /** Two-digit room code from "#42" or from a QR join link "#qr=42.<…>". */
  function roomCodeFromHash() {
    const m = /^(?:qr=)?(\d{2})(?:\.|$)/.exec(currentHash());
    return m ? m[1] : '';
  }

  let generatedCode = null;
  /**
   * The room code of this page: from a QR join link, or picked once by the host. The
   * hub on the hosting phone only knows this one room, so collisions do not matter.
   */
  function roomCode() {
    const fromHash = roomCodeFromHash();
    if (fromHash) return fromHash;
    if (!generatedCode) generatedCode = String(Math.floor(Math.random() * 100)).padStart(2, '0');
    return generatedCode;
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
   * Wrap a guest's connection (host side) for a game hub, with heartbeats. `conn` is a
   * data channel wrapped by qr.js (on('data'|'close'|'error'), send, close).
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
      if (chosenTransport() === 'server') {
        this.transport = 'server';
        this.startServer();
        return;
      }
      this.transport = 'qr';
      await Promise.all([loadScript('vendor/qrcode-generator-2.0.4.js'), loadScript('shared/qr.js')]);
      if (this.readyState === 3) return;
      await root.PloinkQr.start(this);
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

    // ------------------------------------------------------------- QR pairing
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

    /** Host side: a guest's connection is open; hand it to the hub. */
    acceptPeer(conn) {
      this.options.hub.handleConnection(hubSocketFromConnection(conn));
    }

    /** Guest side: use `conn` (see qr.js connFromChannel) as this link's transport. Resolves on open. */
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

  // Offline support (needs a secure context): lets QR mode work without internet
  // once the site has been opened.
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
    roomCode,
    loadScript,
    hubSocketFromConnection,
    /** True when this page was only opened to hand a scanned QR answer to the host tab. */
    relayOnly: /^qra=/.test(currentHash()),
  };

  // A scanned answer code opened this page in a new tab: pass it on to the host tab.
  if (root.PloinkNet.relayOnly) {
    loadScript('shared/qr.js').then(() => root.PloinkQr.relay()).catch(() => {});
  }
})(typeof self !== 'undefined' ? self : this);
