'use strict';

// In-process test of the Plätzchen-Duell hub with fake sockets and short timings.
// Usage: node test/bake-hub.test.js

const assert = require('node:assert/strict');
const hub = require('../public/shared/bake-hub');

Object.assign(hub.CONFIG, { countdownMs: 30, roundMs: 2000, disconnectGraceMs: 100 });

function fakeClient(name) {
  const listeners = { message: [], close: [] };
  const inbox = [];
  const waiters = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    on(event, fn) { listeners[event].push(fn); },
    send(data) {
      const msg = JSON.parse(data);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else inbox.push(msg);
    },
    close() {
      this.readyState = 3;
      listeners.close.forEach((fn) => fn());
    },
  };
  hub.handleConnection(socket);
  return {
    name,
    socket,
    send: (msg) => listeners.message.forEach((fn) => fn(JSON.stringify(msg))),
    next(pred, timeout = 3000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${name}: timeout`)), timeout);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    drain: () => inbox.splice(0),
  };
}

const isType = (type) => (m) => m.type === type;
const phase = (p) => (m) => m.type === 'state' && m.phase === p;

/** Exactly what the recipe asks for, station by station. */
function perfectSteps(recipe) {
  const amounts = (list) => Object.fromEntries(list.map((d) => [d.id, d.amount]));
  const steps = {
    dough: { added: amounts(recipe.dough), stir: 1 },
    bake: { temp: recipe.bake.temp, minutes: recipe.bake.minutes },
    sprinkle: { sprinkles: recipe.sprinkles, side: recipe.kind === 'cake' && recipe.side ? recipe.side : [] },
    plate: {},
  };
  if (recipe.cut) {
    steps.roll = { mm: recipe.mm };
    steps.cut = { shapes: Object.fromEntries(recipe.cut.map((c) => [c.shape, c.count])) };
  }
  if (recipe.icing) steps.icing = { added: amounts(recipe.icing), stir: 1 };
  if (recipe.color) steps.color = { drops: { [recipe.color.id]: recipe.color.drops } };
  if (recipe.form) steps.form = { form: recipe.form, greased: 1 };
  if (recipe.layers) steps.layers = { cuts: Array.from({ length: recipe.layers - 1 }, (_, k) => (k + 1) / recipe.layers) };
  if (recipe.cream) steps.cream = { ml: recipe.cream.ml, vanille: recipe.cream.vanille, stiff: 1 };
  if (recipe.crunch) {
    const c = recipe.crunch;
    steps.crunch = { added: { [c.nut]: c.nutG, zucker: c.zuckerG, butter: c.butterG }, caramel: 1, burnt: 0 };
  }
  if (recipe.order) steps.assemble = { layers: recipe.order };
  if (recipe.top) {
    steps.top = {
      items: Object.fromEntries(recipe.top.map((t) => [t.id, t.count])),
      side: Object.fromEntries((recipe.side || []).map((t) => [t.id, t.count])),
    };
  }
  if (recipe.jam) {
    const j = recipe.jam;
    steps.jam = { added: { [j.fruit]: j.fruitG, gelierzucker: j.sugarG }, boilMinutes: j.minutes, burnt: 0 };
  }
  if (recipe.choc) {
    const c = recipe.choc;
    steps.choc = { added: { [c.kind]: c.grams }, melt: 1, maxTemp: c.temp, overheat: 0 };
  }
  return steps;
}

async function testScoring() {
  for (const type of Object.keys(hub.TYPES)) {
    for (let level = 0; level < hub.LEVELS; level++) {
      const r = hub.makeRecipe({ type, level });
      const p = perfectSteps(r);
      for (const station of hub.scoredOf(r)) {
        const result = hub.scoreStep(station, r, hub.sanitizeStep(station, p[station]));
        assert.equal(result.score, 100, `${type}/${level}/${station} perfect`);
        assert.deepEqual(result.notes, [], `${type}/${level}/${station} has no notes`);
      }
      const lines = hub.recipeSteps(r);
      for (const station of r.stations) assert.ok(lines[station] && lines[station].length, `${type} has text for ${station}`);
    }
  }
  const recipe = hub.makeRecipe({ type: 'butter' });
  const perfect = perfectSteps(recipe);

  // Powdered sugar instead of sugar is a classic mistake.
  const swapped = { ...perfect.dough.added, puderzucker: perfect.dough.added.zucker };
  delete swapped.zucker;
  const dough = hub.scoreStep('dough', recipe, hub.sanitizeStep('dough', { added: swapped, stir: 1 }));
  assert.ok(dough.score < 80, `swapped sugar scores ${dough.score}`);
  assert.ok(dough.notes.some((n) => n.includes('Zucker fehlt')));
  assert.ok(dough.notes.some((n) => n.includes('Puderzucker gehört nicht hinein')));

  // Slightly off is still good, far off is bad.
  const near = hub.scoreStep('roll', recipe, { mm: recipe.mm + 0.3 });
  const far = hub.scoreStep('roll', recipe, { mm: recipe.mm + 4 });
  assert.ok(near.score > 85 && far.score === 0, `roll ${near.score} / ${far.score}`);

  const bake = hub.scoreStep('bake', recipe, { temp: recipe.bake.temp + 20, minutes: recipe.bake.minutes + 3 });
  assert.ok(bake.score < 50 && bake.notes.length === 2, `bake ${bake.score}`);

  const wrongColor = Object.keys(hub.PIPING).find((c) => c !== recipe.color.id);
  const color = hub.scoreStep('color', recipe, { drops: { [wrongColor]: 2 } });
  assert.ok(color.score <= 15, `wrong colour scores ${color.score}`);

  const extra = Object.keys(hub.SPRINKLES).find((id) => !recipe.sprinkles.includes(id));
  const sprinkle = hub.scoreStep('sprinkle', recipe, { sprinkles: [recipe.sprinkles[0], extra] });
  assert.ok(sprinkle.score > 0 && sprinkle.score < 100, `sprinkles ${sprinkle.score}`);

  // Unknown or hostile input is dropped.
  const clean = hub.sanitizeStep('dough', { added: { mehl: '250', gift: 3, __proto__: { x: 1 }, zucker: -5 }, stir: 7 });
  assert.deepEqual(clean, { added: { mehl: 250 }, stir: 1 });

  // The look follows what happened.
  const look = hub.lookOf(perfect, recipe);
  assert.ok(Math.abs(look.doneness - 1) < 1e-9);
  assert.equal(look.glaze.texture, 'smooth');
  assert.deepEqual(look.sprinkles, recipe.sprinkles);
  const burnt = hub.lookOf({ ...perfect, bake: { temp: recipe.bake.temp + 50, minutes: recipe.bake.minutes * 2 } }, recipe);
  assert.ok(burnt.doneness > 2);
  // Marmalade: burnt and too short costs, the wrong fruit too.
  const jam = hub.makeRecipe({ type: 'jam', level: 1 });
  const otherFruit = Object.keys(hub.FRUITS).find((f) => f !== jam.jam.fruit);
  const badJam = hub.scoreStep('jam', jam, hub.sanitizeStep('jam', { added: { [otherFruit]: jam.jam.fruitG, gelierzucker: jam.jam.sugarG }, boilMinutes: 1, burnt: 3 }));
  assert.ok(badJam.score < 40, `bad jam ${badJam.score}`);
  assert.ok(badJam.notes.includes('angebrannt'));
  assert.equal(hub.lookOf({ ...perfectSteps(jam), jam: { added: { [jam.jam.fruit]: 300 }, boilMinutes: 1, burnt: 0 } }, jam).glaze.texture, 'runny');

  // Chocolate: too hot gets crumbly and costs points.
  const choc = hub.makeRecipe({ type: 'choc', level: 2 });
  const hot = hub.scoreStep('choc', choc, hub.sanitizeStep('choc', { added: { [choc.choc.kind]: choc.choc.grams }, melt: 1, maxTemp: choc.choc.temp + 25, overheat: 4 }));
  assert.ok(hot.score < 75, `hot chocolate ${hot.score}`);
  assert.ok(hot.notes.some((n) => n.includes('krümelig')));
  assert.equal(hub.lookOf({ choc: { added: { [choc.choc.kind]: 100 }, melt: 1, maxTemp: 80, overheat: 4 } }, choc).glaze.texture, 'lumpy');

  // Any kind at random, harder recipes on higher difficulty, no repeats.
  const kinds = new Set(Array.from({ length: 200 }, () => hub.makeRecipe().type));
  assert.deepEqual([...kinds].sort(), Object.keys(hub.TYPES).sort(), 'every kind comes up');
  assert.equal(hub.makeRecipe({ type: 'butter', level: 0 }).cut.length, 1);
  assert.equal(hub.makeRecipe({ type: 'butter', level: 3 }).cut.length, 3);
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const r = hub.makeRecipe({ type: 'butter', level: 2, avoid: seen });
    assert.ok(!seen.includes(r.title), `repeated ${r.title}`);
    seen.push(r.title);
  }
  // Cakes: the right tin, greased.
  const cake = hub.makeRecipe({ type: 'cake', level: 1 });
  assert.ok(cake.stations.includes('form') && !cake.stations.includes('cut'));
  const otherForm = Object.keys(hub.FORMS).find((f) => f !== cake.form);
  const tin = hub.scoreStep('form', cake, hub.sanitizeStep('form', { form: otherForm, greased: 0.2 }));
  assert.ok(tin.score < 20 && tin.notes.length === 2, `wrong tin ${tin.score}`);
  assert.ok(hub.lookOf({ form: { form: cake.form, greased: 0.1 } }, cake).stuck);
  assert.equal(hub.lookOf({}, cake).kind, 'cake');

  // Tortes: layers, cream, crunch, stacking, toppings.
  let torte;
  do torte = hub.makeRecipe({ type: 'torte', level: 2 }); while (!torte.crunch);
  const uneven = hub.scoreStep('layers', torte, hub.sanitizeStep('layers', { cuts: [0.1] }));
  assert.ok(uneven.score <= 60 && uneven.notes.length >= 1, `layers ${uneven.score}`);
  const butter = hub.scoreStep('cream', torte, hub.sanitizeStep('cream', { ml: torte.cream.ml, vanille: torte.cream.vanille, stiff: 1.6 }));
  assert.ok(butter.score < 60 && butter.notes.includes('zu Butter geschlagen'), `butter ${butter.score}`);
  assert.equal(hub.lookOf({ cream: { ml: 300, vanille: 1, stiff: 1.6 } }, torte).cream.texture, 'lumpy');
  const burntCrunch = hub.scoreStep('crunch', torte, hub.sanitizeStep('crunch', { added: { [torte.crunch.nut]: torte.crunch.nutG, zucker: torte.crunch.zuckerG, butter: torte.crunch.butterG }, caramel: 1.9, burnt: 4 }));
  assert.ok(burntCrunch.score < 60 && burntCrunch.notes.includes('angebrannt'), `crunch ${burntCrunch.score}`);
  const reversed = hub.scoreStep('assemble', torte, hub.sanitizeStep('assemble', { layers: [...torte.order].reverse() }));
  assert.ok(reversed.score < 100 && reversed.notes.length, `reversed stack ${reversed.score}`);
  const missing = hub.scoreStep('assemble', torte, hub.sanitizeStep('assemble', { layers: torte.order.filter((id) => id !== 'crunch') }));
  assert.ok(missing.notes.some((n) => n.includes('Crunch fehlt')));
  const naked = hub.scoreStep('top', torte, hub.sanitizeStep('top', { items: { tupfen: 2, banane: 4 } }));
  assert.ok(naked.score < 40, `naked torte ${naked.score}`);
  // the side counts too
  const perfectTorte = perfectSteps(torte);
  const noSide = hub.scoreStep('top', torte, hub.sanitizeStep('top', { items: perfectTorte.top.items, side: {} }));
  assert.ok(noSide.score < 70 && noSide.notes.some((n) => n.startsWith('Rand:')), `no side ${noSide.score}`);
  let sideCake;
  do sideCake = hub.makeRecipe({ type: 'cake' }); while (!sideCake.side);
  const bare = hub.scoreStep('sprinkle', sideCake, hub.sanitizeStep('sprinkle', { sprinkles: sideCake.sprinkles, side: [] }));
  assert.equal(bare.score, 70);
  assert.ok(bare.notes.some((n) => n.startsWith('Rand:')));
  assert.ok(hub.recipeSteps(sideCake).sprinkle.some((l) => l.startsWith('Rand rundum')));
  const tl = hub.lookOf(perfectSteps(torte), torte);
  assert.equal(tl.kind, 'torte');
  assert.deepEqual(tl.layers, torte.order);
  console.log('ok scoring');
}

async function testDuel() {
  const code = '57';
  const anna = fakeClient('anna');
  anna.send({ type: 'join', code, name: 'Anna', token: 'anna-token-1', owned: ['ruehrloeffel', 'nonsense'] });
  const joinedA = await anna.next(isType('joined'));
  const ben = fakeClient('ben');
  ben.send({ type: 'join', code, name: 'Ben', token: 'ben-token-12' });
  const joinedB = await ben.next(isType('joined'));
  assert.notEqual(joinedA.color, joinedB.color);

  // A third baker does not fit.
  const carla = fakeClient('carla');
  carla.send({ type: 'join', code, name: 'Carla', token: 'carla-token' });
  const err = await carla.next(isType('error'));
  assert.match(err.message, /zwei/);

  anna.send({ type: 'start' });
  await anna.next(phase('countdown'));
  const baking = await ben.next(phase('baking'));
  const recipe = baking.recipe;
  assert.ok(recipe && recipe.dough.length >= 5);
  assert.ok(Object.hasOwn(hub.TYPES, recipe.type) && recipe.stations.at(-1) === 'plate');
  anna.drain();
  ben.drain();

  // Out of order steps are refused and resynced.
  anna.send({ type: 'step', station: 'bake', data: {} });
  assert.equal((await anna.next(isType('stepped'))).station, 0);

  const perfect = perfectSteps(recipe);
  for (const station of recipe.stations) {
    anna.send({ type: 'step', station, data: perfect[station] });
    await anna.next(isType('stepped'));
  }
  const waiting = await ben.next((m) => m.type === 'state' && m.players.find((p) => p.id === joinedA.you).finished);
  assert.equal(waiting.phase, 'baking');

  // Ben bakes too hot and forgets the sprinkles.
  for (const station of recipe.stations) {
    let data = perfect[station];
    if (station === 'bake') data = { temp: recipe.bake.temp + 30, minutes: recipe.bake.minutes };
    if (station === 'jam') data = { ...data, burnt: 2 };
    if (station === 'sprinkle') data = { sprinkles: [] };
    ben.send({ type: 'step', station, data });
  }
  const results = await anna.next(isType('results'));
  assert.equal(results.winner, joinedA.you);
  assert.equal(results.players[0].total, 100);
  assert.ok(results.players[1].total < 100);
  assert.ok(results.players[1].scores.bake.notes[0].includes('°C'));
  assert.ok(results.prize && results.prize.id !== 'ruehrloeffel', 'prize is a utensil Anna does not own yet');
  assert.equal((await ben.next(isType('results'))).winner, joinedA.you);

  // Another round with a fresh recipe.
  anna.drain();
  ben.send({ type: 'start' });
  const again = await anna.next(phase('baking'));
  assert.equal(again.round, 2);
  assert.ok(again.players.every((p) => p.station === 0 && !p.finished));
  anna.socket.close();
  ben.socket.close();
  console.log('ok duel');
}

async function testRejoinAndLeave() {
  const code = '58';
  const a = fakeClient('a');
  a.send({ type: 'join', code, name: 'A', token: 'rejoin-token-a' });
  await a.next(isType('joined'));
  const b = fakeClient('b');
  b.send({ type: 'join', code, name: 'B', token: 'rejoin-token-b' });
  await b.next(isType('joined'));
  a.send({ type: 'start' });
  const { recipe } = await a.next(phase('baking'));
  a.send({ type: 'step', station: 'dough', data: perfectSteps(recipe).dough });
  await a.next(isType('stepped'));

  // A's phone reloads: progress and steps survive.
  a.socket.close();
  const a2 = fakeClient('a2');
  a2.send({ type: 'join', code, name: 'A', token: 'rejoin-token-a' });
  const back = await a2.next(isType('joined'));
  assert.equal(back.station, 1);
  assert.ok(back.steps.dough);

  // B leaves for good: A finishes alone and the round is judged without B's plate.
  b.socket.close();
  for (const station of recipe.stations.slice(1)) a2.send({ type: 'step', station, data: perfectSteps(recipe)[station] });
  await new Promise((r) => setTimeout(r, 250));
  const results = await a2.next(isType('results'));
  assert.deepEqual(results.players.map((p) => p.name), ['A']);
  assert.equal(results.winner, back.you, 'solo 100 % earns a prize');
  a2.socket.close();
  console.log('ok rejoin and leave');
}

async function testFreeMode() {
  // The jury rewards a sensible, nicely decorated plate and punishes a salty, burnt one.
  const nice = {
    dough: { added: { mehl: 250, butter: 150, zucker: 100, eier: 1, zimt: 8, honig: 50 }, stir: 1 },
    roll: { mm: 5 },
    cut: { shapes: { stern: 4, herz: 3, mond: 2 } },
    bake: { temp: 180, minutes: 11 },
    icing: { added: { puderzucker: 150, zitrone: 3 }, stir: 1 },
    color: { drops: { rosa: 2, gelb: 1 } },
    sprinkle: { sprinkles: ['silber', 'sterne'] },
    plate: {},
  };
  const good = hub.scoreFree(nice);
  assert.ok(good.total >= 90, `nice plate ${good.total}`);
  assert.deepEqual(Object.keys(good.scores), hub.FREE_CATEGORIES.map((c) => c.id));
  const salty = hub.scoreFree({ ...nice, dough: { added: { ...nice.dough.added, salz: 40 }, stir: 1 }, bake: { temp: 230, minutes: 20 } });
  assert.ok(salty.scores.geschmack.notes.includes('versalzen!'));
  assert.ok(salty.scores.backkunst.notes.includes('verbrannt!'));
  assert.ok(salty.total < good.total - 20, `salty ${salty.total}`);
  const plain = hub.scoreFree({ ...nice, cut: { shapes: { kreis: 3 } }, color: { drops: {} }, sprinkle: { sprinkles: [] } });
  assert.ok(plain.scores.kreativ.score < good.scores.kreativ.score && plain.scores.deko.score < good.scores.deko.score);
  assert.equal(hub.scoreFree({}).total, 0);

  // Free cakes and tortes, with or without marmalade.
  assert.deepEqual(hub.makeFreeRecipe('cookie', true).stations, ['dough', 'roll', 'cut', 'bake', 'jam', 'sprinkle', 'plate']);
  assert.ok(hub.makeFreeRecipe('cake').stations.includes('form'));
  const freeTorte = hub.makeFreeRecipe('torte', true);
  assert.ok(freeTorte.stations.includes('jam') && freeTorte.stations.includes('top'));
  for (const id of freeTorte.stations) assert.ok(hub.recipeSteps(freeTorte)[id].length, `tip for ${id}`);
  const lovely = {
    dough: { added: { eier: 5, zucker: 130, mehl: 120, staerke: 30, backpulver: 5, vanille: 8 }, stir: 1 },
    form: { form: 'springform', greased: 1 },
    bake: { temp: 175, minutes: 30 },
    layers: { cuts: [0.33, 0.66] },
    cream: { ml: 400, vanille: 1, stiff: 1 },
    jam: { added: { himbeere: 300, gelierzucker: 150 }, boilMinutes: 4, burnt: 0 },
    assemble: { layers: ['boden', 'marmelade', 'sahne', 'boden', 'sahne', 'boden', 'sahne'] },
    top: { items: { tupfen: 10, himbeere: 10 }, side: { mandel: 8 } },
  };
  const sloppy = { ...lovely, cream: { ml: 400, vanille: 0, stiff: 1.7 }, layers: { cuts: [] }, top: { items: {}, side: {} } };
  const loved = hub.scoreFree(lovely, freeTorte);
  const meh = hub.scoreFree(sloppy, freeTorte);
  assert.ok(loved.total >= 80 && meh.total < loved.total - 20, `free torte ${loved.total} / ${meh.total}`);
  assert.ok(loved.scores.deko.notes.includes('Rand rundum verziert'));
  assert.ok(meh.scores.backkunst.notes.includes('Sahne zu Butter geschlagen'));

  // A room in free mode: no recipe numbers, the jury decides.
  const code = '59';
  const a = fakeClient('free-a');
  a.send({ type: 'join', code, name: 'Frei A', token: 'free-token-a' });
  await a.next(isType('joined'));
  const b = fakeClient('free-b');
  b.send({ type: 'join', code, name: 'Frei B', token: 'free-token-b' });
  await b.next(isType('joined'));
  a.send({ type: 'mode', mode: 'free' });
  assert.equal((await b.next((m) => m.type === 'state' && m.mode === 'free')).phase, 'lobby');
  a.send({ type: 'mode', mode: 'nonsense' });
  a.send({ type: 'free', kind: 'torte', jam: true });
  const chosen = await b.next((m) => m.type === 'state' && m.freeKind === 'torte');
  assert.equal(chosen.freeJam, true);
  a.send({ type: 'free', kind: 'cookie', jam: false });
  await b.next((m) => m.type === 'state' && m.freeKind === 'cookie');
  b.send({ type: 'start' });
  const { recipe } = await a.next(phase('baking'));
  assert.ok(recipe.free, 'free recipe even for an experienced baker');
  assert.deepEqual(recipe.stations, hub.TYPES.butter.stations);
  assert.ok(hub.recipeSteps(recipe).dough[0].includes('Grundlage'));
  for (const station of recipe.stations) a.send({ type: 'step', station, data: nice[station] });
  for (const station of recipe.stations) b.send({ type: 'step', station, data: station === 'bake' ? { temp: 240, minutes: 25 } : {} });
  const results = await a.next(isType('results'));
  assert.equal(results.players[0].name, 'Frei A');
  assert.ok(results.players[0].verdict && results.players[0].scores.deko);
  assert.equal(results.winner, results.players[0].id);
  assert.ok(results.prize);
  a.socket.close();
  b.socket.close();
  console.log('ok free mode');
}

(async () => {
  await testScoring();
  await testFreeMode();
  await testDuel();
  await testRejoinAndLeave();
  console.log('bake hub: all good');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
