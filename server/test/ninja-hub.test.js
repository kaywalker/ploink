'use strict';

// In-process test of the Katana-Küche hub with fake sockets and short timings.
// Usage: node test/ninja-hub.test.js

const assert = require('node:assert/strict');
const hub = require('../public/shared/ninja-hub');

Object.assign(hub.CONFIG, {
  countdownMs: 50,
  roundMs: 9000,
  salvoEveryMs: 60_000,
  lavaFirstMs: 60_000,          // lava is started by hand below
});

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
    take(pred) {
      const i = inbox.findIndex(pred);
      return i >= 0 ? inbox.splice(i, 1)[0] : null;
    },
    drain: () => inbox.splice(0),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Deterministic fruit paths: start above the dojo, stay between the walls, land on time.
  const W = hub.CONFIG.width;
  const sample = { t0: 1000, r: 0.4, x0: 1, y0: hub.CONFIG.height + 1, vx: 7, v0: 1, g: 2.5, rot0: 0, spin: 1 };
  assert.equal(hub.fruitPosition(sample, 1000).y, hub.CONFIG.height + 1);
  for (let t = 1000; t < 5000; t += 37) {
    const { x } = hub.fruitPosition(sample, t);
    assert.ok(x >= sample.r - 1e-9 && x <= W - sample.r + 1e-9, `x ${x} stays inside the dojo`);
  }
  const landed = hub.fruitPosition(sample, sample.t0 + hub.fruitLifetime(sample));
  assert.ok(Math.abs(landed.y - sample.r) < 1e-6, `lands on the floor (y ${landed.y})`);
  console.log('✓ fruit paths bounce off the walls and land on time');

  // Power-up bubbles rise from the floor and leave at the top.
  const riser = { t0: 0, r: 0.45, rise: true, x0: 5, y0: -0.65, vx: 0.3, v0: -2, g: 0, rot0: 0, spin: 0 };
  assert.ok(hub.fruitPosition(riser, 0).y < 0, 'starts in the floor');
  assert.ok(hub.fruitPosition(riser, 2000).y > hub.fruitPosition(riser, 1000).y, 'keeps rising');
  assert.ok(hub.fruitPosition(riser, hub.fruitLifetime(riser)).y >= hub.CONFIG.height + 2.9, 'gone at the top when it expires');
  console.log('✓ power-up bubbles rise from the floor');

  const bad = fakeClient('bad');
  bad.send({ type: 'join', code: '7', name: 'X' });
  assert.equal((await bad.next((m) => m.type === 'error')).type, 'error');
  console.log('✓ invalid room code is rejected');

  const a = fakeClient('Anna');
  const b = fakeClient('Ben');
  a.send({ type: 'join', code: '44', name: 'Anna', token: 'anna-token-1' });
  const joinedA = await a.next((m) => m.type === 'joined');
  b.send({ type: 'join', code: '44', name: 'Ben', token: 'ben-token-12' });
  const joinedB = await b.next((m) => m.type === 'joined');
  assert.notEqual(joinedA.startX, joinedB.startX, 'ninjas start at different spots');

  // Each phone reports its stored personal best; everybody sees it before the round.
  a.send({ type: 'best', score: 5 });
  b.send({ type: 'best', score: 100000 });
  const bests = await b.next((m) => m.type === 'state' && m.players.some((p) => p.best === 5) && m.players.some((p) => p.best === 100000));
  assert.equal(bests.players.length, 2);
  console.log('✓ personal bests are shown to everybody in the room');

  a.send({ type: 'start' });
  await a.next((m) => m.type === 'state' && m.phase === 'countdown');
  await a.next((m) => m.type === 'state' && m.phase === 'playing');
  const spawn = await b.next((m) => m.type === 'spawn');
  assert.ok(spawn.fruit.y0 > hub.CONFIG.height, 'fruit starts above the dojo');
  console.log('✓ round starts and fruit falls from the sky');

  const room = hub.rooms.get('44');
  const anna = [...room.players.values()].find((p) => p.name === 'Anna');
  const ben = [...room.players.values()].find((p) => p.name === 'Ben');

  a.send({ type: 'pos', x: 3, y: 2, rot: 1.2, air: true, facing: 1 });
  b.send({ type: 'pos', x: 8, y: 0.5, rot: 0, air: false, facing: -1 });
  const snap = await a.next((m) => m.type === 'ninjas' && m.list.length === 2);
  const annaRow = snap.list.find((row) => row[0] === anna.id);
  assert.deepEqual(annaRow.slice(1, 5), [3, 2, 1.2, 1]);
  console.log('✓ ninja positions are relayed to everybody');

  // A fruit hanging right next to Anna's katana.
  const hang = (x, y, type = 'apple') => room.spawnFruit(Date.now(), {
    type, r: hub.FRUITS[type].r, points: hub.FRUITS[type].points, x0: x, y0: y, vx: 0, v0: 0, g: 0.0001,
  });

  const f1 = hang(3.8, 2.3);
  a.drain();
  b.drain();
  a.send({ type: 'cut', id: f1.id, x: 3, y: 2, angle: 0.4 });
  const cut1 = await b.next((m) => m.type === 'cut' && m.id === f1.id);
  assert.equal(cut1.by.id, anna.id);
  assert.equal(cut1.points, 10);
  assert.equal(anna.score, 10);
  b.send({ type: 'cut', id: f1.id, x: 8, y: 0.5 });
  await sleep(50);
  assert.equal(ben.score, 0, 'a fruit can only be cut once');
  console.log('✓ cuts score once, first claim wins');

  const far = hang(9, 10);
  a.send({ type: 'cut', id: far.id, x: 3, y: 2 });
  await sleep(50);
  assert.ok(room.fruits.has(far.id), 'fruit out of reach stays');
  a.send({ type: 'cut', id: far.id, x: 8.6, y: 9.6 });
  await sleep(50);
  assert.ok(room.fruits.has(far.id), 'claimed position far from the reported one is rejected');
  assert.equal(anna.score, 10);
  console.log('✓ cuts out of reach are rejected');

  const f2 = hang(2.4, 2.5);
  a.send({ type: 'cut', id: f2.id, x: 3, y: 2 });
  const cut2 = await a.next((m) => m.type === 'cut' && m.id === f2.id);
  assert.equal(cut2.chain, 2);
  assert.equal(cut2.points, 10 + hub.CONFIG.comboBonus);
  console.log('✓ quick cuts in a row give a combo bonus');

  const nest = hang(3.5, 1.4, 'nest');
  a.send({ type: 'cut', id: nest.id, x: 3, y: 2 });
  const stunned = await a.next((m) => m.type === 'stunned');
  assert.equal(stunned.ms, hub.CONFIG.stunMs);
  assert.equal(anna.score, 10 + 15 - 25);
  const f3 = hang(3.4, 2);
  a.send({ type: 'cut', id: f3.id, x: 3, y: 2 });
  await sleep(50);
  assert.ok(room.fruits.has(f3.id), 'a stunned ninja cannot cut');
  console.log('✓ the wasp nest costs points and stuns');

  // Ben stands next to Anna; her katana kicks him away to the right and steals points.
  b.send({ type: 'pos', x: 4.2, y: 2, rot: 0, air: false, facing: -1 });
  anna.stunnedUntil = 0;
  ben.score = 30;
  await sleep(20);
  a.send({ type: 'bump', id: ben.id });
  const kick = await b.next((m) => m.type === 'kick');
  assert.equal(kick.by.id, anna.id);
  assert.equal(kick.target.id, ben.id);
  assert.equal(kick.points, hub.CONFIG.kickSteal);
  assert.ok(kick.vx > 0 && kick.vy > 0, `knocked up and away (${kick.vx}, ${kick.vy})`);
  assert.equal(anna.score, 0 + hub.CONFIG.kickSteal);
  assert.equal(ben.score, 30 - hub.CONFIG.kickSteal);
  console.log('✓ a kick knocks the other ninja away and steals points');

  // A ninja without points loses nothing.
  ben.score = 0;
  anna.bumpReadyAt = 0;
  a.send({ type: 'bump', id: ben.id });
  const empty = await b.next((m) => m.type === 'kick');
  assert.equal(empty.points, 0);
  assert.equal(ben.score, 0);
  console.log('✓ nothing to steal from a ninja with zero points');

  // Ben is spinning too: the katanas clash, both bounce apart, no points change hands.
  ben.score = 20;
  const annaBefore = anna.score;
  anna.bumpReadyAt = 0;
  b.send({ type: 'pos', x: 4.2, y: 2, rot: 2, air: true, facing: -1 });
  await sleep(20);
  a.send({ type: 'bump', id: ben.id });
  const clash = await b.next((m) => m.type === 'clash');
  assert.ok(clash.push[anna.id][0] < 0, 'Anna bounces to the left');
  assert.ok(clash.push[ben.id][0] > 0, 'Ben bounces to the right');
  assert.equal(anna.score, annaBefore);
  assert.equal(ben.score, 20);
  // Ben's phone reports the same contact a moment later: ignored.
  b.send({ type: 'bump', id: anna.id });
  await sleep(50);
  assert.equal(b.take((m) => m.type === 'clash' || m.type === 'kick'), null);
  console.log('✓ two spinning katanas clash and bounce both ninjas apart');

  // Power-ups: a bubble right next to Anna is collected once.
  const bubble = (kind, x, y) => room.spawnItem(Date.now(), { kind, x0: x, y0: y, vx: 0, v0: 0, g: 0.0001 });
  a.send({ type: 'pos', x: 3, y: 2, rot: 0, air: false, facing: 1 });
  await sleep(20);
  const dbl = bubble('double', 3.4, 2.3);
  a.send({ type: 'collect', id: dbl.id, x: 3, y: 2 });
  const got = await b.next((m) => m.type === 'collected' && m.id === dbl.id);
  assert.equal(got.kind, 'double');
  assert.equal(got.by.id, anna.id);
  assert.ok(anna.effects.double > Date.now());
  b.send({ type: 'collect', id: dbl.id, x: 4.2, y: 2 });
  await sleep(30);
  assert.ok(!ben.effects.double, 'a bubble can only be collected once');
  console.log('✓ power-up bubbles are collected once');

  const scoreBefore = anna.score;
  anna.lastCutAt = 0;
  const f4 = hang(3.6, 2.4);
  a.send({ type: 'cut', id: f4.id, x: 3, y: 2 });
  const cut4 = await a.next((m) => m.type === 'cut' && m.id === f4.id);
  assert.equal(cut4.points, 20, 'apple counts double');
  assert.equal(anna.score, scoreBefore + 20);
  console.log('✓ double points');

  const farFruit = hang(6.0, 2);
  a.send({ type: 'cut', id: farFruit.id, x: 3, y: 2 });
  await sleep(30);
  assert.ok(room.fruits.has(farFruit.id), 'out of normal reach');
  const giant = bubble('giant', 3.3, 2);
  a.send({ type: 'collect', id: giant.id, x: 3, y: 2 });
  await a.next((m) => m.type === 'collected' && m.id === giant.id);
  a.send({ type: 'cut', id: farFruit.id, x: 3, y: 2 });
  await a.next((m) => m.type === 'cut' && m.id === farFruit.id);
  console.log('✓ the giant katana reaches further');

  const shield = bubble('shield', 3.3, 2);
  a.send({ type: 'collect', id: shield.id, x: 3, y: 2 });
  await a.next((m) => m.type === 'collected' && m.id === shield.id);
  const annaScore = anna.score;
  ben.bumpReadyAt = 0;
  b.send({ type: 'pos', x: 4.2, y: 2, rot: 2, air: true, facing: -1 });
  await sleep(20);
  a.drain(); // earlier kick messages are still in Anna's inbox
  b.send({ type: 'bump', id: anna.id });
  const blocked = await a.next((m) => m.type === 'kick');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.points, 0);
  assert.ok(blocked.vx > 0, 'Ben bounces back to the right');
  assert.equal(anna.score, annaScore);
  assert.ok(!(anna.effects.shield > Date.now()), 'the shield is used up');
  anna.effects.shield = Date.now() + 5000;
  const nest2 = hang(3.5, 1.6, 'nest');
  a.send({ type: 'cut', id: nest2.id, x: 3, y: 2 });
  const shieldedCut = await a.next((m) => m.type === 'cut' && m.id === nest2.id);
  assert.equal(shieldedCut.shielded, true);
  assert.equal(anna.score, annaScore);
  assert.equal(a.take((m) => m.type === 'stunned'), null, 'no stun behind the shield');
  console.log('✓ the shield blocks one kick and one wasp nest');

  // Shuriken: a bubble gives three stars; a throw flies along a straight line.
  const sh = bubble('shuriken', 3.3, 2);
  a.send({ type: 'collect', id: sh.id, x: 3, y: 2 });
  const gotStars = await a.next((m) => m.type === 'collected' && m.id === sh.id);
  assert.equal(gotStars.stars, 3);
  a.send({ type: 'throw', dx: 1, dy: 0, cid: 7 });
  const thrown = await b.next((m) => m.type === 'star');
  assert.equal(thrown.cid, 7);
  assert.equal(thrown.stars, 2);
  assert.equal(anna.stars, 2);
  const starId = thrown.star.id;

  const onLine = hang(7, 2);
  const offLine = hang(7, 5);
  const nestOnLine = hang(6, 2, 'nest');
  a.send({ type: 'cut', id: offLine.id, star: starId, x: 7, y: 5 });
  a.send({ type: 'cut', id: nestOnLine.id, star: starId, x: 6, y: 2 });
  a.send({ type: 'cut', id: onLine.id, star: starId, x: 7, y: 2 });
  await a.next((m) => m.type === 'cut' && m.id === onLine.id);
  assert.ok(room.fruits.has(offLine.id), 'a star only cuts along its line');
  assert.ok(room.fruits.has(nestOnLine.id), 'stars fly past wasp nests');
  console.log('✓ a shuriken cuts fruit far away along its flight line');

  b.send({ type: 'pos', x: 8.6, y: 2, rot: 0, air: false, facing: -1 });
  ben.score = 20;
  ben.effects = {};
  await sleep(20);
  a.drain();
  a.send({ type: 'starHit', star: starId, target: ben.id, x: 8.3, y: 2 });
  const starKick = await a.next((m) => m.type === 'kick');
  assert.equal(starKick.via, 'star');
  assert.equal(starKick.points, hub.CONFIG.kickSteal);
  assert.ok(starKick.vx > 0, 'knocked along the flight direction');
  assert.equal(ben.score, 20 - hub.CONFIG.kickSteal);
  a.send({ type: 'starHit', star: starId, target: ben.id, x: 8.3, y: 2 });
  await sleep(30);
  assert.equal(ben.score, 20 - hub.CONFIG.kickSteal, 'a star hits only one ninja');
  console.log('✓ a shuriken knocks another ninja away and steals points');

  anna.stars = 0;
  b.drain();
  a.send({ type: 'throw', dx: 1, dy: 0, cid: 8 });
  await sleep(30);
  assert.equal(b.take((m) => m.type === 'star'), null, 'no stars, no throw');
  console.log('✓ no throw without shuriken');

  // Lava: announced in the state, burns ninjas on the floor (not below zero, with a cooldown).
  a.drain();
  room.startLava(Date.now() - hub.CONFIG.lavaWarnMs); // hot right now
  const lavaState = await a.next((m) => m.type === 'state' && m.lava);
  assert.ok(lavaState.lava.startAt <= Date.now() && lavaState.lava.endAt > Date.now());
  a.send({ type: 'pos', x: 3, y: 0.5, rot: 0, air: false, facing: 1 });
  anna.score = 50;
  anna.lavaReadyAt = 0;
  await sleep(20);
  a.send({ type: 'lava' });
  const burned = await b.next((m) => m.type === 'burned');
  assert.equal(burned.by.id, anna.id);
  assert.equal(burned.points, hub.CONFIG.lavaPenalty);
  assert.equal(anna.score, 50 - hub.CONFIG.lavaPenalty);
  a.send({ type: 'lava' });
  await sleep(30);
  assert.equal(anna.score, 50 - hub.CONFIG.lavaPenalty, 'cooldown after a burn');
  anna.lavaReadyAt = 0;
  anna.score = 5;
  a.send({ type: 'lava' });
  await b.next((m) => m.type === 'burned' && m.points === 5);
  assert.equal(anna.score, 0, 'never below zero');
  anna.lavaReadyAt = 0;
  a.send({ type: 'pos', x: 3, y: 6, rot: 0, air: true, facing: 1 });
  await sleep(20);
  anna.score = 30;
  a.send({ type: 'lava' });
  await sleep(30);
  assert.equal(anna.score, 30, 'high above the floor nothing burns');
  room.lava = null;
  a.send({ type: 'pos', x: 3, y: 0.5, rot: 0, air: false, facing: 1 });
  await sleep(20);
  a.send({ type: 'lava' });
  await sleep(30);
  assert.equal(anna.score, 30, 'no lava, no burn');
  console.log('✓ lava burns ninjas on the floor, with cooldown and never below zero');

  // Every power-up comes once per shuffled bag: ten bubbles hold each kind twice.
  room.itemBag = [];
  const kinds = {};
  for (let i = 0; i < 10; i++) {
    const it = room.spawnItem(Date.now());
    kinds[it.kind] = (kinds[it.kind] || 0) + 1;
  }
  assert.deepEqual(Object.keys(kinds).sort(), Object.keys(hub.ITEMS).sort());
  assert.ok(Object.values(kinds).every((n) => n === 2), JSON.stringify(kinds));
  console.log('✓ every power-up kind comes regularly (shuffled bag)');

  const end = await a.next((m) => m.type === 'roundEnd', 11000);
  assert.equal(end.results.length, 2);
  assert.ok(end.results[0].score >= end.results[1].score, 'results are sorted');
  const annaEnd = end.results.find((r) => r.id === anna.id);
  const benEnd = end.results.find((r) => r.id === ben.id);
  assert.equal(annaEnd.prevBest, 5);
  assert.equal(annaEnd.best, Math.max(5, annaEnd.score));
  assert.equal(annaEnd.record, annaEnd.score > 5);
  assert.equal(benEnd.record, false, 'Ben stays below his 100000');
  assert.equal(benEnd.best, 100000);
  console.log('✓ round results mark new records against the personal bests');
  await a.next((m) => m.type === 'state' && m.phase === 'lobby');
  console.log('✓ round ends with results');

  a.socket.close();
  b.socket.close();
  bad.socket.close();
  console.log('\nAll Katana-Küche hub tests passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
