'use strict';

// Schießbude hub: rounds, seats and deterministic target paths for the panorama.
// Transport-agnostic game logic. Runs in Node (server.js) and in the browser of the
// hosting phone (peer-to-peer mode). A "socket" only needs: on('message'|'close', fn),
// send(string), readyState/OPEN and close(code, reason).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PloinkGalleryHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Random hex string; works in Node 22 and in browsers without a secure context. */
  function randomHex(bytes) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }


  const CONFIG = {
    roundMs: 90_000,
    countdownMs: 3_000,
    tickMs: 100,
    baseSpawnPerSecond: 0.45,
    spawnPerSecondPerSeat: 0.35,
    disconnectGraceMs: 60_000,
    maxPlayersPerRoom: 12,
    maxNameLength: 16,
    hitSeatTolerance: 0.6,      // how far outside its own phone a target may be when hit
  };

  const TARGETS = {
    balloon: { points: 10, weight: 35 },
    ufo: { points: 25, weight: 33 },
    drone: { points: 50, weight: 12 },
    bomb: { points: -30, weight: 20 },
  };

  const COLORS = [
    '#ff5d73', '#4dd6ff', '#7ee081', '#ffb84d', '#c77dff',
    '#ffe156', '#ff7ac6', '#5fffd0', '#7d8bff', '#ff9f68',
  ];

  /** @type {Map<string, GalleryRoom>} */
  const rooms = new Map();
  let nextTargetId = 1;

  const rand = (a, b) => a + Math.random() * (b - a);

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, Number(v) || 0));
  }

  function sanitizeName(raw, fallback) {
    const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, CONFIG.maxNameLength);
    return name || fallback;
  }

  function pickTargetType() {
    const total = Object.values(TARGETS).reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const [type, def] of Object.entries(TARGETS)) {
      r -= def.weight;
      if (r <= 0) return type;
    }
    return 'balloon';
  }

  /** Position of a target at server time `now` (same formula as the client). */
  function targetPosition(t, now) {
    const dt = (now - t.t0) / 1000;
    return {
      x: t.x0 + t.vx * dt + t.ax * Math.sin(t.fx * dt + t.ph),
      y: t.y0 + t.vy * dt + t.ay * Math.sin(t.fy * dt + t.ph),
    };
  }

  class GalleryRoom {
    constructor(code) {
      this.code = code;
      /** @type {Map<string, GalleryPlayer>} keyed by client token */
      this.players = new Map();
      /** Seat order, left to right. */
      this.order = [];
      /** @type {Map<number, object>} */
      this.targets = new Map();
      this.phase = 'lobby';           // lobby | countdown | playing
      this.phaseEndsAt = 0;
      this.lastResults = null;
      this.colorIndex = 0;
      this.timer = null;
      this.spawnBudget = 0;
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
        seats: this.order.map((p) => ({
          id: p.id, name: p.name, color: p.color, score: p.score, connected: !!p.socket,
        })),
        lastResults: this.lastResults,
      });
    }

    seatOf(player) {
      return this.order.indexOf(player);
    }

    move(player, dir) {
      if (this.phase !== 'lobby') return;
      const i = this.seatOf(player);
      const j = i + (dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= this.order.length) return;
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      this.broadcastState();
    }

    startCountdown() {
      if (this.phase !== 'lobby') return;
      // Seats of players that left are closed before a new round.
      this.order = this.order.filter((p) => p.socket);
      if (this.order.length === 0) return;
      this.phase = 'countdown';
      this.phaseEndsAt = Date.now() + CONFIG.countdownMs;
      this.broadcastState();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.startRound(), CONFIG.countdownMs);
    }

    startRound() {
      this.phase = 'playing';
      this.phaseEndsAt = Date.now() + CONFIG.roundMs;
      this.targets.clear();
      this.spawnBudget = 1;
      for (const p of this.players.values()) p.score = 0;
      this.broadcastState();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), CONFIG.tickMs);
    }

    tick() {
      const now = Date.now();
      if (now >= this.phaseEndsAt) {
        this.endRound();
        return;
      }
      for (const [id, t] of this.targets) {
        if (t.t0 + t.ttl < now) this.targets.delete(id);
      }
      const seats = Math.max(1, this.order.length);
      this.spawnBudget += (CONFIG.baseSpawnPerSecond + CONFIG.spawnPerSecondPerSeat * seats) * (CONFIG.tickMs / 1000);
      while (this.spawnBudget >= 1) {
        this.spawnBudget -= 1 + Math.random() * 0.4; // a little jitter keeps it organic
        this.spawnTarget(now);
      }
    }

    spawnTarget(now) {
      const seats = Math.max(1, this.order.length);
      const type = pickTargetType();
      const dir = Math.random() < 0.5 ? 1 : -1;
      const edge = dir > 0 ? -0.15 : seats + 0.15;
      let path;
      switch (type) {
        case 'balloon': {
          const vy = -rand(0.07, 0.11);
          path = {
            x0: rand(0.1, seats - 0.1), y0: 1.1, vx: rand(-0.03, 0.03), vy,
            ax: rand(0.02, 0.05), fx: rand(0.8, 1.6), ay: 0, fy: 0, ttl: (1.3 / -vy) * 1000,
          };
          break;
        }
        case 'ufo': {
          const vx = dir * rand(0.25, 0.45);
          path = {
            x0: edge, y0: rand(0.18, 0.55), vx, vy: 0,
            ax: 0, fx: 0, ay: rand(0.03, 0.07), fy: rand(1.5, 3), ttl: ((seats + 0.3) / Math.abs(vx)) * 1000,
          };
          break;
        }
        case 'drone': {
          const vx = dir * rand(0.7, 1.0);
          path = {
            x0: edge, y0: rand(0.15, 0.45), vx, vy: 0,
            ax: 0, fx: 0, ay: rand(0.05, 0.1), fy: rand(4, 6), ttl: ((seats + 0.3) / Math.abs(vx)) * 1000,
          };
          break;
        }
        default: { // bomb
          const vx = dir * rand(0.3, 0.5);
          path = {
            x0: edge, y0: rand(0.3, 0.65), vx, vy: 0,
            ax: 0, fx: 0, ay: 0.02, fy: 1, ttl: ((seats + 0.3) / Math.abs(vx)) * 1000,
          };
        }
      }
      const target = {
        id: nextTargetId++, type, t0: now, ph: rand(0, Math.PI * 2), points: TARGETS[type].points, ...path,
      };
      this.targets.set(target.id, target);
      this.broadcast({ type: 'spawn', target });
    }

    endRound() {
      clearInterval(this.timer);
      clearTimeout(this.timer);
      this.timer = null;
      this.phase = 'lobby';
      this.phaseEndsAt = 0;
      this.targets.clear();
      this.lastResults = [...this.players.values()]
        .filter((p) => this.order.includes(p))
        .sort((a, b) => b.score - a.score)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score }));
      for (const p of this.lastResults) {
        const player = [...this.players.values()].find((q) => q.id === p.id);
        if (player) player.best = Math.max(player.best, p.score);
      }
      this.broadcast({ type: 'roundEnd', results: this.lastResults });
      this.broadcastState();
    }

    shoot(player, targetId) {
      if (this.phase !== 'playing') return;
      const target = this.targets.get(targetId);
      if (!target) return;
      const now = Date.now();
      const seat = this.seatOf(player);
      const pos = targetPosition(target, now);
      if (seat < 0 || pos.x < seat - CONFIG.hitSeatTolerance || pos.x > seat + 1 + CONFIG.hitSeatTolerance) return;

      this.targets.delete(targetId);
      player.score += target.points;
      this.broadcast({
        type: 'pop',
        id: targetId,
        points: target.points,
        by: { id: player.id, name: player.name, color: player.color },
      });
      this.broadcastState();
    }

    removeIfEmpty() {
      if (this.players.size === 0) {
        clearInterval(this.timer);
        clearTimeout(this.timer);
        rooms.delete(this.code);
      }
    }
  }

  class GalleryPlayer {
    constructor(room, token, name) {
      this.id = randomHex(4);
      this.token = token;
      this.name = name;
      this.color = COLORS[room.colorIndex++ % COLORS.length];
      this.score = 0;
      this.best = 0;
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
      room = new GalleryRoom(code);
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
        socket.send(JSON.stringify({ type: 'error', message: 'Dieser Raum ist voll.' }));
        return null;
      }
      player = new GalleryPlayer(room, token, sanitizeName(msg.name, `Schütze ${room.players.size + 1}`));
      room.players.set(token, player);
    }
    if (!room.order.includes(player)) room.order.push(player);

    player.socket = socket;
    player.send({
      type: 'joined', code, you: player.id, token, color: player.color, name: player.name, serverNow: Date.now(),
    });
    if (room.phase === 'playing') {
      player.send({ type: 'targets', list: [...room.targets.values()] });
    }
    room.broadcast({ type: 'event', kind: 'join', id: player.id, name: player.name, color: player.color });
    room.broadcastState();
    return { room, player };
  }

  /** Attach one client connection (WebSocket or peer-to-peer adapter). */
  function handleConnection(socket) {
    /** @type {{room: GalleryRoom, player: GalleryPlayer} | null} */
    let session = null;

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      // Clock sync works before joining, too.
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
        case 'shoot':
          room.shoot(player, Number(msg.id));
          break;
        case 'move':
          room.move(player, clamp(msg.dir, -1, 1));
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
        // Mid-round the seat stays as an empty gap so the panorama does not shift.
        if (room.phase === 'lobby') room.order = room.order.filter((p) => p !== player);
        room.broadcastState();
        room.removeIfEmpty();
      }, CONFIG.disconnectGraceMs);
      room.broadcastState();
    });
  }

  return { handleConnection, targetPosition, rooms, CONFIG, TARGETS };
});
