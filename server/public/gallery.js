'use strict';

// Ploink Schießbude client.
// The phones of a room lie side by side and form one panorama: this phone shows the
// slice x ∈ [seat, seat + 1]. Horizontal positions are in phone widths, vertical
// positions are fractions of the screen height. Target paths are deterministic
// functions of the shared server clock (see gallery.js on the server).

(() => {
  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  const TARGET_RADIUS = { balloon: 0.075, ufo: 0.09, drone: 0.055, bomb: 0.06 };
  const HIT_SLOP = 0.035;          // extra tap tolerance for fingers, in phone widths
  const AMMO_MAX = 6;
  const RELOAD_MS = 900;
  const RECONNECT_DELAY_MS = 1200;
  const BALLOON_COLORS = ['#ff5d73', '#ffe156', '#7ee081', '#4dd6ff', '#ff7ac6'];

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const gameScreen = $('game');
  const canvas = $('field');
  const ctx = canvas.getContext('2d');
  const toastsEl = $('toasts');
  const offlineEl = $('offline');
  const board = $('board');
  const lobby = $('lobby');
  const countdownEl = $('countdown');
  const timerEl = $('hud-timer');
  const ammoEl = $('ammo');

  const storage = {
    get(store, key) {
      try { return store.getItem(key); } catch { return null; }
    },
    set(store, key, value) {
      try { store.setItem(key, value); } catch { /* private mode */ }
    },
  };

  const roomCode = PloinkNet.roomCodeFromHash(); // "#42"
  if (!/^\d{2}$/.test(roomCode)) {
    location.replace('./');
    return;
  }

  let token = storage.get(sessionStorage, 'ploink-gallery-token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    storage.set(sessionStorage, 'ploink-gallery-token', token);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let socket = null;
  let reconnectTimer = null;
  let me = { id: null, name: storage.get(localStorage, 'ploink-name') || '', color: '#ffe156' };
  let phase = 'lobby';
  let phaseEndsAt = 0;
  let seats = [];
  let seat = 0;
  let lastResults = null;
  /** @type {Map<number, any>} */
  const targets = new Map();
  const particles = [];
  const popups = [];
  const rings = [];
  let ammo = AMMO_MAX;
  let reloadUntil = 0;

  // Shared clock: serverNow() ≈ Date.now() on the server.
  let clockOffset = 0;
  let bestRtt = Infinity;
  const serverNow = () => performance.now() + clockOffset;

  let cssW = 1;
  let cssH = 1;
  let dpr = 1;

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function connect() {
    clearTimeout(reconnectTimer);
    // WebSocket to the Ploink server, or WebRTC to/as the hosting phone (see shared/net.js).
    const ws = PloinkNet.open({ mode: 'gallery', code: roomCode, wsPath: '/ws/gallery', hub: window.PloinkGalleryHub });
    socket = ws;
    bestRtt = Infinity;

    ws.addEventListener('open', () => {
      if (ws.role === 'host') toast('📡 Du bist Gastgeber – lass diese Seite offen und das Display an.');
      send({ type: 'join', code: roomCode, name: me.name, token });
      // A short burst of pings gives a good clock estimate right away.
      for (let i = 0; i < 6; i++) setTimeout(ping, i * 250);
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      offlineEl.hidden = false;
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  function ping() {
    send({ type: 'ping', t: performance.now() });
  }
  setInterval(ping, 5000);

  function handleMessage(msg) {
    switch (msg.type) {
      case 'pong': {
        const now = performance.now();
        const rtt = now - msg.t;
        // Keep the sample with the lowest round trip; it has the smallest error.
        if (rtt < bestRtt * 1.2) {
          bestRtt = Math.min(bestRtt, rtt);
          clockOffset = msg.server + rtt / 2 - now;
        }
        break;
      }
      case 'joined':
        me = { id: msg.you, name: msg.name, color: msg.color };
        if (bestRtt === Infinity) clockOffset = msg.serverNow - performance.now();
        if (msg.token) {
          token = msg.token;
          storage.set(sessionStorage, 'ploink-gallery-token', token);
        }
        offlineEl.hidden = true;
        break;
      case 'error':
        alert(msg.message);
        location.replace('./');
        break;
      case 'state':
        applyState(msg);
        break;
      case 'spawn':
        targets.set(msg.target.id, msg.target);
        break;
      case 'targets':
        targets.clear();
        for (const t of msg.list) targets.set(t.id, t);
        break;
      case 'pop':
        handlePop(msg);
        break;
      case 'roundEnd':
        if (msg.results.length > 0) {
          const winner = msg.results[0];
          toast(winner.id === me.id ? '🏆 Du hast gewonnen!' : `🏆 ${winner.name} gewinnt mit ${winner.score} Punkten`, winner.color);
          vibrate([80, 60, 80]);
        }
        break;
      case 'event':
        if (msg.kind === 'join' && msg.id !== me.id) toast(`${msg.name} ist dabei`, msg.color);
        break;
      default:
        break;
    }
  }

  function applyState(msg) {
    const previousPhase = phase;
    phase = msg.phase;
    phaseEndsAt = msg.phaseEndsAt;
    seats = msg.seats;
    lastResults = msg.lastResults;
    seat = Math.max(0, seats.findIndex((s) => s.id === me.id));
    const self = seats.find((s) => s.id === me.id);
    if (self) me.color = self.color;

    if (phase !== 'playing') targets.clear();
    if (phase === 'playing' && previousPhase !== 'playing') {
      ammo = AMMO_MAX;
      reloadUntil = 0;
      renderAmmo();
    }
    renderUi();
  }

  function handlePop(msg) {
    const target = targets.get(msg.id);
    targets.delete(msg.id);
    if (msg.by.id === me.id) {
      $('hud-score').textContent = String(Number($('hud-score').textContent) + msg.points);
      vibrate(msg.points < 0 ? [100, 50, 100] : 25);
    }
    if (!target) return;
    const pos = toScreen(targetPosition(target, serverNow()));
    if (pos.x < -0.2 * cssW || pos.x > 1.2 * cssW) return;
    const bomb = target.type === 'bomb';
    explode(pos.x, pos.y, bomb ? ['#ffb84d', '#ff5d73', '#ffe156'] : [colorOf(target), '#ffffff'], bomb ? 40 : 18);
    const label = `${msg.points > 0 ? '+' : '−'}${Math.abs(msg.points)}`;
    popups.push({
      x: pos.x, y: pos.y, life: 1,
      text: msg.by.id === me.id ? label : `${msg.by.name} ${label}`,
      color: msg.points < 0 ? '#ff5d73' : msg.by.color,
    });
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  function renderUi() {
    $('hud-seat').textContent = seat + 1;
    const self = seats.find((s) => s.id === me.id);
    $('hud-score').textContent = self ? self.score : 0;

    lobby.hidden = phase !== 'lobby';
    timerEl.hidden = phase !== 'playing';
    ammoEl.hidden = phase !== 'playing';
    countdownEl.hidden = phase !== 'countdown';
    if (phase !== 'lobby') board.hidden = board.hidden || phase !== 'playing';

    // Lobby
    $('seat-number').textContent = seat + 1;
    $('seat-total').textContent = `von ${seats.length}`;
    $('move-left').disabled = seat <= 0;
    $('move-right').disabled = seat >= seats.length - 1;
    $('seat-list').replaceChildren(...seats.map((s, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--seat-color', s.color);
      if (s.id === me.id) li.classList.add('me');
      if (!s.connected) li.classList.add('offline');
      const num = document.createElement('b');
      num.textContent = i + 1;
      const name = document.createElement('span');
      name.textContent = s.id === me.id ? `${s.name} (du)` : s.name;
      li.append(num, name);
      return li;
    }));

    const results = $('results');
    results.hidden = !lastResults || lastResults.length === 0;
    if (lastResults) {
      $('results-list').replaceChildren(...lastResults.map((r, i) => {
        const li = document.createElement('li');
        if (r.id === me.id) li.classList.add('me');
        const medal = document.createElement('span');
        medal.textContent = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        const name = document.createElement('span');
        name.textContent = r.name;
        name.style.color = r.color;
        const score = document.createElement('strong');
        score.textContent = r.score;
        li.append(medal, name, score);
        return li;
      }));
    }
    $('start').textContent = lastResults ? 'Nochmal!' : 'Runde starten';

    // Live board
    const sorted = [...seats].sort((a, b) => b.score - a.score);
    $('board-list').replaceChildren(...sorted.map((s) => {
      const li = document.createElement('li');
      if (s.id === me.id) li.classList.add('me');
      if (!s.connected) li.classList.add('offline');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = s.color;
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = `${seats.indexOf(s) + 1}. ${s.name}`;
      const score = document.createElement('span');
      score.className = 'stat';
      score.textContent = `⭐ ${s.score}`;
      li.append(swatch, name, score);
      return li;
    }));
  }

  function renderAmmo() {
    const reloading = reloadUntil > performance.now();
    ammoEl.classList.toggle('reloading', reloading);
    if (reloading) {
      ammoEl.textContent = 'Nachladen …';
      return;
    }
    ammoEl.replaceChildren(...Array.from({ length: AMMO_MAX }, (_, i) => {
      const shell = document.createElement('span');
      shell.className = i < ammo ? 'shell' : 'shell empty';
      return shell;
    }));
  }

  function updateClocks() {
    const now = serverNow();
    if (phase === 'playing') {
      const left = Math.max(0, Math.ceil((phaseEndsAt - now) / 1000));
      const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (timerEl.textContent !== text) timerEl.textContent = text;
      timerEl.classList.toggle('urgent', left <= 10);
    } else if (phase === 'countdown') {
      const left = Math.max(1, Math.ceil((phaseEndsAt - now) / 1000));
      if (countdownEl.textContent !== String(left)) countdownEl.textContent = left;
    }
    if (reloadUntil && reloadUntil <= performance.now()) {
      reloadUntil = 0;
      ammo = AMMO_MAX;
      renderAmmo();
    }
  }

  function toast(text, color) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    if (color) el.style.borderColor = color;
    toastsEl.append(el);
    setTimeout(() => el.remove(), 2700);
    while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
  }

  $('hud-code').textContent = roomCode;
  $('board-code').textContent = roomCode;
  $('lobby-code').textContent = roomCode;
  $('room-badge').addEventListener('click', () => { board.hidden = !board.hidden; });
  $('board-close').addEventListener('click', () => { board.hidden = true; });
  $('move-left').addEventListener('click', () => send({ type: 'move', dir: -1 }));
  $('move-right').addEventListener('click', () => send({ type: 'move', dir: 1 }));
  $('start').addEventListener('click', () => {
    requestImmersiveMode();
    send({ type: 'start' });
  });
  $('stop-round').addEventListener('click', () => {
    board.hidden = true;
    send({ type: 'stop' });
  });

  function requestImmersiveMode() {
    const el = document.documentElement;
    if (el.requestFullscreen && matchMedia('(pointer: coarse)').matches && !document.fullscreenElement) {
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Shooting
  // ---------------------------------------------------------------------------
  function targetPosition(t, now) {
    const dt = (now - t.t0) / 1000;
    return {
      x: t.x0 + t.vx * dt + t.ax * Math.sin(t.fx * dt + t.ph),
      y: t.y0 + t.vy * dt + t.ay * Math.sin(t.fy * dt + t.ph),
    };
  }

  /** Panorama position -> pixel position on this phone. */
  function toScreen(p) {
    return { x: (p.x - seat) * cssW, y: p.y * cssH };
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (phase !== 'playing') return;
    if (reloadUntil > performance.now()) return;
    const x = event.clientX;
    const y = event.clientY;
    ammo--;
    rings.push({ x, y, life: 1 });

    const now = serverNow();
    let best = null;
    let bestDist = Infinity;
    for (const t of targets.values()) {
      const pos = toScreen(targetPosition(t, now));
      const reach = (TARGET_RADIUS[t.type] + HIT_SLOP) * cssW;
      const dist = Math.hypot(pos.x - x, pos.y - y);
      if (dist < reach && dist < bestDist) {
        best = t;
        bestDist = dist;
      }
    }
    if (best) send({ type: 'shoot', id: best.id });

    if (ammo <= 0) reloadUntil = performance.now() + RELOAD_MS;
    renderAmmo();
  });

  gameScreen.addEventListener('touchmove', (e) => {
    if (!board.contains(e.target) && !lobby.contains(e.target)) e.preventDefault();
  }, { passive: false });

  function explode(x, y, colors, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.08 + Math.random() * 0.35) * cssW;
      particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, color: colors[i % colors.length],
      });
    }
  }

  function vibrate(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cssW = Math.max(1, gameScreen.clientWidth || window.innerWidth);
    cssH = Math.max(1, gameScreen.clientHeight || window.innerHeight);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  /** Deterministic pseudo random number in [0, 1) for an integer. */
  function hash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  const backHill = (x) => 0.66 + 0.05 * Math.sin(1.3 * x + 2) + 0.025 * Math.sin(3.7 * x);
  const frontHill = (x) => 0.8 + 0.03 * Math.sin(2.1 * x) + 0.02 * Math.sin(5.3 * x + 1);

  function drawLandscape(nowSec) {
    const total = Math.max(1, seats.length);

    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, cssH);
    sky.addColorStop(0, '#1b1033');
    sky.addColorStop(0.45, '#5b2a6e');
    sky.addColorStop(0.72, '#ff8a5b');
    sky.addColorStop(1, '#ffb36b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cssW, cssH);

    // Stars (only in the upper sky)
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = Math.floor(seat * 30); i < (seat + 1) * 30; i++) {
      const x = (i / 30 - seat + hash(i) / 30) * cssW;
      const y = hash(i + 999) * 0.4 * cssH;
      const twinkle = 0.5 + 0.5 * Math.sin(nowSec * (1 + hash(i + 7) * 2) + i);
      ctx.globalAlpha = 0.25 + 0.6 * twinkle * (1 - y / (0.4 * cssH));
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;

    // Sun in the middle of the whole panorama
    const sun = toScreen({ x: total / 2, y: 0.64 });
    const sunR = 0.32 * cssW;
    if (sun.x > -sunR && sun.x < cssW + sunR) {
      const g = ctx.createRadialGradient(sun.x, sun.y, sunR * 0.2, sun.x, sun.y, sunR);
      g.addColorStop(0, 'rgba(255,240,180,1)');
      g.addColorStop(0.7, 'rgba(255,170,90,0.9)');
      g.addColorStop(1, 'rgba(255,140,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sun.x, sun.y, sunR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Clouds drifting across all phones
    ctx.fillStyle = 'rgba(255,220,240,0.18)';
    for (let i = 0; i < total * 2; i++) {
      const span = total + 1;
      const x = ((i * 1.37 + nowSec * 0.02 * (1 + (i % 3) * 0.3)) % span) - 0.5;
      const p = toScreen({ x, y: 0.1 + 0.07 * (i % 4) });
      const w = (0.25 + hash(i) * 0.2) * cssW;
      if (p.x < -w || p.x > cssW + w) continue;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, w * 0.5, w * 0.12, 0, 0, Math.PI * 2);
      ctx.ellipse(p.x - w * 0.18, p.y - w * 0.06, w * 0.22, w * 0.1, 0, 0, Math.PI * 2);
      ctx.ellipse(p.x + w * 0.15, p.y - w * 0.05, w * 0.25, w * 0.11, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    drawHill(backHill, '#3b1d4f');

    // Pine trees on the front hill, continuous across phones
    ctx.fillStyle = '#1d0f2b';
    for (let k = Math.floor(seat / 0.13) - 1; k <= Math.ceil((seat + 1) / 0.13) + 1; k++) {
      if (hash(k + 50) > 0.4) continue;
      const tx = k * 0.13 + hash(k) * 0.05;
      const base = frontHill(tx);
      const h = 0.06 + hash(k + 3) * 0.05;
      const p = toScreen({ x: tx, y: base });
      const w = 0.035 * cssW;
      ctx.beginPath();
      ctx.moveTo(p.x - w, p.y + 2);
      ctx.lineTo(p.x, p.y - h * cssH);
      ctx.lineTo(p.x + w, p.y + 2);
      ctx.closePath();
      ctx.fill();
    }

    drawHill(frontHill, '#1d0f2b');
  }

  function drawHill(fn, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, cssH);
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const x = seat + i / steps;
      ctx.lineTo((i / steps) * cssW, fn(x) * cssH);
    }
    ctx.lineTo(cssW, cssH);
    ctx.closePath();
    ctx.fill();
  }

  function colorOf(t) {
    return t.type === 'balloon' ? BALLOON_COLORS[t.id % BALLOON_COLORS.length] : '#c9d3ff';
  }

  function drawTarget(t, p, nowSec) {
    const r = TARGET_RADIUS[t.type] * cssW;
    ctx.save();
    ctx.translate(p.x, p.y);
    switch (t.type) {
      case 'balloon': {
        const color = colorOf(t);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, r * 1.15);
        for (let i = 1; i <= 6; i++) {
          ctx.lineTo(Math.sin(nowSec * 3 + i) * r * 0.12, r * 1.15 + i * r * 0.25);
        }
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.85, r, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-r * 0.15, r * 1.15);
        ctx.lineTo(r * 0.15, r * 1.15);
        ctx.lineTo(0, r * 0.95);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.beginPath();
        ctx.ellipse(-r * 0.3, -r * 0.35, r * 0.18, r * 0.3, -0.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'ufo': {
        const tilt = Math.sign(t.vx) * 0.12;
        ctx.rotate(tilt);
        ctx.fillStyle = 'rgba(120,230,255,0.75)';
        ctx.beginPath();
        ctx.ellipse(0, -r * 0.2, r * 0.45, r * 0.4, 0, Math.PI, 0);
        ctx.fill();
        const disc = ctx.createLinearGradient(0, -r * 0.3, 0, r * 0.3);
        disc.addColorStop(0, '#e8ecff');
        disc.addColorStop(1, '#7a83a8');
        ctx.fillStyle = disc;
        ctx.beginPath();
        ctx.ellipse(0, 0, r, r * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 5; i++) {
          const on = Math.floor(nowSec * 6 + i) % 2 === 0;
          ctx.fillStyle = on ? '#ffe156' : '#ff5d73';
          ctx.beginPath();
          ctx.arc((i - 2) * r * 0.38, r * 0.05, r * 0.07, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'drone': {
        const spin = nowSec * 40;
        ctx.fillStyle = '#2a2f45';
        ctx.fillRect(-r * 0.9, -r * 0.12, r * 1.8, r * 0.24);
        for (const sx of [-1, 1]) {
          ctx.fillStyle = 'rgba(220,230,255,0.45)';
          ctx.beginPath();
          ctx.ellipse(sx * r * 0.9, -r * 0.25, r * 0.5 * Math.abs(Math.cos(spin)), r * 0.1, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#3c4363';
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.45, r * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = Math.floor(nowSec * 8) % 2 ? '#ff5d73' : '#ffe156';
        ctx.beginPath();
        ctx.arc(Math.sign(t.vx) * r * 0.25, 0, r * 0.12, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      default: { // bomb
        ctx.strokeStyle = '#c9a46a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(r * 0.5, -r * 0.6);
        ctx.quadraticCurveTo(r * 0.9, -r * 1.1, r * 0.6, -r * 1.3);
        ctx.stroke();
        const spark = 0.6 + 0.4 * Math.sin(nowSec * 30);
        ctx.fillStyle = `rgba(255,${180 + spark * 60},80,${spark})`;
        ctx.beginPath();
        ctx.arc(r * 0.6, -r * 1.3, r * 0.22 * spark + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111219';
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff5d73';
        ctx.font = `800 ${r * 0.9}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', 0, r * 0.05);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.arc(-r * 0.35, -r * 0.35, r * 0.25, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function draw(dt) {
    const now = serverNow();
    const nowSec = now / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLandscape(nowSec);

    // Targets in this phone's slice
    for (const t of targets.values()) {
      if (now > t.t0 + t.ttl) {
        targets.delete(t.id);
        continue;
      }
      const p = toScreen(targetPosition(t, now));
      const margin = TARGET_RADIUS[t.type] * cssW * 1.6;
      if (p.x < -margin || p.x > cssW + margin) continue;
      drawTarget(t, p, nowSec);
    }

    // Shot rings
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life -= dt * 4;
      if (r.life <= 0) { rings.splice(i, 1); continue; }
      ctx.strokeStyle = `rgba(255,255,255,${r.life})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, (1 - r.life) * 26 + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(r.x - 10, r.y); ctx.lineTo(r.x + 10, r.y);
      ctx.moveTo(r.x, r.y - 10); ctx.lineTo(r.x, r.y + 10);
      ctx.stroke();
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt * 1.6;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.6 * cssW * dt;
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
    }
    ctx.globalAlpha = 1;

    // Score popups
    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i];
      p.life -= dt * 0.9;
      if (p.life <= 0) { popups.splice(i, 1); continue; }
      p.y -= 30 * dt;
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.font = `800 ${Math.round(cssW * 0.06)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    // Seat number in the corner so everyone can line up the phones
    ctx.font = `700 ${Math.round(cssW * 0.05)}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(`${seat + 1}/${Math.max(1, seats.length)}`, cssW - 12, cssH - 14);
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  resize();
  renderAmmo();
  connect();

  let last = performance.now();
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    updateClocks();
    draw(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Expose a tiny hook for automated tests.
  window.__gallery = {
    targets, serverNow, targetPosition, toScreen,
    get phase() { return phase; },
    get seats() { return seats; },
    get seat() { return seat; },
    // Lets tests render another seat's slice (reset by the next state update).
    set seat(value) { seat = value; },
  };
})();
