'use strict';

// In-process test of the Kontrollzentrum hub with fake sockets and short timings.
// Usage: node test/control-hub.test.js

const assert = require('node:assert/strict');
const hub = require('../public/shared/control-hub');

Object.assign(hub.CONFIG, {
  countdownMs: 50,
  levelBreakMs: 100,
  tickMs: 20,
  maxStability: 2,
  orderBaseMs: 1500,
  orderStepMs: 0,
  orderMinMs: 300,
  ordersPerLevelBase: 2,
  ordersPerLevelPerPlayer: 1,
  newOrderDelayMs: 20,
  ownPanelChance: 0.2,
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
    /** Take a matching message that already arrived, without waiting. */
    take(pred) {
      const i = inbox.findIndex(pred);
      return i >= 0 ? inbox.splice(i, 1)[0] : null;
    },
  };
}

/** First matching message from any of the clients (no dangling waiters). */
async function nextFromAny(clients, pred, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const c of clients) {
      const m = c.take(pred);
      if (m) return m;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout waiting for any client');
}

const isType = (type) => (m) => m.type === type;
const order = (m) => m.type === 'order' && m.text;

/** Work out which client owns the control named in the order and what to do with it. */
function solve(text, panels) {
  for (const [client, controls] of panels) {
    const control = controls.find((c) => text.startsWith(`${c.name} `));
    if (!control) continue;
    let value = 0;
    if (/einschalten/.test(text)) value = 1;
    const m = / auf (\d) stellen/.exec(text);
    if (m) value = Number(m[1]);
    return { client, control, value };
  }
  throw new Error(`no control for order "${text}"`);
}

async function main() {
  const a = fakeClient('A');
  const b = fakeClient('B');
  a.send({ type: 'join', code: '11', name: 'Anna', token: 'control-anna-1' });
  b.send({ type: 'join', code: '11', name: 'Ben', token: 'control-ben-1' });
  await a.next(isType('joined'));
  await b.next(isType('joined'));

  a.send({ type: 'start' });
  await a.next((m) => m.type === 'state' && m.phase === 'countdown');
  const panelA = await a.next(isType('panel'));
  const panelB = await b.next(isType('panel'));
  assert.equal(panelA.level, 1);
  assert.equal(panelA.controls.length, 5);
  const names = [...panelA.controls, ...panelB.controls].map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'control names are unique');
  console.log('✓ start deals unique panels to every player');

  const panels = new Map([[a, panelA.controls], [b, panelB.controls]]);

  // Complete orders until level 1 is done (target = 2 + 1 per extra player = 3).
  let done = 0;
  while (done < 3) {
    const o = await nextFromAny([a, b], order);
    assert.equal(typeof o.own, 'boolean', 'orders say whether the control is on the own panel');
    const { client: owner, control, value } = solve(o.text, panels);
    owner.send({ type: 'act', id: control.id, value });
    control.value = value;
    const acted = await owner.next((m) => m.type === 'acted' && m.id === control.id);
    assert.equal(acted.ok, true);
    assert.equal(acted.for.length, 1);
    const ev = await a.next((m) => m.type === 'event' && m.kind === 'done' && m.text === o.text);
    assert.equal(ev.by.name, owner === a ? 'Anna' : 'Ben');
    done++;
  }
  const levelEvent = await a.next((m) => m.type === 'event' && m.kind === 'level');
  assert.equal(levelEvent.level, 1);
  console.log('✓ orders are completed by the owner of the control, level ends at target');
  console.log('✓ the actor is told that the action was asked for and by whom');

  const level2 = await a.next((m) => m.type === 'panel' && m.level === 2);
  const panelB2 = await b.next((m) => m.type === 'panel' && m.level === 2);
  assert.equal(level2.controls.length, 5);
  const st2 = await a.next((m) => m.type === 'state' && m.phase === 'playing' && m.level === 2);
  assert.equal(st2.progress, 0);
  assert.equal(st2.completed, 3);
  console.log('✓ next level starts with fresh panels');

  // Wrong values do not complete an order.
  const panels2 = new Map([[a, level2.controls], [b, panelB2.controls]]);
  const o2 = await a.next(order);
  const sol = solve(o2.text, panels2);
  if (sol.control.type === 'slider') {
    sol.client.send({ type: 'act', id: sol.control.id, value: (sol.value + 1) % 5 });
    const miss = await sol.client.next((m) => m.type === 'acted' && m.id === sol.control.id);
    assert.equal(miss.ok, false);
    await assert.rejects(a.next((m) => m.type === 'event' && m.kind === 'done' && m.text === o2.text, 150));
    console.log('✓ a wrong slider value does not count');
  }

  // Ben leaves: orders for his controls are withdrawn, no penalty.
  b.socket.close();
  const st = await a.next((m) => m.type === 'state' && m.players.some((p) => p.name === 'Ben' && !p.connected));
  assert.equal(st.stability, 2);
  a.drain();
  const next = await a.next(order);
  assert.ok(level2.controls.some((c) => next.text.startsWith(`${c.name} `)), 'only Anna\'s controls remain');
  console.log('✓ a leaving player\'s controls are no longer used');

  // Let orders expire until stability runs out.
  a.drain();
  const fail = await a.next((m) => m.type === 'event' && m.kind === 'fail', 3000);
  assert.ok(fail.text);
  const over = await a.next((m) => m.type === 'event' && m.kind === 'over', 5000);
  assert.ok(over.level >= 2);
  const final = await a.next((m) => m.type === 'state' && m.phase === 'over');
  assert.equal(final.stability, 0);
  console.log('✓ expired orders cost stability, game over at zero');

  // A new game can be started.
  a.send({ type: 'start' });
  await a.next((m) => m.type === 'state' && m.phase === 'countdown');
  const restart = await a.next((m) => m.type === 'panel' && m.level === 1);
  assert.ok(restart.controls.length > 0);
  console.log('✓ restart after game over');

  a.socket.close();
  console.log('\nAll Kontrollzentrum hub tests passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
