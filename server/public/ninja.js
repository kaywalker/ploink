'use strict';

// Ploink Katana-Küche client.
// One shared dojo on every phone. The own ninja is simulated here (swipes jump at once,
// no round trip); its position goes to the hub ~15 times per second and the other
// ninjas are drawn slightly in the past from those reports. Fruit paths come from the
// hub clock (PloinkNinjaHub.fruitPosition), cuts are claimed here and confirmed by the hub.

(() => {
  const HUB = window.PloinkNinjaHub;
  const CFG = HUB.CONFIG;
  const W = CFG.width;
  const H = CFG.height;
  const FOOT = 0.5;                 // centre of a standing ninja above the floor

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  const SWIPE_PX = 24;              // finger travel that fires a jump
  const REARM_MS = 170;             // the same finger can jump again after this
  const TAP_PX = 12;
  const TAP_MAX_MS = 300;
  const POS_INTERVAL_MS = 66;
  const INTERP_DELAY_MS = 110;
  const HIT_REACH = CFG.bladeReach * 0.95;
  const RECONNECT_DELAY_MS = 1200;
  const STEP = 1 / 120;
  const TUMBLE_MS = 450;            // a kicked ninja cannot cut or kick back for this long
  const NINJA_SCALE = 1.2;         // drawn a bit larger than its hit box for small screens

  const FLESH = {
    apple: '#fff3cf', orange: '#ffb347', tomato: '#ff6b4a', carrot: '#ff9f3a', eggplant: '#f1ead0',
    banana: '#fff1a6', pineapple: '#ffe066', watermelon: '#ff4d6d', golden: '#fff6b8', nest: '#c99a63',
  };
  const SKIN = {
    apple: '#e5383b', orange: '#ff9f1c', tomato: '#ff4d3d', carrot: '#ff8c1a', eggplant: '#6a3d9a',
    banana: '#ffd93d', pineapple: '#e8a33d', watermelon: '#2d8a3e', golden: '#ffd23f', nest: '#a67c52',
  };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const canvas = $('arena');
  const ctx = canvas.getContext('2d');
  const area = $('arena-wrap');
  const hint = $('gesture-hint');
  const lobby = $('lobby');
  const countdownEl = $('countdown');
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

  let token = storage.get(sessionStorage, 'ploink-ninja-token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    storage.set(sessionStorage, 'ploink-ninja-token', token);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let socket = null;
  let reconnectTimer = null;
  let hintTimer = null;
  let me = { id: null, name: storage.get(localStorage, 'ploink-name') || '', color: '#ffe156' };
  let state = null;                 // last 'state' message
  let startX = W / 2;
  const playerInfo = new Map();     // id -> {name, color}
  const others = new Map();         // id -> [{t, x, y, rot, air, stun, facing}]
  const fruits = new Map();         // id -> fruit (path parameters from the hub)
  const halves = [];
  const particles = [];
  const splats = [];
  const popups = [];
  const bumpCooldown = new Map();   // id -> time when the own katana may knock them again

  const ninja = {
    x: W / 2, y: FOOT, vx: 0, vy: 0, air: false, rot: 0, spinDir: 1, facing: 1,
    onPlatform: null, slashUntil: 0, stunnedUntil: 0, tumbleUntil: 0,
  };

  // Shared clock: serverNow() ≈ Date.now() on the hub.
  let clockOffset = 0;
  let bestRtt = Infinity;
  const serverNow = () => performance.now() + clockOffset;

  let cssW = 1;
  let cssH = 1;
  let dpr = 1;
  let S = 30;                        // px per world unit
  let ox = 0;                        // px of x = 0
  let gy = 0;                        // px of the floor (y = 0)
  const sx = (x) => ox + x * S;
  const sy = (y) => gy - y * S;

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function connect() {
    clearTimeout(reconnectTimer);
    // WebSocket to the Ploink server, or WebRTC to/as the hosting phone (see shared/net.js).
    const ws = PloinkNet.open({ mode: 'ninja', code: roomCode, wsPath: '/ws/ninja', hub: HUB });
    socket = ws;
    bestRtt = Infinity;
    ws.addEventListener('open', () => {
      if (ws.role === 'host') toast('📡 Du bist Gastgeber – lass diese Seite offen und das Display an.');
      send({ type: 'join', code: roomCode, name: me.name, token });
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
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
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
        if (rtt < bestRtt * 1.2) {
          bestRtt = Math.min(bestRtt, rtt);
          clockOffset = msg.server + rtt / 2 - now;
        }
        break;
      }
      case 'joined':
        if (me.id === null) placeAtStart(msg.startX);
        me = { id: msg.you, name: msg.name, color: msg.color };
        startX = msg.startX;
        if (bestRtt === Infinity) clockOffset = msg.serverNow - performance.now();
        if (msg.token) {
          token = msg.token;
          storage.set(sessionStorage, 'ploink-ninja-token', token);
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
        fruits.set(msg.fruit.id, msg.fruit);
        break;
      case 'fruits':
        fruits.clear();
        for (const f of msg.list) fruits.set(f.id, f);
        break;
      case 'cut':
        handleCut(msg);
        break;
      case 'ninjas':
        receiveNinjas(msg.list);
        break;
      case 'kick':
        sparks(msg.x, msg.y, '#ffffff', 10);
        if (msg.target.id === me.id) {
          knock(msg.vx, msg.vy, true);
          shout(`💨 ${msg.by.name}${msg.points ? ` −${msg.points}` : ''}`, msg.by.color);
          vibrate([40, 30, 40]);
        } else if (msg.by.id === me.id) {
          popups.push({ x: msg.x, y: msg.y + 1.7, life: 1.1, text: `Kick!${msg.points ? ` +${msg.points}` : ''}`, color: me.color });
          vibrate(20);
        }
        break;
      case 'clash': {
        sparks(msg.x, msg.y, '#ffe156', 18);
        sparks(msg.x, msg.y, '#ffffff', 8);
        popups.push({ x: msg.x, y: msg.y + 1.7, life: 1, text: 'Klirr!', color: '#ffe156' });
        const push = msg.push[me.id];
        if (push) {
          knock(push[0], push[1], false);
          vibrate([15, 20, 15]);
        }
        break;
      }
      case 'stunned':
        ninja.stunnedUntil = performance.now() + msg.ms;
        shout('🐝 Autsch!', '#ffb84d');
        vibrate([120, 60, 120]);
        break;
      case 'roundEnd':
        if (msg.results.length > 0) {
          const winner = msg.results[0];
          toast(winner.id === me.id ? '🏆 Du hast gewonnen!' : `🏆 ${winner.name} gewinnt mit ${winner.score} Punkten`, winner.color);
          vibrate([80, 60, 80]);
        }
        break;
      case 'event':
        // Mid-round the score chips show newcomers; a message would only get in the way.
        if (msg.kind === 'join' && msg.id !== me.id && (!state || state.phase !== 'playing')) toast(`${msg.name} ist im Dojo`, msg.color);
        break;
      default:
        break;
    }
  }

  function applyState(msg) {
    const previous = state ? state.phase : null;
    state = msg;
    for (const p of msg.players) playerInfo.set(p.id, { name: p.name, color: p.color });
    const self = msg.players.find((p) => p.id === me.id);
    if (self) me.color = self.color;
    $('hud-count').textContent = msg.players.filter((p) => p.connected).length;
    $('hud-score').textContent = self ? self.score : 0;
    $('hud-timer').hidden = msg.phase !== 'playing';
    lobby.hidden = msg.phase !== 'lobby';
    countdownEl.hidden = msg.phase !== 'countdown';
    if (msg.phase !== 'playing') fruits.clear();
    if (msg.phase === 'countdown' && previous !== 'countdown') placeAtStart(startX);

    if (msg.phase === 'lobby') {
      clearTimeout(hintTimer);
      hint.classList.remove('faded');
    } else if (msg.phase === 'playing' && previous !== 'playing') {
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => hint.classList.add('faded'), 8000);
    }

    renderTeam(msg.players);
    renderCrew(msg.players);
    renderResults(msg.lastResults);
    $('start').textContent = msg.lastResults ? 'Nochmal!' : 'Runde starten';
    $('lobby-title').textContent = msg.lastResults ? '🍉 Runde vorbei!' : 'Schneidet, was vom Himmel fällt!';
  }

  function placeAtStart(x) {
    Object.assign(ninja, {
      x: Number.isFinite(x) ? x : W / 2, y: FOOT, vx: 0, vy: 0, air: false,
      rot: 0, onPlatform: null, slashUntil: 0, stunnedUntil: 0, tumbleUntil: 0,
    });
  }

  function receiveNinjas(list) {
    const t = performance.now();
    const seen = new Set();
    for (const [id, x, y, rot, air, stun, facing] of list) {
      if (id === me.id) continue;
      seen.add(id);
      let buf = others.get(id);
      if (!buf) others.set(id, (buf = []));
      buf.push({ t, x, y, rot, air, stun, facing });
      if (buf.length > 12) buf.shift();
    }
    for (const id of others.keys()) if (!seen.has(id)) others.delete(id);
  }

  /** Other ninjas, drawn slightly in the past for smooth motion. */
  function otherNinjas(now) {
    const at = now - INTERP_DELAY_MS;
    const out = [];
    for (const [id, buf] of others) {
      let a = buf[0];
      let b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= at && buf[i + 1].t >= at) {
          a = buf[i];
          b = buf[i + 1];
          break;
        }
      }
      const k = b.t > a.t ? Math.min(1, Math.max(0, (at - a.t) / (b.t - a.t))) : 1;
      const lerp = (p, q) => p + (q - p) * k;
      // Landing resets the roll to 0: do not spin backwards through the whole turn.
      const rot = Math.abs(b.rot - a.rot) > Math.PI * 1.5 ? b.rot : lerp(a.rot, b.rot);
      out.push({ id, x: lerp(a.x, b.x), y: lerp(a.y, b.y), rot, air: b.air, stun: b.stun, facing: b.facing });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Own ninja
  // ---------------------------------------------------------------------------
  function jump(dx, dy) {
    const now = performance.now();
    if (now < ninja.stunnedUntil) return;
    let len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    if (!ninja.air && dy < -0.5) { // swipe down on the ground: spin the katana instead
      slash();
      return;
    }
    if (!ninja.air) dy = Math.max(dy, 0.35); // a sideways hop from the ground still lifts off
    len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    // Air jumps are unlimited; a little puff under the feet shows each one.
    puff(ninja.x, ninja.y - FOOT);
    ninja.vx = dx * CFG.jumpSpeed;
    ninja.vy = dy * CFG.jumpSpeed;
    ninja.air = true;
    ninja.onPlatform = null;
    ninja.tumbleUntil = 0; // jumping is how a kicked ninja catches himself
    if (Math.abs(dx) > 0.15) ninja.facing = dx > 0 ? 1 : -1;
    ninja.spinDir = ninja.facing;
    vibrate(8);
  }

  /** Thrown through the air by another katana. A kicked ninja tumbles with the sword away. */
  function knock(vx, vy, tumble) {
    ninja.air = true;
    ninja.onPlatform = null;
    ninja.vx = vx;
    ninja.vy = vy;
    ninja.spinDir = vx >= 0 ? 1 : -1;
    if (tumble) ninja.tumbleUntil = performance.now() + TUMBLE_MS;
  }

  function slash() {
    const now = performance.now();
    if (ninja.air || now < ninja.stunnedUntil || now < ninja.slashUntil) return;
    ninja.slashUntil = now + CFG.slashMs;
    ninja.spinDir = ninja.facing;
    vibrate(6);
  }

  function land(height, platform) {
    ninja.y = height + FOOT;
    ninja.vx = 0;
    ninja.vy = 0;
    ninja.air = false;
    ninja.onPlatform = platform;
    ninja.rot = 0;
    puff(ninja.x, height);
  }

  function step(dt, now) {
    const n = ninja;
    if (n.air) {
      const prevBottom = n.y - FOOT;
      n.vy = Math.max(-CFG.maxFallSpeed, n.vy - CFG.gravity * dt);
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.rot += n.spinDir * CFG.spinSpeed * dt;
      if (n.x < CFG.ninjaRadius) {
        n.x = CFG.ninjaRadius;
        n.vx = Math.abs(n.vx) * 0.4;
      } else if (n.x > W - CFG.ninjaRadius) {
        n.x = W - CFG.ninjaRadius;
        n.vx = -Math.abs(n.vx) * 0.4;
      }
      if (n.y > H + 1.5) {
        n.y = H + 1.5;
        n.vy = Math.min(n.vy, 0);
      }
      const bottom = n.y - FOOT;
      if (n.vy <= 0) {
        for (const p of HUB.PLATFORMS) {
          if (prevBottom >= p[2] - 0.02 && bottom <= p[2] && n.x >= p[0] - 0.1 && n.x <= p[1] + 0.1) {
            land(p[2], p);
            return;
          }
        }
      }
      if (bottom <= 0) land(0, null);
      return;
    }
    // Standing: walking off the end of a platform means falling.
    if (n.onPlatform && (n.x < n.onPlatform[0] - 0.1 || n.x > n.onPlatform[1] + 0.1)) {
      n.air = true;
      n.onPlatform = null;
    }
    if (now < n.slashUntil) {
      const k = 1 - (n.slashUntil - now) / CFG.slashMs;
      n.rot = n.spinDir * Math.PI * 2 * k;
    } else {
      n.rot = 0;
    }
  }

  const bladeActive = (now) => (ninja.air || now < ninja.slashUntil) && now >= ninja.stunnedUntil && now >= ninja.tumbleUntil;

  /** The spinning katana cuts every fruit within reach. */
  function checkCuts(now) {
    if (!state || state.phase !== 'playing' || !bladeActive(now)) return;
    const t = serverNow();
    for (const f of fruits.values()) {
      const pos = HUB.fruitPosition(f, t);
      if (pos.y > H + 1) continue; // not in the dojo yet
      const dx = pos.x - ninja.x;
      const dy = pos.y - ninja.y;
      if (Math.hypot(dx, dy) > HIT_REACH + f.r) continue;
      const angle = Math.atan2(dy, dx);
      fruits.delete(f.id);
      sliceFruit(f, pos, angle);
      send({ type: 'cut', id: f.id, x: round2(ninja.x), y: round2(ninja.y), angle: round2(angle) });
      vibrate(f.type === 'nest' ? 0 : 12);
    }
  }

  /** Knock another ninja away with the katana. */
  function checkBumps(now, list) {
    if (!state || state.phase === 'lobby' || !bladeActive(now)) return;
    for (const o of list) {
      if ((bumpCooldown.get(o.id) || 0) > now) continue;
      if (Math.hypot(o.x - ninja.x, o.y - ninja.y) > HIT_REACH + CFG.ninjaRadius) continue;
      bumpCooldown.set(o.id, now + CFG.bumpCooldownMs + 200);
      send({ type: 'bump', id: o.id }); // the hub decides: kick or clash
    }
  }

  function handleCut(msg) {
    const f = fruits.get(msg.id);
    let pos = null;
    if (f) {
      fruits.delete(msg.id);
      pos = HUB.fruitPosition(f, serverNow());
      sliceFruit(f, pos, msg.angle);
    }
    const label = `${msg.points > 0 ? '+' : '−'}${Math.abs(msg.points)}${msg.chain > 1 ? ` · ${msg.chain}er-Kombo` : ''}`;
    const mine = msg.by.id === me.id;
    const at = pos || (mine ? { x: ninja.x, y: ninja.y + 1 } : null);
    if (at) {
      popups.push({
        x: at.x, y: at.y + 0.4, life: 1,
        text: mine ? label : `${msg.by.name} ${label}`,
        color: msg.points < 0 ? '#ff5d73' : msg.by.color,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------
  function sliceFruit(f, pos, angle) {
    const vel = fruitVelocity(f);
    for (const side of [1, -1]) {
      const nx = Math.sin(angle) * side;
      const ny = -Math.cos(angle) * side;
      halves.push({
        type: f.type, r: f.r, x: pos.x, y: pos.y, rot: pos.rot, cut: angle, side, spin: 0,
        vx: vel.x * 0.5 + nx * 1.8, vy: vel.y * 0.5 + ny * 1.8 + 1.5, spinV: side * (2 + Math.random() * 2), life: 1,
      });
    }
    if (f.type === 'nest') {
      for (let i = 0; i < 10; i++) {
        particles.push({ x: pos.x, y: pos.y, vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.2) * 5, life: 1, decay: 0.7, color: '#ffd23f', size: 0.09, wasp: true, g: 0 });
      }
    } else {
      sparks(pos.x, pos.y, FLESH[f.type], 14);
    }
    // White slash line along the cut
    particles.push({ x: pos.x, y: pos.y, vx: 0, vy: 0, life: 1, decay: 4, slash: angle, len: f.r * 3, g: 0 });
  }

  function fruitVelocity(f) {
    const t = serverNow();
    const a = HUB.fruitPosition(f, t);
    const b = HUB.fruitPosition(f, t + 50);
    return { x: (b.x - a.x) / 0.05, y: (b.y - a.y) / 0.05 };
  }

  function sparks(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 2 + Math.random() * 4;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 1.5, life: 1, decay: 1.6, color, size: 0.07 + Math.random() * 0.07, g: 14 });
    }
  }

  function puff(x, y) {
    for (let i = 0; i < 6; i++) {
      particles.push({ x, y: y + 0.05, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 1.2, life: 1, decay: 2.2, color: 'rgba(255,240,220,0.7)', size: 0.12, g: 0 });
    }
  }

  function updateEffects(dt) {
    const t = serverNow();
    // Fruit that reaches the floor uncut splats.
    for (const f of fruits.values()) {
      if (t >= f.t0 + HUB.fruitLifetime(f)) {
        fruits.delete(f.id);
        const pos = HUB.fruitPosition(f, t);
        splats.push({ x: pos.x, r: f.r, color: f.type === 'nest' ? '#8b6440' : FLESH[f.type], life: 1 });
        sparks(pos.x, f.r * 0.5, FLESH[f.type], 6);
      }
    }
    for (let i = halves.length - 1; i >= 0; i--) {
      const h = halves[i];
      h.vy -= 14 * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.spin += h.spinV * dt;
      h.life -= dt * 0.75;
      if (h.life <= 0 || h.y < -1) halves.splice(i, 1);
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy -= (p.g ?? 14) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * p.decay;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = splats.length - 1; i >= 0; i--) {
      splats[i].life -= dt * 0.3;
      if (splats[i].life <= 0) splats.splice(i, 1);
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      popups[i].y += dt * 0.9;
      popups[i].life -= dt * 0.8;
      if (popups[i].life <= 0) popups.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Input: the whole dojo is the touch surface
  // ---------------------------------------------------------------------------
  const fingers = new Map(); // pointerId -> {x, y, t, fired, lastFire}

  area.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    area.setPointerCapture?.(e.pointerId);
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), sx: e.clientX, sy: e.clientY, fired: false, lastFire: 0 });
  });

  area.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    const now = performance.now();
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    if (Math.hypot(dx, dy) < SWIPE_PX || now - f.lastFire < REARM_MS) return;
    // Screen y points down, world y up.
    jump(dx, -dy);
    f.fired = true;
    f.lastFire = now;
    f.x = e.clientX;
    f.y = e.clientY;
  });

  function endFinger(e) {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    fingers.delete(e.pointerId);
    const moved = Math.hypot(e.clientX - f.sx, e.clientY - f.sy);
    if (!f.fired && moved < TAP_PX && performance.now() - f.t < TAP_MAX_MS) slash();
    else if (!f.fired && moved >= TAP_PX) jump(e.clientX - f.sx, -(e.clientY - f.sy));
  }
  area.addEventListener('pointerup', endFinger);
  area.addEventListener('pointercancel', (e) => fingers.delete(e.pointerId));

  // Keyboard for desktop testing.
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const keys = {
      ArrowUp: [0, 1], w: [0, 1], ArrowLeft: [-0.7, 0.7], a: [-0.7, 0.7],
      ArrowRight: [0.7, 0.7], d: [0.7, 0.7], ArrowDown: [0, -1], s: [0, -1],
    };
    if (keys[e.key]) jump(...keys[e.key]);
    else if (e.key === ' ') slash();
    else return;
    e.preventDefault();
  });

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  function renderTeam(players) {
    const sorted = [...players].filter((p) => p.connected).sort((a, b) => b.score - a.score);
    $('team').replaceChildren(...sorted.map((p) => {
      const chip = document.createElement('span');
      chip.className = 'team-chip score-chip';
      if (p.id === me.id) chip.classList.add('me');
      chip.style.setProperty('--chip-color', p.color);
      const name = document.createElement('b');
      name.textContent = p.id === me.id ? 'du' : p.name;
      const score = document.createElement('small');
      score.textContent = `⭐ ${p.score}`;
      chip.append(name, score);
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

  function renderResults(results) {
    $('results').hidden = !results || results.length === 0;
    if (!results) return;
    $('results-list').replaceChildren(...results.map((r, i) => {
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

  function updateClocks() {
    if (!state) return;
    const now = serverNow();
    if (state.phase === 'playing') {
      const left = Math.max(0, Math.ceil((state.phaseEndsAt - now) / 1000));
      const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if ($('hud-time').textContent !== text) $('hud-time').textContent = text;
    } else if (state.phase === 'countdown') {
      const left = String(Math.max(1, Math.ceil((state.phaseEndsAt - now) / 1000)));
      if (countdownEl.textContent !== left) countdownEl.textContent = left;
    }
  }

  /** Short message right above the own ninja: where the player is looking anyway. */
  function shout(text, color) {
    popups.push({ x: ninja.x, y: ninja.y + 1.7, life: 1.3, text, color });
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
    if (pattern && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
  }

  const round2 = (v) => Math.round(v * 100) / 100;

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
    // The dojo fits the screen; extra space in portrait is sky, in landscape bamboo.
    S = Math.min(cssW / (W + 0.6), cssH / (H + 2.4));
    ox = (cssW - W * S) / 2;
    gy = cssH - S * 0.9;
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  function drawDojo(t) {
    const sky = ctx.createLinearGradient(0, 0, 0, gy);
    sky.addColorStop(0, '#1b1035');
    sky.addColorStop(0.55, '#55285c');
    sky.addColorStop(1, '#ee8a5b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cssW, gy);

    // Moon
    const mx = sx(W * 0.74);
    const my = sy(H * 0.82);
    const glow = ctx.createRadialGradient(mx, my, S * 0.6, mx, my, S * 3);
    glow.addColorStop(0, 'rgba(255, 230, 190, 0.35)');
    glow.addColorStop(1, 'rgba(255, 230, 190, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(mx - S * 3, my - S * 3, S * 6, S * 6);
    ctx.fillStyle = '#ffe9c4';
    ctx.beginPath();
    ctx.arc(mx, my, S * 1.05, 0, Math.PI * 2);
    ctx.fill();

    // Mountains
    const ridge = (base, peaks, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      const step = cssW / peaks.length;
      peaks.forEach((h, i) => ctx.lineTo(i * step + step / 2, gy - base - h * S));
      ctx.lineTo(cssW, gy);
      ctx.closePath();
      ctx.fill();
    };
    ridge(S * 1.2, [2.2, 3.6, 1.8, 4.2, 2.6, 3.1], '#3c1f50');
    ridge(0, [1.4, 2.1, 1.0, 2.6, 1.5, 2.2, 1.2], '#2a1840');

    // Bamboo: faint stalks behind the dojo, thick ones as its walls and beyond
    const stalk = (x, width, color, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(x - width / 2, 0, width, gy);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      for (let y = gy - S * 1.3; y > 0; y -= S * 1.6) ctx.fillRect(x - width / 2, y, width, Math.max(2, S * 0.07));
      ctx.globalAlpha = 1;
    };
    for (const x of [2.3, 5.1, 7.9]) stalk(sx(x), S * 0.22, '#2f6b3a', 0.35);
    for (let x = ox - S * 0.25; x > -S; x -= S * 0.7) stalk(x, S * 0.38, '#4f8f3a', 1);
    for (let x = sx(W) + S * 0.25; x < cssW + S; x += S * 0.7) stalk(x, S * 0.38, '#4f8f3a', 1);

    // Floor: wooden planks across the whole width
    ctx.fillStyle = '#6b3f22';
    ctx.fillRect(0, gy, cssW, cssH - gy);
    ctx.fillStyle = '#8a5530';
    ctx.fillRect(0, gy, cssW, Math.max(3, S * 0.1));
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 1;
    for (let x = sx(0); x < cssW; x += S * 1.4) {
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }

    // Splats on the floor
    for (const s of splats) {
      ctx.globalAlpha = Math.min(1, s.life * 1.5) * 0.8;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.ellipse(sx(s.x), gy + 2, s.r * S * 1.3, s.r * S * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Bamboo platforms hanging on ropes
    for (const [l, r, h] of HUB.PLATFORMS) {
      ctx.strokeStyle = '#c9a26b';
      ctx.lineWidth = Math.max(1, S * 0.04);
      for (const x of [l + 0.2, r - 0.2]) {
        ctx.beginPath();
        ctx.moveTo(sx(x), 0);
        ctx.lineTo(sx(x), sy(h));
        ctx.stroke();
      }
      const top = sy(h);
      const thick = S * 0.2;
      ctx.fillStyle = '#7fb34a';
      roundRect(sx(l), top, (r - l) * S, thick, thick / 2);
      ctx.fill();
      ctx.fillStyle = '#5a8a32';
      for (let x = l + 0.6; x < r; x += 0.8) ctx.fillRect(sx(x), top, Math.max(2, S * 0.06), thick);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(sx(l) + thick / 2, top + thick * 0.2, (r - l) * S - thick, Math.max(1, thick * 0.18));
    }
  }

  // --- Fruit and vegetables, drawn in world units around (0, 0), canvas y down ---
  function drawFruitBody(type, r, t) {
    const skin = SKIN[type];
    switch (type) {
      case 'apple':
      case 'golden': {
        if (type === 'golden') {
          ctx.shadowColor = '#ffe156';
          ctx.shadowBlur = 18;
        }
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.arc(-r * 0.32, 0, r * 0.75, 0, Math.PI * 2);
        ctx.arc(r * 0.32, 0, r * 0.75, 0, Math.PI * 2);
        ctx.arc(0, r * 0.15, r * 0.82, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#6b3f22';
        ctx.lineWidth = r * 0.12;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.6);
        ctx.lineTo(r * 0.1, -r * 1.05);
        ctx.stroke();
        ctx.fillStyle = '#5cb85c';
        ctx.beginPath();
        ctx.ellipse(r * 0.38, -r * 0.92, r * 0.3, r * 0.13, -0.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'orange':
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(160, 80, 0, 0.35)';
        for (let i = 0; i < 7; i++) {
          const a = i * 2.4;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * 0.05, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#4f8f3a';
        ctx.beginPath();
        ctx.ellipse(r * 0.15, -r * 0.95, r * 0.22, r * 0.1, -0.4, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'tomato':
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 1.05, r * 0.88, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#3f8f3a';
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i - 2) * 0.55;
          ctx.beginPath();
          ctx.ellipse(Math.cos(a) * r * 0.25, -r * 0.75 + Math.sin(a + Math.PI / 2) * r * 0.05, r * 0.28, r * 0.08, a + Math.PI / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case 'carrot':
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.moveTo(-r * 0.5, -r * 0.8);
        ctx.quadraticCurveTo(0, -r * 1.0, r * 0.5, -r * 0.8);
        ctx.lineTo(r * 0.06, r * 1.4);
        ctx.lineTo(-r * 0.06, r * 1.4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(150, 60, 0, 0.5)';
        ctx.lineWidth = r * 0.07;
        for (const y of [-0.3, 0.2, 0.7]) {
          ctx.beginPath();
          ctx.moveTo(-r * 0.3 * (1 - y * 0.4), r * y);
          ctx.lineTo(-r * 0.05, r * (y + 0.06));
          ctx.stroke();
        }
        ctx.strokeStyle = '#4f9f3a';
        ctx.lineWidth = r * 0.14;
        for (const a of [-0.5, 0, 0.5]) {
          ctx.beginPath();
          ctx.moveTo(0, -r * 0.85);
          ctx.lineTo(Math.sin(a) * r * 0.6, -r * 0.85 - Math.cos(a) * r * 0.6);
          ctx.stroke();
        }
        break;
      case 'eggplant':
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.ellipse(0, r * 0.3, r * 0.8, r * 0.95, 0, 0, Math.PI * 2);
        ctx.ellipse(0, -r * 0.4, r * 0.5, r * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.beginPath();
        ctx.ellipse(-r * 0.35, r * 0.2, r * 0.12, r * 0.4, 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#4f8f3a';
        ctx.beginPath();
        ctx.moveTo(-r * 0.45, -r * 0.8);
        ctx.lineTo(0, -r * 1.25);
        ctx.lineTo(r * 0.45, -r * 0.8);
        ctx.lineTo(0, -r * 0.95);
        ctx.closePath();
        ctx.fill();
        break;
      case 'banana':
        ctx.strokeStyle = skin;
        ctx.lineCap = 'round';
        ctx.lineWidth = r * 0.6;
        ctx.beginPath();
        ctx.arc(0, -r * 0.9, r * 1.2, Math.PI * 0.22, Math.PI * 0.78);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(160, 110, 0, 0.45)';
        ctx.lineWidth = r * 0.08;
        ctx.beginPath();
        ctx.arc(0, -r * 0.9, r * 1.32, Math.PI * 0.27, Math.PI * 0.73);
        ctx.stroke();
        ctx.fillStyle = '#5a3a1a';
        for (const a of [0.2, 0.8]) {
          ctx.beginPath();
          ctx.arc(Math.cos(Math.PI * a) * r * 1.2, -r * 0.9 + Math.sin(Math.PI * a) * r * 1.2, r * 0.12, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.lineCap = 'butt';
        break;
      case 'pineapple':
        ctx.fillStyle = '#3f9a3a';
        for (const a of [-0.6, -0.25, 0.1, 0.45, 0.75]) {
          ctx.beginPath();
          ctx.moveTo(-r * 0.15, -r * 0.8);
          ctx.lineTo(Math.sin(a) * r * 0.9, -r * 0.8 - Math.cos(a) * r * 0.9);
          ctx.lineTo(r * 0.15, -r * 0.8);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.ellipse(0, r * 0.15, r * 0.75, r * 0.95, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = 'rgba(120, 70, 10, 0.55)';
        ctx.lineWidth = r * 0.06;
        for (let k = -3; k <= 3; k++) {
          ctx.beginPath();
          ctx.moveTo(-r + k * r * 0.35, -r);
          ctx.lineTo(r + k * r * 0.35, r * 1.3);
          ctx.moveTo(r - k * r * 0.35, -r);
          ctx.lineTo(-r - k * r * 0.35, r * 1.3);
          ctx.stroke();
        }
        ctx.restore();
        break;
      case 'watermelon':
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = '#1c5f29';
        ctx.lineWidth = r * 0.16;
        for (const k of [-0.6, -0.2, 0.2, 0.6]) {
          ctx.beginPath();
          ctx.ellipse(k * r, 0, r * 0.25, r * 1.1, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.beginPath();
        ctx.ellipse(-r * 0.4, -r * 0.45, r * 0.25, r * 0.14, -0.6, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'nest': {
        const bands = ['#8b6440', '#a67c52', '#8b6440', '#b88d5f'];
        bands.forEach((c, i) => {
          ctx.fillStyle = c;
          const w = r * (1 - Math.abs(i - 1.2) * 0.22);
          ctx.beginPath();
          ctx.ellipse(0, r * (0.6 - i * 0.45), w, r * 0.32, 0, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.fillStyle = '#2a1a10';
        ctx.beginPath();
        ctx.arc(0, r * 0.35, r * 0.15, 0, Math.PI * 2);
        ctx.fill();
        // Two wasps buzzing around it
        for (let i = 0; i < 2; i++) {
          const a = t * 5 + i * Math.PI;
          const wx = Math.cos(a) * r * 1.35;
          const wy = Math.sin(a * 1.3) * r * 0.9;
          ctx.fillStyle = '#ffd23f';
          ctx.beginPath();
          ctx.ellipse(wx, wy, r * 0.16, r * 0.1, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#1b1d2e';
          ctx.fillRect(wx - r * 0.03, wy - r * 0.1, r * 0.06, r * 0.2);
        }
        break;
      }
      default:
        break;
    }
  }

  function drawFruit(f, pos, t) {
    ctx.save();
    ctx.translate(sx(pos.x), sy(pos.y));
    ctx.scale(S, S);
    ctx.rotate(-pos.rot);
    drawFruitBody(f.type, f.r, t);
    ctx.restore();
  }

  function drawHalf(h, t) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, h.life * 2.5);
    ctx.translate(sx(h.x), sy(h.y));
    ctx.scale(S, S);
    ctx.rotate(-h.spin);
    ctx.rotate(-h.cut); // cut line along local x
    ctx.beginPath();
    if (h.side > 0) ctx.rect(-h.r * 2, 0, h.r * 4, h.r * 2.5);
    else ctx.rect(-h.r * 2, -h.r * 2.5, h.r * 4, h.r * 2.5);
    ctx.clip();
    ctx.save();
    ctx.rotate(h.cut - h.rot);
    drawFruitBody(h.type, h.r, t);
    ctx.restore();
    ctx.fillStyle = FLESH[h.type];
    ctx.beginPath();
    ctx.ellipse(0, 0, h.r * 0.9, h.r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    if (h.type === 'watermelon') {
      ctx.fillStyle = '#1b1d2e';
      for (const k of [-0.5, -0.15, 0.2, 0.5]) {
        ctx.beginPath();
        ctx.ellipse(k * h.r, h.side * h.r * 0.12, h.r * 0.05, h.r * 0.08, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // --- Ninjas ---
  function drawNinja(n, color, label, now, opts = {}) {
    const px = sx(n.x);
    const py = sy(n.y);
    const t = now / 1000;

    // Shadow on the surface below
    let surface = 0;
    for (const [l, r, h] of HUB.PLATFORMS) if (n.x >= l && n.x <= r && n.y - FOOT >= h - 0.05) surface = Math.max(surface, h);
    const height = Math.max(0, n.y - FOOT - surface);
    ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0.08, 0.3 - height * 0.04)})`;
    ctx.beginPath();
    ctx.ellipse(px, sy(surface) + 1, S * Math.max(0.15, 0.4 - height * 0.03), S * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    const spinning = opts.spinning && !n.stun;
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(S, S);
    if (spinning) {
      // Blur ring of the spinning katana
      ctx.strokeStyle = 'rgba(220, 235, 255, 0.28)';
      ctx.lineWidth = 0.28;
      ctx.beginPath();
      ctx.arc(0, 0, CFG.bladeReach - 0.1, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.rotate(n.rot);
    ctx.scale(n.facing * NINJA_SCALE, NINJA_SCALE);
    if (n.stun) ctx.globalAlpha = 0.75;

    const tuck = n.air ? 1 : 0;
    // Headband tails flutter behind the head
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.07;
    ctx.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      const wave = Math.sin(t * 14 + i) * 0.08;
      ctx.beginPath();
      ctx.moveTo(-0.2, -0.5);
      ctx.quadraticCurveTo(-0.45, -0.5 + wave + i * 0.06, -0.62, -0.4 + wave * 2 + i * 0.1);
      ctx.stroke();
    }

    // Legs
    ctx.strokeStyle = '#1d2240';
    ctx.lineWidth = 0.13;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 0.1, 0.25);
      ctx.lineTo(side * 0.12 + tuck * 0.12, 0.5 - tuck * 0.18);
      ctx.stroke();
    }

    // Body
    ctx.fillStyle = '#262c52';
    ctx.beginPath();
    ctx.ellipse(0, 0.08, 0.27, 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color; // belt
    ctx.fillRect(-0.26, 0.12, 0.52, 0.07);

    // Katana: gold guard at the hand, wrapped grip behind, curved blade ahead
    const hand = { x: 0.24, y: 0.0 };
    ctx.save();
    ctx.translate(hand.x, hand.y);
    ctx.rotate(-0.95);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    ctx.moveTo(-0.26, 0);
    ctx.lineTo(0, 0);
    ctx.stroke();
    ctx.fillStyle = '#e0b84d';
    ctx.beginPath();
    ctx.ellipse(0.02, 0, 0.04, 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#dfe7f2';
    ctx.beginPath();
    ctx.moveTo(0.05, -0.04);
    ctx.quadraticCurveTo(0.6, -0.08, 1.05, -0.02);
    ctx.lineTo(0.05, 0.04);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.02;
    ctx.beginPath();
    ctx.moveTo(0.08, -0.035);
    ctx.quadraticCurveTo(0.6, -0.075, 1.0, -0.025);
    ctx.stroke();
    ctx.restore();

    // Arm to the katana
    ctx.strokeStyle = '#262c52';
    ctx.lineWidth = 0.11;
    ctx.beginPath();
    ctx.moveTo(0.05, -0.12);
    ctx.lineTo(hand.x, hand.y);
    ctx.stroke();

    // Head with eye slit and headband
    ctx.fillStyle = '#262c52';
    ctx.beginPath();
    ctx.arc(0, -0.4, 0.23, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2c9a0';
    ctx.fillRect(-0.12, -0.45, 0.33, 0.09);
    ctx.fillStyle = '#1b1d2e';
    ctx.fillRect(0.03, -0.43, 0.04, 0.05);
    ctx.fillRect(0.13, -0.43, 0.04, 0.05);
    ctx.fillStyle = color;
    ctx.fillRect(-0.22, -0.56, 0.44, 0.07);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';

    // Dizzy stars while stunned
    if (n.stun) {
      ctx.fillStyle = '#ffe156';
      ctx.font = `${Math.round(S * 0.3)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      for (let i = 0; i < 3; i++) {
        const a = t * 4 + (i * Math.PI * 2) / 3;
        ctx.fillText('★', px + Math.cos(a) * S * 0.35, py - S * 0.85 + Math.sin(a) * S * 0.1);
      }
    }

    // Name tag (never rotated)
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.max(10, Math.round(S * 0.32))}px system-ui, sans-serif`;
    ctx.fillStyle = opts.isMe ? '#ffffff' : color;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 4;
    ctx.fillText(label, px, py - S * 1.15);
    ctx.shadowBlur = 0;
  }

  function drawEffects() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      if (p.slash !== undefined) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(2, S * 0.06 * p.life);
        const dx = Math.cos(p.slash) * p.len * 0.5;
        const dy = Math.sin(p.slash) * p.len * 0.5;
        ctx.beginPath();
        ctx.moveTo(sx(p.x - dx), sy(p.y - dy));
        ctx.lineTo(sx(p.x + dx), sy(p.y + dy));
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), Math.max(1.5, p.size * S), 0, Math.PI * 2);
      ctx.fill();
      if (p.wasp) {
        ctx.fillStyle = '#1b1d2e';
        ctx.fillRect(sx(p.x) - 1, sy(p.y) - p.size * S, 2, p.size * S * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.font = `800 ${Math.max(12, Math.round(S * 0.42))}px system-ui, sans-serif`;
    for (const p of popups) {
      ctx.globalAlpha = Math.min(1, p.life * 1.5);
      ctx.fillStyle = p.color;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
      ctx.shadowBlur = 4;
      ctx.fillText(p.text, sx(p.x), sy(p.y));
    }
    ctx.shadowBlur = 0;
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

  function draw(now, list) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = now / 1000;
    drawDojo(t);
    const st = serverNow();
    for (const f of fruits.values()) {
      const pos = HUB.fruitPosition(f, st);
      if (pos.y - f.r > H + 3) continue;
      drawFruit(f, pos, t);
    }
    for (const h of halves) drawHalf(h, t);
    for (const o of list) {
      const info = playerInfo.get(o.id) || { name: '?', color: '#ccc' };
      drawNinja(o, info.color, info.name, now, { spinning: !!o.air });
    }
    if (me.id) {
      const stun = now < ninja.stunnedUntil;
      drawNinja({ ...ninja, stun }, me.color, '▼ du', now, { isMe: true, spinning: bladeActive(now) });
    }
    drawEffects();
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  let last = performance.now();
  let acc = 0;
  let lastPosSent = 0;
  let lastPosKey = '';

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    while (acc >= STEP) {
      step(STEP, now);
      acc -= STEP;
    }
    checkCuts(now);
    const list = otherNinjas(now);
    checkBumps(now, list);

    if (me.id && now - lastPosSent >= POS_INTERVAL_MS) {
      const key = `${round2(ninja.x)}:${round2(ninja.y)}:${round2(ninja.rot)}`;
      if (key !== lastPosKey || now - lastPosSent > 500) {
        send({ type: 'pos', x: round2(ninja.x), y: round2(ninja.y), rot: round2(ninja.rot), air: bladeActive(now), facing: ninja.facing });
        lastPosKey = key;
        lastPosSent = now;
      }
    }

    updateEffects(dt);
    updateClocks();
    draw(now, list);
    if (window.__ninja && window.__ninja.onFrame) window.__ninja.onFrame(now);
    requestAnimationFrame(frame);
  }

  $('hud-code').textContent = roomCode;
  $('lobby-code').textContent = roomCode;
  $('start').addEventListener('click', () => send({ type: 'start' }));

  resize();
  connect();
  requestAnimationFrame(frame);

  // Expose a tiny hook for automated tests.
  window.__ninja = {
    ninja,
    fruits,
    jump,
    slash,
    send,
    serverNow,
    get state() { return state; },
    get me() { return me; },
    onFrame: null, // tests can capture frames at exact animation moments
  };
})();
