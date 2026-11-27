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
  return {
    dough: { added: amounts(recipe.dough), stir: 1 },
    roll: { mm: recipe.mm },
    cut: { shapes: Object.fromEntries(recipe.cut.map((c) => [c.shape, c.count])) },
    bake: { temp: recipe.bake.temp, minutes: recipe.bake.minutes },
    icing: { added: amounts(recipe.icing), stir: 1 },
    color: { drops: { [recipe.color.id]: recipe.color.drops } },
    sprinkle: { sprinkles: recipe.sprinkles },
    plate: {},
  };
}

async function testScoring() {
  const recipe = hub.makeRecipe();
  const perfect = perfectSteps(recipe);
  for (const station of hub.SCORED) {
    const result = hub.scoreStep(station, recipe, hub.sanitizeStep(station, perfect[station]));
    assert.equal(result.score, 100, `${station} perfect`);
    assert.deepEqual(result.notes, [], `${station} has no notes`);
  }

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
  console.log('ok scoring');
}

async function testDuel() {
  const code = '57';
  const anna = fakeClient('anna');
  anna.send({ type: 'join', code, name: 'Anna', token: 'anna-token-1', owned: ['schneebesen', 'nonsense'] });
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
  anna.drain();
  ben.drain();

  // Out of order steps are refused and resynced.
  anna.send({ type: 'step', station: 'bake', data: {} });
  assert.equal((await anna.next(isType('stepped'))).station, 0);

  const perfect = perfectSteps(recipe);
  for (const station of hub.STATIONS) {
    anna.send({ type: 'step', station, data: perfect[station] });
    await anna.next(isType('stepped'));
  }
  const waiting = await ben.next((m) => m.type === 'state' && m.players.find((p) => p.id === joinedA.you).finished);
  assert.equal(waiting.phase, 'baking');

  // Ben bakes too hot and forgets the sprinkles.
  for (const station of hub.STATIONS) {
    let data = perfect[station];
    if (station === 'bake') data = { temp: recipe.bake.temp + 30, minutes: recipe.bake.minutes };
    if (station === 'sprinkle') data = { sprinkles: [] };
    ben.send({ type: 'step', station, data });
  }
  const results = await anna.next(isType('results'));
  assert.equal(results.winner, joinedA.you);
  assert.equal(results.players[0].total, 100);
  assert.ok(results.players[1].total < 100);
  assert.ok(results.players[1].scores.bake.notes[0].includes('°C'));
  assert.ok(results.prize && results.prize.id !== 'schneebesen', 'prize is a utensil Anna does not own yet');
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
  for (const station of hub.STATIONS.slice(1)) a2.send({ type: 'step', station, data: perfectSteps(recipe)[station] });
  await new Promise((r) => setTimeout(r, 250));
  const results = await a2.next(isType('results'));
  assert.deepEqual(results.players.map((p) => p.name), ['A']);
  assert.equal(results.winner, back.you, 'solo 100 % earns a prize');
  a2.socket.close();
  console.log('ok rejoin and leave');
}

(async () => {
  await testScoring();
  await testDuel();
  await testRejoinAndLeave();
  console.log('bake hub: all good');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
