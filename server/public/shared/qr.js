'use strict';

// QR transport for Ploink: WebRTC without any broker. The host creates one offer per
// guest and shows it as a QR code (a link to this page with "#qr=<code>.<id>.<sdp>").
// The guest scans it (in Ploink or with the normal camera app), answers with a second
// QR code ("#qra=<id>.<sdp>"), and the host scans that one. Answers scanned with the
// camera app open in a new tab, which hands them to the host tab via BroadcastChannel.
//
// SDPs are gathered completely before they are shown (no trickle ICE) and compressed
// with deflate-raw + base64url to keep the QR codes small.

(function (root) {
  const ICE_TIMEOUT_MS = 2500;
  const CHANNEL_NAME = 'ploink-qr';
  const MAX_CANDIDATES = 6;
  const PENDING_TTL_MS = 10 * 60_000;

  // ---------------------------------------------------------------------------
  // Encoding
  // ---------------------------------------------------------------------------
  function toBase64Url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  // Compact format ("c…"): only the fields a data-channel SDP really needs, rebuilt from
  // a template on the other side. About a third of the deflated size, so the QR codes
  // stay easy to scan. Anything unexpected falls back to deflate ("z…") or plain ("u…").
  //   c<setup>,<ufrag>,<pwd>,<sha-256 fingerprint base64url>,<candidate>,…
  //   candidate: <h|s|r|p><address>:<port>, address "m<base64url uuid>" = <uuid>.local
  const SETUP = { actpass: 'a', active: 'c', passive: 'p' };
  const SETUP_BACK = { a: 'actpass', c: 'active', p: 'passive' };
  const CAND_TYPE = { host: 'h', srflx: 's', relay: 'r', prflx: 'p' };
  const CAND_BACK = { h: 'host', s: 'srflx', r: 'relay', p: 'prflx' };
  const CAND_PRIORITY = { host: 2113937151, srflx: 1677729535, prflx: 1845501695, relay: 41885439 };

  function compactSdp(sdp) {
    const get = (re) => (re.exec(sdp) || [])[1];
    const ufrag = get(/^a=ice-ufrag:(\S+)$/m);
    const pwd = get(/^a=ice-pwd:(\S+)$/m);
    const fp = get(/^a=fingerprint:sha-256 ([0-9A-F:]+)$/mi);
    const setup = SETUP[get(/^a=setup:(\S+)$/m)];
    const mid = get(/^a=mid:(\S+)$/m);
    if (!ufrag || !pwd || !fp || !setup || mid !== '0' || /[,]/.test(ufrag + pwd)) return null;
    const fpBytes = Uint8Array.from(fp.split(':'), (h) => parseInt(h, 16));
    const candidates = [];
    for (const line of sdp.split('\r\n')) {
      if (!line.startsWith('a=candidate')) continue;
      const p = line.split(' ');
      const type = CAND_TYPE[p[7]];
      if (!type) continue;
      let addr = p[4];
      const mdns = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i.exec(addr);
      if (mdns) {
        const hex = mdns.slice(1).join('');
        addr = `m${toBase64Url(Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16)))}`;
      } else if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
        continue;
      }
      candidates.push(`${type}${addr}:${p[5]}`);
    }
    if (candidates.length === 0) return null;
    return `c${setup},${ufrag},${pwd},${toBase64Url(fpBytes)},${candidates.join(',')}`;
  }

  function expandSdp(compact) {
    const [setupChar, ufrag, pwd, fp, ...cands] = compact.slice(1).split(',');
    const fingerprint = Array.from(fromBase64Url(fp), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const lines = [
      'v=0',
      `o=- ${Math.floor(Math.random() * 1e15)} 2 IN IP4 127.0.0.1`,
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
    ];
    cands.forEach((c, i) => {
      const type = CAND_BACK[c[0]];
      const sep = c.lastIndexOf(':');
      let addr = c.slice(1, sep);
      const port = c.slice(sep + 1);
      if (addr[0] === 'm') {
        const hex = Array.from(fromBase64Url(addr.slice(1)), (b) => b.toString(16).padStart(2, '0')).join('');
        addr = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
      }
      const related = type === 'host' ? '' : ' raddr 0.0.0.0 rport 0';
      lines.push(`a=candidate:${i + 1} 1 udp ${CAND_PRIORITY[type]} ${addr} ${port} typ ${type}${related} generation 0`);
    });
    lines.push(
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      'a=ice-options:trickle',
      `a=fingerprint:sha-256 ${fingerprint}`,
      `a=setup:${SETUP_BACK[setupChar]}`,
      'a=mid:0',
      'a=sctp-port:5000',
      'a=max-message-size:262144',
    );
    return `${lines.join('\r\n')}\r\n`;
  }

  async function pack(text) {
    const compact = compactSdp(text);
    if (compact) return compact;
    if ('CompressionStream' in root) {
      const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return `z${toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
    }
    return `u${toBase64Url(new TextEncoder().encode(text))}`;
  }

  async function unpack(raw) {
    // Camera apps may percent-encode the fragment.
    const data = raw.includes('%') ? decodeURIComponent(raw) : raw;
    if (data[0] === 'c') return expandSdp(data);
    const bytes = fromBase64Url(data.slice(1));
    if (data[0] === 'z') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    return new TextDecoder().decode(bytes);
  }

  /** Drop candidates that only make the QR code bigger (TCP, IPv6 literals, extras). */
  function slimSdp(sdp) {
    let kept = 0;
    return sdp.split('\r\n').filter((line) => {
      if (!line.startsWith('a=candidate')) return true;
      const parts = line.split(' ');
      if ((parts[2] || '').toLowerCase() !== 'udp') return false;
      if ((parts[4] || '').includes(':')) return false;
      kept++;
      return kept <= MAX_CANDIDATES;
    }).join('\r\n');
  }

  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Link to this page (keeping the game) with the given hash. QR is the default transport. */
  function pageUrl(hashPart) {
    const url = new URL(location.href);
    url.searchParams.delete('net');
    url.hash = hashPart;
    return url.toString();
  }

  /** "#…" part of a scanned text (a full link or just the fragment). */
  function fragmentOf(text) {
    const i = text.indexOf('#');
    return i >= 0 ? text.slice(i + 1) : text;
  }

  // ---------------------------------------------------------------------------
  // WebRTC helpers
  // ---------------------------------------------------------------------------
  function rtcConfig() {
    // Same Wi-Fi works with host candidates alone; STUN helps when online.
    return { iceServers: navigator.onLine ? [{ urls: 'stun:stun.l.google.com:19302' }] : [] };
  }

  function waitForIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(done, ICE_TIMEOUT_MS);
    });
  }

  /** Make an RTCDataChannel look like a PeerJS DataConnection (on/send/close). */
  function connFromChannel(channel, pc) {
    const handlers = { open: [], data: [], close: [], error: [] };
    const emit = (event, value) => handlers[event].forEach((fn) => fn(value));
    let closed = false;
    const markClosed = () => {
      if (closed) return;
      closed = true;
      emit('close');
      try { pc.close(); } catch { /* ignore */ }
    };
    channel.addEventListener('open', () => emit('open'));
    channel.addEventListener('message', (e) => emit('data', e.data));
    channel.addEventListener('close', markClosed);
    channel.addEventListener('error', () => emit('error'));
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') markClosed();
    });
    return {
      on(event, fn) {
        handlers[event].push(fn);
        if (event === 'open' && channel.readyState === 'open') queueMicrotask(fn);
      },
      send(data) {
        if (channel.readyState === 'open') channel.send(data);
      },
      close() {
        try { channel.close(); } catch { /* ignore */ }
        markClosed();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  }

  function button(label, onClick, className = 'btn') {
    const b = el('button', { type: 'button', className, textContent: label });
    b.addEventListener('click', onClick);
    return b;
  }

  /** A modal card above the game. */
  function createOverlay() {
    const overlay = el('div', { className: 'qr-overlay' });
    const card = el('div', { className: 'qr-card' });
    overlay.append(card);
    document.body.append(overlay);
    // Touches inside the dialog must not steer paddles or ships.
    for (const type of ['pointerdown', 'pointermove', 'touchmove']) {
      overlay.addEventListener(type, (e) => e.stopPropagation());
    }
    return {
      overlay,
      show(...children) {
        card.replaceChildren(...children);
        overlay.hidden = false;
      },
      hide() { overlay.hidden = true; },
      remove() { overlay.remove(); },
    };
  }

  function renderQr(text, size = 280) {
    const qr = root.qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const modules = qr.getModuleCount();
    const quiet = 4;
    const scale = Math.max(2, Math.floor((size * (window.devicePixelRatio || 1)) / (modules + quiet * 2)));
    const canvas = el('canvas', { className: 'qr-code' });
    canvas.width = canvas.height = (modules + quiet * 2) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    canvas.dataset.payload = text; // read by automated tests
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'QR-Code');
    return canvas;
  }

  /** Scan one QR code with the camera. Resolves to its text, or null if cancelled. */
  async function scanQr(title) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('no-camera');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    let detector = null;
    if ('BarcodeDetector' in root) {
      try {
        const formats = await root.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) detector = new root.BarcodeDetector({ formats: ['qr_code'] });
      } catch { /* fall back to jsQR */ }
    }
    if (!detector) await root.PloinkNet.loadScript('vendor/jsqr-1.4.0.js');

    return new Promise((resolve) => {
      const video = el('video', { className: 'qr-video', muted: true, playsInline: true, autoplay: true });
      video.setAttribute('playsinline', '');
      const frame = el('div', { className: 'qr-scan-frame' });
      const overlay = el('div', { className: 'qr-scanner' },
        el('p', { className: 'qr-scan-title', textContent: title }),
        el('div', { className: 'qr-video-wrap' }, video, frame));
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        stream.getTracks().forEach((t) => t.stop());
        overlay.remove();
        resolve(value);
      };
      overlay.append(button('Abbrechen', () => finish(null), 'btn btn-ghost'));
      for (const type of ['pointerdown', 'pointermove', 'touchmove']) {
        overlay.addEventListener(type, (e) => e.stopPropagation());
      }
      document.body.append(overlay);
      video.srcObject = stream;
      video.play().catch(() => {});

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const tick = async () => {
        if (finished) return;
        try {
          if (video.readyState >= 2) {
            if (detector) {
              const codes = await detector.detect(video);
              if (codes.length) { finish(codes[0].rawValue); return; }
            } else {
              const w = Math.min(640, video.videoWidth);
              const h = Math.round((video.videoHeight / video.videoWidth) * w) || w;
              canvas.width = w;
              canvas.height = h;
              ctx.drawImage(video, 0, 0, w, h);
              const code = root.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
              if (code && code.data) { finish(code.data); return; }
            }
          }
        } catch { /* keep trying */ }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  const NO_CAMERA_HINT = 'Die Kamera ist hier nicht verfügbar (sie braucht HTTPS). Scanne den Code einfach mit der Kamera-App deines Handys.';

  // ---------------------------------------------------------------------------
  // Host
  // ---------------------------------------------------------------------------
  async function startHost(link, ui) {
    link.hostGame();
    const pending = new Map(); // offer id -> {pc, created}
    let connectedCount = 0;
    let currentQr = null;
    const status = el('p', { className: 'qr-status' });
    const qrSlot = el('div', { className: 'qr-slot' });

    const channel = 'BroadcastChannel' in root ? new BroadcastChannel(CHANNEL_NAME) : null;
    if (channel) {
      channel.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'answer') applyAnswer(e.data.fragment);
      });
    }

    const fab = button('📷+', () => openPanel(), 'qr-fab');
    fab.setAttribute('aria-label', 'Spieler koppeln');
    fab.title = 'Spieler koppeln';
    document.body.append(fab);

    link.onCleanup(() => {
      if (channel) channel.close();
      for (const { pc } of pending.values()) pc.close();
      fab.remove();
      ui.remove();
    });

    async function newOffer() {
      for (const [id, entry] of pending) {
        if (Date.now() - entry.created > PENDING_TTL_MS) {
          entry.pc.close();
          pending.delete(id);
        }
      }
      const pc = new RTCPeerConnection(rtcConfig());
      const dataChannel = pc.createDataChannel('ploink', { ordered: true });
      const id = randomId();
      const conn = connFromChannel(dataChannel, pc);
      conn.on('open', () => {
        pending.delete(id);
        connectedCount++;
        link.acceptPeer(conn);
        status.textContent = `✓ Verbunden! Mitspieler bisher: ${connectedCount}. Der nächste kann diesen neuen Code scannen.`;
        refreshOffer();
      });
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      pending.set(id, { pc, created: Date.now() });
      return pageUrl(`qr=${link.options.code}.${id}.${await pack(slimSdp(pc.localDescription.sdp))}`);
    }

    async function refreshOffer() {
      qrSlot.replaceChildren(el('p', { className: 'qr-wait', textContent: 'Code wird erstellt …' }));
      try {
        const url = await newOffer();
        currentQr = renderQr(url);
        qrSlot.replaceChildren(currentQr);
      } catch (err) {
        qrSlot.replaceChildren(el('p', { className: 'qr-error', textContent: `Konnte keinen Code erstellen (${err.message}).` }));
      }
    }

    async function applyAnswer(fragment) {
      const m = /^qra=([0-9a-f]+)\.([czu].+)$/.exec(fragment || '');
      if (!m) {
        status.textContent = 'Das ist kein Antwort-Code von Ploink.';
        return;
      }
      const entry = pending.get(m[1]);
      if (!entry) {
        status.textContent = 'Dieser Antwort-Code gehört zu einem alten QR-Code. Bitte den aktuellen scannen lassen.';
        return;
      }
      try {
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: await unpack(m[2]) });
        status.textContent = 'Verbinde …';
        openPanel(false);
      } catch {
        status.textContent = 'Der Antwort-Code konnte nicht gelesen werden.';
      }
    }

    async function scanAnswer() {
      try {
        const text = await root.PloinkQr.scanQr('Antwort-Code des Mitspielers scannen');
        if (text) applyAnswer(fragmentOf(text));
      } catch (err) {
        status.textContent = err.message === 'no-camera' ? NO_CAMERA_HINT : 'Kein Kamerazugriff. Du kannst den Code auch mit der Kamera-App scannen.';
      }
    }

    function openPanel(createIfMissing = true) {
      ui.show(
        el('h3', { textContent: 'Spieler hinzufügen' }),
        el('p', { textContent: '1. Dein Mitspieler scannt diesen Code – mit der Kamera-App oder in Ploink.' }),
        qrSlot,
        el('p', { textContent: '2. Er zeigt dir dann einen Antwort-Code. Den scannst du:' }),
        button('📷 Antwort-Code scannen', scanAnswer),
        status,
        button('Fertig', () => ui.hide(), 'btn btn-ghost'),
      );
      if (createIfMissing && !currentQr) refreshOffer();
    }

    openPanel();
  }

  // ---------------------------------------------------------------------------
  // Guest
  // ---------------------------------------------------------------------------
  async function startGuest(link, ui, fragment) {
    const m = /^qr=(\d{2})\.([0-9a-f]+)\.([czu].+)$/.exec(fragment);
    // The offer must only be used once; a reload shows the start dialog again.
    history.replaceState(null, '', `${location.pathname}${location.search}#${m ? m[1] : ''}`);
    if (!m) throw new Error('invalid offer');
    const [, , id, data] = m;

    ui.show(el('h3', { textContent: 'Verbinde …' }), el('p', { className: 'qr-wait', textContent: 'Antwort-Code wird erstellt …' }));
    const pc = new RTCPeerConnection(rtcConfig());
    const channelPromise = new Promise((resolve) => {
      pc.addEventListener('datachannel', (e) => resolve(e.channel));
    });
    link.onCleanup(() => { pc.close(); ui.remove(); });

    await pc.setRemoteDescription({ type: 'offer', sdp: await unpack(data) });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc);
    const answerUrl = pageUrl(`qra=${id}.${await pack(slimSdp(pc.localDescription.sdp))}`);

    ui.show(
      el('h3', { textContent: 'Fast geschafft!' }),
      el('p', { textContent: 'Zeig diesen Code dem Gastgeber. Er scannt ihn mit „Antwort-Code scannen“ oder mit seiner Kamera-App.' }),
      renderQr(answerUrl),
      el('p', { className: 'qr-status', textContent: 'Warte auf den Gastgeber …' }),
      button('Abbrechen', () => link.finish(), 'btn btn-ghost'),
    );

    const channel = await channelPromise;
    await link.useGuestConnection(connFromChannel(channel, pc));
    ui.hide();
  }

  /**
   * Answer a host's offer. Problems are shown in the dialog instead of silently starting
   * over, so players can tell what went wrong. Resolves once connected.
   */
  function joinWithOffer(link, ui, fragment) {
    return startGuest(link, ui, fragment).catch((err) => {
      console.warn('[ploink] QR join failed:', err);
      ui.show(
        el('h3', { textContent: 'Verbinden hat nicht geklappt' }),
        el('p', { textContent: 'Der QR-Code konnte nicht beantwortet werden. Lass dir vom Gastgeber einen neuen Code zeigen und versuch es nochmal.' }),
        el('p', { className: 'qr-error', textContent: `Details: ${err && err.message ? err.message : err}` }),
        button('Nochmal versuchen', () => link.finish()),
      );
      return new Promise(() => {}); // keep the dialog until the player retries
    });
  }

  /** No offer in the URL: let the player choose between hosting and joining. */
  function chooseRole(link, ui) {
    return new Promise((resolve, reject) => {
      const status = el('p', { className: 'qr-status' });
      const join = async () => {
        try {
          const text = await root.PloinkQr.scanQr('QR-Code des Gastgebers scannen');
          if (!text) return;
          const url = new URL(text, location.href);
          if (url.origin !== location.origin || !/^qr=/.test(fragmentOf(text))) {
            status.textContent = 'Das ist kein Ploink-Code.';
            return;
          }
          if (url.pathname === location.pathname && url.search === location.search) {
            // Same page: assigning location.href would only change the hash (no reload),
            // so answer the offer right here.
            joinWithOffer(link, ui, fragmentOf(text)).then(resolve, reject);
          } else {
            // Another game: open the scanned link, it carries the offer in its URL.
            location.href = url.toString();
          }
        } catch (err) {
          status.textContent = err.message === 'no-camera' ? NO_CAMERA_HINT : 'Kein Kamerazugriff. Du kannst den Code auch mit der Kamera-App scannen.';
        }
      };
      ui.show(
        el('h3', { textContent: '📷 Verbindung per QR-Code' }),
        el('p', { textContent: 'Kein Internet nötig: Ein Handy eröffnet die Runde, die anderen scannen dessen Code.' }),
        button('🎯 Runde eröffnen (Gastgeber)', () => startHost(link, ui).then(resolve, reject)),
        button('📷 Code vom Gastgeber scannen', join, 'btn btn-ghost'),
        status,
        el('p', { className: 'qr-hint', textContent: 'Tipp: Die normale Kamera-App des Handys funktioniert auch.' }),
        el('a', { href: './', className: 'qr-back', textContent: 'Zurück zur Startseite' }),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------
  root.PloinkQr = {
    /** Called by PloinkNet for links in QR mode. */
    async start(link) {
      const ui = createOverlay();
      link.onCleanup(() => ui.remove());
      const fragment = location.hash.replace(/^#/, '');
      if (/^qr=/.test(fragment)) {
        await joinWithOffer(link, ui, fragment);
      } else {
        await chooseRole(link, ui);
      }
    },

    scanQr,

    /** This tab was opened by scanning an answer code with the camera app. */
    relay() {
      const fragment = location.hash.replace(/^#/, '');
      const ui = createOverlay();
      if ('BroadcastChannel' in root) {
        const channel = new BroadcastChannel(CHANNEL_NAME);
        channel.postMessage({ type: 'answer', fragment });
        setTimeout(() => channel.close(), 1000);
        ui.show(
          el('h3', { textContent: '✓ Antwort übergeben' }),
          el('p', { textContent: 'Du kannst diesen Tab jetzt schließen und zum Spiel zurückkehren.' }),
        );
        setTimeout(() => window.close(), 1500);
      } else {
        ui.show(
          el('h3', { textContent: 'Das hat nicht geklappt' }),
          el('p', { textContent: 'Dieser Browser kann die Antwort nicht an den Spiel-Tab übergeben. Scanne den Code bitte direkt in Ploink.' }),
        );
      }
    },

    // Exposed for tests.
    pack, unpack, slimSdp,
  };
})(typeof self !== 'undefined' ? self : this);
