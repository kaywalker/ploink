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
//
// Bots ("Holzpuppen") fill up a room on request. They exist only here: the hub moves them
// with the same physics the phones use (`stepBody`) and lets them claim cuts, kicks and
// items through the same methods a phone's messages go through.

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

    itemEveryMs: 6_000,         // a power-up bubble rises about this often
    itemRadius: 0.45,
    giantReach: 1.0,            // extra katana reach with the giant katana
    turboFactor: 1.35,          // jump speed with turbo (applied on the phone)
    lavaFirstMs: 15_000,        // the floor turns to lava this long into a round …
    lavaEveryMs: 25_000,        // … and then about this often (warning to warning)
    lavaWarnMs: 2_000,          // glowing floor before it gets hot
    lavaMs: 8_000,
    lavaPenalty: 20,            // points lost when landing in the lava
    lavaCooldownMs: 1_000,
    maxPauseMs: 30_000,         // an open menu pauses the round for everybody, at most this long
    starSpeed: 16,              // shuriken flight speed (units/s), straight line, no gravity
    starRange: 10,              // a shuriken vanishes after this distance
    starRadius: 0.3,
    maxStars: 6,

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

  // Power-ups in floating bubbles. `bit` marks an active effect in the ninja snapshots.
  const ITEMS = {
    giant:  { ms: 8_000,  bit: 1 },  // 🗡️ longer katana
    double: { ms: 10_000, bit: 2 },  // ✨ double points
    shield: { ms: 12_000, bit: 4 },  // 🛡️ blocks one kick or wasp nest
    turbo:  { ms: 8_000,  bit: 8 },  // ⚡ stronger jumps
    shuriken: { ms: 0, bit: 16, stars: 3 }, // ✦ three throwing stars (a count, not a timer)
  };

  const COLORS = ['#ff5d73', '#4dd6ff', '#7ee081', '#ffb84d', '#c77dff', '#ffe156'];

  // Wooden training puppets. Mutable on purpose, like CONFIG.
  const BOT = {
    names: ['Klotz', 'Splitter', 'Knorz', 'Kiefer', 'Brettl'],
    colors: ['#e0a96d', '#e07a5f', '#81b29a', '#9d8df1', '#f2cc8f'],
    thinkMs: 320,               // reaction time between two decisions
    jumpGapMs: [600, 1100],     // pause between two jumps
    aimNoise: 0.3,              // rad, so they miss now and then
    reachFactor: 0.85,          // a little shorter than HIT_REACH on the phones
    throwGapMs: 1_500,
    chaseRange: 2.8,            // a ninja this close may get chased for a kick
    tumbleMs: 450,              // like TUMBLE_MS on the phones
  };
  const FOOT = 0.5;             // centre of a standing ninja above the floor (as in ninja.js)
  const STEP = 1 / 120;         // physics step in seconds (as in ninja.js)

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

  /**
   * Next power-up kind from a shuffled bag: every kind comes once per round of the bag,
   * so none of them goes missing for a whole game (pure chance left long dry spells).
   */
  function pickItemKind(room) {
    if (!room.itemBag.length) {
      room.itemBag = Object.keys(ITEMS);
      for (let i = room.itemBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.itemBag[i], room.itemBag[j]] = [room.itemBag[j], room.itemBag[i]];
      }
    }
    return room.itemBag.pop();
  }

  const hasEffect = (p, kind, now) => (p.effects[kind] || 0) > now;
  const effectBits = (p, now) => Object.entries(ITEMS).reduce(
    (bits, [kind, def]) => bits | ((kind === 'shuriken' ? p.stars > 0 : hasEffect(p, kind, now)) ? def.bit : 0), 0);

  const startX = (slot) => round2(1 + ((slot * 3.1) % (CONFIG.width - 2)));

  /** A fresh standing body for a bot at the given x. */
  function newBody(x) {
    return {
      x, y: FOOT, vx: 0, vy: 0, air: false, rot: 0, spinDir: 1, facing: 1,
      onPlatform: null, slashUntil: 0, tumbleUntil: 0,
    };
  }

  function landBody(n, height, platform) {
    Object.assign(n, { y: height + FOOT, vx: 0, vy: 0, air: false, onPlatform: platform, rot: 0 });
  }

  /** One physics step of a bot body: the same rules as `step` in ninja.js. */
  function stepBody(n, dt, now) {
    if (n.air) {
      const prevBottom = n.y - FOOT;
      n.vy = Math.max(-CONFIG.maxFallSpeed, n.vy - CONFIG.gravity * dt);
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.rot += n.spinDir * CONFIG.spinSpeed * dt;
      if (n.x < CONFIG.ninjaRadius) {
        n.x = CONFIG.ninjaRadius;
        n.vx = Math.abs(n.vx) * 0.4;
      } else if (n.x > CONFIG.width - CONFIG.ninjaRadius) {
        n.x = CONFIG.width - CONFIG.ninjaRadius;
        n.vx = -Math.abs(n.vx) * 0.4;
      }
      if (n.y > CONFIG.height + 1.5) {
        n.y = CONFIG.height + 1.5;
        n.vy = Math.min(n.vy, 0);
      }
      const bottom = n.y - FOOT;
      if (n.vy <= 0) {
        for (const p of PLATFORMS) {
          if (prevBottom >= p[2] - 0.02 && bottom <= p[2] && n.x >= p[0] - 0.1 && n.x <= p[1] + 0.1) {
            landBody(n, p[2], p);
            return;
          }
        }
      }
      if (bottom <= 0) landBody(n, 0, null);
      return;
    }
    if (n.onPlatform && (n.x < n.onPlatform[0] - 0.1 || n.x > n.onPlatform[1] + 0.1)) {
      n.air = true;
      n.onPlatform = null;
    }
    n.rot = now < n.slashUntil ? n.spinDir * Math.PI * 2 * (1 - (n.slashUntil - now) / CONFIG.slashMs) : 0;
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

  /** Milliseconds until the fruit touches the floor (or a rising bubble leaves at the top). */
  function fruitLifetime(f) {
    if (f.rise) return ((CONFIG.height + 3 - f.y0) / -f.v0) * 1000;
    const drop = f.y0 - f.r;
    return ((-f.v0 + Math.sqrt(f.v0 * f.v0 + 2 * f.g * drop)) / f.g) * 1000;
  }

  class NinjaRoom {
    constructor(code) {
      this.code = code;
      this.players = new Map(); // token -> player
      this.fruits = new Map();
      this.items = new Map();   // power-up bubbles, same path formula as the fruit
      this.stars = new Map();   // shuriken in flight
      this.itemBag = [];        // shuffled power-up kinds still to come
      this.lava = null;         // { warnAt, startAt, endAt } on the hub clock while it is due
      this.nextLavaAt = 0;
      this.nextItemAt = 0;
      this.phase = 'lobby';     // lobby | countdown | playing
      this.phaseEndsAt = 0;
      this.lastResults = null;
      this.colorIndex = 0;
      this.timer = null;
      this.phaseTimer = null;
      this.spawnBudget = 0;
      this.nextSalvoAt = 0;
      // Pause: the room has its own clock that stands still while a player has the menu
      // open. Every time on the hub (fruit paths, lava, effects, round end) uses it, so a
      // pause shifts nothing; the phones freeze their copy of the clock the same way.
      this.pausers = new Set(); // ids of players with the menu open
      this.pausedSince = 0;     // Date.now() when the current pause began (0 = running)
      this.pausedTotal = 0;     // ms the clock was stopped so far
      this.pauseTimer = null;
      this.botCount = 0;        // wanted number of bots (fewer when humans fill the room)
      this.botClock = 0;        // hub time of the last bot physics update
    }

    /** Hub clock in ms: Date.now() minus all pauses, frozen during a pause. */
    now() {
      return (this.pausedSince || Date.now()) - this.pausedTotal;
    }

    get paused() {
      return this.pausedSince > 0;
    }

    /** Ends the countdown or the round when its time is up on the hub clock. */
    schedulePhaseEnd() {
      clearTimeout(this.phaseTimer);
      if (this.phase === 'lobby' || this.paused) return;
      const next = this.phase === 'countdown' ? () => this.startRound() : () => this.endRound();
      this.phaseTimer = setTimeout(next, Math.max(0, this.phaseEndsAt - this.now()));
    }

    /** A player opened (on) or closed (off) the menu. */
    setPause(player, on) {
      if (on && this.phase !== 'lobby') this.pausers.add(player.id);
      else this.pausers.delete(player.id);
      this.updatePause();
    }

    updatePause() {
      const want = this.pausers.size > 0 && this.phase !== 'lobby';
      if (want === this.paused) return;
      if (want) {
        this.pausedSince = Date.now();
        clearTimeout(this.phaseTimer);
        // Nobody can hold the whole dojo forever: the round goes on after a while.
        this.pauseTimer = setTimeout(() => {
          this.pausers.clear();
          this.updatePause();
        }, CONFIG.maxPauseMs);
      } else {
        this.pausedTotal += Date.now() - this.pausedSince;
        this.pausedSince = 0;
        clearTimeout(this.pauseTimer);
        this.schedulePhaseEnd();
      }
      this.broadcastState();
    }

    connected() {
      return [...this.players.values()].filter((p) => p.socket);
    }

    /** Everybody in the dojo: connected phones and bots. */
    active() {
      return [...this.players.values()].filter((p) => p.socket || p.bot);
    }

    bots() {
      return [...this.players.values()].filter((p) => p.bot);
    }

    humans() {
      return [...this.players.values()].filter((p) => !p.bot);
    }

    /** Lowest start slot nobody uses, so nobody starts on top of somebody else. */
    freeSlot() {
      const used = new Set([...this.players.values()].map((p) => p.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      return slot;
    }

    /**
     * Bring the bots in line with `botCount` and the free seats. Bots make room for
     * humans at once; new bots only join between rounds (`allowAdd`).
     */
    syncBots(allowAdd = this.phase === 'lobby') {
      const bots = this.bots();
      const humans = this.humans().length;
      const want = humans ? Math.min(this.botCount, CONFIG.maxPlayersPerRoom - humans) : 0;
      while (bots.length > want) {
        const bot = bots.pop();
        this.players.delete(bot.token);
        this.pausers.delete(bot.id);
      }
      if (!allowAdd) return;
      const usedNames = new Set(bots.map((b) => b.botIndex));
      for (let i = 0; bots.length < want && i < BOT.names.length; i++) {
        if (usedNames.has(i)) continue;
        const bot = new NinjaPlayer(this, `bot-${i}-${randomHex(4)}`, BOT.names[i], BOT.colors[i]);
        bot.slot = this.freeSlot();
        bot.bot = true;
        bot.botIndex = i;
        this.placeBot(bot, 0);
        this.players.set(bot.token, bot);
        bots.push(bot);
      }
    }

    placeBot(bot, now) {
      bot.body = newBody(startX(bot.slot));
      bot.brain = { nextThinkAt: now, nextJumpAt: now + rand(300, 1000), nextThrowAt: now, goal: null };
      this.syncBotPos(bot, now);
    }

    syncBotPos(bot, now) {
      const b = bot.body;
      bot.pos = {
        x: round2(b.x), y: round2(b.y), rot: round2(b.rot), air: b.air ? 1 : 0,
        facing: b.facing, at: now,
      };
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
        serverNow: this.now(),
        paused: this.paused ? [...this.pausers] : null,
        players: [...this.players.values()].map((p) => ({
          id: p.id, name: p.name, color: p.color, score: p.score, best: p.best,
          connected: !!(p.socket || p.bot), bot: !!p.bot,
        })),
        bots: this.botCount,
        lastResults: this.lastResults,
        lava: this.lava,
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
      this.syncBots(true);
      const now = this.now();
      for (const bot of this.bots()) this.placeBot(bot, now);
      this.botClock = now;
      this.phase = 'countdown';
      this.phaseEndsAt = now + CONFIG.countdownMs;
      this.broadcastState();
      this.schedulePhaseEnd();
    }

    startRound() {
      const now = this.now();
      this.phase = 'playing';
      this.phaseEndsAt = now + CONFIG.roundMs;
      this.fruits.clear();
      this.items.clear();
      this.stars.clear();
      this.spawnBudget = 1;
      this.nextSalvoAt = now + CONFIG.salvoEveryMs;
      this.nextItemAt = now + CONFIG.itemEveryMs * 0.6;
      this.lava = null;
      this.nextLavaAt = now + CONFIG.lavaFirstMs;
      for (const p of this.players.values()) {
        p.score = 0;
        p.chain = 0;
        p.stunnedUntil = 0;
        p.effects = {};
        p.stars = 0;
        p.prevBest = p.best;
        if (p.bot) p.brain.nextJumpAt = now + rand(150, 700);
      }
      this.broadcastState();
      this.schedulePhaseEnd();
    }

    endRound() {
      clearTimeout(this.phaseTimer);
      this.pausers.clear();
      this.phase = 'lobby';
      this.updatePause(); // a pause ends with the round
      this.phaseEndsAt = 0;
      this.fruits.clear();
      this.items.clear();
      this.stars.clear();
      this.lava = null;
      // Each phone keeps its own best per name; the hub only collects them for the
      // leaderboard and tells everybody where this round's scores landed.
      // Bots keep no bests: they stay out of the leaderboard.
      for (const p of this.players.values()) if (!p.bot) p.best = Math.max(p.best, p.score);
      this.lastResults = [...this.players.values()]
        .sort((a, b) => b.score - a.score)
        .map((p) => ({
          id: p.id, name: p.name, color: p.color, score: p.score, bot: !!p.bot,
          prevBest: p.prevBest, best: p.best, record: !p.bot && p.score > 0 && p.score > p.prevBest,
        }));
      this.broadcast({ type: 'roundEnd', results: this.lastResults });
      this.broadcastState();
    }

    tick() {
      const now = this.now();
      if (this.connected().length === 0) this.stopLoop();
      if (this.paused) return; // everything stands still, the phones already froze
      if (this.phase === 'playing') {
        for (const [id, f] of this.fruits) {
          if (f.t0 + fruitLifetime(f) + 500 < now) this.fruits.delete(id);
        }
        const progress = 1 - Math.max(0, this.phaseEndsAt - now) / CONFIG.roundMs;
        const rate = (CONFIG.baseSpawnPerSecond + CONFIG.spawnPerSecondPerPlayer * this.active().length)
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
        for (const [id, star] of this.stars) {
          if (now - star.t0 > (CONFIG.starRange / CONFIG.starSpeed) * 1000 + 1500) this.stars.delete(id);
        }
        for (const [id, item] of this.items) {
          if (item.t0 + fruitLifetime(item) + 500 < now) this.items.delete(id);
        }
        if (now >= this.nextItemAt) {
          this.nextItemAt = now + CONFIG.itemEveryMs * rand(0.7, 1.3);
          this.spawnItem(now);
        }
        if (!this.lava && now >= this.nextLavaAt) this.startLava(now);
        else if (this.lava && now > this.lava.endAt) {
          this.lava = null;
          this.broadcastState();
        }
      }
      // Ninja positions go out in every phase except the lobby, which covers the dojo.
      if (this.phase !== 'lobby') {
        this.updateBots(now);
        this.broadcast({
          type: 'ninjas',
          list: this.active().filter((p) => p.pos).map((p) => [
            p.id, p.pos.x, p.pos.y, p.pos.rot, p.pos.air, now < p.stunnedUntil ? 1 : 0, p.pos.facing, effectBits(p, now),
          ]),
        });
      }
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

    /**
     * A power-up bubble rises slowly from the floor, away from the falling fruit.
     * Same path formula: a negative v0 without gravity moves it up at a steady pace.
     */
    spawnItem(now, overrides = {}) {
      const r = CONFIG.itemRadius;
      const item = {
        id: nextFruitId++,
        kind: overrides.kind || pickItemKind(this),
        t0: now,
        r,
        rise: true,
        x0: rand(r + 0.3, CONFIG.width - r - 0.3),
        y0: -r - 0.2,
        vx: rand(-0.5, 0.5),
        v0: -rand(1.6, 2.2),
        g: 0,
        rot0: 0,
        spin: 0,
        ...overrides,
      };
      this.items.set(item.id, item);
      this.broadcast({ type: 'item', item });
      return item;
    }

    /** Is the path point (fruit or item) near the claimed position shortly before now? */
    nearPath(f, x, y, reach, now) {
      for (let back = 0; back <= 300; back += 50) {
        const pos = fruitPosition(f, now - back);
        if (Math.hypot(pos.x - x, pos.y - y) <= reach) return true;
      }
      return false;
    }

    /** Body or katana touches a power-up bubble. */
    collect(player, msg) {
      if (this.phase !== 'playing') return;
      const item = this.items.get(Number(msg.id));
      if (!item) return;
      const now = this.now();
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (player.pos && Math.hypot(x - player.pos.x, y - player.pos.y) > CONFIG.positionTolerance) return;
      const bonus = hasEffect(player, 'giant', now) ? CONFIG.giantReach : 0;
      if (!this.nearPath(item, x, y, CONFIG.bladeReach + bonus + item.r + CONFIG.cutTolerance, now)) return;

      this.items.delete(item.id);
      const def = ITEMS[item.kind];
      if (item.kind === 'shuriken') player.stars = Math.min(CONFIG.maxStars, player.stars + def.stars);
      else player.effects[item.kind] = now + def.ms;
      this.broadcast({
        type: 'collected', id: item.id, kind: item.kind, ms: def.ms, stars: player.stars,
        by: { id: player.id, name: player.name, color: player.color },
      });
    }

    /** Announce the next lava phase: glowing warning, then hot floor. */
    startLava(now) {
      const startAt = now + CONFIG.lavaWarnMs;
      this.lava = { warnAt: now, startAt, endAt: startAt + CONFIG.lavaMs };
      this.nextLavaAt = now + CONFIG.lavaEveryMs;
      this.broadcastState();
    }

    /** The phone says its ninja touched the lava floor: lose points (not below zero). */
    burn(player) {
      if (this.phase !== 'playing' || !this.lava || !player.pos) return;
      const now = this.now();
      if (now < this.lava.startAt - 300 || now > this.lava.endAt + 300) return;
      if (now < player.lavaReadyAt || player.pos.y > 1.5) return;
      player.lavaReadyAt = now + CONFIG.lavaCooldownMs;
      const points = Math.min(CONFIG.lavaPenalty, Math.max(0, player.score));
      player.score -= points;
      player.chain = 0;
      this.broadcast({
        type: 'burned', x: player.pos.x, points,
        by: { id: player.id, name: player.name, color: player.color },
      });
      if (points) this.broadcastState();
    }

    /** Throw a shuriken from the ninja's position in direction (dx, dy). */
    throwStar(player, msg) {
      if (this.phase !== 'playing' || player.stars <= 0 || !player.pos) return;
      const dx = Number(msg.dx);
      const dy = Number(msg.dy);
      const len = Math.hypot(dx, dy);
      if (!Number.isFinite(len) || len < 1e-6) return;
      player.stars--;
      const star = {
        id: nextFruitId++, by: player.id, x0: player.pos.x, y0: player.pos.y,
        dx: round2(dx / len), dy: round2(dy / len), t0: this.now(), hitNinja: false,
      };
      this.stars.set(star.id, star);
      this.broadcast({
        type: 'star', cid: msg.cid, stars: player.stars,
        star: { id: star.id, x0: star.x0, y0: star.y0, dx: star.dx, dy: star.dy, t0: star.t0 },
        by: { id: player.id, name: player.name, color: player.color },
      });
    }

    /** Is (x, y) on the flight line of the star (the phone starts it a little earlier)? */
    onStarLine(star, x, y) {
      const rx = x - star.x0;
      const ry = y - star.y0;
      const along = rx * star.dx + ry * star.dy;
      const across = Math.abs(rx * star.dy - ry * star.dx);
      return along >= -1 && along <= CONFIG.starRange + 1 && across <= 0.8;
    }

    /** A shuriken hits another ninja: deflected by a spinning katana, blocked by a shield, else a kick. */
    starHit(player, msg) {
      if (this.phase !== 'playing') return;
      const star = this.stars.get(Number(msg.star));
      if (!star || star.by !== player.id || star.hitNinja) return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !this.onStarLine(star, x, y)) return;
      const target = this.active().find((p) => p.id === msg.target && p !== player);
      if (!target || !target.pos) return;
      if (Math.hypot(target.pos.x - x, target.pos.y - y) > CONFIG.ninjaRadius + CONFIG.starRadius + CONFIG.positionTolerance) return;
      const now = this.now();
      star.hitNinja = true;
      const who = (p) => ({ id: p.id, name: p.name, color: p.color });
      const at = { x: round2(x), y: round2(y) };
      this.broadcast({ type: 'starGone', id: star.id });

      const spinning = target.pos.air && now - target.pos.at <= CONFIG.spinFreshMs && now >= target.stunnedUntil;
      if (spinning) {
        this.broadcast({ type: 'deflect', ...at, target: who(target), by: who(player) });
        return;
      }
      if (hasEffect(target, 'shield', now)) {
        target.effects.shield = 0;
        this.broadcast({ type: 'kick', ...at, by: who(player), target: who(target), points: 0, blocked: true, via: 'star', vx: 0, vy: 0 });
        return;
      }
      const points = Math.min(CONFIG.kickSteal, Math.max(0, target.score));
      target.score -= points;
      player.score += points;
      const vx = round2(star.dx * CONFIG.bumpSpeed);
      const vy = round2(Math.max(0.4, star.dy + 0.6) * CONFIG.bumpSpeed * 0.7);
      this.broadcast({ type: 'kick', ...at, by: who(player), target: who(target), points, via: 'star', vx, vy });
      this.knockBot(target, vx, vy, true);
      if (points) this.broadcastState();
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
        at: this.now(),
      };
    }

    cut(player, msg) {
      if (this.phase !== 'playing') return;
      const fruit = this.fruits.get(Number(msg.id));
      if (!fruit) return;
      const now = this.now();
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const viaStar = msg.star !== undefined && msg.star !== null;
      if (viaStar) {
        // A shuriken cut: (x, y) is where the star was; it must lie on the star's line and
        // the fruit must have been there. Stars fly past wasp nests.
        const star = this.stars.get(Number(msg.star));
        if (!star || star.by !== player.id || fruit.type === 'nest' || !this.onStarLine(star, x, y)) return;
        if (!this.nearPath(fruit, x, y, CONFIG.starRadius + fruit.r + CONFIG.cutTolerance, now)) return;
      } else {
        if (now < player.stunnedUntil) return;
        // The claimed blade position must match the last reported ninja …
        if (player.pos && Math.hypot(x - player.pos.x, y - player.pos.y) > CONFIG.positionTolerance) return;
        // … and the fruit must have been within reach shortly before now (latency).
        const bonus = hasEffect(player, 'giant', now) ? CONFIG.giantReach : 0;
        if (!this.nearPath(fruit, x, y, CONFIG.bladeReach + bonus + fruit.r + CONFIG.cutTolerance, now)) return;
      }

      this.fruits.delete(fruit.id);
      let points = fruit.points;
      let shielded = false;
      if (fruit.type === 'nest') {
        player.chain = 0;
        if (hasEffect(player, 'shield', now)) {
          // The shield takes the stings: no points lost, no stun, shield gone.
          shielded = true;
          points = 0;
          player.effects.shield = 0;
        } else {
          player.stunnedUntil = now + CONFIG.stunMs;
          player.send({ type: 'stunned', ms: CONFIG.stunMs });
        }
      } else {
        player.chain = now - player.lastCutAt <= CONFIG.comboWindowMs ? player.chain + 1 : 1;
        player.lastCutAt = now;
        points += Math.min(CONFIG.maxComboBonus, (player.chain - 1) * CONFIG.comboBonus);
        if (hasEffect(player, 'double', now)) points *= 2;
      }
      player.score += points;
      this.broadcast({
        type: 'cut',
        id: fruit.id,
        points,
        shielded,
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
      const now = this.now();
      if (now < player.bumpReadyAt || now < player.stunnedUntil || !player.pos) return;
      const target = this.active().find((p) => p.id === msg.id && p !== player);
      if (!target || !target.pos) return;
      const dx = target.pos.x - player.pos.x;
      const dy = target.pos.y - player.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > CONFIG.bladeReach + CONFIG.giantReach + CONFIG.ninjaRadius + CONFIG.positionTolerance) return;
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
        const pushes = { [player.id]: push(-1), [target.id]: push(1) };
        this.broadcast({ type: 'clash', ...at, a: who(player), b: who(target), push: pushes });
        this.knockBot(player, ...pushes[player.id], false);
        this.knockBot(target, ...pushes[target.id], false);
        return;
      }

      if (hasEffect(target, 'shield', now)) {
        // The shield blocks the kick: the kicker bounces off, the shield is used up.
        target.effects.shield = 0;
        const vx = round2(-ux * CONFIG.bumpSpeed * 0.8);
        const vy = round2(Math.max(0.4, -uy + 0.6) * CONFIG.bumpSpeed * 0.6);
        this.broadcast({ type: 'kick', ...at, by: who(player), target: who(target), points: 0, blocked: true, vx, vy });
        this.knockBot(player, vx, vy, false);
        return;
      }

      const points = this.phase === 'playing' ? Math.min(CONFIG.kickSteal, Math.max(0, target.score)) : 0;
      target.score -= points;
      player.score += points;
      const vx = round2(ux * CONFIG.bumpSpeed);
      const vy = round2(Math.max(0.4, uy + 0.6) * CONFIG.bumpSpeed * 0.7);
      this.broadcast({ type: 'kick', ...at, by: who(player), target: who(target), points, vx, vy });
      this.knockBot(target, vx, vy, true);
      if (points) this.broadcastState();
    }

    // -------------------------------------------------------------------------
    // Bots
    // -------------------------------------------------------------------------

    /** Thrown through the air by a kick or a clash (no-op for phones: they do it themselves). */
    knockBot(p, vx, vy, tumble) {
      if (!p.bot) return;
      const b = p.body;
      const now = this.now();
      Object.assign(b, { air: true, onPlatform: null, vx, vy, spinDir: vx >= 0 ? 1 : -1 });
      if (tumble) b.tumbleUntil = now + BOT.tumbleMs;
      // Catch itself with a jump after a moment, like a human would.
      p.brain.nextJumpAt = Math.max(p.brain.nextJumpAt, now + rand(250, 550));
      p.brain.goal = null;
    }

    /** Move, think and claim for every bot (called from tick outside the lobby). */
    updateBots(now) {
      const bots = this.bots();
      const dt = Math.min(0.25, Math.max(0, (now - this.botClock) / 1000));
      this.botClock = now;
      if (!bots.length) return;
      if (this.phase !== 'playing') {
        for (const bot of bots) this.syncBotPos(bot, now);
        return;
      }
      const steps = Math.round(dt / STEP);
      for (const bot of bots) {
        if (!this.players.has(bot.token)) continue; // sent home by a claim in this tick
        for (let i = 0; i < steps; i++) {
          const ts = now - (steps - 1 - i) * STEP * 1000;
          stepBody(bot.body, STEP, ts);
          this.syncBotPos(bot, ts);
          this.botContact(bot, ts);
        }
        this.syncBotPos(bot, now);
        this.botThink(bot, now);
        this.botLava(bot, now);
      }
      this.updateBotStars(now);
    }

    botReach(bot, now) {
      return CONFIG.bladeReach * BOT.reachFactor + (hasEffect(bot, 'giant', now) ? CONFIG.giantReach * BOT.reachFactor : 0);
    }

    botBladeActive(bot, now) {
      const b = bot.body;
      return (b.air || now < b.slashUntil) && now >= bot.stunnedUntil && now >= b.tumbleUntil;
    }

    /** What the spinning wooden sword touches: fruit, bubbles and other ninjas. */
    botContact(bot, now) {
      const b = bot.body;
      const active = this.botBladeActive(bot, now);
      const reach = this.botReach(bot, now);
      if (active) {
        for (const f of this.fruits.values()) {
          const pos = fruitPosition(f, now);
          if (pos.y > CONFIG.height + 1) continue;
          if (Math.hypot(pos.x - b.x, pos.y - b.y) > reach + f.r) continue;
          this.cut(bot, { id: f.id, x: b.x, y: b.y, angle: Math.atan2(pos.y - b.y, pos.x - b.x) });
        }
      }
      if (now >= bot.stunnedUntil) {
        for (const it of this.items.values()) {
          const pos = fruitPosition(it, now);
          if (Math.hypot(pos.x - b.x, pos.y - b.y) <= (active ? reach : CONFIG.ninjaRadius) + it.r) {
            this.collect(bot, { id: it.id, x: b.x, y: b.y });
          }
        }
      }
      if (active && now >= bot.bumpReadyAt) {
        const other = this.active().find((o) => o !== bot && o.pos
          && Math.hypot(o.pos.x - b.x, o.pos.y - b.y) <= reach + CONFIG.ninjaRadius);
        if (other) this.bump(bot, { id: other.id });
      }
    }

    /** Standing on the hot floor costs points, like a phone reporting it. */
    botLava(bot, now) {
      const lava = this.lava;
      if (!lava || now < lava.startAt || now > lava.endAt) return;
      if (!bot.body.air && !bot.body.onPlatform) this.burn(bot);
    }

    /** A jump in direction (dx, dy), with the same rules as a swipe on a phone. */
    botJump(bot, dx, dy, now) {
      const b = bot.body;
      if (now < bot.stunnedUntil) return;
      let len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      if (!b.air && dy < -0.5) { // a swipe down on the ground is a sword spin
        if (now >= b.slashUntil) {
          b.slashUntil = now + CONFIG.slashMs;
          b.spinDir = b.facing;
        }
        return;
      }
      if (!b.air) dy = Math.max(dy, 0.35);
      len = Math.hypot(dx, dy);
      const speed = CONFIG.jumpSpeed * (hasEffect(bot, 'turbo', now) ? CONFIG.turboFactor : 1);
      b.vx = (dx / len) * speed;
      b.vy = (dy / len) * speed;
      b.air = true;
      b.onPlatform = null;
      b.tumbleUntil = 0;
      if (Math.abs(dx) > 0.15) b.facing = dx > 0 ? 1 : -1;
      b.spinDir = b.facing;
    }

    /**
     * The jump direction that brings the body to the moving point `at(t)`: tries flight
     * times and keeps the one whose needed speed is closest to the real jump speed.
     */
    aim(bot, at, now) {
      const b = bot.body;
      const speed = CONFIG.jumpSpeed * (hasEffect(bot, 'turbo', now) ? CONFIG.turboFactor : 1);
      let best = null;
      for (let T = 0.08; T <= 0.9; T += 0.04) {
        const p = at(now + T * 1000);
        const dx = p.x - b.x;
        const dy = p.y - b.y + 0.5 * CONFIG.gravity * T * T; // gravity pulls it down meanwhile
        const err = Math.abs(Math.hypot(dx, dy) / T - speed);
        if (!best || err < best.err) best = { dx, dy, err };
      }
      return best;
    }

    /** The most attractive thing to go for, or null. */
    botGoal(bot, now, hot) {
      const b = bot.body;
      const others = this.bots().filter((o) => o !== bot && o.brain.goal);
      const nests = [...this.fruits.values()].filter((f) => f.type === 'nest');
      let best = null;
      const consider = (key, value, at) => {
        const p = at(now + 400);
        if (p.y > CONFIG.height - 0.3 || p.y < 0.5 || p.x < 0 || p.x > CONFIG.width) return;
        if (hot && p.y < 3.5) return; // the floor is (about to be) lava: stay up high
        let score = value / (Math.hypot(p.x - b.x, p.y - b.y) + 2);
        // Keep away from wasp nests and do not all go for the same fruit.
        if (nests.some((n) => n.id !== key && Math.hypot(fruitPosition(n, now + 400).x - p.x, fruitPosition(n, now + 400).y - p.y) < 1.4)) score *= 0.2;
        if (others.some((o) => o.brain.goal.key === key)) score *= 0.45;
        if (bot.brain.goal && bot.brain.goal.key === key) score *= 1.3; // stick to a plan
        score *= rand(0.85, 1.15);
        if (!best || score > best.score) best = { key, score, at };
      };
      for (const f of this.fruits.values()) {
        if (f.type !== 'nest') consider(`f${f.id}`, f.points, (t) => fruitPosition(f, t));
      }
      for (const it of this.items.values()) consider(`i${it.id}`, 22, (t) => fruitPosition(it, t));
      for (const o of this.active()) {
        if (o === bot || !o.pos || o.score <= 0 || now < o.stunnedUntil) continue;
        const d = Math.hypot(o.pos.x - b.x, o.pos.y - b.y);
        if (d < BOT.chaseRange) {
          const at = () => ({ x: o.pos.x, y: o.pos.y });
          consider(`n${o.id}`, 9, at);
        }
      }
      return best;
    }

    /** Nearest platform to wait out the lava on. */
    safeSpot(bot) {
      const b = bot.body;
      let best = null;
      for (const p of PLATFORMS) {
        const spot = { x: Math.min(p[1] - 0.4, Math.max(p[0] + 0.4, b.x)), y: p[2] + FOOT + 0.6 };
        const d = Math.hypot(spot.x - b.x, spot.y - b.y);
        if (!best || d < best.d) best = { d, spot };
      }
      return best.spot;
    }

    /** Decide what to do next: throw, jump after something, flee the lava or rest. */
    botThink(bot, now) {
      const brain = bot.brain;
      const b = bot.body;
      if (now < brain.nextThinkAt || now < bot.stunnedUntil) return;
      brain.nextThinkAt = now + BOT.thinkMs * rand(0.7, 1.3);

      if (bot.stars > 0 && now >= brain.nextThrowAt) {
        const victims = this.active().filter((o) => o !== bot && o.pos
          && Math.hypot(o.pos.x - b.x, o.pos.y - b.y) < CONFIG.starRange * 0.7);
        if (victims.length) {
          const v = victims[Math.floor(Math.random() * victims.length)];
          const a = Math.atan2(v.pos.y - b.y, v.pos.x - b.x) + rand(-BOT.aimNoise, BOT.aimNoise);
          this.throwStar(bot, { dx: Math.cos(a), dy: Math.sin(a) });
          brain.nextThrowAt = now + BOT.throwGapMs * rand(0.8, 1.5);
        }
      }

      // A wasp nest right in the path of the spinning sword: jump away (most of the time).
      if (b.air && now >= (brain.dodgedAt || 0) + 400) {
        const reach = this.botReach(bot, now);
        const ahead = { x: b.x + b.vx * 0.15, y: b.y + b.vy * 0.15 };
        for (const f of this.fruits.values()) {
          if (f.type !== 'nest') continue;
          const p = fruitPosition(f, now + 150);
          if (Math.hypot(p.x - ahead.x, p.y - ahead.y) > reach + f.r + 0.5) continue;
          brain.dodgedAt = now;
          if (Math.random() < 0.65) {
            this.botJump(bot, b.x - p.x + rand(-0.3, 0.3), b.y - p.y, now);
            brain.nextJumpAt = now + rand(...BOT.jumpGapMs);
            brain.goal = null;
            return;
          }
          break;
        }
      }

      if (now < brain.nextJumpAt) return;
      const lava = this.lava;
      const hot = !!lava && now >= lava.warnAt - 500 && now <= lava.endAt;
      // Low down while the floor is (about to be) hot: up onto a platform first.
      const flee = hot && !b.onPlatform && b.y < 3.5;
      const goal = flee ? null : this.botGoal(bot, now, hot);
      brain.goal = goal;
      let at = goal ? goal.at : null;
      if (!at && hot && !b.onPlatform) {
        const spot = this.safeSpot(bot);
        at = () => spot;
      }
      if (!at) {
        // Nothing worth it: stand still, or hop around now and then.
        if (!b.air && Math.random() < 0.25) {
          this.botJump(bot, rand(-1, 1), 1, now);
          brain.nextJumpAt = now + rand(...BOT.jumpGapMs);
        }
        return;
      }
      const p = at(now + 120);
      const reach = this.botReach(bot, now);
      if (goal && Math.hypot(p.x - b.x, p.y - b.y) < reach * 0.8) {
        // Already within reach: in the air the sword spins anyway, on the ground spin it.
        if (!b.air) this.botJump(bot, 0, -1, now);
        brain.nextJumpAt = now + 150;
        return;
      }
      const shot = this.aim(bot, at, now);
      const angle = Math.atan2(shot.dy, shot.dx) + rand(-BOT.aimNoise, BOT.aimNoise);
      this.botJump(bot, Math.cos(angle), Math.sin(angle), now);
      brain.nextJumpAt = now + rand(...BOT.jumpGapMs);
    }

    /** Bot shuriken: the hub flies them itself and claims what they hit. */
    updateBotStars(now) {
      for (const star of this.stars.values()) {
        if (star.done) continue;
        const bot = this.bots().find((p) => p.id === star.by);
        if (!bot) continue;
        const reached = Math.min(CONFIG.starRange, ((now - star.t0) / 1000) * CONFIG.starSpeed);
        let d = star.checked || 0;
        for (; d <= reached && !star.done; d += 0.25) {
          const x = star.x0 + star.dx * d;
          const y = star.y0 + star.dy * d;
          if (x < 0 || x > CONFIG.width || y < 0 || y > CONFIG.height + 2) {
            star.done = true;
            break;
          }
          const t = star.t0 + (d / CONFIG.starSpeed) * 1000;
          for (const f of this.fruits.values()) {
            if (f.type === 'nest') continue;
            const pos = fruitPosition(f, t);
            if (Math.hypot(pos.x - x, pos.y - y) <= CONFIG.starRadius + f.r) {
              this.cut(bot, { id: f.id, x: round2(x), y: round2(y), star: star.id, angle: Math.atan2(star.dy, star.dx) });
            }
          }
          const hit = this.active().find((o) => o !== bot && o.pos
            && Math.hypot(o.pos.x - x, o.pos.y - y) <= CONFIG.starRadius + CONFIG.ninjaRadius);
          if (hit) {
            this.starHit(bot, { star: star.id, x: round2(x), y: round2(y), target: hit.id });
            star.done = true;
          }
        }
        star.checked = d;
        if (reached >= CONFIG.starRange) star.done = true;
      }
    }

    removeIfEmpty() {
      if (this.humans().length === 0) {
        this.players.clear(); // bots do not keep a room alive
        this.stopLoop();
        clearTimeout(this.phaseTimer);
        clearTimeout(this.pauseTimer);
        rooms.delete(this.code);
      }
    }
  }

  class NinjaPlayer {
    constructor(room, token, name, color) {
      this.id = randomHex(4);
      this.token = token;
      this.name = name;
      this.color = color || COLORS[room.colorIndex++ % COLORS.length];
      this.slot = room.freeSlot();
      this.bot = false;
      this.score = 0;
      this.chain = 0;
      this.lastCutAt = 0;
      this.stunnedUntil = 0;
      this.bumpReadyAt = 0;
      this.effects = {};        // item kind -> active until (ms)
      this.stars = 0;           // shuriken left to throw
      this.best = 0;            // personal best, as stored on the player's phone
      this.prevBest = 0;        // best before the current round
      this.lavaReadyAt = 0;
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
      // Bots never take a seat a human wants: syncBots below sends one home.
      if (room.humans().length >= CONFIG.maxPlayersPerRoom) {
        socket.send(JSON.stringify({ type: 'error', message: 'Dieser Dojo ist voll (höchstens 6 Ninjas).' }));
        return null;
      }
      player = new NinjaPlayer(room, token, sanitizeName(msg.name, `Ninja ${room.humans().length + 1}`));
      room.players.set(token, player);
      room.syncBots();
    }

    player.socket = socket;
    // Starting spot on the floor, spread across the dojo.
    player.send({
      type: 'joined', code, you: player.id, token, color: player.color, name: player.name,
      serverNow: room.now(), startX: startX(player.slot),
    });
    if (room.phase === 'playing') {
      player.send({ type: 'fruits', list: [...room.fruits.values()] });
      player.send({ type: 'items', list: [...room.items.values()] });
    }
    room.broadcast({ type: 'event', kind: 'join', id: player.id, name: player.name, color: player.color });
    room.broadcastState();
    room.startLoop();
    return { room, player };
  }

  const FROZEN_MESSAGES = new Set(['pos', 'cut', 'collect', 'throw', 'lava', 'starHit', 'bump']);

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
        socket.send(JSON.stringify({ type: 'pong', t: Number(msg.t) || 0, server: session ? session.room.now() : Date.now() }));
        return;
      }
      if (msg.type === 'join') {
        if (!session) session = handleJoin(socket, msg);
        return;
      }
      if (!session) return;
      const { room, player } = session;
      // During a pause nothing moves: late claims and positions from before it are dropped.
      if (room.paused && FROZEN_MESSAGES.has(msg.type)) return;

      switch (msg.type) {
        case 'pos':
          room.reportPosition(player, msg);
          break;
        case 'cut':
          room.cut(player, msg);
          break;
        case 'collect':
          room.collect(player, msg);
          break;
        case 'throw':
          room.throwStar(player, msg);
          break;
        case 'lava':
          room.burn(player);
          break;
        case 'leave':
          // Left on purpose: gone at once, no grace period for a reconnect.
          clearTimeout(player.removeTimer);
          room.players.delete(player.token);
          session = null;
          room.syncBots();
          room.pausers.delete(player.id);
          room.updatePause();
          room.broadcastState();
          room.removeIfEmpty();
          break;
        case 'best':
          // The phone's stored personal best for this name (sent on joining).
          player.best = Math.round(clamp(msg.score, 0, 1_000_000));
          if (room.phase !== 'playing') player.prevBest = player.best;
          room.broadcastState();
          break;
        case 'starHit':
          room.starHit(player, msg);
          break;
        case 'bump':
          room.bump(player, msg);
          break;
        case 'start':
          room.startCountdown();
          break;
        case 'bots':
          // How many wooden puppets play along; only between rounds.
          if (room.phase !== 'lobby') break;
          room.botCount = Math.round(clamp(msg.count, 0, BOT.names.length));
          room.syncBots();
          room.broadcastState();
          break;
        case 'pause':
          room.setPause(player, !!msg.on);
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
      room.pausers.delete(player.id); // a lost connection must not keep the dojo frozen
      room.updatePause();
      player.removeTimer = setTimeout(() => {
        room.players.delete(player.token);
        room.syncBots();
        room.broadcastState();
        room.removeIfEmpty();
      }, CONFIG.disconnectGraceMs);
      room.broadcastState();
    });
  }

  return { handleConnection, fruitPosition, fruitLifetime, stepBody, rooms, CONFIG, BOT, FRUITS, ITEMS, PLATFORMS };
});
