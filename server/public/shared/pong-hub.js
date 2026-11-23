'use strict';

// Pong hub: relays balls between the phones of a room and keeps the score.
// Transport-agnostic game logic. Runs in Node (server.js) and in the browser of the
// hosting phone (peer-to-peer mode). A "socket" only needs: on('message'|'close', fn),
// send(string), readyState/OPEN and close(code, reason).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PloinkPongHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Random hex string; works in Node 22 and in browsers without a secure context. */
  function randomHex(bytes) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const CONFIG = {
    playersPerBall: 4,          // one extra ball for every N active players
    baseSpeed: 0.8,             // screen widths per second
    maxSpeed: 2.4,
    flightDelayMs: 450,         // time a returned ball "travels" between phones
    respawnDelayMs: 1600,       // pause after a miss before a new ball drops in
    disconnectGraceMs: 60_000,  // keep score of dropped players this long
    ballWatchdogMs: 45_000,     // re-throw a ball if its holder went silent
    maxPlayersPerRoom: 40,
    maxNameLength: 16,
  };

  const COLORS = [
    '#ff5d73', '#ffb84d', '#ffe156', '#7ee081', '#4dd6ff',
    '#7d8bff', '#c77dff', '#ff7ac6', '#5fffd0', '#ff9f68',
  ];

  // ---------------------------------------------------------------------------
  // Rooms, players, balls
  // ---------------------------------------------------------------------------

  /** @type {Map<string, Room>} */
  const rooms = new Map();
  let nextBallId = 1;

  class Room {
    constructor(code) {
      this.code = code;
      /** @type {Map<string, Player>} keyed by client token */
      this.players = new Map();
      /** @type {Map<number, Ball>} */
      this.balls = new Map();
      this.colorIndex = 0;
    }

    activePlayers() {
      return [...this.players.values()].filter((p) => p.isActive());
    }

    targetBallCount() {
      const active = this.activePlayers().length;
      if (active === 0) return 0;
      return Math.max(1, Math.ceil(active / CONFIG.playersPerBall));
    }

    broadcast(msg) {
      const data = JSON.stringify(msg);
      for (const p of this.players.values()) {
        if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(data);
      }
    }

    snapshot() {
      return {
        type: 'state',
        code: this.code,
        players: [...this.players.values()].map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          hits: p.hits,
          misses: p.misses,
          connected: !!p.socket,
          away: p.away,
          balls: [...this.balls.values()].filter((b) => b.holder === p).length,
        })),
      };
    }

    broadcastState() {
      this.broadcast(this.snapshot());
    }

    /** Pick a random active player, preferring someone other than `exclude`. */
    pickTarget(exclude) {
      const active = this.activePlayers();
      if (active.length === 0) return null;
      const others = active.filter((p) => p !== exclude);
      const pool = others.length > 0 ? others : active;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    /** Spawn balls until the room has as many as its player count calls for. */
    fillBalls() {
      while (this.balls.size < this.targetBallCount()) {
        const ball = new Ball(this);
        this.balls.set(ball.id, ball);
        ball.throwTo(this.pickTarget(null), {
          x: 0.2 + Math.random() * 0.6,
          angle: randomDownAngle(),
          speed: CONFIG.baseSpeed,
          delay: CONFIG.respawnDelayMs,
          from: null,
        });
      }
    }

    /** Called when a ball is lost; decides whether it comes back. */
    recycleBall(ball, byPlayer) {
      if (this.balls.size > this.targetBallCount()) {
        ball.destroy();
        return;
      }
      ball.throwTo(this.pickTarget(byPlayer), {
        x: 0.2 + Math.random() * 0.6,
        angle: randomDownAngle(),
        speed: CONFIG.baseSpeed,
        delay: CONFIG.respawnDelayMs,
        from: null,
      });
    }

    /** Re-throw every ball held by a player that just became unavailable. */
    releaseBallsOf(player) {
      for (const ball of this.balls.values()) {
        if (ball.holder === player) this.recycleBall(ball, player);
      }
    }

    removeIfEmpty() {
      if (this.players.size === 0) {
        for (const ball of this.balls.values()) ball.destroy();
        rooms.delete(this.code);
      }
    }
  }

  class Player {
    constructor(room, token, name) {
      this.id = randomHex(4);
      this.token = token;
      this.name = name;
      this.color = COLORS[room.colorIndex++ % COLORS.length];
      this.hits = 0;
      this.misses = 0;
      this.away = false;
      this.socket = null;
      this.removeTimer = null;
    }

    isActive() {
      return !!this.socket && !this.away;
    }

    send(msg) {
      if (this.socket && this.socket.readyState === this.socket.OPEN) {
        this.socket.send(JSON.stringify(msg));
      }
    }
  }

  class Ball {
    constructor(room) {
      this.id = nextBallId++;
      this.room = room;
      this.holder = null;
      this.seq = 0;
      this.watchdog = null;
    }

    throwTo(player, { x, angle, speed, delay, from }) {
      clearTimeout(this.watchdog);
      this.seq++;
      this.holder = player;
      if (!player) {
        // Nobody available: park the ball until someone becomes active again.
        this.room.broadcastState();
        return;
      }
      player.send({
        type: 'ball',
        id: this.id,
        seq: this.seq,
        x: clamp(x, 0.05, 0.95),
        angle,
        speed: clamp(speed, CONFIG.baseSpeed, CONFIG.maxSpeed),
        delay,
        from: from ? { name: from.name, color: from.color } : null,
      });
      this.watchdog = setTimeout(() => {
        if (this.room.balls.has(this.id) && this.holder === player) {
          this.room.recycleBall(this, player);
          this.room.broadcastState();
        }
      }, CONFIG.ballWatchdogMs + delay);
      this.room.broadcastState();
    }

    destroy() {
      clearTimeout(this.watchdog);
      this.room.balls.delete(this.id);
    }
  }

  /** Downward angle in radians, measured from straight down, within ±40°. */
  function randomDownAngle() {
    return (Math.random() * 2 - 1) * (40 * Math.PI) / 180;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, Number(v) || 0));
  }

  function sanitizeName(raw, fallback) {
    const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, CONFIG.maxNameLength);
    return name || fallback;
  }

  /** Resume the paused balls of a room once someone can play again. */
  function wakeParkedBalls(room) {
    for (const ball of room.balls.values()) {
      if (!ball.holder) room.recycleBall(ball, null);
    }
    room.fillBalls();
  }

  // ---------------------------------------------------------------------------
  // Protocol
  // ---------------------------------------------------------------------------

  function handleConnection(socket) {
    /** @type {{room: Room, player: Player} | null} */
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
        if (session) return;
        session = handleJoin(socket, msg);
        return;
      }
      if (!session) return;
      const { room, player } = session;

      switch (msg.type) {
        case 'exit': {
          // Ball left the top of this screen: the player returned it.
          const ball = room.balls.get(msg.id);
          if (!ball || ball.holder !== player || ball.seq !== msg.seq) return;
          player.hits++;
          // The next phone "faces" this one across the table: mirror position and
          // horizontal direction so the ball keeps its world trajectory.
          ball.throwTo(room.pickTarget(player), {
            x: 1 - clamp(msg.x, 0, 1),
            angle: -clamp(msg.angle, -1.2, 1.2),
            speed: msg.speed,
            delay: CONFIG.flightDelayMs,
            from: player,
          });
          break;
        }
        case 'miss': {
          const ball = room.balls.get(msg.id);
          if (!ball || ball.holder !== player || ball.seq !== msg.seq) return;
          player.misses++;
          room.broadcast({ type: 'event', kind: 'miss', id: player.id, name: player.name, color: player.color });
          room.recycleBall(ball, player);
          room.broadcastState();
          break;
        }
        case 'away': {
          if (player.away) return;
          player.away = true;
          room.releaseBallsOf(player);
          room.broadcastState();
          break;
        }
        case 'back': {
          if (!player.away) return;
          player.away = false;
          wakeParkedBalls(room);
          room.broadcastState();
          break;
        }
        case 'rename': {
          player.name = sanitizeName(msg.name, player.name);
          room.broadcastState();
          break;
        }
        default:
          break;
      }
    });

    socket.on('close', () => {
      if (!session) return;
      const { room, player } = session;
      if (player.socket !== socket) return; // replaced by a newer connection
      player.socket = null;
      room.releaseBallsOf(player);
      player.removeTimer = setTimeout(() => {
        room.players.delete(player.token);
        room.broadcastState();
        room.removeIfEmpty();
      }, CONFIG.disconnectGraceMs);
      room.broadcastState();
    });
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
      room = new Room(code);
      rooms.set(code, room);
    }

    let player = room.players.get(token);
    if (player) {
      // Reconnect: keep score and color.
      clearTimeout(player.removeTimer);
      if (player.socket && player.socket !== socket) {
        const old = player.socket;
        player.socket = null;
        room.releaseBallsOf(player);
        old.close(4000, 'replaced');
      }
      player.name = sanitizeName(msg.name, player.name);
    } else {
      if (room.players.size >= CONFIG.maxPlayersPerRoom) {
        socket.send(JSON.stringify({ type: 'error', message: 'Dieser Raum ist voll.' }));
        return null;
      }
      player = new Player(room, token, sanitizeName(msg.name, `Spieler ${room.players.size + 1}`));
      room.players.set(token, player);
    }

    player.socket = socket;
    player.away = !!msg.away;
    player.send({ type: 'joined', code, you: player.id, token, color: player.color, name: player.name });
    room.broadcast({ type: 'event', kind: 'join', id: player.id, name: player.name, color: player.color });
    wakeParkedBalls(room);
    room.broadcastState();
    return { room, player };
  }
  return { handleConnection, rooms, CONFIG };
});
