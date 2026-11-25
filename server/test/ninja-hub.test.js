'use strict';

// In-process test of the Katana-Küche hub with fake sockets and short timings.
// Usage: node test/ninja-hub.test.js

const assert = require('node:assert/strict');
const hub = require('../public/shared/ninja-hub');

Object.assign(hub.CONFIG, {
  countdownMs: 50,
  roundMs: 4000,
  salvoEveryMs: 60_000,
  bumpCooldownMs: 0,
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

  // Ben stands next to Anna; her katana knocks him away to the right.
  b.send({ type: 'pos', x: 4.2, y: 2, rot: 0, air: false, facing: -1 });
  anna.stunnedUntil = 0;
  await sleep(20);
  a.send({ type: 'bump', id: ben.id });
  const bumped = await b.next((m) => m.type === 'bumped');
  assert.equal(bumped.by.id, anna.id);
  assert.ok(bumped.vx > 0 && bumped.vy > 0, `knocked up and away (${bumped.vx}, ${bumped.vy})`);
  console.log('✓ the katana knocks other ninjas away');

  const end = await a.next((m) => m.type === 'roundEnd', 6000);
  assert.equal(end.results[0].id, anna.id);
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
