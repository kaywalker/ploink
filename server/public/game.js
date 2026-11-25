'use strict';

// Ploink client.
// World coordinates: the screen is 1 unit wide and H units tall (H = height / width).
// Balls enter at the top, bounce off the side walls, can be returned with the paddle
// and fly to another player's phone when they leave the top edge.

(() => {
  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  const BALL_RADIUS = 0.04;
  const PADDLE_WIDTH = 0.3;
  const PADDLE_HEIGHT = 0.035;
  const PADDLE_BOTTOM_GAP = 0.14;   // distance between paddle and bottom edge
  const MAX_BOUNCE_ANGLE = (60 * Math.PI) / 180;
  const SPEED_UP = 1.06;            // speed multiplier per paddle hit
  const MAX_SPEED = 2.4;
  const KEYBOARD_SPEED = 1.8;       // paddle speed for arrow keys, widths/sec
  const RECONNECT_DELAY_MS = 1200;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const joinScreen = $('join');
  const gameScreen = $('game');
  const joinForm = $('join-form');
  const codeInput = $('code');
  const nameInput = $('name');
  const joinError = $('join-error');
  const joinButton = $('join-button');
  const randomCodeButton = $('random-code');
  const canvas = $('field');
  const ctx = canvas.getContext('2d');
  const statusEl = $('status');
  const toastsEl = $('toasts');
  const offlineEl = $('offline');
  const board = $('board');
  const boardList = $('board-list');

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------
  const storage = {
    get(store, key) {
      try { return store.getItem(key); } catch { return null; }
    },
    set(store, key, value) {
      try { store.setItem(key, value); } catch { /* private mode */ }
    },
  };

  let token = storage.get(sessionStorage, 'ploink-token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    storage.set(sessionStorage, 'ploink-token', token);
  }

  let socket = null;
  let wantConnected = false;
  let reconnectTimer = null;
  let roomCode = null;
  let me = { id: null, name: '', color: '#4dd6ff' };
  let players = [];

  // ---------------------------------------------------------------------------
  // Field state
  // ---------------------------------------------------------------------------
  let cssW = 1;
  let cssH = 1;
  let H = 1;           // world height in widths
  let dpr = 1;
  let indicatorTop = 0.03; // world y below the HUD where incoming balls are announced
  const paddle = { x: 0.5, target: 0.5 };
  const keys = { left: false, right: false };
  /** @type {Map<number, any>} */
  const balls = new Map();
  const particles = [];
  let missFlash = 0;
  let hitFlash = 0;

  // ---------------------------------------------------------------------------
  // Join screen
  // ---------------------------------------------------------------------------
  function initialCode() {
    const fromHash = PloinkNet.roomCodeFromHash();
    const fromQuery = new URLSearchParams(location.search).get('code') || '';
    const code = /^\d{2}$/.test(fromHash) ? fromHash : fromQuery;
    return /^\d{2}$/.test(code) ? code : '';
  }

  codeInput.value = initialCode();
  nameInput.value = storage.get(localStorage, 'ploink-name') || '';
  // A shared "#42" link opens Pong (that is what such links pointed to first);
  // otherwise preselect the mode played last.
  const preferredMode = location.hash ? 'pong' : storage.get(localStorage, 'ploink-mode');
  if (['pong', 'blaster', 'gallery', 'control', 'brawl', 'ninja'].includes(preferredMode)) joinForm.elements.mode.value = preferredMode;

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 2);
    joinError.hidden = true;
    if (codeInput.value.length === 2 && !nameInput.value) nameInput.focus();
  });

  randomCodeButton.addEventListener('click', () => {
    codeInput.value = String(Math.floor(Math.random() * 100)).padStart(2, '0');
    joinError.hidden = true;
    nameInput.focus();
  });

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!/^\d{2}$/.test(code)) {
      showJoinError('Bitte einen zweistelligen Code eingeben (00–99).');
      codeInput.focus();
      return;
    }
    const name = nameInput.value.trim();
    storage.set(localStorage, 'ploink-name', name);
    const mode = joinForm.elements.mode.value;
    storage.set(localStorage, 'ploink-mode', mode);
    const query = location.search; // keeps e.g. ?net=server
    const pages = { blaster: 'shooter.html', gallery: 'gallery.html', control: 'control.html', brawl: 'brawl.html', ninja: 'ninja.html' };
    if (pages[mode]) {
      location.href = `${pages[mode]}${query}#${code}`;
      return;
    }
    roomCode = code;
    me.name = name;
    joinButton.disabled = true;
    requestImmersiveMode();
    connect();
  });

  function showJoinError(message) {
    joinError.textContent = message;
    joinError.hidden = false;
  }

  function requestImmersiveMode() {
    // Hides the browser chrome on Android; silently ignored elsewhere (e.g. iOS).
    const el = document.documentElement;
    if (el.requestFullscreen && matchMedia('(pointer: coarse)').matches) {
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function connect() {
    wantConnected = true;
    clearTimeout(reconnectTimer);
    // WebSocket to the Ploink server, or WebRTC to/as the hosting phone (see shared/net.js).
    const ws = PloinkNet.open({ mode: 'pong', code: roomCode, wsPath: '/ws', hub: window.PloinkPongHub });
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
      balls.clear(); // the server re-throws balls of disconnected players
      if (!wantConnected) return;
      if (gameScreen.hidden) {
        joinButton.disabled = false;
        showJoinError('Keine Verbindung möglich. Bitte nochmal versuchen.');
        wantConnected = false;
        return;
      }
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
        if (msg.token) {
          token = msg.token;
          storage.set(sessionStorage, 'ploink-token', token);
        }
        offlineEl.hidden = true;
        enterGame();
        break;
      case 'error':
        wantConnected = false;
        if (socket) socket.close();
        joinButton.disabled = false;
        showJoinError(msg.message);
        if (!gameScreen.hidden) leaveGame();
        break;
      case 'state':
        players = msg.players;
        renderPlayers();
        break;
      case 'ball':
        receiveBall(msg);
        break;
      case 'event':
        if (msg.kind === 'miss') {
          toast(msg.id === me.id ? 'Verpasst! 😬' : `${msg.name} hat den Ball verpasst!`, msg.color);
        } else if (msg.kind === 'join' && msg.id !== me.id) {
          toast(`${msg.name} ist dabei`, msg.color);
        }
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function enterGame() {
    if (location.hash !== `#${roomCode}`) history.replaceState(null, '', `#${roomCode}`);
    joinScreen.hidden = true;
    gameScreen.hidden = false;
    joinButton.disabled = false;
    $('hud-code').textContent = roomCode;
    $('board-code').textContent = roomCode;
    $('board-code-2').textContent = roomCode;
    $('board-link').textContent = `${location.host}/#${roomCode}`;
    resize();
    requestWakeLock();
  }

  function leaveGame() {
    wantConnected = false;
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
    socket = null;
    balls.clear();
    players = [];
    board.hidden = true;
    offlineEl.hidden = true;
    gameScreen.hidden = true;
    joinScreen.hidden = false;
    history.replaceState(null, '', location.pathname);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  $('leave').addEventListener('click', leaveGame);
  $('room-badge').addEventListener('click', () => { board.hidden = !board.hidden; });
  $('board-close').addEventListener('click', () => { board.hidden = true; });

  let wakeLock = null;
  async function requestWakeLock() {
    // Only available in secure contexts (https or localhost).
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* not supported or denied */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (gameScreen.hidden) return;
    if (document.hidden) {
      // Hand our balls to someone else instead of letting them silently drop.
      balls.clear();
      send({ type: 'away' });
    } else {
      send({ type: 'back' });
      requestWakeLock();
    }
  });

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  function renderPlayers() {
    const self = players.find((p) => p.id === me.id);
    if (self) {
      me.color = self.color;
      me.name = self.name;
      $('hud-hits').textContent = self.hits;
      $('hud-misses').textContent = self.misses;
    }
    $('hud-count').textContent = players.filter((p) => p.connected).length;

    const sorted = [...players].sort((a, b) => (b.hits - b.misses) - (a.hits - a.misses) || b.hits - a.hits);
    boardList.replaceChildren(...sorted.map((p) => {
      const li = document.createElement('li');
      if (p.id === me.id) li.classList.add('me');
      if (!p.connected || p.away) li.classList.add('offline');

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = p.color;

      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name + (p.balls > 0 ? ' ●' : '');
      if (p.id === me.id || !p.connected || p.away) {
        const small = document.createElement('small');
        small.textContent = p.id === me.id ? ' (du)' : !p.connected ? ' (offline)' : ' (pausiert)';
        name.append(small);
      }

      const hits = document.createElement('span');
      hits.className = 'hits';
      hits.textContent = `✓ ${p.hits}`;

      const misses = document.createElement('span');
      misses.className = 'misses';
      misses.textContent = `✕ ${p.misses}`;

      li.append(swatch, name, hits, misses);
      return li;
    }));

    updateStatus();
  }

  function updateStatus() {
    if (balls.size > 0) {
      statusEl.textContent = '';
      return;
    }
    const holders = players.filter((p) => p.balls > 0 && p.id !== me.id);
    const others = players.filter((p) => p.connected && p.id !== me.id);
    statusEl.replaceChildren();
    if (holders.length > 0) {
      statusEl.append('Ball ist bei ');
      holders.forEach((p, i) => {
        if (i > 0) statusEl.append(i === holders.length - 1 ? ' und ' : ', ');
        const strong = document.createElement('strong');
        strong.textContent = p.name;
        strong.style.color = p.color;
        statusEl.append(strong);
      });
      statusEl.append(document.createElement('br'), 'Mach dich bereit …');
    } else if (others.length === 0) {
      statusEl.append('Du bist allein im Raum.', document.createElement('br'), `Lade andere mit Code ${roomCode} ein!`);
    } else {
      statusEl.append('Gleich geht’s weiter …');
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

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  function pointerToPaddle(event) {
    if (!board.hidden && board.contains(event.target)) return;
    paddle.target = event.clientX / cssW;
  }

  gameScreen.addEventListener('pointerdown', pointerToPaddle);
  gameScreen.addEventListener('pointermove', pointerToPaddle);
  // Prevent iOS from scrolling / zooming while dragging the paddle.
  gameScreen.addEventListener('touchmove', (e) => {
    if (!board.contains(e.target)) e.preventDefault();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (gameScreen.hidden) return;
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = true;
    if (e.key === 'ArrowRight' || e.key === 'd') keys.right = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd') keys.right = false;
  });

  // ---------------------------------------------------------------------------
  // Physics
  // ---------------------------------------------------------------------------
  function receiveBall(msg) {
    balls.set(msg.id, {
      id: msg.id,
      seq: msg.seq,
      x: msg.x,
      y: -BALL_RADIUS,
      vx: Math.sin(msg.angle) * msg.speed,
      vy: Math.cos(msg.angle) * msg.speed,
      speed: msg.speed,
      enterAt: performance.now() + msg.delay,
      delay: msg.delay,
      from: msg.from,
      live: false,
      trail: [],
    });
    updateStatus();
  }

  function paddleY() {
    return H - PADDLE_BOTTOM_GAP;
  }

  function step(dt, now) {
    // Paddle
    if (keys.left) paddle.target = paddle.x - KEYBOARD_SPEED * dt;
    if (keys.right) paddle.target = paddle.x + KEYBOARD_SPEED * dt;
    const half = PADDLE_WIDTH / 2;
    paddle.target = Math.min(1 - half, Math.max(half, paddle.target));
    paddle.x = paddle.target;

    const py = paddleY();
    for (const ball of balls.values()) {
      if (!ball.live) {
        if (now >= ball.enterAt) ball.live = true;
        else continue;
      }

      // Sub-steps keep fast balls from tunnelling through the paddle.
      const steps = Math.max(1, Math.ceil((ball.speed * dt) / (BALL_RADIUS * 0.5)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const prevY = ball.y;
        ball.x += ball.vx * h;
        ball.y += ball.vy * h;

        if (ball.x < BALL_RADIUS) { ball.x = BALL_RADIUS; ball.vx = Math.abs(ball.vx); }
        if (ball.x > 1 - BALL_RADIUS) { ball.x = 1 - BALL_RADIUS; ball.vx = -Math.abs(ball.vx); }

        const crossesPaddle = ball.vy > 0 && prevY + BALL_RADIUS <= py + 0.001 && ball.y + BALL_RADIUS >= py;
        const withinPaddle = Math.abs(ball.x - paddle.x) <= half + BALL_RADIUS;
        if (crossesPaddle && withinPaddle) {
          bounceOffPaddle(ball, py);
          continue;
        }

        if (ball.vy < 0 && ball.y < -BALL_RADIUS) {
          send({
            type: 'exit',
            id: ball.id,
            seq: ball.seq,
            x: ball.x,
            angle: Math.atan2(ball.vx, -ball.vy),
            speed: ball.speed,
          });
          balls.delete(ball.id);
          updateStatus();
          break;
        }

        if (ball.y - BALL_RADIUS > H) {
          send({ type: 'miss', id: ball.id, seq: ball.seq });
          balls.delete(ball.id);
          missFlash = 1;
          vibrate([60, 40, 60]);
          updateStatus();
          break;
        }
      }

      ball.trail.push({ x: ball.x, y: ball.y });
      if (ball.trail.length > 10) ball.trail.shift();
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt * 2.2;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 1.2 * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    missFlash = Math.max(0, missFlash - dt * 1.8);
    hitFlash = Math.max(0, hitFlash - dt * 4);
  }

  function bounceOffPaddle(ball, py) {
    const offset = Math.max(-1, Math.min(1, (ball.x - paddle.x) / (PADDLE_WIDTH / 2 + BALL_RADIUS)));
    const angle = offset * MAX_BOUNCE_ANGLE;
    ball.speed = Math.min(MAX_SPEED, ball.speed * SPEED_UP);
    ball.vx = Math.sin(angle) * ball.speed;
    ball.vy = -Math.cos(angle) * ball.speed;
    ball.y = py - BALL_RADIUS;
    hitFlash = 1;
    vibrate(18);
    for (let i = 0; i < 12; i++) {
      const a = Math.PI + Math.random() * Math.PI;
      const s = 0.2 + Math.random() * 0.5;
      particles.push({ x: ball.x, y: py, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, color: me.color });
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
    H = cssH / cssW;
    const hud = document.querySelector('.hud');
    indicatorTop = (hud.getBoundingClientRect().bottom + 8) / cssW;
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  function draw(now) {
    const s = cssW * dpr; // world units -> device pixels
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bg.addColorStop(0, '#141833');
    bg.addColorStop(1, '#0d0f1a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(s, 0, 0, s, 0, 0);

    // Center grid lines for a sense of depth
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 2 / s;
    for (let y = 0.25; y < H; y += 0.25) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1, y);
      ctx.stroke();
    }

    // Side walls
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(0, 0, 0.012, H);
    ctx.fillRect(1 - 0.012, 0, 0.012, H);

    // Open top edge (portal to the other phones)
    ctx.save();
    ctx.setLineDash([0.03, 0.025]);
    ctx.strokeStyle = 'rgba(77,214,255,0.5)';
    ctx.lineWidth = 0.006;
    ctx.beginPath();
    ctx.moveTo(0, 0.003);
    ctx.lineTo(1, 0.003);
    ctx.stroke();
    ctx.restore();

    // Goal zone at the bottom
    const goal = ctx.createLinearGradient(0, H - 0.12, 0, H);
    goal.addColorStop(0, 'rgba(255,93,115,0)');
    goal.addColorStop(1, `rgba(255,93,115,${0.22 + missFlash * 0.5})`);
    ctx.fillStyle = goal;
    ctx.fillRect(0, H - 0.12, 1, 0.12);

    // Incoming indicators
    for (const ball of balls.values()) {
      if (ball.live) continue;
      const remaining = Math.max(0, ball.enterAt - now);
      const progress = ball.delay > 0 ? 1 - remaining / ball.delay : 1;
      const pulse = 0.6 + 0.4 * Math.sin(now / 90);
      const color = ball.from ? ball.from.color : '#ffe156';

      ctx.save();
      ctx.globalAlpha = 0.35 + 0.65 * pulse;
      ctx.fillStyle = color;
      ctx.beginPath();
      const tx = ball.x;
      const ty = indicatorTop + progress * 0.05;
      ctx.moveTo(tx - 0.05, ty);
      ctx.lineTo(tx + 0.05, ty);
      ctx.lineTo(tx, ty + 0.06);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      if (ball.from) {
        ctx.save();
        ctx.font = `600 ${0.042}px system-ui, sans-serif`;
        ctx.textAlign = tx < 0.25 ? 'left' : tx > 0.75 ? 'right' : 'center';
        ctx.fillStyle = color;
        ctx.fillText(`von ${ball.from.name}`, Math.min(0.97, Math.max(0.03, tx)), ty + 0.12);
        ctx.restore();
      }
    }

    // Balls
    for (const ball of balls.values()) {
      if (!ball.live) continue;
      ball.trail.forEach((p, i) => {
        const a = (i + 1) / ball.trail.length;
        ctx.fillStyle = `rgba(255,225,86,${a * 0.25})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, BALL_RADIUS * (0.4 + a * 0.5), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.save();
      ctx.shadowColor = '#ffe156';
      ctx.shadowBlur = 24;
      ctx.fillStyle = '#ffe156';
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Particles
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 0.006, p.y - 0.006, 0.012, 0.012);
    }
    ctx.globalAlpha = 1;

    // Paddle
    const py = paddleY();
    ctx.save();
    ctx.shadowColor = me.color;
    ctx.shadowBlur = 18 + hitFlash * 30;
    ctx.fillStyle = me.color;
    roundRect(paddle.x - PADDLE_WIDTH / 2, py, PADDLE_WIDTH, PADDLE_HEIGHT, PADDLE_HEIGHT / 2);
    ctx.fill();
    ctx.restore();

    // Miss flash
    if (missFlash > 0) {
      ctx.fillStyle = `rgba(255,93,115,${missFlash * 0.25})`;
      ctx.fillRect(0, 0, 1, H);
    }
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
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!gameScreen.hidden) {
      step(dt, now);
      draw(now);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Expose a tiny hook for automated tests.
  window.__ploink = { balls, paddle, get players() { return players; } };
})();
