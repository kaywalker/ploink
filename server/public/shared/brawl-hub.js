'use strict';

// Hausmeister-Trupp hub: a cooperative side-scrolling brawler. The hub owns the whole
// simulation (players, dust monsters, hits, waves) and broadcasts compact snapshots;
// clients only send their thumb input. Transport-agnostic like the other hubs: runs in
// Node (server.js) and in the browser of the hosting phone.
//
// World units: x along the corridor (0 … arenaWidth), z into the depth of the floor
// (0 = back wall, depth = front), y = height above the floor.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PloinkBrawlHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function randomHex(bytes) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Mutable on purpose: tests shorten the timings.
  const CONFIG = {
    tickMs: 33,
    snapshotEveryTicks: 2,       // ≈ 15 snapshots per second
    countdownMs: 3000,
    waveBreakMs: 3000,
    arenaWidth: 22,
    depth: 3.2,

    playerHp: 100,
    playerSpeed: 3.4,
    playerDepthSpeed: 2.3,
    jumpVelocity: 6.5,
    gravity: 20,
    punchMs: 260,
    punchHitAtMs: 90,
    comboWindowMs: 450,
    punchRange: 1.3,             // a tap sweeps the broom along the floor in front
    depthReach: 0.5,
    sweepDepthReach: 0.65,       // the sweep covers a bit more floor depth than a kick
    punchDamage: [9, 9, 16],     // third sweep of a combo knocks down
    aimAssistRange: 2.4,
    kickMs: 320,
    kickDamage: 14,
    dashMs: 300,
    dashSpeed: 8,
    dashDamage: 12,
    sweepRange: 1.15,            // broom sweeping the floor during the dash
    hurtMs: 350,
    respawnMs: 5000,
    invulnMs: 2000,

    enemyHp: 34,
    enemySpeed: 1.6,
    enemyDamage: 8,
    enemyRange: 1.0,
    enemyWindupMs: 520,
    enemyAttackMs: 260,
    enemyCooldownMs: 1100,
    enemyHurtMs: 300,
    enemyKnockdownMs: 900,
    spawnIntervalMs: 800,
    spawnViewHalf: 4.4,          // monsters from the sides appear just outside a phone's view
    flankEveryMs: 1200,          // how often a monster reconsiders which side of its target to attack

    maxPlayersPerRoom: 6,
    disconnectGraceMs: 60_000,
    maxNameLength: 16,
  };

  const COLORS = ['#ff5d73', '#4dd6ff', '#7ee081', '#ffb84d', '#c77dff', '#ffe156'];

  // Compact state codes used in snapshots.
  const P = { idle: 0, walk: 1, punch: 2, jump: 3, hurt: 4, down: 5, dash: 6, kick: 7 };
  const E = { idle: 0, walk: 1, windup: 2, attack: 3, hurt: 4, knocked: 5, dead: 6 };

  const SPAWN_SIDES = ['left', 'right', 'back', 'front'];
  const ENTRY_MARGIN = 0.9; // how far off the floor monsters from the back/front start
  const ATTACK_SLOTS = [{ dx: 0.85, dz: 0 }, { dx: 0.8, dz: 0.4 }, { dx: 0.8, dz: -0.4 }, { dx: 1.6, dz: 0 }];

  const rooms = new Map();

  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  const round2 = (v) => Math.round(v * 100) / 100;

  function sanitizeName(raw, fallback) {
    const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, CONFIG.maxNameLength);
    return name || fallback;
  }

  class BrawlRoom {
    constructor(code) {
      this.code = code;
      this.players = new Map(); // token -> player
      this.enemies = [];
      this.fx = [];             // hit effects since the last snapshot
      this.phase = 'lobby';     // lobby | countdown | playing | break | over
      this.phaseEndsAt = 0;
      this.wave = 0;
      this.toSpawn = 0;
      this.nextSpawnAt = 0;
      this.kos = 0;
      this.nextEnemyId = 1;
      this.tickCount = 0;
      this.lastTick = 0;
      this.timer = null;
      this.phaseTimer = null;
      this.colorIndex = 0;
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
        phaseInMs: Math.max(0, this.phaseEndsAt - Date.now()),
        wave: this.wave,
        kos: this.kos,
        arenaWidth: CONFIG.arenaWidth,
        depth: CONFIG.depth,
        players: [...this.players.values()].map((p) => ({
          id: p.id, name: p.name, color: p.color, connected: !!p.socket, kos: p.kos,
        })),
      });
    }

    // ------------------------------------------------------------------ flow
    start() {
      if (this.phase !== 'lobby' && this.phase !== 'over') return;
      if (this.connected().length === 0) return;
      this.wave = 0;
      this.kos = 0;
      this.enemies = [];
      const players = this.connected();
      players.forEach((p, i) => p.reset(CONFIG.arenaWidth / 2 + (i - (players.length - 1) / 2) * 1.2, CONFIG.depth * 0.55));
      this.phase = 'countdown';
      this.phaseEndsAt = Date.now() + CONFIG.countdownMs;
      this.broadcastState();
      this.ensureLoop();
      clearTimeout(this.phaseTimer);
      this.phaseTimer = setTimeout(() => this.startWave(1), CONFIG.countdownMs);
    }

    startWave(wave) {
      this.wave = wave;
      this.phase = 'playing';
      this.phaseEndsAt = 0;
      this.toSpawn = 2 + wave * 2 + this.connected().length;
      this.nextSpawnAt = Date.now() + 400;
      this.broadcast({ type: 'event', kind: 'wave', wave });
      this.broadcastState();
    }

    waveCleared() {
      this.phase = 'break';
      this.phaseEndsAt = Date.now() + CONFIG.waveBreakMs;
      // Everybody who is down gets back up between waves.
      for (const p of this.connected()) {
        if (p.state === 'down') p.respawn(this.respawnX(p));
        p.hp = Math.min(CONFIG.playerHp, p.hp + 30);
      }
      this.broadcast({ type: 'event', kind: 'cleared', wave: this.wave });
      this.broadcastState();
      clearTimeout(this.phaseTimer);
      this.phaseTimer = setTimeout(() => this.startWave(this.wave + 1), CONFIG.waveBreakMs);
    }

    gameOver() {
      clearTimeout(this.phaseTimer);
      this.phase = 'over';
      this.phaseEndsAt = 0;
      this.broadcast({ type: 'event', kind: 'over', wave: this.wave, kos: this.kos });
      this.broadcastState();
    }

    ensureLoop() {
      if (this.timer) return;
      this.lastTick = Date.now();
      this.timer = setInterval(() => this.tick(), CONFIG.tickMs);
    }

    stopLoop() {
      clearInterval(this.timer);
      this.timer = null;
    }

    // ------------------------------------------------------------- simulation
    tick() {
      const now = Date.now();
      const dt = Math.min(0.1, (now - this.lastTick) / 1000);
      this.lastTick = now;
      const simulate = this.phase === 'playing' || this.phase === 'break' || this.phase === 'countdown';
      if (simulate) {
        for (const p of this.players.values()) if (p.socket) this.updatePlayer(p, dt, now);
        for (const e of this.enemies) this.updateEnemy(e, dt, now);
        this.separateEnemies();
        this.enemies = this.enemies.filter((e) => !(e.state === 'dead' && now >= e.stateUntil));
        if (this.phase === 'playing') this.updateWave(now);
      }
      this.tickCount++;
      if (this.tickCount % CONFIG.snapshotEveryTicks === 0) this.sendSnapshot();
      if (this.phase === 'lobby' && this.connected().length === 0) this.stopLoop();
    }

    updateWave(now) {
      const alive = this.enemies.filter((e) => e.state !== 'dead').length;
      const maxConcurrent = 3 + this.connected().length * 2;
      if (this.toSpawn > 0 && alive < maxConcurrent && now >= this.nextSpawnAt) {
        this.spawnEnemy();
        this.toSpawn--;
        this.nextSpawnAt = now + CONFIG.spawnIntervalMs;
      }
      if (this.toSpawn === 0 && this.enemies.length === 0) this.waveCleared();
    }

    /**
     * Monsters come from every direction around a random janitor: from the left and
     * right just outside the view, out of the lockers at the back and up from the
     * front edge of the floor.
     */
    spawnEnemy(from = SPAWN_SIDES[Math.floor(Math.random() * SPAWN_SIDES.length)]) {
      const standing = this.connected().filter((p) => p.state !== 'down');
      const anchor = standing.length ? standing[Math.floor(Math.random() * standing.length)] : null;
      const ax = anchor ? anchor.x : CONFIG.arenaWidth / 2;
      const W = CONFIG.arenaWidth;
      let x;
      let z;
      if (from === 'left' || from === 'right') {
        x = ax + (from === 'left' ? -1 : 1) * CONFIG.spawnViewHalf;
        if (x < 0 || x > W) x = x < 0 ? ax + CONFIG.spawnViewHalf : ax - CONFIG.spawnViewHalf;
        x = clamp(x, -0.8, W + 0.8);
        z = Math.random() * CONFIG.depth;
      } else {
        x = clamp(ax + (Math.random() * 2 - 1) * 2.5, 0.6, W - 0.6);
        z = from === 'back' ? -ENTRY_MARGIN : CONFIG.depth + ENTRY_MARGIN;
      }
      const scale = 1 + (this.wave - 1) * 0.12;
      const enemy = new Enemy(this.nextEnemyId++, x, z, Math.round(CONFIG.enemyHp * scale), CONFIG.enemyDamage + (this.wave - 1));
      enemy.facing = x < ax ? 1 : -1;
      this.enemies.push(enemy);
      return enemy;
    }

    /**
     * Which side of the target a monster attacks from: the less crowded one, so a group
     * surrounds a janitor instead of queueing up on one side.
     */
    flankSide(e, target, now) {
      if (e.targetId === target.id && now < e.flankAt) return e.side;
      let left = 0;
      let right = 0;
      for (const o of this.enemies) {
        if (o === e || o.state === 'dead' || o.targetId !== target.id) continue;
        if (o.side < 0) left++;
        else right++;
      }
      const natural = e.x < target.x ? -1 : 1;
      e.side = left === right ? natural : left < right ? -1 : 1;
      e.targetId = target.id;
      e.flankAt = now + CONFIG.flankEveryMs;
      return e.side;
    }

    respawnX(player) {
      const others = this.connected().filter((p) => p !== player && p.state !== 'down');
      return others.length ? others[0].x : CONFIG.arenaWidth / 2;
    }

    updatePlayer(p, dt, now) {
      if (p.state === 'down') {
        if (now >= p.respawnAt && this.phase !== 'over') p.respawn(this.respawnX(p));
        return;
      }

      // Gravity
      if (p.y > 0 || p.vy !== 0) {
        p.vy -= CONFIG.gravity * dt;
        p.y += p.vy * dt;
        if (p.y <= 0) {
          p.y = 0;
          p.vy = 0;
          if (p.state === 'jump' || p.state === 'kick') p.setState('idle', now);
        }
      }

      // Knockback slides out
      if (p.vx) {
        p.x += p.vx * dt;
        p.vx *= Math.pow(0.02, dt);
        if (Math.abs(p.vx) < 0.05) p.vx = 0;
      }

      switch (p.state) {
        case 'hurt':
          if (now >= p.stateUntil) p.setState('idle', now);
          break;
        case 'punch':
          if (!p.hitDone && now >= p.stateStart + CONFIG.punchHitAtMs) {
            p.hitDone = true;
            const knock = p.combo === 2;
            this.hitEnemies(p, CONFIG.punchRange, CONFIG.punchDamage[p.combo], knock, now, CONFIG.sweepDepthReach);
          }
          if (now >= p.stateUntil) {
            p.lastPunchEnd = now;
            p.setState('idle', now);
            if (p.queuedPunch) {
              p.queuedPunch = false;
              this.punch(p, now);
            }
          }
          break;
        case 'kick':
          this.moveByInput(p, dt, 0.6);
          if (!p.hitDone && now >= p.stateStart + 60) {
            p.hitDone = true;
            this.hitEnemies(p, CONFIG.punchRange + 0.2, CONFIG.kickDamage, true, now);
          }
          break;
        case 'dash': {
          p.x += p.facing * CONFIG.dashSpeed * dt;
          for (const e of this.enemies) {
            if (p.dashHits.has(e.id)) continue;
            if (this.inReach(p, e, CONFIG.sweepRange)) {
              p.dashHits.add(e.id);
              this.damageEnemy(p, e, CONFIG.dashDamage, true, now);
            }
          }
          if (now >= p.stateUntil) p.setState('idle', now);
          break;
        }
        default: {
          const moving = this.moveByInput(p, dt, 1);
          if (p.state !== 'jump') p.setLoopState(moving ? 'walk' : 'idle', now);
        }
      }

      p.x = clamp(p.x, 0.4, CONFIG.arenaWidth - 0.4);
      p.z = clamp(p.z, 0, CONFIG.depth);
    }

    moveByInput(p, dt, factor) {
      const { mx, mz } = p.input;
      if (Math.abs(mx) < 0.05 && Math.abs(mz) < 0.05) return false;
      p.x += mx * CONFIG.playerSpeed * factor * dt;
      p.z += mz * CONFIG.playerDepthSpeed * factor * dt;
      if (Math.abs(mx) > 0.2) p.facing = mx > 0 ? 1 : -1;
      return true;
    }

    /** Is the enemy in front of the player within `range`? */
    inReach(p, e, range, depthReach = CONFIG.depthReach) {
      if (e.state === 'dead') return false;
      const dx = (e.x - p.x) * p.facing;
      return dx >= -0.25 && dx <= range && Math.abs(e.z - p.z) <= depthReach && Math.abs(e.y - p.y) < 1.3;
    }

    hitEnemies(p, range, damage, knock, now, depthReach) {
      let hits = 0;
      for (const e of this.enemies) {
        if (this.inReach(p, e, range, depthReach)) {
          this.damageEnemy(p, e, damage, knock, now);
          hits++;
        }
      }
      return hits;
    }

    damageEnemy(p, e, damage, knock, now) {
      e.hp -= damage;
      e.vx = p.facing * (knock ? 5 : 2);
      this.fx.push([round2(e.x), round2(e.z), round2(e.y + 0.9), knock ? 2 : 1]);
      if (e.hp <= 0) {
        e.hp = 0;
        e.state = 'dead';
        e.stateUntil = now + 700;
        p.kos++;
        this.kos++;
      } else if (knock) {
        e.setState('knocked', now, CONFIG.enemyKnockdownMs);
      } else {
        e.setState('hurt', now, CONFIG.enemyHurtMs);
      }
    }

    /** Thumb tap: broom sweep (combo) on the ground, jump kick in the air. */
    punch(p, now) {
      if (p.state === 'down' || p.state === 'hurt' || p.state === 'dash' || p.state === 'kick') return;
      if (p.state === 'punch') {
        p.queuedPunch = true; // chain into the next combo hit
        return;
      }
      if (p.y > 0.05) {
        p.setState('kick', now, CONFIG.kickMs);
        p.hitDone = false;
        return;
      }
      // Aim assist: turn to the nearest monster and take a small step towards it.
      let target = null;
      let best = Infinity;
      for (const e of this.enemies) {
        if (e.state === 'dead') continue;
        const dx = Math.abs(e.x - p.x);
        const dz = Math.abs(e.z - p.z);
        if (dx < CONFIG.aimAssistRange && dz < 0.9 && dx + dz < best) {
          best = dx + dz;
          target = e;
        }
      }
      if (target) {
        p.facing = target.x >= p.x ? 1 : -1;
        const gap = Math.abs(target.x - p.x) - 1.0; // stop at broom distance
        if (gap > 0) p.x += Math.min(0.4, gap) * p.facing;
        p.z += clamp(target.z - p.z, -0.3, 0.3);
      }
      p.combo = now - p.lastPunchEnd < CONFIG.comboWindowMs ? (p.combo + 1) % 3 : 0;
      p.setState('punch', now, CONFIG.punchMs);
      p.hitDone = false;
    }

    jump(p, now) {
      if (p.y > 0 || !(p.state === 'idle' || p.state === 'walk')) return;
      p.vy = CONFIG.jumpVelocity;
      p.setState('jump', now);
    }

    dash(p, dir, now) {
      if (p.y > 0 || !(p.state === 'idle' || p.state === 'walk' || p.state === 'punch')) return;
      p.facing = dir < 0 ? -1 : 1;
      p.dashHits = new Set();
      p.setState('dash', now, CONFIG.dashMs);
    }

    damagePlayer(e, p, now) {
      if (p.state === 'down' || now < p.invulnUntil) return;
      p.hp -= e.damage;
      p.vx = e.facing * 3;
      p.queuedPunch = false;
      this.fx.push([round2(p.x), round2(p.z), round2(p.y + 1), 3]);
      if (p.hp <= 0) {
        p.hp = 0;
        p.setState('down', now);
        p.respawnAt = now + CONFIG.respawnMs;
        p.send({ type: 'event', kind: 'ko', respawnMs: CONFIG.respawnMs });
        if (this.connected().every((q) => q.state === 'down')) this.gameOver();
      } else {
        p.setState('hurt', now, CONFIG.hurtMs);
      }
    }

    updateEnemy(e, dt, now) {
      if (e.vx) {
        e.x += e.vx * dt;
        e.vx *= Math.pow(0.02, dt);
        if (Math.abs(e.vx) < 0.05) e.vx = 0;
      }
      if (e.state === 'dead') return;
      if ((e.state === 'hurt' || e.state === 'knocked') && now < e.stateUntil) return;

      if (e.state === 'windup') {
        if (now >= e.stateUntil) {
          e.setState('attack', now, CONFIG.enemyAttackMs);
          e.x += e.facing * 0.25; // lunge
          for (const p of this.connected()) {
            const dx = (p.x - e.x) * e.facing;
            if (dx >= -0.2 && dx <= CONFIG.enemyRange && Math.abs(p.z - e.z) <= 0.45 && p.y < 0.8) {
              this.damagePlayer(e, p, now);
            }
          }
        }
        return;
      }
      if (e.state === 'attack') {
        if (now >= e.stateUntil) {
          e.cooldownUntil = now + CONFIG.enemyCooldownMs * (0.8 + Math.random() * 0.4);
          e.setState('idle', now);
        }
        return;
      }

      // Pick the nearest player who is still standing.
      let target = null;
      let best = Infinity;
      for (const p of this.connected()) {
        if (p.state === 'down') continue;
        const d = Math.abs(p.x - e.x) + Math.abs(p.z - e.z) * 2;
        if (d < best) {
          best = d;
          target = p;
        }
      }
      if (!target) {
        e.setState('idle', now);
        return;
      }
      const side = this.flankSide(e, target, now);
      // Attack spots on each side: straight in front, then diagonally above and below,
      // the rest wait a step further out. Closer monsters get the better spots.
      const dist = (o) => Math.abs(o.x - target.x) + Math.abs(o.z - target.z);
      const rank = this.enemies.filter((o) => o !== e && o.state !== 'dead' && o.targetId === target.id
        && o.side === side && dist(o) < dist(e)).length;
      const slot = ATTACK_SLOTS[Math.min(rank, ATTACK_SLOTS.length - 1)];
      const wantX = target.x + side * (slot.dx + Math.max(0, rank - ATTACK_SLOTS.length + 1) * 0.6);
      const wantZ = clamp(target.z + slot.dz, 0, CONFIG.depth);
      const dx = wantX - e.x;
      // Walking around the target to its other side: swing out in depth instead of
      // walking straight through the janitor.
      const crossing = (e.x - target.x) * side < 0 && Math.abs(e.x - target.x) < 1.2;
      const detour = crossing ? (target.z < CONFIG.depth / 2 ? 0.9 : -0.9) : 0;
      const dz = wantZ + detour - e.z;
      e.facing = target.x >= e.x ? 1 : -1;
      if (Math.abs(dx) < 0.25 && Math.abs(dz) < 0.3) {
        if (now >= e.cooldownUntil) e.setState('windup', now, CONFIG.enemyWindupMs);
        else e.setState('idle', now);
        return;
      }
      const len = Math.hypot(dx, dz * 1.5) || 1;
      e.x += (dx / len) * CONFIG.enemySpeed * dt;
      e.z += ((dz * 1.5) / len) * CONFIG.enemySpeed * 0.7 * dt;
      // Monsters entering from the lockers or the front edge may still be off the floor.
      e.z = clamp(e.z, -ENTRY_MARGIN, CONFIG.depth + ENTRY_MARGIN);
      e.setState('walk', now);
    }

    separateEnemies() {
      const list = this.enemies.filter((e) => e.state !== 'dead');
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          if (Math.abs(dx) < 0.6 && Math.abs(dz) < 0.35) {
            const push = (0.6 - Math.abs(dx)) / 2 || 0.15;
            const dir = dx >= 0 ? 1 : -1;
            a.x -= dir * push * 0.5;
            b.x += dir * push * 0.5;
          }
        }
      }
    }

    sendSnapshot() {
      if (this.phase === 'lobby') return;
      const now = Date.now();
      this.broadcast({
        type: 'snap',
        players: this.connected().map((p) => [
          p.id, round2(p.x), round2(p.z), round2(p.y), p.facing, P[p.state], Math.round(p.hp), p.combo,
          p.state === 'down' ? Math.max(0, p.respawnAt - now) : 0, now < p.invulnUntil ? 1 : 0,
        ]),
        enemies: this.enemies.map((e) => [
          e.id, round2(e.x), round2(e.z), round2(e.y), e.facing, E[e.state], Math.round((e.hp / e.maxHp) * 100),
        ]),
        fx: this.fx.splice(0),
      });
    }

    removeIfEmpty() {
      if (this.players.size === 0) {
        this.stopLoop();
        clearTimeout(this.phaseTimer);
        rooms.delete(this.code);
      }
    }
  }

  class BrawlPlayer {
    constructor(room, token, name) {
      this.id = randomHex(4);
      this.token = token;
      this.name = name;
      this.color = COLORS[room.colorIndex++ % COLORS.length];
      this.kos = 0;
      this.socket = null;
      this.removeTimer = null;
      this.reset(CONFIG.arenaWidth / 2, CONFIG.depth / 2);
    }

    reset(x, z) {
      this.x = x;
      this.z = z;
      this.y = 0;
      this.vy = 0;
      this.vx = 0;
      this.facing = 1;
      this.hp = CONFIG.playerHp;
      this.state = 'idle';
      this.stateStart = 0;
      this.stateUntil = 0;
      this.input = { mx: 0, mz: 0 };
      this.combo = 0;
      this.lastPunchEnd = 0;
      this.queuedPunch = false;
      this.hitDone = false;
      this.dashHits = new Set();
      this.respawnAt = 0;
      this.invulnUntil = 0;
      this.kos = 0;
    }

    respawn(x) {
      this.x = clamp(x, 1, CONFIG.arenaWidth - 1);
      this.y = 0;
      this.vy = 0;
      this.vx = 0;
      this.hp = CONFIG.playerHp;
      this.state = 'idle';
      this.invulnUntil = Date.now() + CONFIG.invulnMs;
    }

    /** Timed or one-off state (punch, hurt, …); restarts even if already in it. */
    setState(state, now, duration = 0) {
      this.state = state;
      this.stateStart = now;
      this.stateUntil = duration ? now + duration : 0;
    }

    /** Looping state (idle/walk): keeps its start time while it continues. */
    setLoopState(state, now) {
      if (this.state !== state) this.setState(state, now);
    }

    send(msg) {
      if (this.socket && this.socket.readyState === this.socket.OPEN) {
        this.socket.send(JSON.stringify(msg));
      }
    }
  }
  class Enemy {
    constructor(id, x, z, hp, damage) {
      this.id = id;
      this.x = x;
      this.z = z;
      this.y = 0;
      this.vx = 0;
      this.facing = x < CONFIG.arenaWidth / 2 ? 1 : -1;
      this.hp = hp;
      this.maxHp = hp;
      this.damage = damage;
      this.state = 'walk';
      this.stateUntil = 0;
      this.cooldownUntil = 0;
      this.targetId = null;
      this.side = x < CONFIG.arenaWidth / 2 ? -1 : 1;
      this.flankAt = 0;
    }

    setState(state, now, duration = 0) {
      if (this.state === state && !duration) return;
      this.state = state;
      this.stateUntil = duration ? now + duration : 0;
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
      room = new BrawlRoom(code);
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
      player = new BrawlPlayer(room, token, sanitizeName(msg.name, `Hausmeister ${room.players.size + 1}`));
      room.players.set(token, player);
    }

    player.socket = socket;
    player.input = { mx: 0, mz: 0 };
    if (room.phase !== 'lobby' && room.phase !== 'over') {
      // Joining mid-game: drop in next to a teammate.
      player.respawn(room.respawnX(player));
    }
    player.send({
      type: 'joined', code, you: player.id, token, color: player.color, name: player.name,
      arenaWidth: CONFIG.arenaWidth, depth: CONFIG.depth,
    });
    room.broadcast({ type: 'event', kind: 'join', id: player.id, name: player.name, color: player.color });
    room.broadcastState();
    room.ensureLoop();
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
      const now = Date.now();
      const active = room.phase === 'playing' || room.phase === 'break';

      switch (msg.type) {
        case 'start':
          room.start();
          break;
        case 'input':
          player.input = { mx: clamp(msg.mx, -1, 1), mz: clamp(msg.mz, -1, 1) };
          break;
        case 'punch':
          if (active) room.punch(player, now);
          break;
        case 'jump':
          if (active) room.jump(player, now);
          break;
        case 'dash':
          if (active) room.dash(player, Number(msg.dir) < 0 ? -1 : 1, now);
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
      if (room.phase !== 'lobby' && room.phase !== 'over') {
        const standing = room.connected().filter((p) => p.state !== 'down');
        if (room.connected().length === 0 || standing.length === 0) room.gameOver();
      }
      player.removeTimer = setTimeout(() => {
        room.players.delete(player.token);
        room.broadcastState();
        room.removeIfEmpty();
      }, CONFIG.disconnectGraceMs);
      room.broadcastState();
    });
  }

  return { handleConnection, rooms, CONFIG, P, E };
});
