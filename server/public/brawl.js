'use strict';

// Ploink Hausmeister-Trupp client: draws the corridor from this player's point of view
// and turns one-thumb gestures into input. The simulation runs in shared/brawl-hub.js;
// snapshots are interpolated, and the own player's walking is predicted locally so the
// thumb feels direct.

(() => {
  const HUB = window.PloinkBrawlHub;
  const CFG = HUB.CONFIG;
  const P = HUB.P;
  const E = HUB.E;

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  // The scale adapts to the screen: portrait shows ~6 units, landscape a wider strip.
  const UNITS_ACROSS = 6.2;       // at most this many world units fit the width…
  const UNITS_HIGH = 5.2;         // …and this many the height
  const FLOOR_BOTTOM = 0.94;      // floor ends at this fraction of the screen height
  const INTERP_DELAY_MS = 100;    // render others this far in the past for smooth motion
  const STICK_RADIUS = 55;        // px for full speed
  const DRAG_THRESHOLD = 14;      // px before a touch counts as walking
  const SWIPE_MAX_MS = 260;
  const SWIPE_MIN_PX = 45;
  const TAP_MAX_MS = 300;
  const INPUT_INTERVAL_MS = 50;
  const RECONNECT_DELAY_MS = 1200;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const canvas = $('arena');
  const ctx = canvas.getContext('2d');
  const area = $('arena-wrap');    // the whole arena is the touch surface
  const hint = $('gesture-hint');
  const stick = $('stick');
  const knob = stick.querySelector('.stick-knob');
  const lobby = $('lobby');
  const banner = $('banner');
  const koEl = $('ko');
  const offlineEl = $('offline');
  const toastsEl = $('toasts');

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

  let token = storage.get(sessionStorage, 'ploink-brawl-token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    storage.set(sessionStorage, 'ploink-brawl-token', token);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let socket = null;
  let reconnectTimer = null;
  let me = { id: null, name: storage.get(localStorage, 'ploink-name') || '', color: '#ffe156' };
  let state = null;
  const playerInfo = new Map();  // id -> {name, color}
  const snaps = [];              // [{at, players: Map, enemies: Map}]
  const pred = { x: CFG.arenaWidth / 2, z: CFG.depth / 2, ready: false };
  let camX = CFG.arenaWidth / 2;
  const input = { mx: 0, mz: 0 };
  let lastInputSent = 0;
  let inputDirty = false;
  const particles = [];
  const stateSince = new Map();  // entity key -> {code, at} for animations
  let bannerTimer = null;
  let hintTimer = null;

  let cssW = 1;
  let cssH = 1;
  let dpr = 1;

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function connect() {
    clearTimeout(reconnectTimer);
    // WebSocket to the Ploink server, or WebRTC to/as the hosting phone (see shared/net.js).
    const ws = PloinkNet.open({ mode: 'brawl', code: roomCode, wsPath: '/ws/brawl', hub: HUB });
    socket = ws;
    ws.addEventListener('open', () => {
      if (ws.role === 'host') toast('📡 Du bist Gastgeber – lass diese Seite offen und das Display an.');
      send({ type: 'join', code: roomCode, name: me.name, token });
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
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        me = { id: msg.you, name: msg.name, color: msg.color };
        if (msg.token) {
          token = msg.token;
          storage.set(sessionStorage, 'ploink-brawl-token', token);
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
      case 'snap':
        receiveSnapshot(msg);
        break;
      case 'event':
        handleEvent(msg);
        break;
      default:
        break;
    }
  }

  function applyState(msg) {
    const previous = state ? state.phase : null;
    state = msg;
    for (const p of msg.players) playerInfo.set(p.id, { name: p.name, color: p.color });
    $('hud-wave').textContent = Math.max(1, msg.wave);
    $('hud-kos').textContent = msg.kos;
    $('hud-count').textContent = msg.players.filter((p) => p.connected).length;

    const inLobby = msg.phase === 'lobby' || msg.phase === 'over';
    lobby.hidden = !inLobby;
    // The gesture hint stays for the first seconds of a game, then gets out of the way.
    if (inLobby) {
      clearTimeout(hintTimer);
      hint.classList.remove('faded');
    } else if (msg.phase === 'playing' && previous !== 'playing' && msg.wave <= 1) {
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => hint.classList.add('faded'), 8000);
    }
    renderCrew(msg.players);
    if (inLobby) {
      $('start').textContent = msg.phase === 'over' ? 'Nochmal!' : 'Schicht starten';
      $('results').hidden = msg.phase !== 'over';
      $('lobby-title').textContent = msg.phase === 'over' ? '💥 Der Trupp ist erledigt!' : 'Die Staubmonster sind los!';
      if (msg.phase === 'over') renderResults(msg);
      koEl.hidden = true;
    }
    if (msg.phase === 'countdown' && previous !== 'countdown') {
      pred.ready = false;
      countdownBanner(msg.phaseInMs);
    } else if (msg.phase !== 'countdown' && previous === 'countdown') {
      hideBanner();
    }
  }

  function handleEvent(msg) {
    if (msg.kind === 'join' && msg.id !== me.id) {
      toast(`${msg.name} ist im Einsatz`, msg.color);
    } else if (msg.kind === 'wave') {
      flashBanner(`Welle ${msg.wave}`, 'Staubmonster im Anmarsch!');
    } else if (msg.kind === 'cleared') {
      flashBanner('Welle geschafft!', 'Kurz durchatmen …');
    } else if (msg.kind === 'ko') {
      vibrate([120, 60, 120]);
    } else if (msg.kind === 'over') {
      vibrate([200, 100, 200]);
    }
  }

  function receiveSnapshot(msg) {
    const at = performance.now();
    const players = new Map(msg.players.map((p) => [p[0], {
      id: p[0], x: p[1], z: p[2], y: p[3], facing: p[4], state: p[5], hp: p[6], combo: p[7], respawnMs: p[8], invuln: p[9],
    }]));
    const enemies = new Map(msg.enemies.map((e) => [e[0], {
      id: e[0], x: e[1], z: e[2], y: e[3], facing: e[4], state: e[5], hp: e[6],
    }]));
    snaps.push({ at, players, enemies });
    while (snaps.length > 4) snaps.shift();

    for (const f of msg.fx) spawnHitFx(f[0], f[1], f[2], f[3]);

    const own = players.get(me.id);
    if (own) {
      reconcile(own);
      updateOwnHud(own);
    }
    updateTeam(players);
  }

  // ---------------------------------------------------------------------------
  // Prediction and interpolation
  // ---------------------------------------------------------------------------
  const MOVABLE = new Set([P.idle, P.walk, P.jump, P.kick]);

  function reconcile(own) {
    if (!pred.ready || !MOVABLE.has(own.state)) {
      pred.x = own.x;
      pred.z = own.z;
      pred.ready = true;
      return;
    }
    const ex = own.x - pred.x;
    const ez = own.z - pred.z;
    if (Math.abs(ex) > 1.5 || Math.abs(ez) > 1) {
      pred.x = own.x;
      pred.z = own.z;
    } else {
      // The server is a little behind while walking; pull gently so both agree at rest.
      pred.x += ex * 0.25;
      pred.z += ez * 0.25;
    }
  }

  function predict(dt) {
    const latest = snaps[snaps.length - 1];
    const own = latest && latest.players.get(me.id);
    if (!own || !pred.ready || !MOVABLE.has(own.state)) return;
    const factor = own.state === P.kick ? 0.6 : 1;
    pred.x += input.mx * CFG.playerSpeed * factor * dt;
    pred.z += input.mz * CFG.playerDepthSpeed * factor * dt;
    pred.x = Math.min(CFG.arenaWidth - 0.4, Math.max(0.4, pred.x));
    pred.z = Math.min(CFG.depth, Math.max(0, pred.z));
  }

  /** Entities as they were INTERP_DELAY_MS ago, blended between two snapshots. */
  function interpolated(now) {
    if (snaps.length === 0) return null;
    const renderAt = now - INTERP_DELAY_MS;
    let a = snaps[0];
    let b = snaps[snaps.length - 1];
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].at <= renderAt && snaps[i + 1].at >= renderAt) {
        a = snaps[i];
        b = snaps[i + 1];
        break;
      }
    }
    const span = b.at - a.at;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderAt - a.at) / span)) : 1;
    const blend = (from, to) => {
      const out = new Map();
      for (const [id, cur] of to) {
        const prev = from.get(id);
        if (!prev) {
          out.set(id, cur);
          continue;
        }
        out.set(id, {
          ...cur,
          x: prev.x + (cur.x - prev.x) * t,
          z: prev.z + (cur.z - prev.z) * t,
          y: prev.y + (cur.y - prev.y) * t,
        });
      }
      return out;
    };
    return { players: blend(a.players, b.players), enemies: blend(a.enemies, b.enemies) };
  }

  // ---------------------------------------------------------------------------
  // Thumb gestures on the whole arena
  // ---------------------------------------------------------------------------
  // Every finger is tracked on its own: the first one that starts dragging steers
  // (floating stick), any other finger can tap or swipe at the same time. With one
  // thumb that means: drag to walk, let go and tap to punch.
  const fingers = new Map(); // pointerId -> {x, y, t, dragging}
  let steeringId = null;

  area.addEventListener('pointerdown', (e) => {
    try { area.setPointerCapture(e.pointerId); } catch { /* keep going without capture */ }
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), dragging: false });
    e.preventDefault();
  });

  area.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    const dist = Math.hypot(dx, dy);
    if (!f.dragging && dist > DRAG_THRESHOLD && steeringId === null) {
      f.dragging = true;
      steeringId = e.pointerId;
      const rect = area.getBoundingClientRect();
      stick.style.left = `${f.x - rect.left}px`;
      stick.style.top = `${f.y - rect.top}px`;
      stick.hidden = false;
    }
    if (!f.dragging) return;
    const scale = Math.min(1, dist / STICK_RADIUS) / (dist || 1);
    setInput(dx * scale, dy * scale);
    const kx = Math.max(-STICK_RADIUS, Math.min(STICK_RADIUS, dx));
    const ky = Math.max(-STICK_RADIUS, Math.min(STICK_RADIUS, dy));
    knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
  });

  function endFinger(e) {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    fingers.delete(e.pointerId);
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    const dist = Math.hypot(dx, dy);
    const dur = performance.now() - f.t;
    if (dur < SWIPE_MAX_MS && dist > SWIPE_MIN_PX) {
      if (-dy > Math.abs(dx)) send({ type: 'jump' });
      else if (Math.abs(dx) >= Math.abs(dy)) send({ type: 'dash', dir: dx < 0 ? -1 : 1 });
      vibrate(12);
    } else if (!f.dragging && dur < TAP_MAX_MS && e.type === 'pointerup') {
      send({ type: 'punch' });
      vibrate(8);
    }
    if (steeringId === e.pointerId) {
      steeringId = null;
      setInput(0, 0);
      flushInput(true);
      stick.hidden = true;
      knob.style.transform = 'translate(-50%, -50%)';
    }
  }

  area.addEventListener('pointerup', endFinger);
  area.addEventListener('pointercancel', endFinger);
  area.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  area.addEventListener('contextmenu', (e) => e.preventDefault()); // long press on mobile

  function setInput(mx, mz) {
    const nx = Math.round(mx * 100) / 100;
    const nz = Math.round(mz * 100) / 100;
    if (nx !== input.mx || nz !== input.mz) {
      input.mx = nx;
      input.mz = nz;
      inputDirty = true;
    }
  }

  function flushInput(force = false) {
    const now = performance.now();
    if (!inputDirty || (!force && now - lastInputSent < INPUT_INTERVAL_MS)) return;
    send({ type: 'input', mx: input.mx, mz: input.mz });
    lastInputSent = now;
    inputDirty = false;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    // World scale: fits the width in portrait and the height in landscape.
    U = Math.min(cssW / UNITS_ACROSS, cssH / UNITS_HIGH);
    // Floor depth: fill about half the screen, but keep the perspective believable.
    ZS = Math.min(U * 1.6, Math.max(U * 0.8, (cssH * 0.5) / CFG.depth));
    floorTop = cssH * FLOOR_BOTTOM - CFG.depth * ZS;
    viewWidth = cssW / U;
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  let U = 50;            // px per world unit
  let ZS = 60;           // px per unit of floor depth
  let floorTop = 200;    // px where the floor meets the wall
  let viewWidth = 7;     // world units visible across the screen
  const unit = () => U;
  const floorTopPx = () => floorTop;
  const zScale = () => ZS;
  const toScreen = (x, z, y = 0) => ({
    x: (x - camX) * U + cssW / 2,
    gy: floorTop + z * ZS,
    y: floorTop + z * ZS - y * U,
  });

  function drawCorridor() {
    const u = unit();
    const floorTop = floorTopPx();
    // Wall
    const wall = ctx.createLinearGradient(0, 0, 0, floorTop);
    wall.addColorStop(0, '#14162b');
    wall.addColorStop(1, '#262a4f');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, cssW, floorTop);

    const left = camX - viewWidth / 2 - 1;
    const right = camX + viewWidth / 2 + 1;
    const lockerTop = floorTop - u * 1.55;

    // Ceiling lamps with a soft light cone (fills the tall wall in portrait)
    for (let lx = Math.floor(left / 3) * 3 + 1.5; lx < right; lx += 3) {
      const sx = (lx - camX) * u + cssW / 2;
      const cone = ctx.createLinearGradient(0, 0, 0, floorTop);
      cone.addColorStop(0, 'rgba(255, 240, 200, 0.10)');
      cone.addColorStop(1, 'rgba(255, 240, 200, 0)');
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(sx - u * 0.3, 0);
      ctx.lineTo(sx + u * 0.3, 0);
      ctx.lineTo(sx + u * 1.3, floorTop);
      ctx.lineTo(sx - u * 1.3, floorTop);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#c9c3a8';
      ctx.fillRect(sx - u * 0.35, 0, u * 0.7, Math.max(4, u * 0.08));
    }

    // Windows with moonlight, high on the wall
    for (let wx = Math.floor(left / 5) * 5 + 2; wx < right; wx += 5) {
      const sx = (wx - camX) * u + cssW / 2;
      const w = 1.6 * u;
      const h = u * 1.25;
      const top = Math.max(8, lockerTop - h - u * 0.45);
      ctx.fillStyle = '#0c1530';
      ctx.fillRect(sx - w / 2, top, w, h);
      ctx.fillStyle = 'rgba(180, 200, 255, 0.18)';
      ctx.fillRect(sx - w / 2 + 3, top + 3, w - 6, h - 6);
      ctx.strokeStyle = '#3b416e';
      ctx.lineWidth = 3;
      ctx.strokeRect(sx - w / 2, top, w, h);
      ctx.beginPath();
      ctx.moveTo(sx, top);
      ctx.lineTo(sx, top + h);
      ctx.stroke();
      if (Math.round(wx / 5) % 3 === 0) {
        ctx.fillStyle = 'rgba(255, 250, 220, 0.85)';
        ctx.beginPath();
        ctx.arc(sx - w * 0.2, top + h * 0.35, h * 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Lockers along the wall
    for (let lx = Math.floor(left / 1.1) * 1.1; lx < right; lx += 1.1) {
      const sx = (lx - camX) * u + cssW / 2;
      const w = 1.0 * u;
      const i = Math.round(lx / 1.1);
      ctx.fillStyle = i % 2 ? '#2c5d7c' : '#2a5572';
      ctx.fillRect(sx, lockerTop, w, floorTop - lockerTop);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      for (let v = 0; v < 3; v++) ctx.fillRect(sx + w * 0.2, lockerTop + 8 + v * 6, w * 0.6, 2);
      ctx.fillStyle = '#c9d3ff';
      ctx.fillRect(sx + w * 0.78, lockerTop + (floorTop - lockerTop) * 0.5, 3, 10);
    }

    // Floor tiles
    ctx.fillStyle = '#3a3552';
    ctx.fillRect(0, floorTop, cssW, cssH - floorTop);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let tx = Math.floor(left); tx < right; tx++) {
      const sx = (tx - camX) * u + cssW / 2;
      ctx.beginPath();
      ctx.moveTo(sx, floorTop);
      ctx.lineTo(sx, cssH);
      ctx.stroke();
    }
    for (let z = 0; z <= CFG.depth; z += 0.8) {
      const sy = floorTop + z * zScale();
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(cssW, sy);
      ctx.stroke();
    }

    // Ends of the corridor
    for (const edge of [0, CFG.arenaWidth]) {
      const sx = (edge - camX) * u + cssW / 2;
      if (sx < -20 || sx > cssW + 20) continue;
      ctx.fillStyle = '#0a0b16';
      if (edge === 0) ctx.fillRect(0, 0, Math.max(0, sx), cssH);
      else ctx.fillRect(sx, 0, cssW - sx, cssH);
    }

    // Night vignette
    const vignette = ctx.createRadialGradient(cssW / 2, cssH * 0.6, cssH * 0.2, cssW / 2, cssH * 0.6, cssH);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  function since(key, code, now) {
    const entry = stateSince.get(key);
    if (!entry || entry.code !== code) {
      stateSince.set(key, { code, at: now });
      return 0;
    }
    return now - entry.at;
  }

  function drawShadow(sx, gy, w) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    ctx.ellipse(sx, gy, w, w * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * amount)));
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  const BROOM_HANDLE = 0.85; // grip to bristles, in world units
  const BROOM_BRUSH = 0.3;
  const BROOM_REACH = BROOM_HANDLE + BROOM_BRUSH;

  /**
   * Broom pose in the janitor's local frame (x = forward, y = down, feet at 0):
   * grip = front hand, angle = broom direction measured from straight down towards
   * the front. A tap sweeps the bristles along the floor from behind the feet to the
   * front; the dash pushes the broom ahead.
   */
  function broomPose(p, elapsed, walk, t) {
    const hitAt = CFG.punchHitAtMs;
    switch (p.state) {
      case P.punch: {
        const k = Math.min(1, elapsed / (hitAt + 60));
        const e = 1 - (1 - k) * (1 - k);                          // fast stroke, soft stop
        const back = Math.min(1, Math.max(0, (elapsed - hitAt - 80) / 120));
        const angle = -0.75 + 1.95 * e - 0.55 * back;              // behind the feet → in front
        const gripY = Math.min(-0.75, 0.02 - Math.cos(angle) * BROOM_REACH); // bristles stay on the floor
        return { angle, grip: { x: -0.05 + 0.35 * e - 0.15 * back, y: gripY } };
      }
      case P.dash:
        return { angle: 1.25 + 0.35 * Math.sin(elapsed / 45), grip: { x: 0.32, y: -0.8 } };
      case P.kick:
        return { angle: 1.57, grip: { x: 0.38, y: -1.15 } };
      case P.jump:
        return { angle: 2.3, grip: { x: 0.12, y: -1.4 } };
      case P.hurt:
        return { angle: -0.5, grip: { x: -0.02, y: -1.25 } };
      case P.down:
        return { angle: 0.35, grip: { x: 0.2, y: -0.95 } };
      default:
        return { angle: 0.5 + walk * 0.12 + Math.sin(t * 2) * 0.03, grip: { x: 0.22, y: -0.98 } };
    }
  }

  function drawBroom(grip, angle) {
    ctx.save();
    ctx.translate(grip.x, grip.y);
    ctx.rotate(-angle); // local +y now points along the broom
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#a0703c';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.moveTo(0, -0.22);
    ctx.lineTo(0, BROOM_HANDLE);
    ctx.stroke();
    ctx.fillStyle = '#d6455d';
    ctx.fillRect(-0.08, BROOM_HANDLE - 0.02, 0.16, 0.06);
    ctx.fillStyle = '#e2bf6e';
    ctx.beginPath();
    ctx.moveTo(-0.08, BROOM_HANDLE + 0.03);
    ctx.lineTo(0.08, BROOM_HANDLE + 0.03);
    ctx.lineTo(0.2, BROOM_HANDLE + BROOM_BRUSH);
    ctx.lineTo(-0.2, BROOM_HANDLE + BROOM_BRUSH);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#b8913f';
    ctx.lineWidth = 0.015;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 0.03, BROOM_HANDLE + 0.05);
      ctx.lineTo(i * 0.09, BROOM_HANDLE + BROOM_BRUSH - 0.01);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Cosmetic dust kicked up by the bristles: while sweeping and during the dash. */
  function broomDust(p, now) {
    const entry = stateSince.get(`p${p.id}`);
    if (!entry) return;
    const elapsed = now - entry.at;
    if (p.state === P.dash && Math.random() < 0.7) {
      spawnDust(p.x + p.facing * 1.05, p.z, 0.05, 1, p.facing);
    } else if (p.state === P.punch && elapsed < CFG.punchHitAtMs + 70 && Math.random() < 0.8) {
      const pose = broomPose(p, elapsed, 0, 0);
      const tip = pose.grip.x + Math.sin(pose.angle) * BROOM_REACH;
      spawnDust(p.x + p.facing * tip, p.z, 0.05, p.combo === 2 ? 3 : 2, p.facing);
    }
  }

  function spawnDust(x, z, y, count, dir = 0) {
    const colors = ['#b9ae9a', '#8f877a', '#d8cfbd'];
    for (let i = 0; i < count; i++) {
      particles.push({
        x, z, y,
        vx: dir ? dir * (0.6 + Math.random() * 2) : (Math.random() - 0.5) * 2.2,
        vy: 0.3 + Math.random() * 1.2,
        life: 1,
        decay: 1.4,
        color: colors[i % colors.length],
        size: 0.14,
      });
    }
  }

  function drawJanitor(p, s, color, now, isMe, tagLift = 0) {
    const u = unit();
    const t = now / 1000;
    const elapsed = since(`p${p.id}`, p.state, now);
    drawShadow(s.x, s.gy, u * 0.32);
    broomDust(p, now);
    if (p.invuln && Math.floor(now / 90) % 2) return;

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.scale(p.facing * u, u); // 1 = one world unit, x mirrored to the facing direction

    if (p.state === P.down) {
      ctx.rotate(-Math.PI / 2);
      ctx.translate(0.15, -0.1);
    } else if (p.state === P.hurt) {
      ctx.rotate(-0.25);
    } else if (p.state === P.dash) {
      ctx.rotate(0.3);
    }

    const walk = p.state === P.walk ? Math.sin(t * 12) : 0;
    const skin = '#f2c9a0';
    const dark = shade(color, 0.6);
    ctx.lineCap = 'round';

    // Legs
    ctx.strokeStyle = '#2b2f4a';
    ctx.lineWidth = 0.13;
    const hipY = -0.72;
    const legs = [
      { a: walk * 0.5, back: true },
      { a: -walk * 0.5, back: false },
    ];
    if (p.state === P.jump) { legs[0].a = -0.6; legs[1].a = 0.5; }
    if (p.state === P.kick || p.state === P.dash) { legs[1].a = -1.35; legs[0].a = 0.3; }
    for (const leg of legs) {
      ctx.beginPath();
      ctx.moveTo(leg.back ? -0.08 : 0.08, hipY);
      ctx.lineTo((leg.back ? -0.08 : 0.08) - Math.sin(leg.a) * 0.72, hipY + Math.cos(leg.a) * 0.72);
      ctx.stroke();
    }

    // The broom: where the front hand grips it and which way it points.
    const pose = broomPose(p, elapsed, walk, t);
    const dir = { x: Math.sin(pose.angle), y: Math.cos(pose.angle) };
    const otherHand = { x: pose.grip.x + dir.x * 0.22, y: pose.grip.y + dir.y * 0.22 };

    // Back arm reaches for the broom, too
    ctx.strokeStyle = skin;
    ctx.lineWidth = 0.11;
    ctx.beginPath();
    ctx.moveTo(-0.1, -1.18);
    ctx.lineTo(otherHand.x, otherHand.y);
    ctx.stroke();

    // Body: overalls in the player colour
    ctx.fillStyle = color;
    roundRect(-0.25, -1.32, 0.5, 0.66, 0.12);
    ctx.fill();
    ctx.fillStyle = dark;
    ctx.fillRect(-0.2, -1.32, 0.07, 0.3);
    ctx.fillRect(0.13, -1.32, 0.07, 0.3);
    ctx.fillRect(-0.14, -1.0, 0.28, 0.18);

    drawBroom(pose.grip, pose.angle);

    // Front arm and both hands on the handle
    ctx.strokeStyle = skin;
    ctx.lineWidth = 0.11;
    ctx.beginPath();
    ctx.moveTo(0.08, -1.18);
    ctx.lineTo(pose.grip.x, pose.grip.y);
    ctx.stroke();
    ctx.fillStyle = skin;
    for (const hand of [pose.grip, otherHand]) {
      ctx.beginPath();
      ctx.arc(hand.x, hand.y, 0.075, 0, Math.PI * 2);
      ctx.fill();
    }

    // Head with cap
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(0, -1.52, 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1b1d2e';
    ctx.beginPath();
    ctx.arc(0.08, -1.54, 0.025, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(0, -1.6, 0.19, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(0, -1.62, 0.3, 0.05);

    ctx.restore();

    // Name tag (unmirrored)
    if (p.state !== P.down) {
      ctx.font = `700 ${Math.round(u * 0.24)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = isMe ? '#fff' : color;
      ctx.globalAlpha = 0.85;
      ctx.fillText(isMe ? '▼ du' : (playerInfo.get(p.id) || {}).name || '', s.x, s.y - u * (1.95 + tagLift));
      ctx.globalAlpha = 1;
    }
  }

  function drawMonster(e, s, now) {
    const u = unit();
    const t = now / 1000;
    const elapsed = since(`e${e.id}`, e.state, now);
    let alpha = 1;
    if (e.state === E.dead) alpha = Math.max(0, 1 - elapsed / 600);
    // Monsters from the back crawl out of the lockers: fade in until they reach the floor.
    if (e.z < 0) alpha = Math.max(0.15, 1 + e.z / 0.9);
    ctx.globalAlpha = alpha;
    if (e.z >= 0) drawShadow(s.x, s.gy, u * 0.38);

    ctx.save();
    ctx.translate(s.x, s.y - u * 0.42);
    ctx.scale(e.facing, 1);
    let r = u * 0.42;
    let body = '#8b90a3';
    if (e.state === E.windup) {
      const pulse = 1 + 0.12 * Math.sin(elapsed / 40);
      r *= pulse;
      body = Math.floor(now / 80) % 2 ? '#d9576b' : '#a3687a';
    } else if (e.state === E.attack) {
      ctx.scale(1.3, 0.85);
    } else if (e.state === E.hurt) {
      ctx.scale(0.85, 1.1);
      body = '#e8e8f0';
    } else if (e.state === E.knocked || e.state === E.dead) {
      ctx.rotate(Math.PI / 2);
    }
    const bob = e.state === E.walk ? Math.sin(t * 10 + e.id) * u * 0.04 : 0;

    // Fuzzy dust body
    ctx.fillStyle = body;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const jitter = 0.85 + 0.15 * Math.sin(t * 6 + i * 2.3 + e.id);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.78, Math.sin(a) * r * 0.78 + bob, r * 0.32 * jitter, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, bob, r * 0.82, 0, Math.PI * 2);
    ctx.fill();

    // Eyes
    const angry = e.state === E.windup || e.state === E.attack;
    for (const ex of [0.12, 0.42]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex * r, -0.15 * r + bob, r * 0.17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = angry ? '#c0142e' : '#1b1d2e';
      ctx.beginPath();
      ctx.arc(ex * r + r * 0.05, -0.13 * r + bob, r * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
    if (angry) {
      ctx.strokeStyle = '#1b1d2e';
      ctx.lineWidth = r * 0.07;
      ctx.beginPath();
      ctx.moveTo(0.0, -0.38 * r);
      ctx.lineTo(0.55 * r, -0.26 * r);
      ctx.stroke();
    }
    ctx.restore();

    // Health bar once damaged
    if (e.hp < 100 && e.state !== E.dead) {
      const w = u * 0.7;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(s.x - w / 2, s.y - u * 1.05, w, 5);
      ctx.fillStyle = '#7ee081';
      ctx.fillRect(s.x - w / 2, s.y - u * 1.05, (w * e.hp) / 100, 5);
    }
    ctx.globalAlpha = 1;
  }

  function spawnHitFx(x, z, y, kind) {
    const colors = kind === 3 ? ['#ff5d73', '#ffb84d'] : kind === 2 ? ['#ffe156', '#ffffff', '#ffb84d'] : ['#ffffff', '#ffe156'];
    const count = kind === 2 ? 16 : 9;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 2.5;
      particles.push({ x, z, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color: colors[i % colors.length] });
    }
    if (kind === 3) vibrate(30);
  }

  function drawParticles(dt) {
    const u = unit();
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt * (p.decay || 2.6);
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt * 0.5;
      p.y += p.vy * dt * 0.5;
      const s = toScreen(p.x, p.z, p.y);
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      const size = u * (p.size || 0.09) * p.life + 2;
      ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw(now, dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const world = interpolated(now);
    const own = world && world.players.get(me.id);

    // Camera follows the own (predicted) player, or a teammate while knocked out.
    let focus = pred.ready ? pred.x : CFG.arenaWidth / 2;
    if (own && own.state === P.down && world) {
      const mate = [...world.players.values()].find((p) => p.id !== me.id && p.state !== P.down);
      if (mate) focus = mate.x;
    }
    const half = viewWidth / 2;
    const targetCam = Math.min(CFG.arenaWidth - half + 0.5, Math.max(half - 0.5, focus));
    camX += (targetCam - camX) * Math.min(1, dt * 8);

    drawCorridor();
    if (!world) return;

    const items = [];
    const ownX = own ? (pred.ready ? pred.x : own.x) : null;
    for (const p of world.players.values()) {
      const isMe = p.id === me.id;
      const pos = isMe && pred.ready && MOVABLE.has(p.state) ? { ...p, x: pred.x, z: pred.z } : p;
      // Lift a teammate's name tag when it would overlap the own "▼ du".
      const lift = !isMe && ownX !== null && Math.abs(pos.x - ownX) < 0.9 ? 0.32 : 0;
      // Slight bias: a janitor stays in front of a monster standing at the same depth.
      items.push({ z: pos.z + 0.05, draw: () => drawJanitor(pos, toScreen(pos.x, pos.z, pos.y), (playerInfo.get(p.id) || {}).color || '#ccc', now, isMe, lift) });
    }
    for (const e of world.enemies.values()) {
      items.push({ z: e.z, draw: () => drawMonster(e, toScreen(e.x, e.z, e.y), now) });
    }
    items.sort((a, b) => a.z - b.z);
    for (const item of items) item.draw();
    drawParticles(dt);

    // Off-screen markers for monsters, so nobody gets surprised from the side.
    for (const e of world.enemies.values()) {
      if (e.state === E.dead) continue;
      const s = toScreen(e.x, e.z, 0);
      if (s.x >= 0 && s.x <= cssW) continue;
      const left = s.x < 0;
      ctx.fillStyle = e.state === E.windup ? '#ff5d73' : 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      const mx = left ? 8 : cssW - 8;
      const my = Math.min(cssH - 12, Math.max(12, s.gy - unit() * 0.4));
      ctx.moveTo(mx + (left ? -4 : 4), my);
      ctx.lineTo(mx + (left ? 8 : -8), my - 8);
      ctx.lineTo(mx + (left ? 8 : -8), my + 8);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  function updateOwnHud(own) {
    $('hp-fill').style.width = `${Math.max(0, own.hp)}%`;
    $('hp-text').textContent = own.state === P.down ? 'K.O.' : own.hp;
    $('hp-fill').classList.toggle('low', own.hp <= 30);
    if (own.state === P.down && state && state.phase !== 'over') {
      koEl.hidden = false;
      koEl.textContent = `K.O.! Zurück in ${Math.ceil(own.respawnMs / 1000)} …`;
    } else {
      koEl.hidden = true;
    }
  }

  function updateTeam(players) {
    const others = [...players.values()].filter((p) => p.id !== me.id);
    $('team').replaceChildren(...others.map((p) => {
      const info = playerInfo.get(p.id) || { name: '?', color: '#ccc' };
      const chip = document.createElement('span');
      chip.className = 'team-chip';
      chip.style.setProperty('--chip-color', info.color);
      const name = document.createElement('b');
      name.textContent = info.name;
      const bar = document.createElement('i');
      bar.style.width = `${Math.max(0, p.hp)}%`;
      chip.append(name, bar);
      if (p.state === P.down) chip.classList.add('down');
      return chip;
    }));
  }

  function renderCrew(players) {
    $('crew').replaceChildren(...players.map((p, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--seat-color', p.color);
      if (p.id === me.id) li.classList.add('me');
      if (!p.connected) li.classList.add('offline');
      const num = document.createElement('b');
      num.textContent = i + 1;
      const name = document.createElement('span');
      name.textContent = p.id === me.id ? `${p.name} (du)` : p.name;
      li.append(num, name);
      return li;
    }));
  }

  function renderResults(msg) {
    $('results-text').textContent = `Welle ${msg.wave} erreicht · ${msg.kos} Staubmonster erledigt`;
    const sorted = [...msg.players].sort((a, b) => b.kos - a.kos);
    $('results-list').replaceChildren(...sorted.map((p, i) => {
      const li = document.createElement('li');
      if (p.id === me.id) li.classList.add('me');
      const medal = document.createElement('span');
      medal.textContent = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      const name = document.createElement('span');
      name.textContent = p.name;
      name.style.color = p.color;
      const score = document.createElement('strong');
      score.textContent = `${p.kos} 💥`;
      li.append(medal, name, score);
      return li;
    }));
  }

  function renderBanner(title, subtitle) {
    banner.hidden = false;
    banner.replaceChildren();
    const t = document.createElement('div');
    t.textContent = title;
    banner.append(t);
    if (subtitle) {
      const s = document.createElement('small');
      s.textContent = subtitle;
      banner.append(s);
    }
  }

  function flashBanner(title, subtitle) {
    clearInterval(bannerTimer);
    clearTimeout(bannerTimer);
    renderBanner(title, subtitle);
    bannerTimer = setTimeout(() => { banner.hidden = true; }, 1600);
  }

  function countdownBanner(ms) {
    clearInterval(bannerTimer);
    clearTimeout(bannerTimer);
    const end = performance.now() + ms;
    const tick = () => renderBanner(String(Math.max(1, Math.ceil((end - performance.now()) / 1000))), 'Besen bereit?');
    tick();
    bannerTimer = setInterval(tick, 200);
  }

  function hideBanner() {
    clearInterval(bannerTimer);
    clearTimeout(bannerTimer);
    banner.hidden = true;
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

  function vibrate(pattern) {
    // Browsers refuse vibration before the first tap and log an error for every attempt.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
  }

  $('hud-code').textContent = roomCode;
  $('lobby-code').textContent = roomCode;
  $('start').addEventListener('click', () => send({ type: 'start' }));

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  resize();
  connect();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    flushInput();
    predict(dt);
    draw(now, dt);
    if (window.__brawl && window.__brawl.onFrame) window.__brawl.onFrame(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Expose a tiny hook for automated tests.
  window.__brawl = {
    get state() { return state; },
    get latest() { return snaps[snaps.length - 1]; },
    get me() { return me; },
    pred,
    send,
    stateSince,
    toScreen,
    onFrame: null, // tests can capture frames at exact animation moments
  };
})();
