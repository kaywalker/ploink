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
    soloFreePrizeScore: 80,     // ... and in the free mode (8 of 10 points)
    bakeMsPerMinute: 1600,      // oven clock on the phones: one recipe minute per 1.6 seconds
    stirTurns: 6,               // full circles in the bowl for a smooth dough
  };

  const PLAYER_COLORS = ['#ff8fab', '#4dd6ff', '#7ee081', '#ffb84d'];

  // Stations of the classic recipe; every recipe brings its own list (recipe.stations).
  const STATIONS = ['dough', 'roll', 'cut', 'bake', 'icing', 'color', 'sprinkle', 'plate'];
  const SCORED = STATIONS.filter((s) => s !== 'plate');
  const scoredOf = (recipe) => (recipe && recipe.stations ? recipe.stations : STATIONS).filter((s) => s !== 'plate');
  const STATION_INFO = {
    dough: { title: 'Teig anrühren', icon: '🥣' },
    roll: { title: 'Ausrollen', icon: '🪵' },
    cut: { title: 'Ausstechen', icon: '⭐' },
    bake: { title: 'Backen', icon: '🔥' },
    icing: { title: 'Zuckerguss', icon: '🍋' },
    color: { title: 'Färben', icon: '🎨' },
    jam: { title: 'Marmelade kochen', icon: '🍓' },
    choc: { title: 'Schokolade schmelzen', icon: '🍫' },
    form: { title: 'Backform', icon: '🍰' },
    layers: { title: 'Böden schneiden', icon: '🔪' },
    cream: { title: 'Sahne schlagen', icon: '🥛' },
    crunch: { title: 'Crunch rösten', icon: '🥜' },
    assemble: { title: 'Torte schichten', icon: '🎂' },
    top: { title: 'Torte verzieren', icon: '🍒' },
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
    puder: { name: 'Puderzucker zum Bestäuben', label: 'Puder­zucker' },
  };

  // Marmalade: fruit from the crates and jam sugar, cooked on the stove.
  const FRUITS = {
    erdbeere: { name: 'Erdbeeren', prefix: 'Erdbeer', color: '#d7263d' },
    himbeere: { name: 'Himbeeren', prefix: 'Himbeer', color: '#c2185b' },
    aprikose: { name: 'Aprikosen', prefix: 'Aprikosen', color: '#f39c34' },
    johannisbeere: { name: 'Johannisbeeren', prefix: 'Johannisbeer', color: '#9b1b30' },
    kirsche: { name: 'Kirschen', prefix: 'Kirsch', color: '#7b1026' },
    heidelbeere: { name: 'Heidelbeeren', prefix: 'Heidelbeer', color: '#3b2a6b' },
  };
  const JAM_ITEMS = { ...FRUITS, gelierzucker: { name: 'Gelierzucker' } };

  // Chocolate, melted in a water bath.
  const CHOCOLATES = {
    zartbitter: { name: 'Zartbitter-Schokolade', prefix: 'Zartbitter', color: '#3b1f12' },
    vollmilch: { name: 'Vollmilch-Schokolade', prefix: 'Vollmilch', color: '#6b4128' },
    weiss: { name: 'weiße Schokolade', prefix: 'Weißschoko', color: '#f1e6cf' },
  };

  // Recipe kinds; every round picks one at random.
  const TYPES = {
    butter: { kind: 'cookie', label: 'Plätzchen mit Zuckerguss', stations: ['dough', 'roll', 'cut', 'bake', 'icing', 'color', 'sprinkle', 'plate'] },
    jam: { kind: 'cookie', label: 'Marmeladenplätzchen', stations: ['dough', 'roll', 'cut', 'bake', 'jam', 'sprinkle', 'plate'] },
    choc: { kind: 'cookie', label: 'Schokoplätzchen', stations: ['dough', 'roll', 'cut', 'bake', 'choc', 'sprinkle', 'plate'] },
    cake: { kind: 'cake', label: 'Rührkuchen' },   // stations depend on the topping
    torte: { kind: 'torte', label: 'Sahnetorte' }, // stations depend on crunch or not
  };
  const LEVELS = 5; // difficulty 0..4, picked at random

  // Cakes and tortes
  const FORMS = {
    springform: { name: 'Springform', shape: 'kreis' },
    kastenform: { name: 'Kastenform', shape: 'kasten' },
    gugelhupf: { name: 'Gugelhupfform', shape: 'ring' },
    tarteform: { name: 'Tarteform', shape: 'tarte' },
  };
  const CAKES = [
    { id: 'kakao', title: 'Marmorkuchen', amounts: [20, 25, 30] },
    { id: 'zitrone', title: 'Zitronenkuchen', amounts: [2, 3, 4] },
    { id: 'mandeln', title: 'Mandelkuchen', amounts: [75, 100, 125] },
    { id: 'zimt', title: 'Zimtkuchen', amounts: [5, 8, 10] },
    { id: 'vanille', title: 'Vanillekuchen', amounts: [8, 16] },
    { id: 'honig', title: 'Honigkuchen', amounts: [60, 80, 100] },
  ];
  const TORTES = [
    { id: 'krokant', title: 'Krokant-Sahnetorte', fruit: null, crunch: true },
    { id: 'erdbeer', title: 'Erdbeer-Sahnetorte', fruit: 'erdbeere', crunch: false },
    { id: 'schwarzwald', title: 'Schwarzwälder Kirschtorte', fruit: 'kirsche', crunch: false, cocoa: true, raspel: true },
    { id: 'himbeer', title: 'Himbeer-Crunch-Torte', fruit: 'himbeere', crunch: true },
    { id: 'nuss', title: 'Haselnuss-Crunch-Torte', fruit: null, crunch: true, nut: 'haselnuss', cocoa: true, raspel: true },
  ];
  const LAYER_ITEMS = {
    boden: { name: 'Boden' },
    sahne: { name: 'Sahne' },
    crunch: { name: 'Crunch' },
    erdbeere: { name: 'Erdbeeren' },
    kirsche: { name: 'Kirschen' },
    himbeere: { name: 'Himbeeren' },
    marmelade: { name: 'Marmelade' },
  };
  const TOPPINGS = {
    tupfen: { one: 'Sahnetupfen', many: 'Sahnetupfen' },
    erdbeere: { one: 'Erdbeere', many: 'Erdbeeren' },
    kirsche: { one: 'Kirsche', many: 'Kirschen' },
    himbeere: { one: 'Himbeere', many: 'Himbeeren' },
    raspel: { one: 'Häufchen Schokoraspel', many: 'Häufchen Schokoraspel' },
    krokant: { one: 'Häufchen Krokant', many: 'Häufchen Krokant' },
    minze: { one: 'Minzblatt', many: 'Minzblätter' },
    mandel: { one: 'Häufchen Mandelblättchen', many: 'Häufchen Mandelblättchen' },
  };
  const CRUNCH_ITEMS = {
    mandeln: { name: 'gehackte Mandeln', portion: 25, color: '#d9b88f', plural: true },
    haselnuss: { name: 'gehackte Haselnüsse', portion: 25, color: '#a8743f', plural: true },
    kokos: { name: 'Kokosraspeln', portion: 25, color: '#f4efe6', plural: true },
    zucker: { name: 'Zucker', portion: 10, color: '#ffffff' },
    butter: { name: 'Butter', portion: 10, color: '#f6dd7c' },
  };

  // Prizes: one new baking utensil for the winner of a round.
  const UTENSILS = {
    ruehrloeffel: { name: 'Goldener Rührlöffel', emoji: '🥄' },
    ruehrschuessel: { name: 'Porzellan-Rührschüssel', emoji: '🥣' },
    waage: { name: 'Balkenwaage', emoji: '⚖️' },
    handschuhe: { name: 'Ofenhandschuhe', emoji: '🧤' },
    muetze: { name: 'Echte Kochmütze', emoji: '🧑‍🍳' },
    wecker: { name: 'Küchenwecker', emoji: '⏲️' },
    muffinform: { name: 'Muffinförmchen', emoji: '🧁' },
    kuchenteller: { name: 'Kuchenteller mit Goldrand', emoji: '🍽️' },
    streuer: { name: 'Streuselstreuer', emoji: '🧂' },
    honigtopf: { name: 'Honigtopf mit Honiglöffel', emoji: '🍯' },
    plaetzchenglas: { name: 'Plätzchenglas', emoji: '🫙' },
    teekanne: { name: 'Teekanne für die Kaffeetafel', emoji: '🫖' },
    messer: { name: 'Konditormesser', emoji: '🔪' },
    kuchengabeln: { name: 'Kuchengabel-Set', emoji: '🍴' },
    pfanne: { name: 'Gusseiserne Pfanne', emoji: '🍳' },
    waffeleisen: { name: 'Waffeleisen', emoji: '🧇' },
    tarteform: { name: 'Tarteform', emoji: '🥧' },
    puddingform: { name: 'Puddingform', emoji: '🍮' },
    donutblech: { name: 'Donut-Backblech', emoji: '🍩' },
    fonduetopf: { name: 'Schokofondue-Topf', emoji: '🫕' },
    tasse: { name: 'Lieblingstasse', emoji: '☕' },
    eisbecher: { name: 'Eisbecher-Set', emoji: '🍨' },
    kerzen: { name: 'Tortenkerzen', emoji: '🕯️' },
    schleife: { name: 'Geschenkband für Plätzchentüten', emoji: '🎀' },
    picknickkorb: { name: 'Picknickkorb', emoji: '🧺' },
    stoppuhr: { name: 'Stoppuhr', emoji: '⏱️' },
    thermometer: { name: 'Küchenthermometer', emoji: '🌡️' },
    rezeptbuch: { name: 'Omas Rezeptbuch', emoji: '📖' },
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
  function cookieRecipe(type, level, rng) {
    const fine = level >= 2; // odd amounts from level 2 on
    const flavour = pick(FLAVOURS, rng);
    const dough = [
      { id: 'mehl', amount: between(200, 300, fine ? 5 : 25, rng) },
      { id: 'zucker', amount: between(75, 125, fine ? 5 : 25, rng) },
      { id: 'butter', amount: between(100, 175, fine ? 5 : 25, rng) },
      { id: 'eier', amount: between(1, 2, 1, rng) },
      { id: flavour.id, amount: pick(flavour.amounts, rng) },
    ];
    if (level >= 3) {
      const second = pick(FLAVOURS.filter((f) => f.id !== flavour.id), rng);
      dough.push({ id: second.id, amount: pick(second.amounts, rng) });
    }
    if (rng() < (level >= 3 ? 0.7 : 0.35)) dough.push({ id: 'salz', amount: pick([2, 3, 5], rng) });

    const shapeCount = level === 0 ? 1 : level <= 2 ? 2 : 3;
    const shapes = shuffle(Object.keys(SHAPES), rng).slice(0, shapeCount);
    const cut = shapes.map((shape, i) => ({ shape, count: i === 0 ? between(shapeCount === 3 ? 3 : 4, shapeCount === 1 ? 8 : 6, 1, rng) : between(2, 4, 1, rng) }));

    const sprinklePool = Object.keys(SPRINKLES).filter((id) => id !== 'puder');
    const sprinkleCount = level === 0 ? 1 : level === 1 ? (rng() < 0.5 ? 1 : 2) : 2;
    let sprinkles = shuffle(sprinklePool, rng).slice(0, sprinkleCount);

    const recipe = {
      type,
      kind: 'cookie',
      level,
      label: TYPES[type].label,
      stations: TYPES[type].stations,
      dough,
      mm: level >= 3 ? between(30, 70, 5, rng) / 10 : between(3, 7, 1, rng),
      cut,
      bake: { temp: between(160, 200, fine ? 5 : 10, rng), minutes: between(8, 14, 1, rng) },
    };
    const main = SHAPES[shapes[0]].many;
    if (type === 'jam') {
      const fruit = pick(Object.keys(FRUITS), rng);
      const fruitG = level >= 3 ? between(250, 500, 50, rng) : between(300, 500, 100, rng);
      const ratio = level >= 2 && rng() < 0.5 ? 3 : 2;
      recipe.jam = { fruit, fruitG, ratio, sugarG: Math.round(fruitG / ratio / 50) * 50 || 50, minutes: between(3, 5, 1, rng) };
      sprinkles = level >= 2 && rng() < 0.5 ? ['puder', sprinkles[0]] : ['puder'];
      recipe.title = `${FRUITS[fruit].prefix}-${main}`;
    } else if (type === 'choc') {
      const kind = pick(Object.keys(CHOCOLATES), rng);
      recipe.choc = { kind, grams: between(100, 200, level >= 3 ? 25 : 50, rng), temp: between(40, 50, 5, rng) };
      recipe.title = `${CHOCOLATES[kind].prefix}-${main}`;
    } else {
      recipe.icing = [
        { id: 'puderzucker', amount: between(100, 200, fine ? 5 : 25, rng) },
        { id: 'zitrone', amount: between(2, 4, 1, rng) },
      ];
      recipe.color = { id: pick(Object.keys(PIPING), rng), drops: between(1, 4, 1, rng) };
      recipe.title = `${flavour.prefix}-${main}`;
    }
    recipe.sprinkles = sprinkles;
    return recipe;
  }

  function cakeRecipe(level, rng) {
    const fine = level >= 2;
    const cake = pick(CAKES, rng);
    const dough = [
      { id: 'mehl', amount: between(250, 350, fine ? 5 : 25, rng) },
      { id: 'zucker', amount: between(150, 250, fine ? 5 : 25, rng) },
      { id: 'butter', amount: between(150, 250, fine ? 5 : 25, rng) },
      { id: 'eier', amount: between(3, 5, 1, rng) },
      { id: 'milch', amount: between(4, 8, 1, rng) },
      { id: 'backpulver', amount: 15 },
      { id: cake.id, amount: pick(cake.amounts, rng) },
    ];
    if (level >= 3) dough.push({ id: 'salz', amount: pick([2, 3], rng) });
    const form = pick(['springform', 'kastenform', 'gugelhupf'], rng);
    const topping = pick(['icing', 'choc', 'puder'], rng);
    const stations = ['dough', 'form', 'bake'];
    const recipe = {
      type: 'cake',
      kind: 'cake',
      level,
      dough,
      form,
      bake: { temp: between(160, 180, fine ? 5 : 10, rng), minutes: between(40, 60, 5, rng), msPerMinute: 600 },
      title: `${cake.title}${form === 'gugelhupf' ? ' im Gugelhupf' : form === 'kastenform' ? ' aus der Kastenform' : ''}`,
    };
    const extras = shuffle(Object.keys(SPRINKLES).filter((id) => id !== 'puder'), rng);
    if (topping === 'icing') {
      recipe.icing = [
        { id: 'puderzucker', amount: between(150, 250, fine ? 5 : 25, rng) },
        { id: 'zitrone', amount: between(3, 5, 1, rng) },
      ];
      stations.push('icing');
      recipe.sprinkles = extras.slice(0, level >= 2 ? 2 : 1);
      if (rng() < 0.5) recipe.side = [pick(['mandel', 'kokos', 'schoko', 'bunt'], rng)];
      recipe.label = 'Rührkuchen mit Zuckerguss';
    } else if (topping === 'choc') {
      const kind = pick(Object.keys(CHOCOLATES), rng);
      recipe.choc = { kind, grams: between(150, 250, 50, rng), temp: between(40, 50, 5, rng) };
      stations.push('choc');
      recipe.sprinkles = extras.slice(0, level >= 2 ? 2 : 1);
      if (rng() < 0.5) recipe.side = [pick(['mandel', 'kokos', 'schoko', 'bunt'], rng)];
      recipe.label = 'Rührkuchen mit Schokoguss';
    } else {
      recipe.sprinkles = ['puder'];
      recipe.label = 'Rührkuchen mit Puderzucker';
    }
    recipe.stations = [...stations, 'sprinkle', 'plate'];
    return recipe;
  }

  function torteRecipe(level, rng) {
    const fine = level >= 2;
    const v = pick(TORTES, rng);
    const dough = [
      { id: 'eier', amount: between(4, 6, 1, rng) },
      { id: 'zucker', amount: between(100, 150, fine ? 5 : 25, rng) },
      { id: 'mehl', amount: between(100, 150, fine ? 5 : 25, rng) },
      { id: 'staerke', amount: between(25, 50, 25, rng) },
      { id: 'backpulver', amount: 5 },
    ];
    if (v.cocoa) dough.push({ id: 'kakao', amount: pick([20, 25, 30], rng) });
    const layers = level >= 2 && rng() < 0.5 ? 4 : v.fruit && v.crunch ? 3 : between(2, 3, 1, rng);
    // Build the stack from the bottom: Boden, filling, Boden, filling, …, cream on top.
    const order = [];
    for (let i = 0; i < layers; i++) {
      order.push('boden');
      const last = i === layers - 1;
      if (last) order.push('sahne');
      else if (i % 2 === 0) order.push(...(v.fruit ? [v.fruit] : []), 'sahne', ...(v.crunch && layers === 2 ? ['crunch'] : []));
      else order.push('sahne', ...(v.crunch ? ['crunch'] : []));
    }
    const tupfen = between(8, 16, 2, rng);
    const top = [{ id: 'tupfen', count: tupfen }];
    if (v.fruit) top.push({ id: v.fruit, count: tupfen });
    if (v.raspel) top.push({ id: 'raspel', count: between(3, 5, 1, rng) });
    if (v.crunch) top.push({ id: 'krokant', count: between(3, 5, 1, rng) });
    if (!v.fruit && !v.raspel) top.push({ id: 'minze', count: between(3, 6, 1, rng) });
    const sideId = v.crunch ? 'krokant' : v.raspel ? 'raspel' : pick(['mandel', 'tupfen'], rng);
    const side = [{ id: sideId, count: sideId === 'tupfen' ? between(8, 12, 2, rng) : between(6, 10, 2, rng) }];
    const recipe = {
      type: 'torte',
      kind: 'torte',
      level,
      label: v.crunch ? 'Sahnetorte mit Crunch' : 'Sahnetorte',
      title: v.title,
      dough,
      form: 'springform',
      bake: { temp: between(170, 180, fine ? 5 : 10, rng), minutes: between(25, 35, 5, rng), msPerMinute: 600 },
      layers,
      cream: { ml: between(300, 600, 100, rng), vanille: between(1, 2, 1, rng) },
      order,
      top,
      side,
      sprinkles: [],
      stations: ['dough', 'form', 'bake', 'layers', 'cream', ...(v.crunch ? ['crunch'] : []), 'assemble', 'top', 'plate'],
    };
    if (v.crunch) {
      recipe.crunch = { nut: v.nut || pick(['mandeln', 'haselnuss', 'kokos'], rng), nutG: between(50, 150, 25, rng), zuckerG: between(30, 60, 10, rng), butterG: between(10, 20, 10, rng) };
    }
    return recipe;
  }

  function recipeOfType(type, level, rng) {
    if (type === 'cake') return cakeRecipe(level, rng);
    if (type === 'torte') return torteRecipe(level, rng);
    return cookieRecipe(type, level, rng);
  }

  /** A random recipe. opts: { type, level, avoid: [titles] } */
  function makeRecipe(opts = {}, rng = Math.random) {
    const level = opts.level !== undefined ? Math.max(0, Math.min(LEVELS - 1, Math.floor(opts.level))) : Math.floor(rng() * LEVELS);
    const avoid = new Set(opts.avoid || []);
    let recipe = null;
    for (let i = 0; i < 40; i++) {
      const type = opts.type && TYPES[opts.type] ? opts.type : pick(Object.keys(TYPES), rng);
      recipe = recipeOfType(type, level, rng);
      if (!avoid.has(recipe.title)) break;
    }
    return recipe;
  }

  // ------------------------------------------------------------- free mode
  // Baking without a recipe: same stations, no numbers. A jury rates taste, baking,
  // decoration and creativity instead of comparing with a recipe.
  const FREE_CATEGORIES = [
    { id: 'geschmack', title: 'Geschmack', icon: '😋' },
    { id: 'backkunst', title: 'Backkunst', icon: '🔥' },
    { id: 'deko', title: 'Dekoration', icon: '✨' },
    { id: 'kreativ', title: 'Kreativität', icon: '🎨' },
  ];

  const FREE_KINDS = ['cookie', 'cake', 'torte'];
  const FREE_TIPS = {
    dough: ['Mehl, Butter, Zucker und ein Ei sind eine gute Grundlage', 'etwas Besonderes dazu? Zimt, Kakao, Honig …', 'gut verrühren'],
    form: ['jede Form ist erlaubt', 'gut einfetten, sonst klebt es'],
    layers: ['zwei bis vier Böden sind schön'],
    cream: ['Sahne mit etwas Vanillezucker', 'steif schlagen, nicht zu Butter'],
    crunch: ['Nüsse mit etwas Zucker und Butter', 'goldbraun rösten – oder einfach weiter'],
    jam: ['Früchte und Gelierzucker', 'sprudelnd kochen und rühren'],
    assemble: ['Böden, Sahne, Früchte, Crunch – ganz wie du magst'],
    top: ['oben und am Rand verzieren'],
    roll: ['3 bis 7 mm sind ideal'],
    cut: ['so viele Formen, wie du magst'],
    bake: ['bei 160 bis 200 °C', 'goldbraun wieder rausholen'],
    icing: ['Puderzucker mit etwas Zitronensaft', 'nicht zu flüssig'],
    color: ['deine Lieblingsfarbe – oder eine eigene Mischung'],
    sprinkle: ['Guss aufpinseln', 'Streusel nach Lust und Laune'],
    plate: ['alles schön anrichten'],
  };

  /**
   * The free "recipe": stations only, plus hidden reference values for the looks.
   * kind: cookie | cake | torte, jam: with a marmalade station.
   */
  function makeFreeRecipe(kind = 'cookie', jam = false) {
    const k = FREE_KINDS.includes(kind) ? kind : 'cookie';
    const stations = {
      cookie: ['dough', 'roll', 'cut', 'bake', ...(jam ? ['jam'] : ['icing', 'color']), 'sprinkle', 'plate'],
      cake: ['dough', 'form', 'bake', jam ? 'jam' : 'icing', 'sprinkle', 'plate'],
      torte: ['dough', 'form', 'bake', 'layers', 'cream', 'crunch', ...(jam ? ['jam'] : []), 'assemble', 'top', 'plate'],
    }[k];
    const names = { cookie: 'Plätzchen', cake: 'Kuchen', torte: 'Torte' };
    return {
      type: 'free',
      kind: k,
      free: true,
      jamChoice: !!jam,
      level: 0,
      title: `Freies Backen: ${names[k]}${jam ? ' mit Marmelade' : ''}`,
      label: 'Freimodus – ganz ohne Rezept',
      stations,
      dough: [],
      cut: [],
      mm: 5,
      bake: k === 'cookie' ? { temp: 180, minutes: 11 } : { temp: 175, minutes: k === 'cake' ? 50 : 30, msPerMinute: 600 },
      icing: [{ id: 'puderzucker', amount: 150 }, { id: 'zitrone', amount: 3 }],
      sprinkles: [],
    };
  }

  function juryResult(scores) {
    let sum = 0;
    for (const cat of Object.values(scores)) {
      cat.score = Math.round(clamp(cat.score, 0, 100));
      sum += cat.score;
    }
    const total = Math.round(sum / FREE_CATEGORIES.length);
    const verdict = total >= 85 ? 'Backprofi! Die Jury ist begeistert 🏅'
      : total >= 70 ? 'Richtig lecker und schön gemacht'
        : total >= 50 ? 'Ganz ordentlich – da geht noch was'
          : 'Na ja … Übung macht den Meister';
    return { scores, total, verdict };
  }

  /** The jury for a free cake or torte. */
  function scoreFreeBig(steps, recipe) {
    const s = steps || {};
    const d = s.dough ? s.dough.added : {};
    const g = (id) => d[id] || 0;
    const look = lookOf(s, recipe);
    const torte = recipe.kind === 'torte';
    const flavours = [...FLAVOURS.map((f) => f.id), 'zitrone'].filter((id) => g(id) > 0);
    const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
    const down = (cat, n, note) => {
      cat.score -= n;
      if (note) cat.notes.push(note);
    };
    const up = (cat, n, note) => {
      cat.score += n;
      if (note) cat.notes.push(note);
    };

    const taste = { score: 100, notes: [] };
    if (Object.keys(d).length === 0) {
      taste.score = 0;
      taste.notes.push('kein Teig angerührt');
    } else {
      const mehl = g('mehl') + g('staerke');
      if (mehl < 80) down(taste, 40, 'viel zu wenig Mehl');
      const sweet = (g('zucker') + g('puderzucker') + g('honig') * 0.8 + g('vanille')) / Math.max(mehl, 1);
      if (torte) {
        if (g('eier') < 3) down(taste, 25, 'zu wenig Eier – der Biskuit wird nicht luftig');
        else taste.notes.push('luftiger Biskuit');
        if (g('butter') > 50) down(taste, 10, 'Biskuit braucht keine Butter');
        if (mehl >= 80 && sweet < 0.4) down(taste, 15, 'kaum süß');
        else if (sweet > 2) down(taste, 15, 'viel zu süß');
      } else {
        if (mehl >= 80) {
          const fat = g('butter') / mehl;
          if (fat < 0.35) down(taste, 20, 'eher trocken');
          else if (fat > 1.1) down(taste, 20, 'zu fettig');
          else taste.notes.push('schön saftig');
          if (sweet < 0.3) down(taste, 15, 'kaum süß');
          else if (sweet > 1.2) down(taste, 15, 'viel zu süß');
        }
        if (g('eier') < 2) down(taste, 15, 'zu wenig Eier');
        if (!g('backpulver')) down(taste, 15, 'ohne Backpulver geht er nicht auf');
        else if (g('backpulver') > 30) down(taste, 15, 'zu viel Backpulver');
      }
      if (g('salz') > 8) down(taste, 40, 'versalzen!');
      if (flavours.length === 0) down(taste, 5, 'etwas langweilig ohne Gewürz');
      else if (flavours.length > 3) down(taste, 15, 'zu viele Aromen durcheinander');
      else taste.notes.push(`fein mit ${flavours.map((id) => INGREDIENTS[id].name).join(' und ')}`);
      if (s.dough.stir < 0.9) down(taste, 15, 'klumpig gerührt');
    }
    if (torte && s.cream && s.cream.ml) {
      if (s.cream.vanille) taste.notes.push('Sahne mit Vanille');
      else down(taste, 5, 'Sahne ohne Vanillezucker');
    }
    if (s.jam && Object.keys(s.jam.added).length) {
      if (s.jam.burnt > 1) down(taste, 15, 'Marmelade angebrannt');
      else taste.notes.push('mit selbst gekochter Marmelade');
    }

    const bake = { score: 100, notes: [] };
    if (Object.keys(d).length === 0) down(bake, 80, 'ohne Teig gibt es nichts zu backen');
    if (!s.form || !s.form.form) down(bake, 20, 'ohne Backform');
    else if (s.form.greased < 0.6) down(bake, 25, 'klebt in der Form fest');
    const dn = look.doneness;
    if (!s.bake || s.bake.minutes <= 0) down(bake, 60, 'gar nicht gebacken');
    else if (dn < 0.8) down(bake, Math.min(45, (0.8 - dn) * 120), 'innen noch roh');
    else if (dn > 1.6) down(bake, 55, 'verbrannt!');
    else if (dn > 1.25) down(bake, Math.min(40, (dn - 1.25) * 120), 'recht dunkel');
    else bake.notes.push('perfekt durchgebacken');
    if (torte) {
      const cuts = s.layers ? s.layers.cuts : [];
      if (!cuts.length) down(bake, 10, 'nicht in Böden geschnitten');
      else {
        const n = cuts.length + 1;
        const err = cuts.reduce((a, c, k) => a + Math.abs(c - (k + 1) / n), 0) / cuts.length;
        if (err > 0.05) down(bake, 15, 'Böden ungleich dick');
        else bake.notes.push(`${n} gleichmäßige Böden`);
      }
      const st = s.cream ? s.cream.stiff : 0;
      if (!s.cream || !s.cream.ml) down(bake, 15, 'keine Sahne');
      else if (st > 1.25) down(bake, 25, 'Sahne zu Butter geschlagen');
      else if (st < 0.6) down(bake, 20, 'Sahne zu flüssig');
      else if (st >= 0.85) bake.notes.push('Sahne schön steif');
      if (s.crunch && Object.keys(s.crunch.added).length) {
        if (s.crunch.caramel > 1.4 || s.crunch.burnt > 1) down(bake, 10, 'Crunch verbrannt');
        else if (s.crunch.caramel >= 0.8) bake.notes.push('knuspriger Crunch');
      }
    }

    const deco = { score: 10, notes: [] };
    if (torte) {
      const items = look.toppings || {};
      const topCount = sum(items);
      const kinds = Object.keys(items).length;
      if (topCount === 0) deco.notes.push('oben ganz nackt');
      else {
        up(deco, 25);
        if ((items.tupfen || 0) >= 6) up(deco, 15, 'schöne Sahnetupfen');
        if (kinds >= 2) up(deco, 15, 'liebevoll belegt');
        if (topCount > 40) down(deco, 10, 'etwas überladen');
      }
      const sideCount = sum(look.side);
      if (sideCount >= 4) up(deco, 25, 'Rand rundum verziert');
      else if (sideCount > 0) up(deco, 10, 'Rand ein bisschen verziert');
      else deco.notes.push('Rand nicht verziert');
      if (look.cream && look.cream.texture === 'smooth') up(deco, 10);
    } else {
      if (look.glaze) {
        up(deco, 30);
        if (look.glaze.texture === 'smooth') up(deco, 10, 'glänzende Glasur');
        else down(deco, 10, look.glaze.texture === 'runny' ? 'Glasur läuft davon' : 'Glasur klumpt');
      } else deco.notes.push('ohne Glasur');
      const kinds = look.sprinkles.length;
      if (kinds) up(deco, kinds <= 3 ? 25 : 10, kinds <= 3 ? 'hübsch bestreut' : 'etwas überladen');
      else deco.notes.push('ohne Streusel');
      if (look.sideSprinkles.length) up(deco, 15, 'Rand verziert');
      if (dn >= 0.85 && dn <= 1.25) up(deco, 10);
      if (look.stuck) down(deco, 15, 'beim Stürzen zerbrochen');
    }
    if (dn > 1.6) down(deco, 15, 'verbrannt sieht nicht schön aus');

    const crea = { score: 0, notes: [] };
    up(crea, [0, 8, 15, 20][Math.min(3, flavours.length)]);
    if (s.form && s.form.form && s.form.form !== 'springform') up(crea, 10, `in der ${FORMS[s.form.form].name}`);
    if (torte) {
      const stack = look.layers || [];
      const distinct = new Set(stack).size;
      up(crea, Math.min(30, distinct * 7), distinct >= 4 ? 'spannende Schichten' : '');
      if (stack.length >= 7) up(crea, 10, 'eine hohe Torte');
      const kinds = new Set([...Object.keys(look.toppings || {}), ...Object.keys(look.side || {})]).size;
      up(crea, Math.min(25, kinds * 6), kinds >= 4 ? 'viele verschiedene Verzierungen' : '');
      if (s.jam && Object.keys(s.jam.added).length) up(crea, 5);
    } else {
      if (s.jam && Object.keys(s.jam.added).length) up(crea, 15, 'Marmeladenglasur');
      up(crea, Math.min(3, look.sprinkles.length) * 8);
      if (look.sideSprinkles.length) up(crea, 12, 'Rand eigens verziert');
    }
    if (crea.score < 30) crea.notes.push('trau dich mehr!');
    return juryResult({ geschmack: taste, backkunst: bake, deko: deco, kreativ: crea });
  }

  /** The jury: 0–100 per category, short comments, a total and a verdict. */
  function scoreFree(steps, recipe = makeFreeRecipe()) {
    if (recipe.kind === 'cake' || recipe.kind === 'torte') return scoreFreeBig(steps, recipe);
    const s = steps || {};
    const d = s.dough ? s.dough.added : {};
    const g = (id) => d[id] || 0;
    const look = lookOf(s, recipe);
    const flavours = FLAVOURS.map((f) => f.id).filter((id) => g(id) > 0);
    const down = (cat, n, note) => {
      cat.score -= n;
      if (note) cat.notes.push(note);
    };
    const up = (cat, n, note) => {
      cat.score += n;
      if (note) cat.notes.push(note);
    };

    const taste = { score: 100, notes: [] };
    if (Object.keys(d).length === 0) {
      taste.score = 0;
      taste.notes.push('kein Teig angerührt');
    } else {
      const mehl = g('mehl') + g('staerke') * 0.5;
      if (mehl < 120) down(taste, 40, 'viel zu wenig Mehl');
      else {
        if (mehl > 450) down(taste, 15, 'sehr viel Mehl – eher trocken');
        const fat = g('butter') / mehl;
        if (fat < 0.3) down(taste, 25, 'zu wenig Butter – bröselig');
        else if (fat > 0.9) down(taste, 25, 'zu viel Butter – fettig');
        else taste.notes.push('mürbe und buttrig');
        const sweet = (g('zucker') + g('puderzucker') + g('honig') * 0.8 + g('vanille')) / mehl;
        if (sweet < 0.15) down(taste, 20, 'kaum süß');
        else if (sweet > 0.75) down(taste, 20, 'viel zu süß');
      }
      if (g('eier') === 0) down(taste, 10, 'ohne Ei hält der Teig schlecht');
      else if (g('eier') > 3) down(taste, 15, 'zu viele Eier');
      if (g('salz') > 8) down(taste, 40, 'versalzen!');
      if (g('backpulver') > 15) down(taste, 20, 'viel zu viel Backpulver');
      if (g('zimt') > 25) down(taste, 20, 'Zimt-Explosion');
      if (g('kakao') > 80) down(taste, 15, 'bitter vor lauter Kakao');
      if (g('zitrone') + g('milch') > 6) down(taste, 15, 'Teig ist zu flüssig');
      if (flavours.length === 0) down(taste, 5, 'etwas langweilig ohne Gewürz');
      else if (flavours.length > 3) down(taste, 15, 'zu viele Aromen durcheinander');
      else taste.notes.push(`fein mit ${flavours.map((id) => INGREDIENTS[id].name).join(' und ')}`);
      if (s.dough.stir < 0.9) down(taste, 15, 'klumpig gerührt');
    }

    const bake = { score: 100, notes: [] };
    const shapes = s.cut ? s.cut.shapes : {};
    const count = Object.values(shapes).reduce((a, b) => a + b, 0);
    if (count === 0) {
      bake.score = 0;
      bake.notes.push('keine Plätzchen ausgestochen');
    } else {
      const mm = s.roll ? s.roll.mm : 20;
      if (mm < 3) down(bake, Math.min(40, (3 - mm) * 15), 'hauchdünn – zerbricht leicht');
      else if (mm > 7) down(bake, Math.min(40, (mm - 7) * 8), 'ziemlich dick');
      else bake.notes.push('schön gleichmäßig ausgerollt');
      const dn = look.doneness;
      if (!s.bake || s.bake.minutes <= 0) down(bake, 60, 'gar nicht gebacken');
      else if (dn < 0.8) down(bake, Math.min(50, (0.8 - dn) * 120), 'noch ziemlich hell');
      else if (dn > 1.6) down(bake, 60, 'verbrannt!');
      else if (dn > 1.25) down(bake, Math.min(45, (dn - 1.25) * 120), 'recht dunkel');
      else bake.notes.push('goldbraun gebacken');
      if (s.bake && s.bake.minutes > 0 && (s.bake.temp < 150 || s.bake.temp > 210)) down(bake, 10, `${s.bake.temp} °C ist ungewöhnlich`);
    }

    const deco = { score: 10, notes: [] };
    const drops = s.color ? s.color.drops : {};
    const dropTotal = Object.values(drops).reduce((a, b) => a + b, 0);
    const colors = Object.keys(drops).length;
    const kinds = s.sprinkle ? s.sprinkle.sprinkles.length : 0;
    if (look.glaze) {
      up(deco, 30);
      if (look.glaze.texture === 'smooth') up(deco, 12, 'glatter, glänzender Guss');
      else down(deco, 10, look.glaze.texture === 'runny' ? 'der Guss läuft davon' : 'der Guss klumpt');
      if (dropTotal === 0) up(deco, 6, s.jam ? 'die Marmelade glänzt' : 'klassisch weiß');
      else if (dropTotal <= 6) up(deco, 13, 'schöne Farbe');
      else down(deco, 5, 'sehr knallige Farbe');
      if (colors > 2) down(deco, 8, 'Farben vermatscht');
    } else deco.notes.push('ohne Guss');
    if (kinds === 0) deco.notes.push('ohne Streusel etwas schlicht');
    else if (kinds === 1) up(deco, 18, 'hübsch bestreut');
    else if (kinds <= 3) up(deco, 25, 'liebevoll bestreut');
    else up(deco, 10, 'etwas überladen');
    if (count === 0) deco.score = 0;
    else if (look.doneness > 1.6) down(deco, 15, 'verbrannt sieht nicht schön aus');
    else if (look.doneness >= 0.85 && look.doneness <= 1.25) up(deco, 10);

    const crea = { score: 0, notes: [] };
    const shapeKinds = Object.keys(shapes).length;
    // Full marks only for many shapes, flavours, an own colour, several sprinkles and a full plate.
    up(crea, [0, 10, 22, 32][Math.min(3, shapeKinds)], shapeKinds >= 3 ? `${shapeKinds} verschiedene Formen` : '');
    up(crea, [0, 8, 15, 20][Math.min(3, flavours.length)]);
    if (colors === 2) up(crea, 12, 'eigene Mischfarbe');
    else if (colors === 1) up(crea, 6);
    up(crea, Math.min(3, kinds) * 6);
    if (count >= 8) up(crea, 8, 'eine ganze Ladung');
    const combos = [['kakao', 'zimt'], ['honig', 'mandeln'], ['zimt', 'honig'], ['vanille', 'mandeln'], ['kakao', 'vanille']];
    if (combos.some(([a, b]) => g(a) && g(b))) up(crea, 10, 'spannende Kombination');
    if (s.jam && Object.keys(s.jam.added).length) up(crea, 10, 'selbst gekochte Marmelade');
    if (crea.score < 30) crea.notes.push('trau dich mehr!');

    return juryResult({ geschmack: taste, backkunst: bake, deko: deco, kreativ: crea });
  }

  /** The recipe as text lines per station, used by the recipe card and in tests. */
  function recipeSteps(recipe) {
    if (recipe.free) return Object.fromEntries(recipe.stations.map((id) => [id, FREE_TIPS[id] || ['ganz wie du magst']]));
    const lines = {
      dough: [...recipe.dough.map((d) => formatAmount(d.id, d.amount)), 'alles glatt verrühren'],
      bake: [`bei ${recipe.bake.temp} °C`, `${recipe.bake.minutes} Minuten backen`],
      plate: [recipe.kind === 'cookie' ? 'alle Plätzchen auf den Teller legen' : 'auf die Tortenplatte heben'],
    };
    if (recipe.kind === 'cookie') {
      lines.roll = [`Teig ${num(recipe.mm)} mm dick ausrollen`];
      lines.cut = recipe.cut.map((c) => shapeCount(c.shape, c.count));
    }
    const spread = recipe.jam ? 'Marmelade aufstreichen' : recipe.choc ? 'Schokolade aufstreichen' : recipe.icing ? 'Guss aufpinseln' : null;
    lines.sprinkle = [...(spread ? [spread] : []), ...recipe.sprinkles.map((s) => SPRINKLES[s].name), ...(recipe.side || []).filter((id) => SPRINKLES[id]).map((id) => `Rand rundum: ${SPRINKLES[id].name}`)];
    if (recipe.form) lines.form = [FORMS[recipe.form].name, 'gut mit Butter einfetten'];
    if (recipe.layers) lines.layers = [`in ${recipe.layers} gleich dicke Böden schneiden`];
    if (recipe.cream) lines.cream = [`${recipe.cream.ml} ml Sahne`, `${recipe.cream.vanille} ${recipe.cream.vanille === 1 ? 'Päckchen' : 'Päckchen'} Vanillezucker`, 'steif schlagen – aber nicht zu lange!'];
    if (recipe.crunch) {
      const c = recipe.crunch;
      lines.crunch = [`${c.nutG} g ${CRUNCH_ITEMS[c.nut].name}`, `${c.zuckerG} g Zucker`, `${c.butterG} g Butter`, 'in der Pfanne goldbraun rösten, dabei rühren'];
    }
    if (recipe.order) lines.assemble = ['von unten nach oben:', ...recipe.order.map((id, i) => `${i + 1}. ${LAYER_ITEMS[id].name}`)];
    if (recipe.top) {
      const n = (t) => `${t.count} ${t.count === 1 ? TOPPINGS[t.id].one : TOPPINGS[t.id].many}`;
      lines.top = [...recipe.top.map((t) => `oben: ${n(t)}`), ...(recipe.side || []).map((t) => `Rand: ${n(t)}`)];
    }
    if (recipe.icing) {
      lines.icing = [...recipe.icing.map((d) => formatAmount(d.id, d.amount)), 'glatt rühren'];
      if (recipe.color) lines.color = [`${recipe.color.drops} Tropfen ${PIPING[recipe.color.id].name} in den Guss`];
    }
    if (recipe.jam) {
      const j = recipe.jam;
      lines.jam = [`${j.fruitG} g ${FRUITS[j.fruit].name}`, `${j.sugarG} g Gelierzucker (${j.ratio}:1)`, `aufkochen, ${j.minutes} Minuten sprudelnd kochen`, 'dabei immer rühren'];
    }
    if (recipe.choc) {
      const c = recipe.choc;
      lines.choc = [`${c.grams} g ${CHOCOLATES[c.kind].name}`, `im Wasserbad bei ${c.temp} °C schmelzen`, `nicht heißer als ${c.temp + 10} °C!`];
    }
    return lines;
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
      case 'jam':
        return {
          added: sanitizeCounts(d.added, JAM_ITEMS, 3000),
          boilMinutes: Math.round(clamp(d.boilMinutes, 0, 60) * 10) / 10,
          burnt: Math.round(clamp(d.burnt, 0, 120) * 10) / 10,
        };
      case 'choc':
        return {
          added: sanitizeCounts(d.added, CHOCOLATES, 2000),
          melt: clamp(d.melt, 0, 1),
          maxTemp: Math.round(clamp(d.maxTemp, 0, 150)),
          overheat: Math.round(clamp(d.overheat, 0, 120) * 10) / 10,
        };
      case 'sprinkle':
        return {
          sprinkles: [...new Set(Array.isArray(d.sprinkles) ? d.sprinkles : [])].filter((s) => Object.hasOwn(SPRINKLES, s)),
          side: [...new Set(Array.isArray(d.side) ? d.side : [])].filter((s) => Object.hasOwn(SPRINKLES, s)),
        };
      case 'form':
        return { form: Object.hasOwn(FORMS, d.form) ? d.form : null, greased: clamp(d.greased, 0, 1) };
      case 'layers':
        return { cuts: (Array.isArray(d.cuts) ? d.cuts : []).slice(0, 8).map((c) => Math.round(clamp(c, 0, 1) * 1000) / 1000).sort((x, y) => x - y) };
      case 'cream':
        return { ml: Math.round(clamp(d.ml, 0, 3000)), vanille: Math.round(clamp(d.vanille, 0, 10)), stiff: Math.round(clamp(d.stiff, 0, 2) * 100) / 100 };
      case 'crunch':
        return { added: sanitizeCounts(d.added, CRUNCH_ITEMS, 1000), caramel: Math.round(clamp(d.caramel, 0, 3) * 100) / 100, burnt: Math.round(clamp(d.burnt, 0, 120) * 10) / 10 };
      case 'assemble':
        return { layers: (Array.isArray(d.layers) ? d.layers : []).filter((id) => Object.hasOwn(LAYER_ITEMS, id)).slice(0, 24) };
      case 'top':
        return { items: sanitizeCounts(d.items, TOPPINGS, 80), side: sanitizeCounts(d.side, TOPPINGS, 80) };
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

  /** Grams of the right things, wrong things cost extra. */
  function scoreAmounts(wanted, got, nameOf, pluralOf = () => false) {
    const notes = [];
    let sum = 0;
    for (const { id, amount } of wanted) {
      const have = got[id] || 0;
      sum += Math.max(0, 1 - Math.abs(have - amount) / Math.max(amount * 0.5, 10));
      if (have === 0) notes.push(`${nameOf(id)} ${pluralOf(id) ? 'fehlen' : 'fehlt'}`);
      else if (have !== amount) notes.push(`${have} g ${nameOf(id)} statt ${amount} g`);
    }
    let score = (sum / wanted.length) * 100;
    const ids = new Set(wanted.map((w) => w.id));
    for (const id of Object.keys(got)) {
      if (ids.has(id)) continue;
      score -= 25;
      notes.push(`${nameOf(id)} ${pluralOf(id) ? 'standen' : 'stand'} nicht im Rezept`);
    }
    return { score: Math.max(0, score), notes };
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
      case 'jam': {
        const j = recipe.jam;
        const ing = scoreAmounts(
          [{ id: j.fruit, amount: j.fruitG }, { id: 'gelierzucker', amount: j.sugarG }],
          data.added,
          (id) => JAM_ITEMS[id].name,
          (id) => !!FRUITS[id],
        );
        const notes = [...ing.notes];
        let cook = 0;
        if (data.boilMinutes <= 0) notes.push('nicht sprudelnd gekocht');
        else {
          const d = Math.abs(data.boilMinutes - j.minutes);
          cook = 100 - 20 * Math.max(0, d - 0.2);
          if (d >= 0.25) notes.push(`${num(data.boilMinutes)} Minuten statt ${j.minutes} gekocht`);
        }
        if (data.burnt > 0.2) {
          cook -= 12 * data.burnt;
          notes.push('angebrannt');
        }
        result = { score: 0.5 * ing.score + 0.5 * Math.max(0, cook), notes };
        break;
      }
      case 'choc': {
        const c = recipe.choc;
        const ing = scoreAmounts([{ id: c.kind, amount: c.grams }], data.added, (id) => CHOCOLATES[id].name);
        const notes = [...ing.notes];
        if (data.melt < 0.99) notes.push(`nur zu ${Math.round(data.melt * 100)} % geschmolzen`);
        let temp = 100 - 4 * Math.max(0, data.maxTemp - (c.temp + 5)) - 10 * data.overheat;
        if (data.maxTemp > c.temp + 5) notes.push(`bis ${data.maxTemp} °C erhitzt statt ${c.temp} °C`);
        if (data.overheat > 0.2) notes.push('zu heiß geworden – krümelig');
        if (data.maxTemp === 0) temp = 0;
        result = { score: 0.4 * ing.score + 0.3 * 100 * data.melt + 0.3 * Math.max(0, temp), notes };
        break;
      }
      case 'form': {
        const notes = [];
        let score = 0;
        if (data.form === recipe.form) score += 70;
        else notes.push(`${data.form ? FORMS[data.form].name : 'keine Form'} statt ${FORMS[recipe.form].name}`);
        score += 30 * Math.min(1, data.greased / 0.8);
        if (data.greased < 0.6) notes.push('nicht richtig eingefettet – klebt fest');
        result = { score, notes };
        break;
      }
      case 'layers': {
        const notes = [];
        const n = data.cuts.length + 1;
        const ideal = data.cuts.map((_, k) => (k + 1) / n);
        const err = data.cuts.length ? data.cuts.reduce((sum, c, k) => sum + Math.abs(c - ideal[k]), 0) / data.cuts.length : 0;
        let score = Math.max(0, 100 - 500 * Math.max(0, err - 0.02));
        if (err > 0.04) notes.push('ungleich dick geschnitten');
        if (n !== recipe.layers) {
          score = Math.min(score, Math.max(0, 60 - 25 * Math.abs(n - recipe.layers)));
          notes.unshift(`${n} ${n === 1 ? 'Boden' : 'Böden'} statt ${recipe.layers}`);
        }
        result = { score, notes };
        break;
      }
      case 'cream': {
        const c = recipe.cream;
        const notes = [];
        const ml = Math.max(0, 1 - Math.abs(data.ml - c.ml) / Math.max(c.ml * 0.5, 50));
        if (data.ml !== c.ml) notes.push(`${data.ml} ml Sahne statt ${c.ml} ml`);
        const van = Math.max(0, 1 - Math.abs(data.vanille - c.vanille) * 0.5);
        if (data.vanille !== c.vanille) notes.push(`${data.vanille} statt ${c.vanille} Päckchen Vanillezucker`);
        let stiff;
        const st = data.stiff;
        if (st > 1.25) {
          stiff = 10;
          notes.push('zu Butter geschlagen');
        } else if (st > 1.15) {
          stiff = 100 - (st - 1.15) * 600;
          notes.push('etwas zu fest');
        } else if (st >= 0.85) stiff = 100;
        else {
          stiff = Math.max(0, 100 - (0.85 - st) * 150);
          notes.push(st < 0.5 ? 'noch flüssig' : 'nicht ganz steif');
        }
        result = { score: data.ml ? 35 * ml + 15 * van + 0.5 * stiff : 0, notes: data.ml ? notes : ['keine Sahne geschlagen'] };
        break;
      }
      case 'crunch': {
        const c = recipe.crunch;
        const ing = scoreAmounts(
          [{ id: c.nut, amount: c.nutG }, { id: 'zucker', amount: c.zuckerG }, { id: 'butter', amount: c.butterG }],
          data.added,
          (id) => CRUNCH_ITEMS[id].name,
          (id) => !!CRUNCH_ITEMS[id].plural,
        );
        const notes = [...ing.notes];
        const cm = data.caramel;
        let roast = 100;
        if (cm < 0.85) {
          roast = Math.max(0, 100 - (0.85 - cm) * 120);
          notes.push('noch blass');
        } else if (cm > 1.25) {
          roast = Math.max(0, 100 - (cm - 1.25) * 150);
          notes.push('zu dunkel geröstet');
        }
        if (data.burnt > 0.5) {
          roast -= 10 * data.burnt;
          notes.push('angebrannt');
        }
        result = { score: 0.5 * ing.score + 0.5 * Math.max(0, roast), notes };
        break;
      }
      case 'assemble': {
        const want = recipe.order;
        const got = data.layers;
        // longest common subsequence: right things in the right order
        const dp = Array.from({ length: want.length + 1 }, () => new Array(got.length + 1).fill(0));
        for (let i = 1; i <= want.length; i++) {
          for (let j = 1; j <= got.length; j++) {
            dp[i][j] = want[i - 1] === got[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
          }
        }
        const notes = [];
        const count = (list) => list.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map());
        const w = count(want);
        const g = count(got);
        for (const [id, n] of w) if ((g.get(id) || 0) < n) notes.push(`${n - (g.get(id) || 0)}× ${LAYER_ITEMS[id].name} fehlt`);
        for (const [id, n] of g) if ((w.get(id) || 0) < n) notes.push(`${n - (w.get(id) || 0)}× ${LAYER_ITEMS[id].name} zu viel`);
        const same = got.length === want.length && got.every((id, i) => id === want[i]);
        if (!same && notes.length === 0) notes.push('Reihenfolge stimmt nicht');
        result = { score: (100 * dp[want.length][got.length]) / Math.max(want.length, got.length, 1), notes };
        break;
      }
      case 'top': {
        const part = (list, items, where) => {
          const notes = [];
          let matched = 0;
          let wantTotal = 0;
          const want = new Map(list.map((t) => [t.id, t.count]));
          for (const [id, count] of want) {
            const got = items[id] || 0;
            matched += Math.min(got, count);
            wantTotal += count;
            if (got !== count) notes.push(`${where}${got} statt ${count} ${TOPPINGS[id].many}`);
          }
          let gotTotal = 0;
          for (const [id, count] of Object.entries(items)) {
            gotTotal += count;
            if (!want.has(id)) notes.push(`${where}${TOPPINGS[id].many} standen nicht im Rezept`);
          }
          return { score: (100 * matched) / Math.max(wantTotal, gotTotal, 1), notes };
        };
        const top = part(recipe.top, data.items, '');
        if (recipe.side) {
          const side = part(recipe.side, data.side || {}, 'Rand: ');
          result = { score: 0.65 * top.score + 0.35 * side.score, notes: [...top.notes, ...side.notes] };
        } else result = top;
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
        result = { score: union ? (100 * both) / union : 100, notes };
        if (recipe.side) {
          const sideGot = new Set(data.side || []);
          const sideWant = new Set(recipe.side);
          let hit = 0;
          for (const k of sideWant) {
            if (sideGot.has(k)) hit++;
            else notes.push(`Rand: ${SPRINKLES[k].name} fehlen`);
          }
          for (const k of sideGot) if (!sideWant.has(k)) notes.push(`Rand: ${SPRINKLES[k].name} standen nicht im Rezept`);
          const sideScore = (100 * hit) / Math.max(1, new Set([...sideWant, ...sideGot]).size);
          result.score = 0.7 * result.score + 0.3 * sideScore;
        }
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
    const most = (added, catalogue) => Object.entries(added || {}).filter(([id]) => catalogue[id]).sort((a, b) => b[1] - a[1])[0];
    if (s.jam && most(s.jam.added, FRUITS)) {
      const [fruit] = most(s.jam.added, FRUITS);
      let color = FRUITS[fruit].color;
      if (s.jam.burnt > 1) color = mix(color, '#2a1208', 0.45);
      const want = recipe && recipe.jam ? recipe.jam.minutes : 4;
      const runny = !s.jam.added.gelierzucker || s.jam.boilMinutes < want * 0.6;
      glaze = { color, opacity: runny ? 0.7 : 0.93, texture: runny ? 'runny' : 'smooth' };
    }
    if (s.choc && most(s.choc.added, CHOCOLATES)) {
      const [kind] = most(s.choc.added, CHOCOLATES);
      let color = CHOCOLATES[kind].color;
      let texture = 'smooth';
      if (s.choc.overheat > 1) {
        color = mix(color, '#8a8070', 0.35);
        texture = 'lumpy';
      }
      if (s.choc.melt < 0.8) texture = 'lumpy';
      glaze = { color, opacity: 1, texture };
    }
    const kind = (recipe && recipe.kind) || 'cookie';
    const look = {
      kind,
      shapes,
      mm: s.roll ? s.roll.mm : 10,
      dough: doughColor(dough),
      doneness,
      color: bakedColor(doughColor(dough), doneness),
      glaze,
      sprinkles: s.sprinkle ? s.sprinkle.sprinkles : [],
      sideSprinkles: s.sprinkle && s.sprinkle.side ? s.sprinkle.side : [],
    };
    if (kind !== 'cookie') {
      const form = (s.form && s.form.form) || (recipe && recipe.form) || 'springform';
      look.form = form;
      look.shapes = { [FORMS[form].shape]: 1 };
      look.mm = kind === 'torte' ? 22 : 16;
      look.stuck = !!s.form && s.form.greased < 0.6;
    }
    if (kind === 'torte') {
      const st = s.cream ? s.cream.stiff : 1;
      look.cream = st > 1.25 ? { color: '#f3e3a6', texture: 'lumpy' } : st < 0.5 ? { color: '#fbfaf4', texture: 'runny' } : { color: '#fdfcf7', texture: 'smooth' };
      look.layers = s.assemble ? s.assemble.layers : [];
      look.toppings = s.top ? s.top.items : {};
      look.side = s.top && s.top.side ? s.top.side : {};
      look.jamColor = s.jam && Object.keys(s.jam.added).some((id) => FRUITS[id])
        ? FRUITS[Object.entries(s.jam.added).filter(([id]) => FRUITS[id]).sort((a, b) => b[1] - a[1])[0][0]].color
        : '#c2185b';
      const cm = s.crunch ? s.crunch.caramel : 1;
      look.crunchColor = bakedColor('#e9c99a', cm);
      look.glaze = null;
      look.sprinkles = [];
    }
    return look;
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
      this.mode = 'recipe'; // recipe | free
      this.freeKind = 'cookie';
      this.freeJam = false;
    }

    setFree(kind, jam) {
      if (this.phase !== 'lobby' && this.phase !== 'results') return;
      if (FREE_KINDS.includes(kind)) this.freeKind = kind;
      this.freeJam = !!jam;
      this.broadcastState();
    }

    setMode(mode) {
      if (this.phase !== 'lobby' && this.phase !== 'results') return;
      if (mode !== 'recipe' && mode !== 'free') return;
      this.mode = mode;
      this.broadcastState();
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
        mode: this.mode,
        freeKind: this.freeKind,
        freeJam: this.freeJam,
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
      this.roundId = randomHex(4);
      // Any recipe at random, just not the same one twice in a row.
      this.recipe = this.mode === 'free' ? makeFreeRecipe(this.freeKind, this.freeJam) : makeRecipe({ avoid: this.recipe ? [this.recipe.title] : [] });
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
      const stations = this.recipe.stations;
      if (stations[player.station] !== station) {
        player.send({ type: 'stepped', station: player.station }); // resync a confused phone
        return;
      }
      const clean = sanitizeStep(station, data);
      player.steps[station] = clean;
      player.station++;
      if (player.station >= stations.length) player.finishedAt = Date.now();
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
        if (this.recipe.free) {
          const jury = scoreFree(p.steps, this.recipe);
          return {
            player: p,
            id: p.id,
            name: p.name,
            color: p.color,
            total: jury.total,
            verdict: jury.verdict,
            timeMs: (p.finishedAt || Date.now()) - this.startedAt,
            finished: !!p.finishedAt,
            scores: jury.scores,
            look: lookOf(p.steps, this.recipe),
          };
        }
        const scores = {};
        let total = 0;
        const scored = scoredOf(this.recipe);
        for (const station of scored) {
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
          total: Math.round(total / scored.length),
          timeMs: (p.finishedAt || Date.now()) - this.startedAt,
          finished: !!p.finishedAt,
          scores,
          look: lookOf(p.steps, this.recipe),
        };
      });
      rows.sort((a, b) => b.total - a.total || a.timeMs - b.timeMs);

      let winner = null;
      if (rows.length >= 2 && rows[0].total > 0) winner = rows[0];
      else if (rows.length === 1 && rows[0].total >= (this.recipe.free ? CONFIG.soloFreePrizeScore : CONFIG.soloPrizeScore)) winner = rows[0];
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
        roundId: this.roundId,
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
        case 'mode':
          room.setMode(msg.mode);
          break;
        case 'free':
          room.setFree(msg.kind, msg.jam);
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
    TYPES,
    FRUITS,
    CHOCOLATES,
    JAM_ITEMS,
    LEVELS,
    FORMS,
    LAYER_ITEMS,
    TOPPINGS,
    CRUNCH_ITEMS,
    scoredOf,
    FREE_CATEGORIES,
    FREE_KINDS,
    makeFreeRecipe,
    scoreFree,
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
