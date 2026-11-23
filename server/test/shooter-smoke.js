'use strict';

// End-to-end smoke test for the Blaster protocol.
// Usage: node test/shooter-smoke.js [ws://localhost:3000/ws/shooter]

const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { CONFIG } = require('../public/shared/blaster-hub');

const URL = process.argv[2] || 'ws://localhost:3000/ws/shooter';
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
    next(pred, timeout = 6000) {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a = client('A');
  await a.open();
  a.send({ type: 'join', code, name: 'Anna', token: 'blaster-anna-1' });
  const ja = await a.next(isType('joined'));

  const b = client('B');
  await b.open();
  b.send({ type: 'join', code, name: 'Ben', token: 'blaster-ben-1' });
  const jb = await b.next(isType('joined'));
  assert.equal(jb.maxHp, CONFIG.maxHp);

  // Anna shoots at Ben: Ben receives a mirrored incoming shot.
  a.send({ type: 'shot', target: jb.you, x: 0.25, angle: 0.2, speed: 1.0 });
  const inc = await b.next(isType('incoming'));
  assert.ok(Math.abs(inc.x - 0.75) < 1e-9);
  assert.ok(Math.abs(inc.angle + 0.2) < 1e-9);
  assert.equal(inc.from.name, 'Anna');
  console.log('✓ shot is relayed to the chosen target (mirrored)');

  // Ben is still protected by the spawn shield: the hit does not count.
  b.send({ type: 'hit', id: inc.id });
  await sleep(CONFIG.spawnShieldMs + 100);

  // Shots at yourself or unknown players are ignored.
  a.send({ type: 'shot', target: ja.you, x: 0.5, angle: 0, speed: 1 });
  a.send({ type: 'shot', target: 'nobody', x: 0.5, angle: 0, speed: 1 });

  // Three hits destroy Ben.
  a.drain();
  b.drain();
  for (let i = 0; i < CONFIG.maxHp; i++) {
    a.send({ type: 'shot', target: jb.you, x: 0.5, angle: 0, speed: 1 });
    const shot = await b.next(isType('incoming'));
    b.send({ type: 'hit', id: shot.id });
    b.send({ type: 'hit', id: shot.id }); // duplicate report must not count twice
    await a.next((m) => m.type === 'event' && m.kind === 'landed');
  }
  const kill = await a.next((m) => m.type === 'event' && m.kind === 'kill');
  assert.equal(kill.name, 'Ben');
  assert.equal(kill.by.name, 'Anna');
  const state = await a.next((m) => m.type === 'state' && m.players.some((p) => p.name === 'Ben' && p.respawnMs > 0));
  const anna = state.players.find((p) => p.name === 'Anna');
  const ben = state.players.find((p) => p.name === 'Ben');
  assert.equal(anna.hits, CONFIG.maxHp, 'shielded hit and duplicates were ignored');
  assert.equal(anna.kills, 1);
  assert.equal(ben.deaths, 1);
  console.log('✓ hits are counted once, shield works, kill after max HP');

  // Dead players cannot be targeted.
  a.send({ type: 'shot', target: jb.you, x: 0.5, angle: 0, speed: 1 });
  await assert.rejects(b.next(isType('incoming'), 500));
  console.log('✓ dead players receive no shots');

  // Respawn restores HP.
  const respawned = await b.next((m) => m.type === 'state' && m.players.some((p) => p.name === 'Ben' && p.hp === CONFIG.maxHp && p.shieldMs > 0), CONFIG.respawnMs + 2000);
  assert.ok(respawned);
  console.log('✓ respawn with full HP and shield');

  // Paused players are not targetable.
  b.send({ type: 'away' });
  await sleep(100);
  a.send({ type: 'shot', target: jb.you, x: 0.5, angle: 0, speed: 1 });
  await assert.rejects(b.next(isType('incoming'), 500));
  console.log('✓ paused players receive no shots');

  a.ws.close();
  b.ws.close();
  console.log(`\nAll Blaster smoke tests passed (room ${code}).`);
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
