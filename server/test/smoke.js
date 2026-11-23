'use strict';

// End-to-end smoke test for the room / ball relay protocol.
// Usage: node test/smoke.js [ws://localhost:3000/ws]

const assert = require('node:assert/strict');
const WebSocket = require('ws');

const URL = process.argv[2] || 'ws://localhost:3000/ws';
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
    name,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred, timeout = 4000) {
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

async function main() {
  // Invalid code is rejected.
  const bad = client('bad');
  await bad.open();
  bad.send({ type: 'join', code: '123', name: 'X' });
  const err = await bad.next(isType('error'));
  assert.match(err.message, /zweistellig/);
  bad.ws.close();

  // First player gets the ball.
  const a = client('A');
  await a.open();
  a.send({ type: 'join', code, name: 'Anna', token: 'token-anna-1' });
  const joinedA = await a.next(isType('joined'));
  assert.equal(joinedA.code, code);
  const ball1 = await a.next(isType('ball'));
  assert.ok(ball1.x >= 0.05 && ball1.x <= 0.95);
  console.log('✓ solo player receives a ball');

  // Second player joins; Anna returns the ball, it must land at Ben's.
  const b = client('B');
  await b.open();
  b.send({ type: 'join', code, name: 'Ben', token: 'token-ben-1' });
  await b.next(isType('joined'));
  a.send({ type: 'exit', id: ball1.id, seq: ball1.seq, x: 0.2, angle: 0.3, speed: 1.0 });
  const ball2 = await b.next(isType('ball'));
  assert.equal(ball2.id, ball1.id);
  assert.ok(Math.abs(ball2.x - 0.8) < 1e-9, 'x is mirrored');
  assert.ok(Math.abs(ball2.angle + 0.3) < 1e-9, 'angle is mirrored');
  assert.equal(ball2.from.name, 'Anna');
  console.log('✓ returned ball travels to the other player (mirrored)');

  // Stale messages (old seq) are ignored.
  a.send({ type: 'miss', id: ball1.id, seq: ball1.seq });

  // Ben misses: score updates and the ball respawns at Anna (the only other player).
  b.send({ type: 'miss', id: ball2.id, seq: ball2.seq });
  const missEvent = await a.next((m) => m.type === 'event' && m.kind === 'miss');
  assert.equal(missEvent.name, 'Ben');
  const ball3 = await a.next(isType('ball'));
  assert.equal(ball3.from, null);
  const state = await a.next((m) => m.type === 'state' && m.players.some((p) => p.name === 'Ben' && p.misses === 1));
  const anna = state.players.find((p) => p.name === 'Anna');
  assert.equal(anna.hits, 1);
  assert.equal(anna.misses, 0, 'stale miss was ignored');
  console.log('✓ miss is counted, stale messages ignored, ball respawns');

  // Anna pauses (tab hidden): her ball goes to Ben.
  a.send({ type: 'away' });
  const ball4 = await b.next(isType('ball'));
  assert.equal(ball4.id, ball3.id);
  console.log('✓ pausing player hands the ball over');

  // Ben disconnects while holding it; Anna comes back and gets it.
  b.ws.close();
  a.send({ type: 'back' });
  const ball5 = await a.next(isType('ball'));
  assert.equal(ball5.id, ball3.id);
  console.log('✓ disconnect releases the ball');

  // Ben reconnects with his token and keeps his score.
  const b2 = client('B2');
  await b2.open();
  b2.send({ type: 'join', code, name: 'Ben', token: 'token-ben-1' });
  await b2.next(isType('joined'));
  const st = await b2.next((m) => m.type === 'state' && m.players.some((p) => p.name === 'Ben' && p.connected));
  assert.equal(st.players.length, 2);
  assert.equal(st.players.find((p) => p.name === 'Ben').misses, 1);
  console.log('✓ reconnect keeps score');

  a.ws.close();
  b2.ws.close();
  console.log(`\nAll smoke tests passed (room ${code}).`);
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
