'use strict';

// Plätzchen-Duell hub: two players bake the same random recipe on their own phones,
// station by station (dough, rolling, cutting, baking, icing, colour, sprinkles, plate).
// The phones run the interactive stations and report what the player did; the hub
// scores every station against the recipe and compares the plates at the end. The
// catalogue, the scoring and the cookie "look" are shared with bake.js.
// Transport-agnostic like the other hubs: runs in Node (server.js) and in the browser
// of the hosting phone.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PloinkBakeHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function randomHex(bytes) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Mutable on purpose: tests shorten the timings.
  const CONFIG = {
    countdownMs: 3000,
    roundMs: 12 * 60_000,       // unfinished stations score 0 after this
    disconnectGraceMs: 60_000,
    maxPlayersPerRoom: 2,
    maxNameLength: 16,
    soloPrizeScore: 90,         // playing alone wins a utensil from this score on
    bakeMsPerMinute: 1000,      // oven clock on the phones: one recipe minute per second
    stirTurns: 6,               // full circles in the bowl for a smooth dough
  };

  const PLAYER_COLORS = ['#ff8fab', '#4dd6ff', '#7ee081', '#ffb84d'];

  const STATIONS = ['dough', 'roll', 'cut', 'bake', 'icing', 'color', 'sprinkle', 'plate'];
  const SCORED = STATIONS.filter((s) => s !== 'plate');
  const STATION_INFO = {
    dough: { title: 'Teig anrühren', icon: '🥣' },
    roll: { title: 'Ausrollen', icon: '🪵' },
    cut: { title: 'Ausstechen', icon: '⭐' },
    bake: { title: 'Backen', icon: '🔥' },
    icing: { title: 'Zuckerguss', icon: '🍋' },
    color: { title: 'Färben', icon: '🎨' },
    sprinkle: { title: 'Verzieren', icon: '✨' },
    plate: { title: 'Anrichten', icon: '🍽️' },
  };

  // The shelf. unit: g (scale), Stk (counted), EL (spoons).
  const INGREDIENTS = {
    mehl: { name: 'Mehl', unit: 'g', emoji: '🌾', color: '#efe6d2' },
    zucker: { name: 'Zucker', unit: 'g', emoji: '🍬', color: '#f7f4ee' },
    puderzucker: { name: 'Puderzucker', label: 'Puder­zucker', unit: 'g', emoji: '❄️', color: '#ffffff' },
    butter: { name: 'Butter', unit: 'g', emoji: '🧈', color: '#f6dd7c' },
    eier: { name: 'Eier', unit: 'Stk', one: 'Ei', many: 'Eier', emoji: '🥚', color: '#f1dcc0' },
    kakao: { name: 'Kakao', unit: 'g', emoji: '🍫', color: '#6b4128' },
    zimt: { name: 'Zimt', unit: 'g', emoji: '🪵', color: '#a0582f' },
    vanille: { name: 'Vanillezucker', label: 'Vanille­zucker', unit: 'g', emoji: '🌼', color: '#f5e9b8' },
    honig: { name: 'Honig', unit: 'g', emoji: '🍯', color: '#e2a52e' },
    mandeln: { name: 'gemahlene Mandeln', label: 'gem. Mandeln', unit: 'g', emoji: '🌰', color: '#d9b88f' },
    salz: { name: 'Salz', unit: 'g', emoji: '🧂', color: '#e9eef2' },
    backpulver: { name: 'Backpulver', label: 'Back­pulver', unit: 'g', emoji: '🫧', color: '#e8eefc' },
    staerke: { name: 'Speisestärke', label: 'Speise­stärke', unit: 'g', emoji: '🌽', color: '#fbf3c9' },
    zitrone: { name: 'Zitronensaft', label: 'Zitronen­saft', unit: 'EL', emoji: '🍋', color: '#fff27a' },
    milch: { name: 'Milch', unit: 'EL', emoji: '🥛', color: '#fafafa' },
  };
  const UNIT_MAX = { g: 2000, Stk: 12, EL: 20 };

  const SHAPES = {
    stern: { one: 'Stern', many: 'Sterne' },
    herz: { one: 'Herz', many: 'Herzen' },
    mond: { one: 'Mond', many: 'Monde' },
    kreis: { one: 'Kreis', many: 'Kreise' },
    tanne: { one: 'Tanne', many: 'Tannen' },
    glocke: { one: 'Glocke', many: 'Glocken' },
    blume: { one: 'Blume', many: 'Blumen' },
  };

  const PIPING = {
    rot: { name: 'Rot', color: '#e63946' },
    orange: { name: 'Orange', color: '#f48c2a' },
    gelb: { name: 'Gelb', color: '#ffd23d' },
    gruen: { name: 'Grün', color: '#3fae6a' },
    blau: { name: 'Blau', color: '#3a86ff' },
    lila: { name: 'Lila', color: '#9d4edd' },
    rosa: { name: 'Rosa', color: '#ff7eb6' },
  };

  const SPRINKLES = {
    schoko: { name: 'Schokostreusel', label: 'Schoko­streusel' },
    bunt: { name: 'Bunte Streusel' },
    perlen: { name: 'Zuckerperlen', label: 'Zucker­perlen' },
    silber: { name: 'Silberperlen', label: 'Silber­perlen' },
    kokos: { name: 'Kokosraspeln', label: 'Kokos­raspeln' },
    mandel: { name: 'Mandelblättchen', label: 'Mandel­blättchen' },
    sterne: { name: 'Zuckersterne', label: 'Zucker­sterne' },
    herzen: { name: 'Zuckerherzen', label: 'Zucker­herzen' },
  };

  // Prizes: one new baking utensil for the winner of a round.
  const UTENSILS = {
    schneebesen: { name: 'Goldener Schneebesen', emoji: '🥄' },
    nudelholz: { name: 'Silbernes Nudelholz', emoji: '🪵' },
    spritzbeutel: { name: 'Profi-Spritzbeutel', emoji: '🍦' },
    feinwaage: { name: 'Digitale Feinwaage', emoji: '⚖️' },
    schuessel: { name: 'Porzellan-Rührschüssel', emoji: '🥣' },
    handschuhe: { name: 'Ofenhandschuhe mit Sternen', emoji: '🧤' },
    muetze: { name: 'Echte Kochmütze', emoji: '🧑‍🍳' },
    dose: { name: 'Plätzchendose aus Blech', emoji: '🥫' },
    muffinform: { name: 'Muffinform', emoji: '🧁' },
    tortenplatte: { name: 'Tortenplatte', emoji: '🍰' },
    eieruhr: { name: 'Eieruhr', emoji: '⏲️' },
    streuer: { name: 'Streusel-Streuer', emoji: '🧂' },
    teigrad: { name: 'Teigrädchen', emoji: '🛞' },
    honigloeffel: { name: 'Honiglöffel', emoji: '🍯' },
  };

  // Dough flavours: each adds one typical ingredient and names the recipe.
  const FLAVOURS = [
    { id: 'kakao', prefix: 'Schoko', amounts: [20, 25, 30] },
    { id: 'zimt', prefix: 'Zimt', amounts: [5, 8, 10] },
    { id: 'vanille', prefix: 'Vanille', amounts: [8, 16] },
    { id: 'honig', prefix: 'Honig', amounts: [50, 60, 75] },
    { id: 'mandeln', prefix: 'Mandel', amounts: [50, 75, 100] },
  ];

  const rooms = new Map();

  // ---------------------------------------------------------------- helpers
  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, Number(v) || 0));
  }

  function sanitizeName(raw, fallback) {
    const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, CONFIG.maxNameLength);
    return name || fallback;
  }

  function pick(list, rng) {
    return list[Math.floor(rng() * list.length)];
  }

  function shuffle(list, rng) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function between(min, max, step, rng) {
    const steps = Math.round((max - min) / step);
    return min + step * Math.floor(rng() * (steps + 1));
  }

  /** German number with comma, at most one decimal: 5.25 -> "5,3". */
  function num(v) {
    return String(Math.round(v * 10) / 10).replace('.', ',');
  }

  function formatAmount(id, amount) {
    const ing = INGREDIENTS[id];
    if (!ing) return String(amount);
    if (ing.unit === 'Stk') return `${amount} ${amount === 1 ? ing.one : ing.many}`;
    return `${num(amount)} ${ing.unit} ${ing.name}`;
  }

  function shapeCount(shape, count) {
    const s = SHAPES[shape];
    return `${count} ${count === 1 ? s.one : s.many}`;
  }

  // ---------------------------------------------------------------- recipe
  function makeRecipe(rng = Math.random) {
    const flavour = pick(FLAVOURS, rng);
    const dough = [
      { id: 'mehl', amount: between(200, 300, 25, rng) },
      { id: 'zucker', amount: between(75, 125, 25, rng) },
      { id: 'butter', amount: between(100, 175, 25, rng) },
      { id: 'eier', amount: between(1, 2, 1, rng) },
      { id: flavour.id, amount: pick(flavour.amounts, rng) },
    ];
    if (rng() < 0.35) dough.push({ id: 'salz', amount: pick([2, 3, 5], rng) });

    const [mainShape, secondShape] = shuffle(Object.keys(SHAPES), rng);
    const mainCount = between(4, 7, 1, rng);
    const cut = [{ shape: mainShape, count: mainCount }];
    if (rng() < 0.7) cut.push({ shape: secondShape, count: between(2, 4, 1, rng) });

    const sprinkleCount = rng() < 0.5 ? 1 : 2;
    return {
      title: `${flavour.prefix}-${SHAPES[mainShape].many}`,
      dough,
      mm: between(3, 7, 1, rng),
      cut,
      bake: { temp: between(160, 200, 10, rng), minutes: between(8, 14, 1, rng) },
      icing: [
        { id: 'puderzucker', amount: between(100, 200, 25, rng) },
        { id: 'zitrone', amount: between(2, 4, 1, rng) },
      ],
      color: { id: pick(Object.keys(PIPING), rng), drops: between(1, 4, 1, rng) },
      sprinkles: shuffle(Object.keys(SPRINKLES), rng).slice(0, sprinkleCount),
    };
  }

  /** The recipe as text lines per station, used by the recipe card and in tests. */
  function recipeSteps(recipe) {
    const color = PIPING[recipe.color.id];
    return {
      dough: [...recipe.dough.map((d) => formatAmount(d.id, d.amount)), 'alles glatt verrühren'],
      roll: [`Teig ${recipe.mm} mm dick ausrollen`],
      cut: recipe.cut.map((c) => shapeCount(c.shape, c.count)),
      bake: [`bei ${recipe.bake.temp} °C`, `${recipe.bake.minutes} Minuten backen`],
      icing: [...recipe.icing.map((d) => formatAmount(d.id, d.amount)), 'glatt rühren'],
      color: [`${recipe.color.drops} Tropfen ${color.name} in den Guss`],
      sprinkle: recipe.sprinkles.map((s) => SPRINKLES[s].name),
      plate: ['alle Plätzchen auf den Teller legen'],
    };
  }

  // --------------------------------------------------------------- scoring
  function sanitizeAmounts(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, value] of Object.entries(raw)) {
      if (!Object.hasOwn(INGREDIENTS, id)) continue;
      const unit = INGREDIENTS[id].unit;
      const v = clamp(value, 0, UNIT_MAX[unit]);
      const rounded = Math.round(v);
      if (rounded > 0) out[id] = rounded;
    }
    return out;
  }

  function sanitizeCounts(raw, catalogue, max) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, value] of Object.entries(raw)) {
      if (!Object.hasOwn(catalogue, id)) continue;
      const v = Math.round(clamp(value, 0, max));
      if (v > 0) out[id] = v;
    }
    return out;
  }

  function sanitizeStep(station, data) {
    const d = data && typeof data === 'object' ? data : {};
    switch (station) {
      case 'dough':
      case 'icing':
        return { added: sanitizeAmounts(d.added), stir: clamp(d.stir, 0, 1) };
      case 'roll':
        return { mm: Math.round(clamp(d.mm, 0.5, 40) * 10) / 10 };
      case 'cut':
        return { shapes: sanitizeCounts(d.shapes, SHAPES, 40) };
      case 'bake':
        return { temp: Math.round(clamp(d.temp, 0, 300)), minutes: Math.round(clamp(d.minutes, 0, 90) * 10) / 10 };
      case 'color':
        return { drops: sanitizeCounts(d.drops, PIPING, 40) };
      case 'sprinkle':
        return { sprinkles: [...new Set(Array.isArray(d.sprinkles) ? d.sprinkles : [])].filter((s) => Object.hasOwn(SPRINKLES, s)) };
      default:
        return {};
    }
  }

  /** Weighing + stirring (dough and icing). */
  function scoreMix(wanted, data) {
    const notes = [];
    const added = data.added;
    let sum = 0;
    for (const { id, amount } of wanted) {
      const ing = INGREDIENTS[id];
      const got = added[id] || 0;
      let err;
      if (ing.unit === 'g') err = Math.abs(got - amount) / Math.max(amount * 0.5, 10);
      else err = Math.abs(got - amount) * 0.5;
      sum += Math.max(0, 1 - err);
      if (got === 0) notes.push(`${ing.name} fehlt`);
      else if (got !== amount) notes.push(`${formatAmount(id, got)} statt ${num(amount)}${ing.unit === 'Stk' ? '' : ` ${ing.unit}`}`);
    }
    let score = (sum / wanted.length) * 100;
    const wantedIds = new Set(wanted.map((w) => w.id));
    for (const id of Object.keys(added)) {
      if (wantedIds.has(id)) continue;
      score -= 15;
      notes.push(`${INGREDIENTS[id].name} gehört nicht hinein`);
    }
    score *= 0.7 + 0.3 * data.stir;
    if (data.stir < 0.999) notes.push(`nur zu ${Math.round(data.stir * 100)} % verrührt`);
    return { score, notes };
  }

  function scoreStep(station, recipe, data) {
    let result;
    switch (station) {
      case 'dough':
        result = scoreMix(recipe.dough, data);
        break;
      case 'icing':
        result = scoreMix(recipe.icing, data);
        break;
      case 'roll': {
        const diff = Math.abs(data.mm - recipe.mm);
        result = { score: 100 - 30 * diff, notes: diff >= 0.1 ? [`${num(data.mm)} mm statt ${recipe.mm} mm dick`] : [] };
        break;
      }
      case 'cut': {
        const notes = [];
        let matched = 0;
        let wantedTotal = 0;
        const wanted = new Map(recipe.cut.map((c) => [c.shape, c.count]));
        for (const [shape, count] of wanted) {
          const got = data.shapes[shape] || 0;
          matched += Math.min(got, count);
          wantedTotal += count;
          if (got !== count) notes.push(`${shapeCount(shape, got)} statt ${count}`);
        }
        let gotTotal = 0;
        for (const [shape, count] of Object.entries(data.shapes)) {
          gotTotal += count;
          if (!wanted.has(shape)) notes.push(`${shapeCount(shape, count)} standen nicht im Rezept`);
        }
        result = { score: (100 * matched) / Math.max(wantedTotal, gotTotal, 1), notes };
        break;
      }
      case 'bake': {
        const notes = [];
        const dT = Math.abs(data.temp - recipe.bake.temp);
        const dMin = Math.abs(data.minutes - recipe.bake.minutes);
        if (dT > 0) notes.push(`${data.temp} °C statt ${recipe.bake.temp} °C`);
        if (dMin >= 0.25) notes.push(`${num(data.minutes)} Minuten statt ${recipe.bake.minutes}`);
        const tempScore = Math.max(0, 100 - 3 * dT);
        const timeScore = Math.max(0, 100 - 20 * Math.max(0, dMin - 0.2));
        result = { score: 0.4 * tempScore + 0.6 * timeScore, notes };
        break;
      }
      case 'color': {
        const want = recipe.color;
        const right = data.drops[want.id] || 0;
        let wrong = 0;
        const notes = [];
        for (const [id, n] of Object.entries(data.drops)) {
          if (id === want.id) continue;
          wrong += n;
          notes.push(`${n} Tropfen ${PIPING[id].name} zu viel`);
        }
        if (right !== want.drops) notes.unshift(`${right} statt ${want.drops} Tropfen ${PIPING[want.id].name}`);
        result = { score: 100 - 25 * Math.abs(right - want.drops) - 30 * wrong, notes };
        break;
      }
      case 'sprinkle': {
        const want = new Set(recipe.sprinkles);
        const got = new Set(data.sprinkles);
        const notes = [];
        let both = 0;
        for (const s of want) {
          if (got.has(s)) both++;
          else notes.push(`${SPRINKLES[s].name} fehlen`);
        }
        for (const s of got) if (!want.has(s)) notes.push(`${SPRINKLES[s].name} standen nicht im Rezept`);
        const union = new Set([...want, ...got]).size;
        result = { score: (100 * both) / Math.max(union, 1), notes };
        break;
      }
      default:
        result = { score: 100, notes: [] };
    }
    result.score = Math.round(clamp(result.score, 0, 100));
    return result;
  }

  // ------------------------------------------------------------------ looks
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(rgb) {
    return `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
  }

  function mix(a, b, t) {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    return rgbToHex(x.map((v, i) => v + (y[i] - v) * clamp(t, 0, 1)));
  }

  /** Colour of the raw dough from what went into the bowl. */
  function doughColor(added = {}) {
    let c = '#f2d9a6';
    c = mix(c, '#5b341f', Math.min(0.8, (added.kakao || 0) / 45));
    c = mix(c, '#a0552d', Math.min(0.45, (added.zimt || 0) / 25));
    c = mix(c, '#d99a2b', Math.min(0.3, (added.honig || 0) / 200));
    c = mix(c, '#d8b080', Math.min(0.3, (added.mandeln || 0) / 300));
    return c;
  }

  /** Dough colour after baking: 0 raw, 1 golden, 1.5 dark, 2+ burnt. */
  function bakedColor(base, doneness) {
    const d = Math.max(0, doneness);
    const golden = mix(base, '#b8722a', 0.5);
    if (d <= 1) return mix(mix(base, '#fff3dc', 0.4), golden, d);
    if (d <= 1.6) return mix(golden, '#5e3216', (d - 1) / 0.6);
    return mix('#5e3216', '#1e120b', Math.min(1, (d - 1.6) / 0.6));
  }

  function glazeColor(drops = {}) {
    let total = 0;
    const sum = [0, 0, 0];
    for (const [id, n] of Object.entries(drops)) {
      if (!PIPING[id] || n <= 0) continue;
      const rgb = hexToRgb(PIPING[id].color);
      for (let i = 0; i < 3; i++) sum[i] += rgb[i] * n;
      total += n;
    }
    if (total === 0) return '#fbfaf6';
    const avg = rgbToHex(sum.map((v) => v / total));
    return mix('#ffffff', avg, 0.25 + 0.6 * (1 - 0.65 ** total));
  }

  /** How the cookies of one player look, from their recorded steps. */
  function lookOf(steps, recipe) {
    const s = steps || {};
    const dough = s.dough ? s.dough.added : {};
    const shapes = s.cut ? s.cut.shapes : {};
    let doneness = 0;
    if (s.bake && recipe) {
      doneness = (s.bake.minutes / recipe.bake.minutes) * (Math.max(1, s.bake.temp) / recipe.bake.temp) ** 2;
    }
    let glaze = null;
    if (s.icing && s.icing.added.puderzucker) {
      const sugar = s.icing.added.puderzucker;
      const lemon = (s.icing.added.zitrone || 0) + (s.icing.added.milch || 0);
      const want = recipe ? recipe.icing[1].amount / (recipe.icing[0].amount / 100) : 2;
      const ratio = lemon / (sugar / 100);
      let opacity = 0.95;
      let texture = 'smooth';
      if (ratio < want * 0.55) { opacity = 1; texture = 'lumpy'; }
      else if (ratio > want * 1.7) { opacity = 0.45; texture = 'runny'; }
      if (s.icing.stir < 0.6) texture = 'lumpy';
      glaze = { color: glazeColor(s.color ? s.color.drops : {}), opacity, texture };
    }
    return {
      shapes,
      mm: s.roll ? s.roll.mm : 10,
      dough: doughColor(dough),
      doneness,
      color: bakedColor(doughColor(dough), doneness),
      glaze,
      sprinkles: s.sprinkle ? s.sprinkle.sprinkles : [],
    };
  }

  // ------------------------------------------------------------------- room
  class BakeRoom {
    constructor(code) {
      this.code = code;
      this.players = new Map(); // token -> player
      this.phase = 'lobby';     // lobby | countdown | baking | results
      this.recipe = null;
      this.startedAt = 0;
      this.results = null;
      this.round = 0;
      this.timer = null;
    }

    activePlayers() {
      return [...this.players.values()].filter((p) => p.socket);
    }

    participants() {
      return [...this.players.values()].filter((p) => p.inRound);
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
        round: this.round,
        recipe: this.phase === 'lobby' ? null : this.recipe,
        elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
        roundMs: CONFIG.roundMs,
        countdownMs: this.phase === 'countdown' ? Math.max(0, this.startedAt - Date.now()) : 0,
        players: [...this.players.values()].map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          connected: !!p.socket,
          inRound: p.inRound,
          station: p.station,
          finished: !!p.finishedAt,
        })),
      });
    }

    start() {
      if (this.phase !== 'lobby' && this.phase !== 'results') return;
      const players = this.activePlayers();
      if (players.length === 0) return;
      this.round++;
      this.recipe = makeRecipe();
      this.results = null;
      for (const p of this.players.values()) {
        p.inRound = !!p.socket;
        p.station = 0;
        p.steps = {};
        p.finishedAt = 0;
      }
      this.phase = 'countdown';
      this.startedAt = Date.now() + CONFIG.countdownMs;
      this.broadcastState();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.beginBaking(), CONFIG.countdownMs);
    }

    beginBaking() {
      this.phase = 'baking';
      this.startedAt = Date.now();
      this.broadcastState();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.judge(), CONFIG.roundMs);
    }

    submit(player, station, data) {
      if (this.phase !== 'baking' || !player.inRound || player.finishedAt) return;
      if (STATIONS[player.station] !== station) {
        player.send({ type: 'stepped', station: player.station }); // resync a confused phone
        return;
      }
      const clean = sanitizeStep(station, data);
      player.steps[station] = clean;
      player.station++;
      if (player.station >= STATIONS.length) player.finishedAt = Date.now();
      player.send({ type: 'stepped', station: player.station });
      this.broadcastState();
      this.checkFinished();
    }

    checkFinished() {
      if (this.phase !== 'baking') return;
      const open = this.participants().filter((p) => !p.finishedAt);
      if (open.length === 0) this.judge();
    }

    judge() {
      if (this.phase !== 'baking') return;
      clearTimeout(this.timer);
      const rows = this.participants().map((p) => {
        const scores = {};
        let total = 0;
        for (const station of SCORED) {
          const step = p.steps[station];
          const result = step ? scoreStep(station, this.recipe, step) : { score: 0, notes: ['nicht geschafft'] };
          scores[station] = result;
          total += result.score;
        }
        return {
          player: p,
          id: p.id,
          name: p.name,
          color: p.color,
          total: Math.round(total / SCORED.length),
          timeMs: (p.finishedAt || Date.now()) - this.startedAt,
          finished: !!p.finishedAt,
          scores,
          look: lookOf(p.steps, this.recipe),
        };
      });
      rows.sort((a, b) => b.total - a.total || a.timeMs - b.timeMs);

      let winner = null;
      if (rows.length >= 2 && rows[0].total > 0) winner = rows[0];
      else if (rows.length === 1 && rows[0].total >= CONFIG.soloPrizeScore) winner = rows[0];
      let prize = null;
      if (winner) {
        const owned = new Set(winner.player.owned);
        const ids = Object.keys(UTENSILS);
        const fresh = ids.filter((id) => !owned.has(id));
        const id = pick(fresh.length ? fresh : ids, Math.random);
        prize = { id, ...UTENSILS[id] };
        winner.player.owned.push(id);
      }

      this.results = {
        type: 'results',
        round: this.round,
        recipe: this.recipe,
        winner: winner ? winner.id : null,
        prize,
        players: rows.map(({ player, ...row }) => row),
      };
      this.phase = 'results';
      this.broadcast(this.results);
      this.broadcastState();
    }

    removeIfEmpty() {
      if (this.players.size === 0) {
        clearTimeout(this.timer);
        rooms.delete(this.code);
      }
    }
  }

  class BakePlayer {
    constructor(room, token, name) {
      this.id = randomHex(4);
      this.token = token;
      this.name = name;
      const taken = new Set([...room.players.values()].map((p) => p.color));
      this.color = PLAYER_COLORS.find((c) => !taken.has(c)) || PLAYER_COLORS[0];
      this.socket = null;
      this.removeTimer = null;
      this.inRound = false;
      this.station = 0;
      this.steps = {};
      this.finishedAt = 0;
      this.owned = [];
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
      room = new BakeRoom(code);
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
        socket.send(JSON.stringify({ type: 'error', message: 'In dieser Backstube stehen schon zwei. Nimm einen anderen Code!' }));
        return null;
      }
      player = new BakePlayer(room, token, sanitizeName(msg.name, `Bäcker ${room.players.size + 1}`));
      room.players.set(token, player);
    }
    if (Array.isArray(msg.owned)) player.owned = [...new Set(msg.owned)].filter((id) => Object.hasOwn(UTENSILS, id));

    player.socket = socket;
    player.send({
      type: 'joined', code, you: player.id, token, color: player.color, name: player.name,
      station: player.station, steps: player.steps,
    });
    room.broadcast({ type: 'event', kind: 'join', id: player.id, name: player.name, color: player.color });
    room.broadcastState();
    if (room.phase === 'results' && room.results) player.send(room.results);
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
        case 'step':
          room.submit(player, String(msg.station), msg.data);
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
        if (room.phase === 'baking' && player.inRound) {
          player.inRound = false;
          room.checkFinished();
        }
        room.broadcastState();
        room.removeIfEmpty();
      }, CONFIG.disconnectGraceMs);
      room.broadcastState();
    });
  }

  return {
    handleConnection,
    rooms,
    CONFIG,
    STATIONS,
    SCORED,
    STATION_INFO,
    INGREDIENTS,
    UNIT_MAX,
    SHAPES,
    PIPING,
    SPRINKLES,
    UTENSILS,
    makeRecipe,
    recipeSteps,
    sanitizeStep,
    scoreStep,
    lookOf,
    bakedColor,
    doughColor,
    glazeColor,
    mix,
    formatAmount,
    num,
  };
});
