'use strict';

// Blaster hub: relays shots between phones, validates hits and keeps the score.
// Transport-agnostic game logic. Runs in Node (server.js) and in the browser of the
// hosting phone (peer-to-peer mode). A "socket" only needs: on('message'|'close', fn),
// send(string), readyState/OPEN and close(code, reason).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PloinkBlasterHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Random hex string; works in Node 22 and in browsers without a secure context. */
  function randomHex(bytes) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }


  const CONFIG = {
    maxHp: 3,
    respawnMs: 3000,
    spawnShieldMs: 2000,
    maxShotsPerSecond: 8,
    shotTtlMs: 15_000,          // a shot can only score within this time
    minShotSpeed: 0.7,          // screen widths per second on the target's screen
    maxShotSpeed: 1.6,
    disconnectGraceMs: 60_000,
    maxPlayersPerRoom: 12,
    maxNameLength: 16,
  };

  const COLORS = [
    '#ff5d73', '#4dd6ff', '#7ee081', '#ffb84d', '#c77dff',
    '#ffe156', '#ff7ac6', '#5fffd0', '#7d8bff', '#ff9f68',
  ];

  /** @type {Map<string, ShooterRoom>} */
  const rooms = new Map();
  let nextShotId = 1;

  class ShooterRoom {
    constructor(code) {
      this.code = code;
      /** @type {Map<string, ShooterPlayer>} keyed by client token */
      this.players = new Map();
      /** @type {Map<number, {shooter: ShooterPlayer, target: ShooterPlayer, at: number}>} */
      this.shots = new Map();
      this.colorIndex = 0;
    }

    broadcast(msg) {
      const data = JSON.stringify(msg);
      for (const p of this.players.values()) {
        if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(data);
      }
    }

    broadcastState() {
      const now = Date.now();
      this.broadcast({
        type: 'state',
        code: this.code,
        players: [...this.players.values()].map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          hp: p.hp,
          hits: p.hits,
          kills: p.kills,
          deaths: p.deaths,
          connected: !!p.socket,
          away: p.away,
          respawnMs: Math.max(0, p.deadUntil - now),
          shieldMs: Math.max(0, p.shieldUntil - now),
        })),
      });
    }

    pruneShots() {
      const cutoff = Date.now() - CONFIG.shotTtlMs;
      for (const [id, shot] of this.shots) {
        if (shot.at < cutoff) this.shots.delete(id);
      }
    }

    removeIfEmpty() {
      if (this.players.size === 0) rooms.delete(this.code);
    }
  }

  class ShooterPlayer {
    constructor(room, token, name) {
      this.id = randomHex(4);
      this.token = token;
      this.name = name;
      this.color = COLORS[room.colorIndex++ % COLORS.length];
      this.hp = CONFIG.maxHp;
      this.hits = 0;      // shots that hit someone else
      this.kills = 0;     // opponents destroyed
      this.deaths = 0;
      this.deadUntil = 0;
      this.shieldUntil = 0;
      this.respawnTimer = null;
      this.away = false;
      this.socket = null;
      this.removeTimer = null;
      this.shotTimes = [];
    }

    isActive() {
      return !!this.socket && !this.away;
    }

    isDead(now = Date.now()) {
      return this.deadUntil > now;
    }

    isVulnerable(now = Date.now()) {
      return this.isActive() && !this.isDead(now) && this.shieldUntil <= now;
    }

    /** Simple sliding-window rate limit against spammed shots. */
    allowShot(now) {
      this.shotTimes = this.shotTimes.filter((t) => now - t < 1000);
      if (this.shotTimes.length >= CONFIG.maxShotsPerSecond) return false;
      this.shotTimes.push(now);
      return true;
    }

    send(msg) {
      if (this.socket && this.socket.readyState === this.socket.OPEN) {
        this.socket.send(JSON.stringify(msg));
      }
    }
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, Number(v) || 0));
  }

  function sanitizeName(raw, fallback) {
    const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, CONFIG.maxNameLength);
    return name || fallback;
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
      room = new ShooterRoom(code);
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
      player = new ShooterPlayer(room, token, sanitizeName(msg.name, `Pilot ${room.players.size + 1}`));
      player.shieldUntil = Date.now() + CONFIG.spawnShieldMs;
      room.players.set(token, player);
    }

    player.socket = socket;
    player.away = !!msg.away;
    player.send({
      type: 'joined', code, you: player.id, token, color: player.color, name: player.name, maxHp: CONFIG.maxHp,
    });
    room.broadcast({ type: 'event', kind: 'join', id: player.id, name: player.name, color: player.color });
    room.broadcastState();
    return { room, player };
  }

  function handleShot(room, player, msg) {
    const now = Date.now();
    if (!player.isActive() || player.isDead(now)) return;
    if (!player.allowShot(now)) return;
    const target = [...room.players.values()].find((p) => p.id === msg.target);
    if (!target || target === player || !target.isActive() || target.isDead(now)) return;

    const shotId = nextShotId++;
    room.shots.set(shotId, { shooter: player, target, at: now });
    if (room.shots.size > 500) room.pruneShots();

    // The target "faces" the shooter: mirror position and horizontal direction.
    target.send({
      type: 'incoming',
      id: shotId,
      x: 1 - clamp(msg.x, 0, 1),
      angle: -clamp(msg.angle, -0.6, 0.6),
      speed: clamp(msg.speed, CONFIG.minShotSpeed, CONFIG.maxShotSpeed),
      from: { id: player.id, name: player.name, color: player.color },
    });
  }

  function handleHit(room, player, msg) {
    const now = Date.now();
    const shot = room.shots.get(msg.id);
    if (!shot || shot.target !== player) return;
    room.shots.delete(msg.id);
    if (now - shot.at > CONFIG.shotTtlMs || !player.isVulnerable(now)) return;

    const shooter = shot.shooter;
    player.hp--;
    shooter.hits++;
    shooter.send({ type: 'event', kind: 'landed', id: player.id, name: player.name, color: player.color });

    if (player.hp <= 0) {
      player.deaths++;
      shooter.kills++;
      player.deadUntil = now + CONFIG.respawnMs;
      room.broadcast({
        type: 'event',
        kind: 'kill',
        id: player.id,
        name: player.name,
        color: player.color,
        by: { id: shooter.id, name: shooter.name, color: shooter.color },
      });
      clearTimeout(player.respawnTimer);
      player.respawnTimer = setTimeout(() => {
        player.hp = CONFIG.maxHp;
        player.shieldUntil = Date.now() + CONFIG.spawnShieldMs;
        room.broadcastState();
      }, CONFIG.respawnMs);
    }
    room.broadcastState();
  }

  /** Attach one client connection (WebSocket or peer-to-peer adapter). */
  function handleConnection(socket) {
    /** @type {{room: ShooterRoom, player: ShooterPlayer} | null} */
    let session = null;

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'join') {
        if (!session) session = handleJoin(socket, msg);
        return;
      }
      if (!session) return;
      const { room, player } = session;

      switch (msg.type) {
        case 'shot':
          handleShot(room, player, msg);
          break;
        case 'hit':
          handleHit(room, player, msg);
          break;
        case 'away':
          if (!player.away) {
            player.away = true;
            room.broadcastState();
          }
          break;
        case 'back':
          if (player.away) {
            player.away = false;
            player.shieldUntil = Date.now() + CONFIG.spawnShieldMs;
            room.broadcastState();
          }
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
        clearTimeout(player.respawnTimer);
        room.players.delete(player.token);
        room.broadcastState();
        room.removeIfEmpty();
      }, CONFIG.disconnectGraceMs);
      room.broadcastState();
    });
  }

  return { handleConnection, rooms, CONFIG };
});
