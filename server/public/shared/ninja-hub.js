'use strict';

// Katana-Küche hub: ninjas hop around one shared dojo and slice fruit and vegetables
// that fall from the sky. Like the Schießbude, the falling paths are deterministic
// functions of the hub clock (`fruitPosition`), so every phone draws them itself. Each
// phone simulates its own ninja (instant swipe jumps) and reports its position; cuts
// are claimed by the phone and validated here, first claim wins.
//
// World units: x from the left wall (0 … WIDTH), y up from the floor (0 … HEIGHT).
// Transport-agnostic like the other hubs: runs in Node (server.js) and in the browser
// of the hosting phone.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PloinkNinjaHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function randomHex(bytes) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Mutable on purpose: tests shorten the timings. Clients read the physics from here.
  const CONFIG = {
    width: 10,
    height: 16,                 // tall: fills a portrait phone, fruit enters right under the HUD
    roundMs: 75_000,
    countdownMs: 3_000,
    tickMs: 66,                 // position snapshots ≈ 15 per second

    gravity: 26,
    jumpSpeed: 14,
    spinSpeed: 15,              // rad/s while airborne: the ninja rolls, the katana spins with him
    slashMs: 320,               // tap on the ground: a spin in place
    bladeReach: 1.25,           // centre of the ninja to the tip of the katana
    ninjaRadius: 0.42,
    maxFallSpeed: 18,

    baseSpawnPerSecond: 1.0,
    spawnPerSecondPerPlayer: 0.3,
    rampUp: 0.6,                // spawn rate grows by this factor over the round
    salvoEveryMs: 9_000,        // a row of fruit across the whole dojo
    comboWindowMs: 900,
    comboBonus: 5,
    maxComboBonus: 25,
    stunMs: 1_300,
    bumpSpeed: 9,
    bumpCooldownMs: 600,
    kickSteal: 10,              // points a kick takes from the kicked ninja
    clashSpeed: 8,              // two spinning katanas bounce both ninjas apart
    spinFreshMs: 400,           // a reported spin counts for this long

    cutTolerance: 0.9,          // slack for latency when checking a claimed cut
    positionTolerance: 2.5,     // claimed position vs. the last reported one
    disconnectGraceMs: 60_000,
    maxPlayersPerRoom: 6,
    maxNameLength: 16,
  };

  // One-way bamboo platforms: [left, right, height].
  const PLATFORMS = [
    [1.0, 3.6, 4.2],
    [6.4, 9.0, 4.2],
    [3.7, 6.3, 8.0],
    [0.6, 3.0, 11.6],
    [7.0, 9.4, 11.6],
  ];

  const FRUITS = {
    apple:      { points: 10, weight: 18, r: 0.34 },
    orange:     { points: 10, weight: 16, r: 0.36 },
    tomato:     { points: 10, weight: 14, r: 0.3 },
    carrot:     { points: 15, weight: 12, r: 0.32 },
    eggplant:   { points: 15, weight: 10, r: 0.36 },
    banana:     { points: 15, weight: 10, r: 0.36 },
    pineapple:  { points: 20, weight: 7, r: 0.42 },
    watermelon: { points: 25, weight: 6, r: 0.55 },
    golden:     { points: 50, weight: 2, r: 0.3 },
    nest:       { points: -25, weight: 8, r: 0.4 },   // wasp nest: costs points and stuns
  };

  const COLORS = ['#ff5d73', '#4dd6ff', '#7ee081', '#ffb84d', '#c77dff', '#ffe156'];

  const rooms = new Map();
  let nextFruitId = 1;

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  const round2 = (v) => Math.round(v * 100) / 100;

  function sanitizeName(raw, fallback) {
    const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, CONFIG.maxNameLength);
    return name || fallback;
  }

  function pickFruitType() {
    const total = Object.values(FRUITS).reduce((s, f) => s + f.weight, 0);
    let r = Math.random() * total;
    for (const [type, def] of Object.entries(FRUITS)) {
      r -= def.weight;
      if (r <= 0) return type;
    }
    return 'apple';
  }

  /** Position and rotation of a fruit at hub time `now` (same formula on every phone). */
  function fruitPosition(f, now) {
    const t = Math.max(0, (now - f.t0) / 1000);
    // Bounce between the walls: fold the straight path into [r, width - r].
    const span = CONFIG.width - 2 * f.r;
    let u = (f.x0 - f.r + f.vx * t) % (2 * span);
    if (u < 0) u += 2 * span;
    return {
      x: f.r + (u <= span ? u : 2 * span - u),
      y: f.y0 - f.v0 * t - 0.5 * f.g * t * t,
      rot: f.rot0 + f.spin * t,
    };
  }

  /** Milliseconds until the fruit touches the floor. */
  function fruitLifetime(f) {
    const drop = f.y0 - f.r;
    return ((-f.v0 + Math.sqrt(f.v0 * f.v0 + 2 * f.g * drop)) / f.g) * 1000;
  }

  class NinjaRoom {
    constructor(code) {
      this.code = code;
      this.players = new Map(); // token -> player
      this.fruits = new Map();
      this.phase = 'lobby';     // lobby | countdown | playing
      this.phaseEndsAt = 0;
      this.lastResults = null;
      this.colorIndex = 0;
      this.timer = null;
      this.phaseTimer = null;
      this.spawnBudget = 0;
      this.nextSalvoAt = 0;
    }

    connected() {
      return [...this.players.values()].filter((p) => p.socket);
    }

    broadcast(msg) {
      const data = JSON.stringify(msg);
      for (const p of this.players.values()) {
        if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(data);
      }
    }

    broadcastState() {
      this.broadcast({
        type: 'state',
        phase: this.phase,
        phaseEndsAt: this.phaseEndsAt,
        serverNow: Date.now(),
        players: [...this.players.values()].map((p) => ({
          id: p.id, name: p.name, color: p.color, score: p.score, connected: !!p.socket,
        })),
        lastResults: this.lastResults,
      });
    }

    startLoop() {
      if (!this.timer) this.timer = setInterval(() => this.tick(), CONFIG.tickMs);
    }

    stopLoop() {
      clearInterval(this.timer);
      this.timer = null;
    }

    startCountdown() {
      if (this.phase !== 'lobby' || this.connected().length === 0) return;
      this.phase = 'countdown';
      this.phaseEndsAt = Date.now() + CONFIG.countdownMs;
      this.broadcastState();
      clearTimeout(this.phaseTimer);
      this.phaseTimer = setTimeout(() => this.startRound(), CONFIG.countdownMs);
    }

    startRound() {
      const now = Date.now();
      this.phase = 'playing';
      this.phaseEndsAt = now + CONFIG.roundMs;
      this.fruits.clear();
      this.spawnBudget = 1;
      this.nextSalvoAt = now + CONFIG.salvoEveryMs;
      for (const p of this.players.values()) {
        p.score = 0;
        p.chain = 0;
        p.stunnedUntil = 0;
      }
      this.broadcastState();
      clearTimeout(this.phaseTimer);
      this.phaseTimer = setTimeout(() => this.endRound(), CONFIG.roundMs);
    }

    endRound() {
      clearTimeout(this.phaseTimer);
      this.phase = 'lobby';
      this.phaseEndsAt = 0;
      this.fruits.clear();
      this.lastResults = [...this.players.values()]
        .sort((a, b) => b.score - a.score)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score }));
      this.broadcast({ type: 'roundEnd', results: this.lastResults });
      this.broadcastState();
    }

    tick() {
      const now = Date.now();
      if (this.phase === 'playing') {
        for (const [id, f] of this.fruits) {
          if (f.t0 + fruitLifetime(f) + 500 < now) this.fruits.delete(id);
        }
        const progress = 1 - Math.max(0, this.phaseEndsAt - now) / CONFIG.roundMs;
        const rate = (CONFIG.baseSpawnPerSecond + CONFIG.spawnPerSecondPerPlayer * this.connected().length)
          * (1 + CONFIG.rampUp * progress);
        this.spawnBudget += rate * (CONFIG.tickMs / 1000);
        while (this.spawnBudget >= 1) {
          this.spawnBudget -= 1 + Math.random() * 0.5;
          this.spawnFruit(now);
        }
        if (now >= this.nextSalvoAt) {
          this.nextSalvoAt = now + CONFIG.salvoEveryMs * rand(0.8, 1.2);
          this.spawnSalvo(now);
        }
      }
      // Ninja positions go out in every phase except the lobby, which covers the dojo.
      if (this.phase !== 'lobby') {
        this.broadcast({
          type: 'ninjas',
          list: this.connected().filter((p) => p.pos).map((p) => [
            p.id, p.pos.x, p.pos.y, p.pos.rot, p.pos.air, now < p.stunnedUntil ? 1 : 0, p.pos.facing,
          ]),
        });
      }
      if (this.connected().length === 0) this.stopLoop();
    }

    spawnFruit(now, overrides = {}) {
      const type = overrides.type || pickFruitType();
      const def = FRUITS[type];
      const fruit = {
        id: nextFruitId++,
        type,
        t0: now,
        r: def.r,
        x0: rand(def.r + 0.2, CONFIG.width - def.r - 0.2),
        y0: CONFIG.height + 2.5,
        vx: rand(-0.9, 0.9),
        v0: rand(0.3, 1.4),
        g: rand(2.0, 3.2),
        rot0: rand(0, Math.PI * 2),
        spin: rand(-2.5, 2.5),
        points: def.points,
        ...overrides,
      };
      this.fruits.set(fruit.id, fruit);
      this.broadcast({ type: 'spawn', fruit });
      return fruit;
    }

    /** A row of fruit across the dojo, falling together. */
    spawnSalvo(now) {
      const count = 5;
      const g = rand(2.2, 2.8);
      for (let i = 0; i < count; i++) {
        let type = pickFruitType();
        if (type === 'nest') type = 'apple';
        this.spawnFruit(now, { type, r: FRUITS[type].r, points: FRUITS[type].points, x0: 1 + i * 2, vx: 0, v0: 0.6, g });
      }
    }

    reportPosition(player, msg) {
      player.pos = {
        x: round2(clamp(msg.x, 0, CONFIG.width)),
        y: round2(clamp(msg.y, 0, CONFIG.height + 3)),
        rot: round2(Number(msg.rot) || 0),
        air: msg.air ? 1 : 0,
        facing: Number(msg.facing) < 0 ? -1 : 1,
        at: Date.now(),
      };
    }

    cut(player, msg) {
      if (this.phase !== 'playing') return;
      const fruit = this.fruits.get(Number(msg.id));
      if (!fruit) return;
      const now = Date.now();
      if (now < player.stunnedUntil) return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      // The claimed blade position must match the last reported ninja …
      if (player.pos && Math.hypot(x - player.pos.x, y - player.pos.y) > CONFIG.positionTolerance) return;
      // … and the fruit must have been within reach shortly before now (latency).
      const reach = CONFIG.bladeReach + fruit.r + CONFIG.cutTolerance;
      let near = false;
      for (let back = 0; back <= 300 && !near; back += 50) {
        const pos = fruitPosition(fruit, now - back);
        near = Math.hypot(pos.x - x, pos.y - y) <= reach;
      }
      if (!near) return;

      this.fruits.delete(fruit.id);
      let points = fruit.points;
      if (fruit.type === 'nest') {
        player.chain = 0;
        player.stunnedUntil = now + CONFIG.stunMs;
        player.send({ type: 'stunned', ms: CONFIG.stunMs });
      } else {
        player.chain = now - player.lastCutAt <= CONFIG.comboWindowMs ? player.chain + 1 : 1;
        player.lastCutAt = now;
        points += Math.min(CONFIG.maxComboBonus, (player.chain - 1) * CONFIG.comboBonus);
      }
      player.score += points;
      this.broadcast({
        type: 'cut',
        id: fruit.id,
        points,
        chain: player.chain,
        angle: round2(Number(msg.angle) || 0),
        by: { id: player.id, name: player.name, color: player.color },
      });
      this.broadcastState();
    }

    /**
     * The spinning katana of `player` hits another ninja. If that ninja is spinning too,
     * the blades clash and both bounce apart; otherwise it is a kick that knocks the
     * other ninja away and steals some of their points.
     */
    bump(player, msg) {
      if (this.phase === 'lobby') return;
      const now = Date.now();
      if (now < player.bumpReadyAt || now < player.stunnedUntil || !player.pos) return;
      const target = this.connected().find((p) => p.id === msg.id && p !== player);
      if (!target || !target.pos) return;
      const dx = target.pos.x - player.pos.x;
      const dy = target.pos.y - player.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > CONFIG.bladeReach + CONFIG.ninjaRadius + CONFIG.positionTolerance) return;
      const len = dist || 1;
      const ux = dist ? dx / len : 1;
      const uy = dist ? dy / len : 0;
      const at = { x: round2((player.pos.x + target.pos.x) / 2), y: round2((player.pos.y + target.pos.y) / 2) };
      const who = (p) => ({ id: p.id, name: p.name, color: p.color });
      player.bumpReadyAt = now + CONFIG.bumpCooldownMs;

      const targetSpinning = target.pos.air && now - target.pos.at <= CONFIG.spinFreshMs && now >= target.stunnedUntil;
      if (targetSpinning) {
        target.bumpReadyAt = now + CONFIG.bumpCooldownMs; // its own report of the same contact is ignored
        const push = (sign) => [round2(sign * ux * CONFIG.clashSpeed), round2(Math.max(0.5, sign * uy + 0.7) * CONFIG.clashSpeed * 0.6)];
        this.broadcast({
          type: 'clash', ...at, a: who(player), b: who(target),
          push: { [player.id]: push(-1), [target.id]: push(1) },
        });
        return;
      }

      const points = this.phase === 'playing' ? Math.min(CONFIG.kickSteal, Math.max(0, target.score)) : 0;
      target.score -= points;
      player.score += points;
      this.broadcast({
        type: 'kick', ...at, by: who(player), target: who(target), points,
        vx: round2(ux * CONFIG.bumpSpeed),
        vy: round2(Math.max(0.4, uy + 0.6) * CONFIG.bumpSpeed * 0.7),
      });
      if (points) this.broadcastState();
    }

    removeIfEmpty() {
      if (this.players.size === 0) {
        this.stopLoop();
        clearTimeout(this.phaseTimer);
        rooms.delete(this.code);
      }
    }
  }

  class NinjaPlayer {
    constructor(room, token, name) {
      this.id = randomHex(4);
      this.token = token;
      this.name = name;
      this.color = COLORS[room.colorIndex++ % COLORS.length];
      this.slot = room.players.size;
      this.score = 0;
      this.chain = 0;
      this.lastCutAt = 0;
      this.stunnedUntil = 0;
      this.bumpReadyAt = 0;
      this.pos = null;
      this.socket = null;
      this.removeTimer = null;
    }

    send(msg) {
      if (this.socket && this.socket.readyState === this.socket.OPEN) {
        this.socket.send(JSON.stringify(msg));
      }
    }
  }

  function handleJoin(socket, msg) {
    const code = String(msg.code || '');
    if (!/^\d{2}$/.test(code)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Der Code muss zweistellig sein (00–99).' }));
      return null;
    }
    const token = /^[a-zA-Z0-9-]{8,64}$/.test(msg.token || '') ? msg.token : randomHex(16);

    let room = rooms.get(code);
    if (!room) {
      room = new NinjaRoom(code);
      rooms.set(code, room);
    }

    let player = room.players.get(token);
    if (player) {
      clearTimeout(player.removeTimer);
      if (player.socket && player.socket !== socket) {
        const old = player.socket;
        player.socket = null;
        old.close(4000, 'replaced');
      }
      player.name = sanitizeName(msg.name, player.name);
    } else {
      if (room.players.size >= CONFIG.maxPlayersPerRoom) {
        socket.send(JSON.stringify({ type: 'error', message: 'Dieser Dojo ist voll (höchstens 6 Ninjas).' }));
        return null;
      }
      player = new NinjaPlayer(room, token, sanitizeName(msg.name, `Ninja ${room.players.size + 1}`));
      room.players.set(token, player);
    }

    player.socket = socket;
    // Starting spot on the floor, spread across the dojo.
    const startX = round2(1 + ((player.slot * 3.1) % (CONFIG.width - 2)));
    player.send({
      type: 'joined', code, you: player.id, token, color: player.color, name: player.name,
      serverNow: Date.now(), startX,
    });
    if (room.phase === 'playing') player.send({ type: 'fruits', list: [...room.fruits.values()] });
    room.broadcast({ type: 'event', kind: 'join', id: player.id, name: player.name, color: player.color });
    room.broadcastState();
    room.startLoop();
    return { room, player };
  }

  /** Attach one client connection (WebSocket or peer-to-peer adapter). */
  function handleConnection(socket) {
    let session = null;

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', t: Number(msg.t) || 0, server: Date.now() }));
        return;
      }
      if (msg.type === 'join') {
        if (!session) session = handleJoin(socket, msg);
        return;
      }
      if (!session) return;
      const { room, player } = session;

      switch (msg.type) {
        case 'pos':
          room.reportPosition(player, msg);
          break;
        case 'cut':
          room.cut(player, msg);
          break;
        case 'bump':
          room.bump(player, msg);
          break;
        case 'start':
          room.startCountdown();
          break;
        case 'stop':
          if (room.phase !== 'lobby') room.endRound();
          break;
        default:
          break;
      }
    });

    socket.on('close', () => {
      if (!session) return;
      const { room, player } = session;
      if (player.socket !== socket) return; // replaced by a newer connection
      player.socket = null;
      player.removeTimer = setTimeout(() => {
        room.players.delete(player.token);
        room.broadcastState();
        room.removeIfEmpty();
      }, CONFIG.disconnectGraceMs);
      room.broadcastState();
    });
  }

  return { handleConnection, fruitPosition, fruitLifetime, rooms, CONFIG, FRUITS, PLATFORMS };
});
