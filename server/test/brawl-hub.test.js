'use strict';

// In-process test of the Hausmeister-Trupp (brawler) hub with fake sockets.
// Usage: node test/brawl-hub.test.js

const assert = require('node:assert/strict');
const hub = require('../public/shared/brawl-hub');

Object.assign(hub.CONFIG, {
  countdownMs: 100,
  waveBreakMs: 100,
  enemyWindupMs: 120,
  spawnIntervalMs: 50,
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
    drain: () => inbox.splice(0),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isEvent = (kind) => (m) => m.type === 'event' && m.kind === kind;

async function main() {
  const a = fakeClient('A');
  const b = fakeClient('B');
  a.send({ type: 'join', code: '33', name: 'Anna', token: 'brawl-anna-1' });
  b.send({ type: 'join', code: '33', name: 'Ben', token: 'brawl-ben-1' });
  await a.next((m) => m.type === 'joined');
  await b.next((m) => m.type === 'joined');
  const room = hub.rooms.get('33');
  const anna = [...room.players.values()].find((p) => p.name === 'Anna');
  const ben = [...room.players.values()].find((p) => p.name === 'Ben');

  a.send({ type: 'start' });
  await a.next((m) => m.type === 'state' && m.phase === 'countdown');
  const wave = await a.next(isEvent('wave'));
  assert.equal(wave.wave, 1);
  const snap = await a.next((m) => m.type === 'snap' && m.players.length === 2);
  assert.equal(snap.players[0].length, 10);
  console.log('✓ start, wave 1 and snapshots with both players');

  // Walking: hold the thumb to the right.
  const x0 = anna.x;
  a.send({ type: 'input', mx: 1, mz: 0 });
  await sleep(300);
  a.send({ type: 'input', mx: 0, mz: 0 });
  assert.ok(anna.x > x0 + 0.6, `moved from ${x0} to ${anna.x}`);
  assert.equal(anna.facing, 1);
  console.log('✓ thumb input moves the player');

  // Punch combo on a monster placed right in front of Anna.
  await sleep(150);
  const target = room.enemies.find((e) => e.state !== 'dead');
  assert.ok(target, 'a monster has spawned');
  for (const e of room.enemies) if (e !== target) e.x = -50; // keep the others away
  Object.assign(target, { x: anna.x + 0.8, z: anna.z, vx: 0, state: 'idle', cooldownUntil: Date.now() + 60_000 });
  const hp0 = target.hp;
  a.send({ type: 'punch' });
  await sleep(150);
  assert.ok(target.hp < hp0, 'first punch hits');
  for (let i = 0; i < 4 && target.state !== 'dead'; i++) {
    target.x = anna.x + 0.8;
    target.z = anna.z;
    target.cooldownUntil = Date.now() + 60_000;
    a.send({ type: 'punch' });
    await sleep(300);
  }
  assert.equal(target.state, 'dead');
  assert.ok(anna.kos >= 1 && room.kos >= 1);
  console.log('✓ punch combo knocks out a monster and counts the KO');

  // A monster next to Ben winds up and hits him.
  await sleep(100);
  const attacker = room.enemies.find((e) => e.state !== 'dead');
  if (attacker) {
    for (const e of room.enemies) if (e !== attacker) e.x = -50;
    Object.assign(attacker, { x: ben.x + 0.85, z: ben.z, vx: 0, state: 'idle', cooldownUntil: 0 });
    ben.invulnUntil = 0;
    const benHp = ben.hp;
    await sleep(600);
    assert.ok(ben.hp < benHp, 'Ben took damage');
    console.log('✓ monsters wind up and hit players');
  }

  // Everybody down: game over.
  for (const p of [anna, ben]) {
    p.invulnUntil = 0;
    room.damagePlayer({ damage: 999, facing: 1 }, p, Date.now());
  }
  const over = await a.next(isEvent('over'));
  assert.ok(over.wave >= 1);
  await a.next((m) => m.type === 'state' && m.phase === 'over');
  console.log('✓ game over when the whole crew is down');

  // Restart resets health.
  a.send({ type: 'start' });
  await a.next((m) => m.type === 'state' && m.phase === 'countdown');
  assert.equal(anna.hp, hub.CONFIG.playerHp);
  assert.equal(ben.state, 'idle');
  console.log('✓ restart puts everybody back on their feet');

  a.socket.close();
  b.socket.close();
  console.log('\nAll Hausmeister-Trupp hub tests passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
