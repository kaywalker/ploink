'use strict';

// End-to-end smoke test for the Schießbude protocol.
// Usage: node test/gallery-smoke.js [ws://localhost:3000/ws/gallery]

const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { targetPosition, CONFIG } = require('../public/shared/gallery-hub');

const URL = process.argv[2] || 'ws://localhost:3000/ws/gallery';
const code = String(Math.floor(Math.random() * 100)).padStart(2, '0');

function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred, timeout = 8000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${name}: timeout waiting for message`)), timeout);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    drain: () => inbox.splice(0),
  };
}

const isType = (type) => (m) => m.type === type;
const lastState = (c, pred, timeout) => c.next((m) => m.type === 'state' && pred(m), timeout);

async function main() {
  const a = client('A');
  await a.open();
  a.send({ type: 'ping', t: 123 });
  const pong = await a.next(isType('pong'));
  assert.equal(pong.t, 123);
  assert.ok(Math.abs(pong.server - Date.now()) < 2000);
  console.log('✓ clock sync ping/pong');

  a.send({ type: 'join', code, name: 'Anna', token: 'gallery-anna-1' });
  await a.next(isType('joined'));
  const b = client('B');
  await b.open();
  b.send({ type: 'join', code, name: 'Ben', token: 'gallery-ben-1' });
  await b.next(isType('joined'));

  let st = await lastState(a, (m) => m.seats.length === 2);
  assert.deepEqual(st.seats.map((s) => s.name), ['Anna', 'Ben']);
  b.send({ type: 'move', dir: -1 });
  st = await lastState(a, (m) => m.seats[0].name === 'Ben');
  assert.deepEqual(st.seats.map((s) => s.name), ['Ben', 'Anna']);
  console.log('✓ seats in join order, players can swap places');

  a.send({ type: 'start' });
  await lastState(a, (m) => m.phase === 'countdown');
  b.send({ type: 'move', dir: 1 }); // moving is locked once the countdown runs
  st = await lastState(a, (m) => m.phase === 'playing', CONFIG.countdownMs + 2000);
  assert.deepEqual(st.seats.map((s) => s.name), ['Ben', 'Anna']);
  assert.ok(st.phaseEndsAt - Date.now() > CONFIG.roundMs - 2000);
  console.log('✓ countdown starts the round, seats are locked');

  // Wait for a non-bomb target that is currently over Anna's phone (seat 1, x ∈ [0.4, 2.6]).
  let target = null;
  while (!target) {
    const spawn = await a.next(isType('spawn'));
    const pos = targetPosition(spawn.target, Date.now());
    if (spawn.target.type !== 'bomb' && pos.x > 0.5 && pos.x < 2.5) target = spawn.target;
  }
  a.send({ type: 'shoot', id: target.id });
  b.send({ type: 'shoot', id: target.id }); // second shot on the same target must not count
  const pop = await b.next((m) => m.type === 'pop' && m.id === target.id);
  assert.equal(pop.by.name, 'Anna');
  assert.equal(pop.points, target.points);
  st = await lastState(a, (m) => m.seats.some((s) => s.name === 'Anna' && s.score === target.points));
  assert.equal(st.seats.find((s) => s.name === 'Ben').score, 0);
  console.log('✓ first hit wins and scores, second hit is ignored');

  // A target far away from the shooter's phone is rejected.
  a.drain();
  b.drain(); // drop old spawns, including the target that was just popped
  const far = await (async () => {
    for (;;) {
      const spawn = await b.next(isType('spawn'));
      const pos = targetPosition(spawn.target, Date.now());
      if (pos.x > 1 + CONFIG.hitSeatTolerance + 0.05) return spawn.target; // off Ben's reach (seat 0)
      if (pos.x < -CONFIG.hitSeatTolerance - 0.05) return spawn.target;
    }
  })();
  b.send({ type: 'shoot', id: far.id });
  await assert.rejects(a.next((m) => m.type === 'pop' && m.id === far.id, 600));
  console.log('✓ hits on targets outside the own phone are rejected');

  // Late joiner gets the active targets.
  const c = client('C');
  await c.open();
  c.send({ type: 'join', code, name: 'Cem', token: 'gallery-cem-1' });
  const list = await c.next(isType('targets'));
  assert.ok(Array.isArray(list.list));
  console.log('✓ late joiner receives the targets in flight');

  // Stopping the round produces results sorted by score.
  a.send({ type: 'stop' });
  const end = await b.next(isType('roundEnd'));
  assert.equal(end.results[0].name, 'Anna');
  st = await lastState(b, (m) => m.phase === 'lobby');
  assert.ok(st.lastResults.length >= 2);
  console.log('✓ round end with results');

  for (const x of [a, b, c]) x.ws.close();
  console.log(`\nAll Schießbude smoke tests passed (room ${code}).`);
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
