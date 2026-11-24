'use strict';

// Ploink Blaster client.
// World coordinates: the screen is 1 unit wide and H units tall (H = height / width).
// The top edge is split into one lane per opponent. A laser leaving the top through a
// lane is sent to that opponent and comes down on their screen as an enemy shot.

(() => {
  // This tab only relays a scanned QR answer to the host tab (see shared/qr.js).
  if (window.PloinkNet && PloinkNet.relayOnly) return;

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  const SHIP_RADIUS = 0.045;       // hit box
  const SHIP_WIDTH = 0.11;
  const SHIP_HEIGHT = 0.1;
  const FINGER_OFFSET = 0.16;      // ship floats above the finger so it stays visible
  const SHIP_MIN_Y_RATIO = 0.45;   // ship may use the lower 55 % of the screen
  const LASER_SPEED = 1.9;
  const LASER_RADIUS = 0.012;
  const FIRE_INTERVAL = 0.25;      // seconds between auto-fire shots
  const ENEMY_RADIUS = 0.024;
  const ENEMY_SPEED = 1.05;        // speed of our shots on the opponent's screen
  const MAX_SHOT_ANGLE = 0.45;
  const KEYBOARD_SPEED = 1.6;
  const RECONNECT_DELAY_MS = 1200;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const gameScreen = $('game');
  const canvas = $('field');
  const ctx = canvas.getContext('2d');
  const statusEl = $('status');
  const toastsEl = $('toasts');
  const offlineEl = $('offline');
  const board = $('board');
  const boardList = $('board-list');
  const hud = document.querySelector('.hud');

  const storage = {
    get(store, key) {
      try { return store.getItem(key); } catch { return null; }
    },
    set(store, key, value) {
      try { store.setItem(key, value); } catch { /* private mode */ }
    },
  };

  // Internal room code: from the host's QR join link, or picked by the host itself.
  const roomCode = PloinkNet.roomCode();

  let token = storage.get(sessionStorage, 'ploink-blaster-token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    storage.set(sessionStorage, 'ploink-blaster-token', token);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let socket = null;
  let reconnectTimer = null;
  let me = { id: null, name: storage.get(localStorage, 'ploink-name') || '', color: '#4dd6ff' };
  let maxHp = 3;
  let players = [];
  const deadUntil = new Map();   // player id -> performance.now() timestamp
  let myShieldUntil = 0;
  let lastKiller = null;

  let cssW = 1;
  let cssH = 1;
  let H = 1;
  let dpr = 1;
  let laneLabelY = 0.1;

  const ship = { x: 0.5, y: 1.5, tx: 0.5, ty: 1.5, vx: 0 };
  let firing = false;
  let fireCooldown = 0;
  const keys = { left: false, right: false, up: false, down: false, fire: false };
  const lasers = [];
  const enemies = [];
  const particles = [];
  let stars = [];
  let hitFlash = 0;

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function connect() {
    clearTimeout(reconnectTimer);
    // WebSocket to the Ploink server, or WebRTC to/as the hosting phone (see shared/net.js).
    const ws = PloinkNet.open({ mode: 'blaster', code: roomCode, wsPath: '/ws/shooter', hub: window.PloinkBlasterHub });
    socket = ws;

    ws.addEventListener('open', () => {
      if (ws.role === 'host') toast('📡 Du bist Gastgeber – lass diese Seite offen und das Display an.');
      send({ type: 'join', code: roomCode, name: me.name, token, away: document.hidden });
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      enemies.length = 0;
      offlineEl.hidden = false;
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        me = { id: msg.you, name: msg.name, color: msg.color };
        maxHp = msg.maxHp || 3;
        if (msg.token) {
          token = msg.token;
          storage.set(sessionStorage, 'ploink-blaster-token', token);
        }
        offlineEl.hidden = true;
        break;
      case 'error':
        alert(msg.message);
        location.replace('./');
        break;
      case 'state':
        applyState(msg.players);
        break;
      case 'incoming':
        enemies.push({
          id: msg.id,
          x: msg.x,
          y: -ENEMY_RADIUS,
          vx: Math.sin(msg.angle) * msg.speed,
          vy: Math.cos(msg.angle) * msg.speed,
          color: msg.from.color,
        });
        break;
      case 'event':
        handleEvent(msg);
        break;
      default:
        break;
    }
  }

  function applyState(list) {
    const now = performance.now();
    players = list;
    for (const p of players) {
      if (p.respawnMs > 0) deadUntil.set(p.id, now + p.respawnMs);
      else deadUntil.delete(p.id);
      if (p.id === me.id) {
        me.color = p.color;
        me.name = p.name;
        myShieldUntil = now + p.shieldMs;
      }
    }
    renderHud();
  }

  function handleEvent(msg) {
    if (msg.kind === 'join' && msg.id !== me.id) {
      toast(`${msg.name} ist gelandet`, msg.color);
    } else if (msg.kind === 'landed') {
      toast(`🎯 Treffer bei ${msg.name}!`, msg.color);
    } else if (msg.kind === 'kill') {
      if (msg.id === me.id) {
        lastKiller = msg.by;
        explode(ship.x, ship.y, me.color, 60);
        enemies.length = 0;
        vibrate([120, 60, 200]);
      } else if (msg.by.id === me.id) {
        toast(`💥 Du hast ${msg.name} abgeschossen!`, msg.color);
        vibrate([30, 30, 30]);
      } else {
        toast(`${msg.by.name} hat ${msg.name} abgeschossen`, msg.by.color);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  function opponents() {
    return players.filter((p) => p.id !== me.id && p.connected && !p.away);
  }

  function isDead(id, now = performance.now()) {
    return (deadUntil.get(id) || 0) > now;
  }

  function renderHud() {
    const self = players.find((p) => p.id === me.id);
    if (self) {
      $('hud-hp').textContent = '❤'.repeat(Math.max(0, self.hp)) + '♡'.repeat(Math.max(0, maxHp - self.hp));
      $('hud-kills').textContent = self.kills;
    }
    $('hud-count').textContent = players.filter((p) => p.connected).length;

    const sorted = [...players].sort((a, b) => b.kills - a.kills || b.hits - a.hits || a.deaths - b.deaths);
    boardList.replaceChildren(...sorted.map((p) => {
      const li = document.createElement('li');
      if (p.id === me.id) li.classList.add('me');
      if (!p.connected || p.away) li.classList.add('offline');

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = p.color;

      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name;
      if (p.id === me.id || !p.connected || p.away) {
        const small = document.createElement('small');
        small.textContent = p.id === me.id ? ' (du)' : !p.connected ? ' (offline)' : ' (pausiert)';
        name.append(small);
      }

      const cells = [`💥 ${p.kills}`, `🎯 ${p.hits}`, `☠️ ${p.deaths}`].map((text) => {
        const span = document.createElement('span');
        span.className = 'stat';
        span.textContent = text;
        return span;
      });

      li.append(swatch, name, ...cells);
      return li;
    }));
  }

  let lastStatus = '';
  function updateStatus(now) {
    let html = '';
    const respawn = (deadUntil.get(me.id) || 0) - now;
    if (respawn > 0) {
      const by = lastKiller ? ` von <strong style="color:${lastKiller.color}">${escapeHtml(lastKiller.name)}</strong>` : '';
      html = `Abgeschossen${by}!<br>Respawn in ${Math.ceil(respawn / 1000)} …`;
    } else if (opponents().length === 0) {
      html = 'Warte auf Gegner …<br>Der Gastgeber koppelt weitere Spieler über den Knopf „📷+“ unten links.';
    }
    if (html !== lastStatus) {
      statusEl.innerHTML = html;
      lastStatus = html;
    }
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
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

  $('room-badge').addEventListener('click', () => { board.hidden = !board.hidden; });
  $('board-close').addEventListener('click', () => { board.hidden = true; });

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  let fullscreenTried = false;
  function onPointer(event) {
    if (!board.hidden && board.contains(event.target)) return;
    if (event.target.closest('.hud')) return;
    if (event.type === 'pointerdown') {
      firing = true;
      if (!fullscreenTried) {
        fullscreenTried = true;
        const el = document.documentElement;
        if (el.requestFullscreen && matchMedia('(pointer: coarse)').matches) {
          el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
        }
      }
    }
    // A mouse steers by hovering and fires while pressed; a finger steers and fires at once.
    ship.tx = event.clientX / cssW;
    ship.ty = event.clientY / cssW - (event.pointerType === 'mouse' ? 0 : FINGER_OFFSET);
  }

  gameScreen.addEventListener('pointerdown', onPointer);
  gameScreen.addEventListener('pointermove', onPointer);
  const stopFiring = () => { firing = false; };
  window.addEventListener('pointerup', stopFiring);
  window.addEventListener('pointercancel', stopFiring);
  gameScreen.addEventListener('touchmove', (e) => {
    if (!board.contains(e.target)) e.preventDefault();
  }, { passive: false });

  const KEYMAP = {
    ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right',
    ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', ' ': 'fire',
  };
  window.addEventListener('keydown', (e) => {
    if (KEYMAP[e.key]) { keys[KEYMAP[e.key]] = true; e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    if (KEYMAP[e.key]) keys[KEYMAP[e.key]] = false;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      enemies.length = 0;
      firing = false;
      send({ type: 'away' });
    } else {
      send({ type: 'back' });
    }
  });

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------
  function step(dt, now) {
    const dead = isDead(me.id, now);
    const shielded = myShieldUntil > now;

    // Ship movement
    if (keys.left) ship.tx = ship.x - KEYBOARD_SPEED * dt;
    if (keys.right) ship.tx = ship.x + KEYBOARD_SPEED * dt;
    if (keys.up) ship.ty = ship.y - KEYBOARD_SPEED * dt;
    if (keys.down) ship.ty = ship.y + KEYBOARD_SPEED * dt;
    const minY = H * SHIP_MIN_Y_RATIO;
    const maxY = H - 0.08;
    ship.tx = Math.min(0.94, Math.max(0.06, ship.tx));
    ship.ty = Math.min(maxY, Math.max(minY, ship.ty));
    const prevX = ship.x;
    const follow = 1 - Math.exp(-dt * 30);
    ship.x += (ship.tx - ship.x) * follow;
    ship.y += (ship.ty - ship.y) * follow;
    const instantVx = dt > 0 ? (ship.x - prevX) / dt : 0;
    ship.vx += (instantVx - ship.vx) * Math.min(1, dt * 12);

    // Auto-fire
    fireCooldown -= dt;
    if ((firing || keys.fire) && !dead && fireCooldown <= 0) {
      fireCooldown = FIRE_INTERVAL;
      const angle = Math.max(-MAX_SHOT_ANGLE, Math.min(MAX_SHOT_ANGLE, ship.vx * 0.12));
      lasers.push({
        x: ship.x,
        y: ship.y - SHIP_HEIGHT * 0.6,
        vx: Math.sin(angle) * LASER_SPEED,
        vy: -Math.cos(angle) * LASER_SPEED,
      });
    }

    // Own lasers
    const opps = opponents();
    for (let i = lasers.length - 1; i >= 0; i--) {
      const l = lasers[i];
      l.x += l.vx * dt;
      l.y += l.vy * dt;
      if (l.x < LASER_RADIUS || l.x > 1 - LASER_RADIUS) {
        l.vx = -l.vx;
        l.x = Math.min(1 - LASER_RADIUS, Math.max(LASER_RADIUS, l.x));
      }
      if (l.y < -LASER_RADIUS) {
        lasers.splice(i, 1);
        if (opps.length === 0) continue;
        const lane = Math.min(opps.length - 1, Math.floor(l.x * opps.length));
        const target = opps[lane];
        if (isDead(target.id, now)) continue;
        send({
          type: 'shot',
          target: target.id,
          x: l.x * opps.length - lane,
          angle: Math.atan2(l.vx, -l.vy),
          speed: ENEMY_SPEED,
        });
      }
    }

    // Enemy shots
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (e.x < ENEMY_RADIUS) { e.x = ENEMY_RADIUS; e.vx = Math.abs(e.vx); }
      if (e.x > 1 - ENEMY_RADIUS) { e.x = 1 - ENEMY_RADIUS; e.vx = -Math.abs(e.vx); }

      // Shot down by one of our lasers?
      let destroyed = false;
      for (let j = lasers.length - 1; j >= 0; j--) {
        const l = lasers[j];
        const r = ENEMY_RADIUS + LASER_RADIUS + 0.008;
        if ((l.x - e.x) ** 2 + (l.y - e.y) ** 2 < r * r) {
          lasers.splice(j, 1);
          explode(e.x, e.y, e.color, 10);
          destroyed = true;
          break;
        }
      }
      if (destroyed) { enemies.splice(i, 1); continue; }

      // Hit our ship?
      if (!dead) {
        const r = SHIP_RADIUS + ENEMY_RADIUS;
        if ((ship.x - e.x) ** 2 + (ship.y - e.y) ** 2 < r * r) {
          enemies.splice(i, 1);
          if (shielded) {
            explode(e.x, e.y, '#ffffff', 8);
          } else {
            send({ type: 'hit', id: e.id });
            explode(e.x, e.y, e.color, 18);
            hitFlash = 1;
            vibrate(80);
          }
          continue;
        }
      }

      if (e.y - ENEMY_RADIUS > H) enemies.splice(i, 1);
    }

    // Particles and background
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt * p.decay;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.97;
      p.vy *= 0.97;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (const s of stars) {
      s.y += s.speed * dt;
      if (s.y > H) { s.y -= H; s.x = Math.random(); }
    }
    hitFlash = Math.max(0, hitFlash - dt * 3);
    updateStatus(now);
  }

  function explode(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.1 + Math.random() * (count > 30 ? 0.9 : 0.5);
      particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, decay: 1.5 + Math.random(), color,
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
    // A page loaded in a hidden or collapsed view can report 0; never divide by it.
    cssW = Math.max(1, gameScreen.clientWidth || window.innerWidth);
    cssH = Math.max(1, gameScreen.clientHeight || window.innerHeight);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    H = cssH / cssW;
    laneLabelY = (hud.getBoundingClientRect().bottom + 22) / cssW;
    stars = Array.from({ length: 70 }, () => ({
      x: Math.random(), y: Math.random() * H, speed: 0.03 + Math.random() * 0.12, size: Math.random() < 0.2 ? 0.006 : 0.003,
    }));
    if (!Number.isFinite(ship.y) || !Number.isFinite(ship.ty) || ship.y > H || ship.y === 1.5) {
      ship.y = ship.ty = H - 0.25;
    }
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  function draw(now) {
    const s = cssW * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07080f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);

    // Stars
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (const st of stars) ctx.fillRect(st.x, st.y, st.size, st.size);

    // Opponent lanes
    const opps = opponents();
    const laneW = opps.length > 0 ? 1 / opps.length : 1;
    opps.forEach((p, i) => {
      const x0 = i * laneW;
      const dead = isDead(p.id, now);
      const grad = ctx.createLinearGradient(0, 0, 0, H * 0.6);
      grad.addColorStop(0, hexToRgba(dead ? '#888888' : p.color, 0.22));
      grad.addColorStop(1, hexToRgba(dead ? '#888888' : p.color, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(x0, 0, laneW, H * 0.6);
      ctx.fillStyle = dead ? '#666' : p.color;
      ctx.fillRect(x0, 0, laneW, 0.012);
      if (i > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x0 - 0.002, 0, 0.004, H * 0.35);
      }

      const label = dead ? `💀 ${p.name}` : p.name;
      const hearts = dead ? '' : '❤'.repeat(Math.max(0, p.hp));
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = dead ? '#888' : p.color;
      const fontSize = Math.min(0.045, laneW * 0.16);
      ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
      ctx.fillText(fitText(label, laneW * 0.92), x0 + laneW / 2, laneLabelY);
      ctx.font = `${fontSize * 0.8}px system-ui, sans-serif`;
      ctx.fillText(hearts, x0 + laneW / 2, laneLabelY + fontSize * 1.1);
      ctx.restore();
    });

    // Lasers
    ctx.save();
    ctx.shadowColor = me.color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = me.color;
    for (const l of lasers) {
      ctx.save();
      ctx.translate(l.x, l.y);
      ctx.rotate(Math.atan2(l.vx, -l.vy));
      roundRect(-LASER_RADIUS * 0.6, -LASER_RADIUS * 3, LASER_RADIUS * 1.2, LASER_RADIUS * 6, LASER_RADIUS * 0.6);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // Enemy shots
    for (const e of enemies) {
      ctx.save();
      ctx.shadowColor = e.color;
      ctx.shadowBlur = 20;
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(e.x, e.y, ENEMY_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(e.x, e.y, ENEMY_RADIUS * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Ship
    if (!isDead(me.id, now)) drawShip(now);

    // Particles
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 0.005, p.y - 0.005, 0.01, 0.01);
    }
    ctx.globalAlpha = 1;

    if (hitFlash > 0) {
      ctx.fillStyle = `rgba(255,60,80,${hitFlash * 0.3})`;
      ctx.fillRect(0, 0, 1, H);
    }
  }

  function drawShip(now) {
    const { x, y } = ship;
    const tilt = Math.max(-0.35, Math.min(0.35, ship.vx * 0.08));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);

    // Engine flame
    const flame = 0.03 + Math.random() * 0.02 + (firing ? 0.01 : 0);
    ctx.fillStyle = 'rgba(255,184,77,0.9)';
    ctx.beginPath();
    ctx.moveTo(-SHIP_WIDTH * 0.18, SHIP_HEIGHT * 0.35);
    ctx.lineTo(SHIP_WIDTH * 0.18, SHIP_HEIGHT * 0.35);
    ctx.lineTo(0, SHIP_HEIGHT * 0.35 + flame);
    ctx.closePath();
    ctx.fill();

    // Hull
    ctx.shadowColor = me.color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = me.color;
    ctx.beginPath();
    ctx.moveTo(0, -SHIP_HEIGHT * 0.6);
    ctx.lineTo(SHIP_WIDTH / 2, SHIP_HEIGHT * 0.4);
    ctx.lineTo(0, SHIP_HEIGHT * 0.2);
    ctx.lineTo(-SHIP_WIDTH / 2, SHIP_HEIGHT * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(0, -SHIP_HEIGHT * 0.08, SHIP_WIDTH * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Shield bubble
    if (myShieldUntil > now) {
      const remaining = myShieldUntil - now;
      const blink = remaining < 600 ? (Math.floor(now / 80) % 2) : 1;
      if (blink) {
        ctx.save();
        ctx.strokeStyle = 'rgba(180,240,255,0.8)';
        ctx.lineWidth = 0.006;
        ctx.beginPath();
        ctx.arc(x, y - 0.01, SHIP_RADIUS * 1.7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function fitText(text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
    return `${t}…`;
  }

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
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

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  resize();
  connect();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt, now);
    draw(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Expose a tiny hook for automated tests.
  window.__blaster = {
    ship, lasers, enemies,
    get players() { return players; },
    get me() { return me; },
    setFiring(v) { firing = v; },
  };
})();
