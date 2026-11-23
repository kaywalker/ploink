'use strict';

// Kontrollzentrum hub: a cooperative shouting game. Every phone gets its own panel of
// oddly named controls; every player also gets an order, which usually refers to a
// control on somebody else's panel. Completed orders fill the team's progress bar,
// expired orders cost stability. Transport-agnostic like the other hubs: runs in Node
// (server.js) and in the browser of the hosting phone.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PloinkControlHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function randomHex(bytes) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Mutable on purpose: tests shorten the timings.
  const CONFIG = {
    countdownMs: 3000,
    levelBreakMs: 3500,
    tickMs: 200,
    maxStability: 6,
    orderBaseMs: 14_000,       // time for an order on level 1
    orderStepMs: 1500,         // ... minus this per level
    orderMinMs: 6000,
    ordersPerLevelBase: 6,     // successes needed: base + perPlayer * players
    ordersPerLevelPerPlayer: 2,
    newOrderDelayMs: 600,      // short pause before the next order appears
    ownPanelChance: 0.2,       // how often an order targets the issuer's own panel
    disconnectGraceMs: 60_000,
    maxPlayersPerRoom: 10,
    maxNameLength: 16,
  };

  const COLORS = [
    '#ff5d73', '#4dd6ff', '#7ee081', '#ffb84d', '#c77dff',
    '#ffe156', '#ff7ac6', '#5fffd0', '#7d8bff', '#ff9f68',
  ];

  // Control names are compounds like "Quantenquirl" or "Bananenspule".
  const PREFIXES = [
    'Turbo', 'Quanten', 'Hyper', 'Plasma', 'Nebel', 'Wackel', 'Glitzer', 'Schwerkraft',
    'Zeit', 'Bananen', 'Tachyonen', 'Wurmloch', 'Antimaterie', 'Kristall', 'Kaffee', 'Gummi',
    'Disko', 'Magnet', 'Pudding', 'Laser', 'Sternen', 'Flausch', 'Donner', 'Socken',
  ];
  const STEMS = [
    'quirl', 'pumpe', 'ventil', 'drossel', 'spule', 'kurbel', 'filter', 'schleuder',
    'zange', 'waffel', 'trommel', 'linse', 'gabel', 'lüfter', 'mühle', 'antenne',
    'bremse', 'klappe', 'düse', 'walze', 'kompass', 'heizung', 'hupe', 'pfeife',
  ];

  const rooms = new Map();

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, Number(v) || 0));
  }

  function sanitizeName(raw, fallback) {
    const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, CONFIG.maxNameLength);
    return name || fallback;
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  class ControlRoom {
    constructor(code) {
      this.code = code;
      this.players = new Map(); // token -> player
      this.phase = 'lobby';     // lobby | countdown | playing | break | over
      this.phaseEndsAt = 0;
      this.level = 0;
      this.stability = CONFIG.maxStability;
      this.progress = 0;
      this.target = 0;
      this.completed = 0;
      this.failed = 0;
      this.usedNames = new Set();
      this.nextControlId = 1;
      this.nextOrderId = 1;
      this.timer = null;
      this.phaseTimer = null;
      this.colorIndex = 0;
    }

    activePlayers() {
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
        phaseInMs: Math.max(0, this.phaseEndsAt - Date.now()),
        level: this.level,
        stability: this.stability,
        maxStability: CONFIG.maxStability,
        progress: this.progress,
        target: this.target,
        completed: this.completed,
        failed: this.failed,
        players: [...this.players.values()].map((p) => ({
          id: p.id, name: p.name, color: p.color, connected: !!p.socket, done: p.done,
        })),
      });
    }

    // ------------------------------------------------------------------ flow
    start() {
      if (this.phase !== 'lobby' && this.phase !== 'over') return;
      if (this.activePlayers().length === 0) return;
      this.level = 0;
      this.stability = CONFIG.maxStability;
      this.completed = 0;
      this.failed = 0;
      for (const p of this.players.values()) p.done = 0;
      this.phase = 'countdown';
      this.phaseEndsAt = Date.now() + CONFIG.countdownMs;
      this.broadcastState();
      clearTimeout(this.phaseTimer);
      this.phaseTimer = setTimeout(() => this.startLevel(1), CONFIG.countdownMs);
    }

    startLevel(level) {
      this.level = level;
      this.phase = 'playing';
      this.phaseEndsAt = 0;
      this.progress = 0;
      const players = this.activePlayers();
      this.target = CONFIG.ordersPerLevelBase + CONFIG.ordersPerLevelPerPlayer * Math.max(0, players.length - 1);
      this.usedNames.clear();
      for (const p of this.players.values()) {
        p.controls = [];
        p.order = null;
        clearTimeout(p.orderTimer);
      }
      for (const p of players) this.dealPanel(p);
      this.broadcastState();
      for (const p of players) this.scheduleOrder(p, 300 + Math.random() * 900);
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), CONFIG.tickMs);
    }

    endLevel() {
      clearInterval(this.timer);
      for (const p of this.players.values()) {
        clearTimeout(p.orderTimer);
        p.order = null;
      }
      this.phase = 'break';
      this.phaseEndsAt = Date.now() + CONFIG.levelBreakMs;
      this.broadcast({ type: 'event', kind: 'level', level: this.level });
      this.broadcastState();
      clearTimeout(this.phaseTimer);
      this.phaseTimer = setTimeout(() => this.startLevel(this.level + 1), CONFIG.levelBreakMs);
    }

    gameOver() {
      clearInterval(this.timer);
      clearTimeout(this.phaseTimer);
      for (const p of this.players.values()) {
        clearTimeout(p.orderTimer);
        p.order = null;
      }
      this.phase = 'over';
      this.phaseEndsAt = 0;
      this.broadcast({ type: 'event', kind: 'over', level: this.level, completed: this.completed });
      this.broadcastState();
    }

    // ---------------------------------------------------------------- panels
    panelSize() {
      return Math.min(8, 4 + Math.ceil(this.level / 2));
    }

    uniqueName() {
      for (let i = 0; i < 200; i++) {
        const name = pick(PREFIXES) + pick(STEMS);
        if (!this.usedNames.has(name)) {
          this.usedNames.add(name);
          return name;
        }
      }
      return `Gerät ${this.nextControlId}`;
    }

    dealPanel(player) {
      const size = this.panelSize();
      const types = shuffle(['button', 'toggle', 'slider', 'button', 'toggle', 'slider', 'toggle', 'button']).slice(0, size);
      player.controls = types.map((type) => ({
        id: this.nextControlId++,
        name: this.uniqueName(),
        type,
        value: 0,
        max: type === 'slider' ? 4 : 1,
      }));
      player.send({
        type: 'panel',
        level: this.level,
        controls: player.controls.map(({ id, name, type, value, max }) => ({ id, name, type, value, max })),
      });
    }

    findControl(controlId) {
      for (const p of this.players.values()) {
        const c = p.controls.find((x) => x.id === controlId);
        if (c) return { owner: p, control: c };
      }
      return null;
    }

    // ---------------------------------------------------------------- orders
    orderDuration() {
      return Math.max(CONFIG.orderMinMs, CONFIG.orderBaseMs - CONFIG.orderStepMs * (this.level - 1));
    }

    scheduleOrder(player, delay = CONFIG.newOrderDelayMs) {
      clearTimeout(player.orderTimer);
      player.orderTimer = setTimeout(() => this.issueOrder(player), delay);
    }

    issueOrder(player) {
      if (this.phase !== 'playing' || !player.socket) return;
      const busy = new Set([...this.players.values()].filter((p) => p.order).map((p) => p.order.controlId));
      const candidates = [];
      for (const owner of this.activePlayers()) {
        for (const control of owner.controls) {
          if (!busy.has(control.id)) candidates.push({ owner, control });
        }
      }
      if (candidates.length === 0) {
        this.scheduleOrder(player, 1000);
        return;
      }
      const foreign = candidates.filter((c) => c.owner !== player);
      const pool = foreign.length > 0 && Math.random() > CONFIG.ownPanelChance ? foreign : candidates;
      const { owner, control } = pick(pool);

      let target = null;
      let text;
      if (control.type === 'button') {
        text = `${control.name} drücken!`;
      } else if (control.type === 'toggle') {
        target = control.value ? 0 : 1;
        text = `${control.name} ${target ? 'einschalten' : 'ausschalten'}!`;
      } else {
        const options = [0, 1, 2, 3, 4].filter((v) => v !== control.value);
        target = pick(options);
        text = `${control.name} auf ${target} stellen!`;
      }
      const duration = this.orderDuration();
      player.order = { id: this.nextOrderId++, controlId: control.id, target, text, expiresAt: Date.now() + duration };
      // `own`: the control is on the issuer's panel, so they have to do it themselves.
      player.send({ type: 'order', id: player.order.id, text, ms: duration, own: owner === player });
    }

    tick() {
      if (this.phase !== 'playing') return;
      const now = Date.now();
      for (const p of this.players.values()) {
        if (p.order && p.order.expiresAt <= now) {
          const text = p.order.text;
          p.order = null;
          this.failed++;
          this.stability--;
          p.send({ type: 'order', id: null, text: null, ms: 0 });
          this.broadcast({ type: 'event', kind: 'fail', text, id: p.id, name: p.name });
          if (this.stability <= 0) {
            this.gameOver();
            return;
          }
          this.broadcastState();
          this.scheduleOrder(p);
        }
      }
    }

    /** A player operated a control on their own panel. */
    act(player, controlId, value) {
      if (this.phase !== 'playing') return;
      const control = player.controls.find((c) => c.id === controlId);
      if (!control) return;
      if (control.type !== 'button') control.value = clamp(Math.round(value), 0, control.max);

      // Tell the actor whether this was asked for, so players learn whom to listen to.
      const matching = [...this.players.values()].filter((p) => p.order && p.order.controlId === control.id
        && (control.type === 'button' || control.value === p.order.target));
      player.send({
        type: 'acted',
        id: control.id,
        ok: matching.length > 0,
        for: matching.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      });

      for (const issuer of this.players.values()) {
        const order = issuer.order;
        if (!order || order.controlId !== control.id) continue;
        if (control.type !== 'button' && control.value !== order.target) continue;
        issuer.order = null;
        this.completed++;
        this.progress++;
        player.done++;
        issuer.send({ type: 'order', id: null, text: null, ms: 0 });
        this.broadcast({
          type: 'event', kind: 'done', text: order.text,
          by: { id: player.id, name: player.name, color: player.color }, issuer: issuer.id,
        });
        if (this.progress >= this.target) {
          this.endLevel();
          return;
        }
        this.broadcastState();
        this.scheduleOrder(issuer);
      }
    }

    /** Orders that point at a player's panel cannot be completed once they are gone. */
    dropPlayerFromRound(player) {
      clearTimeout(player.orderTimer);
      player.order = null;
      const ids = new Set(player.controls.map((c) => c.id));
      for (const p of this.players.values()) {
        if (p.order && ids.has(p.order.controlId)) {
          p.order = null;
          p.send({ type: 'order', id: null, text: null, ms: 0 });
          this.scheduleOrder(p);
        }
      }
      player.controls = [];
    }

    removeIfEmpty() {
      if (this.players.size === 0) {
        clearInterval(this.timer);
        clearTimeout(this.phaseTimer);
        rooms.delete(this.code);
      }
    }
  }

  class ControlPlayer {
    constructor(room, token, name) {
      this.id = randomHex(4);
      this.token = token;
      this.name = name;
      this.color = COLORS[room.colorIndex++ % COLORS.length];
      this.controls = [];
      this.order = null;
      this.orderTimer = null;
      this.done = 0;
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
      room = new ControlRoom(code);
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
      player = new ControlPlayer(room, token, sanitizeName(msg.name, `Technik ${room.players.size + 1}`));
      room.players.set(token, player);
    }

    player.socket = socket;
    player.send({ type: 'joined', code, you: player.id, token, color: player.color, name: player.name });
    room.broadcast({ type: 'event', kind: 'join', id: player.id, name: player.name, color: player.color });
    room.broadcastState();
    // Joining (or coming back) mid-level: get a fresh panel and an order.
    if (room.phase === 'playing') {
      room.dealPanel(player);
      room.scheduleOrder(player, 800);
    }
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
      if (msg.type === 'join') {
        if (!session) session = handleJoin(socket, msg);
        return;
      }
      if (!session) return;
      const { room, player } = session;

      switch (msg.type) {
        case 'start':
          room.start();
          break;
        case 'act':
          room.act(player, Number(msg.id), Number(msg.value));
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
      room.dropPlayerFromRound(player);
      if (room.activePlayers().length === 0 && room.phase !== 'lobby') room.gameOver();
      player.removeTimer = setTimeout(() => {
        room.players.delete(player.token);
        room.broadcastState();
        room.removeIfEmpty();
      }, CONFIG.disconnectGraceMs);
      room.broadcastState();
    });
  }

  return { handleConnection, rooms, CONFIG };
});
